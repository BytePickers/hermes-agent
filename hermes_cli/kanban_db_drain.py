"""Claim lifecycle at process boundaries: shutdown drain, boot reconcile, and the
liveness verdict + failure-counter reset they book with.

Split out of ``hermes_cli/kanban_db.py`` (with ``_clear_failure_counter`` moved
here from ``hermes_cli/kanban_db_dispatch.py``); bound onto the facade via the
late import in ``kanban_db.py``. Facade names resolve lazily inside functions so
the module imports cleanly regardless of the ``kanban_db`` <->/
``kanban_db_dispatch`` late-bind order.

Ghost-class killer: when a dispatcher/gateway process exits (update, rollover,
crash) without booking its claims, the board holds ``running`` rows whose owner
PID is gone. The claim TTL reclaims them ~15 min later — booked as failures,
inflating the capacity count and tripping the failure breaker after two stale
passes. The entry points below book those claims immediately at a process
boundary instead: operator-path semantics, pure board bookkeeping, no process
signals.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from typing import Callable, Optional

from hermes_cli.kanban_db_connect import write_txn

logger = logging.getLogger(__name__)


def _worker_alive_for_reclaim(pid: Optional[int], started_at) -> bool:
    """Liveness verdict for the crash sweep, fail-safe toward ALIVE.

    Booking a running task as ``pid not alive`` ends its run, burns a breaker
    slot and cascades into gave_up — so the sweep must only fire on death we
    can PROVE. Same as ``_worker_alive`` except one case: a live pid whose
    start-time fingerprint can no longer be read (transient /proc failure
    under load, partial psutil, exotic fs) would classify as recycled and
    get swept. Here an unreadable fingerprint keeps the worker alive; the
    claim TTL still reclaims it when it really is gone. The strict
    ``_worker_alive`` remains in charge of SIGNALLING, where an unreadable
    fingerprint must refuse the signal rather than approve it."""
    from hermes_cli import kanban_db as _kb
    from hermes_cli import kanban_db_dispatch as _kbd

    if not _kb._pid_alive(pid):
        return False
    if started_at is None or not pid or started_at == _kbd.UNVERIFIED_WORKER_FINGERPRINT:
        return True
    if isinstance(started_at, str) and "|" in started_at:
        current = _kbd._process_fingerprint(int(pid))
        if current is None:
            return True  # unreadable: fail-safe to alive
        return current == started_at
    from gateway.status import _start_times_agree, get_process_start_time
    current = get_process_start_time(int(pid))
    if current is None:
        return True
    try:
        return _start_times_agree(current, started_at)
    except (TypeError, ValueError):
        return True


def _clear_failure_counter(conn: sqlite3.Connection, task_id: str) -> None:
    """Reset the unified consecutive-failures counter.

    Called from ``complete_task`` on success. NOT called on spawn success: a
    spawn proves the worker could start, not that the run will succeed, so
    timeouts and crashes must accumulate across spawn boundaries.
    """
    with write_txn(conn):
        conn.execute(
            "UPDATE tasks SET consecutive_failures = 0, "
            "last_failure_error = NULL WHERE id = ?",
            (task_id,),
        )


def _drain_running_claim(
    conn: sqlite3.Connection, task_id: str, claim_lock: Optional[str],
    worker_pid: Optional[int], *, reason: str, owner_pid: Optional[int] = None,
) -> bool:
    """Book ONE running claim as cleanly reclaimed (shutdown-drain family).

    Operator-path semantics (:func:`reclaim_task`): the run closes as
    ``reclaimed`` with a ``shutdown_drain`` event, the task returns to its
    source phase via ``_retry_status_for_run`` (never a hard ``ready``), and
    the failure counter resets after the commit — a planned process rollover
    is not a work failure and must not spend a breaker slot. (The TTL path
    books every reclaim as a failure on purpose: its reclaims race a LIVE
    dispatcher. A one-shot drain at a process boundary cannot loop, so that
    safeguard stays intact.) CAS on ``claim_lock`` + ``worker_pid`` so a
    worker that registers itself between the caller's SELECT and this UPDATE
    keeps its claim. Pure bookkeeping: never signals a process.

    Note on the payload: this builds its own event + run metadata instead of
    going through ``_record_reclaim`` — that helper merges a termination
    report over the payload, which would clobber the drain's own keys.
    """
    from hermes_cli import kanban_db as _kb

    now = int(time.time())
    payload: dict = {
        "reason": reason,
        "claim_lock": claim_lock,
        "claim_host_local": True,
        "worker_pid": worker_pid,
        "owner_pid": owner_pid,
        "now": now,
    }
    with write_txn(conn):
        retry_status = _kb._retry_status_for_run(conn, task_id)
        payload["retry_status"] = retry_status
        cur = conn.execute(
            "UPDATE tasks SET status = ?, claim_lock = NULL, "
            "claim_expires = NULL, worker_pid = NULL, worker_started_at = NULL "
            "WHERE id = ? AND status = 'running' AND claim_lock IS ? "
            "AND worker_pid IS ?",
            (retry_status, task_id, claim_lock, worker_pid),
        )
        if cur.rowcount != 1:
            return False
        run_id = _kb._end_run(
            conn, task_id, outcome="reclaimed", status="reclaimed",
            error=f"shutdown_drain lock={claim_lock}", metadata=payload,
        )
        _kb._append_event(conn, task_id, "shutdown_drain", payload, run_id=run_id)
    # Own txn, after the reclaim commit (same shape as ``reclaim_task``).
    _clear_failure_counter(conn, task_id)
    logger.info(
        "kanban shutdown drain: requeued task %s (reason=%s, claim_lock=%s, "
        "worker_pid=%s, retry_status=%s)",
        task_id, reason, claim_lock, worker_pid, payload["retry_status"],
    )
    return True


def _drain_dead_worker_claim_rows(
    conn: sqlite3.Connection, rows: list, *, reason: str,
    owner_pid_of: Optional[Callable[[sqlite3.Row], Optional[int]]] = None,
) -> int:
    """Book the given running rows whose worker is provably gone.

    Shared skip rules for both drain entry points (a PID recycle is
    indistinguishable from alive, so both fail safe toward SKIP):

    - crash grace window (``started_at`` younger than the grace): a spawn
      may be in flight with its worker PID not yet registered — requeuing it
      under a dying/starting process would strand the worker mid-flight;
    - fail-safe worker-liveness verdict: a live worker keeps its claim
      (decoupled workers survive the dispatcher process and keep
      heartbeating the old lock). This also covers the "live worker under a
      dead owner" class — the claim is still being worked, never touch it.

    ``worker_pid`` NULL rows older than the grace window ARE booked: that is
    the ghost class a dead owner leaves when it died between spawn and PID
    registration, and the TTL path would otherwise reclaim the same row
    ~15 min later as a failure.
    """
    from hermes_cli import kanban_db as _kb

    now = int(time.time())
    grace = _kb._resolve_crash_grace_seconds()
    drained = 0
    for row in rows:
        started_at = _kb._row_get(row, "started_at")
        if started_at is not None and now - int(started_at) < grace:
            continue
        worker_pid = _kb._opt_int(row["worker_pid"])
        if worker_pid is not None and _worker_alive_for_reclaim(
            worker_pid, _kb._row_get(row, "worker_started_at"),
        ):
            continue
        owner_pid = owner_pid_of(row) if owner_pid_of is not None else None
        if _drain_running_claim(
            conn, row["id"], row["claim_lock"], worker_pid, reason=reason,
            owner_pid=owner_pid,
        ):
            drained += 1
    return drained


def drain_claims_on_shutdown(
    conn: sqlite3.Connection, *, reason: str = "gateway_shutdown",
) -> int:
    """Release THIS process's own running claims at a clean shutdown.

    Selection is exactly the process's own claim identity
    (``claim_lock == host:pid``), so a second dispatcher on the same host is
    never touched. Returns the number of claims requeued. Wired into the
    gateway teardown (``run_shutdown._stop_drain_kanban_claims``) and after
    the ``run_daemon`` loop — a planned stop must not leave ghost rows that
    age into TTL reclaims booked as failures.
    """
    from hermes_cli import kanban_db as _kb

    rows = conn.execute(
        "SELECT id, claim_lock, worker_pid, worker_started_at, started_at "
        "FROM tasks WHERE status = 'running' AND claim_lock IS ?",
        (_kb._claimer_id(),),
    ).fetchall()
    return _drain_dead_worker_claim_rows(conn, rows, reason=reason)


def reconcile_claims_of_dead_owners(conn: sqlite3.Connection) -> int:
    """Requeue running claims whose owner process died uncleanly (boot path).

    Complement to :func:`drain_claims_on_shutdown` for what a shutdown drain
    cannot book: the previous process died before it could drain (SIGKILL,
    OOM, power loss). The NEXT dispatcher books the leftovers ONCE, before
    its first tick — never per tick (a per-tick drain resetting the failure
    counter would defeat the breaker the TTL path exists to feed).

    Selection: host-local lock (another machine's PIDs are meaningless), not
    this process's own identity, owner PID (parsed off the lock) provably
    dead — a live owner is skipped, and a malformed lock is not ours to
    judge. Returns the number of claims requeued.
    """
    from hermes_cli import kanban_db as _kb

    own_lock = _kb._claimer_id()
    host_prefix = _kb._host_prefix()
    rows = conn.execute(
        "SELECT id, claim_lock, worker_pid, worker_started_at, started_at "
        "FROM tasks WHERE status = 'running' AND claim_lock IS NOT NULL"
    ).fetchall()
    dead_owner_rows = []
    owner_pids: dict[str, int] = {}
    for row in rows:
        lock = row["claim_lock"] or ""
        if not lock.startswith(host_prefix) or lock == own_lock:
            continue
        try:
            owner_pid = int(lock.rsplit(":", 1)[1])
        except (IndexError, ValueError):
            continue
        if _kb._pid_alive(owner_pid):
            continue  # owner alive: another dispatcher on this host owns it
        owner_pids[row["id"]] = owner_pid
        dead_owner_rows.append(row)
    return _drain_dead_worker_claim_rows(
        conn, dead_owner_rows, reason="dispatcher_startup_reconcile",
        owner_pid_of=lambda row: owner_pids.get(row["id"]),
    )


def reconcile_at_daemon_boot() -> None:
    """One-shot ``run_daemon`` boot hook: book dead-owner claims before the tick loop."""
    import contextlib

    from hermes_cli import kanban_db as _kb
    from hermes_cli import kanban_db_connect as _kbc

    try:
        with contextlib.closing(_kbc.connect()) as conn:
            reconciled = _kb.reconcile_claims_of_dead_owners(conn)
        if reconciled:
            print(f"kanban daemon: startup reconcile requeued {reconciled} dead-owner claim(s)")
    except Exception:
        logger.exception("kanban daemon: startup reconcile failed")


def drain_at_daemon_exit() -> None:
    """One-shot ``run_daemon`` exit hook: drain this daemon's claims after the loop."""
    import contextlib

    from hermes_cli import kanban_db as _kb
    from hermes_cli import kanban_db_connect as _kbc

    try:
        with contextlib.closing(_kbc.connect()) as conn:
            drained = _kb.drain_claims_on_shutdown(conn, reason="daemon_shutdown")
        if drained:
            print(f"kanban daemon: shutdown drain requeued {drained} claim(s)")
    except Exception:
        logger.exception("kanban daemon: shutdown drain failed")
