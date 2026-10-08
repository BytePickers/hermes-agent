"""Tests: the shutdown drain + dead-owner reconcile book ghost claims cleanly.

When a dispatcher/gateway process exits without booking its claims (update,
rollover, crash), the board holds ``running`` rows whose owner PID is gone.
The claim TTL reclaims them ~15 min later — booked as failures, inflating
the capacity count and tripping the failure breaker after two stale passes
(a real rollover incident: claims reclaimed ~15.5 min after the owner died,
then a 90+ min stall once the breaker had tripped 2/2). These tests pin the
replacement behaviour:

- ``drain_claims_on_shutdown``: the dying process books its OWN claims
  (``claim_lock == host:pid``) before exiting — operator-path semantics
  (``reclaimed`` run + ``shutdown_drain`` event + counter reset), never
  touching another dispatcher's claims or a live worker.
- ``reconcile_claims_of_dead_owners``: the NEXT dispatcher books the
  leftovers of an unclean death once at boot — only host-local locks whose
  owner PID is provably dead, never a live worker under a dead owner.
- Wiring: ``run_daemon`` runs both hooks around its loop; the gateway
  teardown phase drains every board and survives drain failures.
"""

from __future__ import annotations

import json
import subprocess
import threading
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_db_dispatch as kbd

# Pre-import the gateway runner facade at module level: its import chain runs
# the interpreter bootstrap's environment probe (hermes_bootstrap ->
# pm.environments), which reads ``manifest.json`` beside the checkout. Doing
# that here (collection time, before the per-test real-home I/O guard
# installs) keeps the teardown tests' lazy
# ``from gateway.run import GatewayRunner`` a sys.modules hit instead of a
# guarded file read of a file this checkout does not own.
import gateway.run  # noqa: F401
from gateway.run_shutdown import GatewayShutdownMixin


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_CRASH_GRACE_SECONDS", "0")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    db_path = kb.kanban_db_path(board="default")
    kb._INITIALIZED_PATHS.discard(str(db_path.resolve()))
    kb.init_db()
    return home


@pytest.fixture
def conn(kanban_home):
    with kbc.connect() as c:
        yield c


def _dead_pid() -> int:
    p = subprocess.Popen(["true"])
    p.wait()
    return p.pid


class _AlivePid:
    """A real live PID for liveness checks; killed on exit."""

    def __enter__(self) -> int:
        self._p = subprocess.Popen(["sleep", "30"])
        return self._p.pid

    def __exit__(self, *exc) -> None:
        self._p.terminate()
        self._p.wait()


def _claim(conn, tid, claimer, *, worker_pid=None, review=False):
    """Claim a task as ``claimer`` and optionally register a worker PID."""
    if review:
        assert conn.execute(
            "UPDATE tasks SET status='review' WHERE id=?", (tid,)
        ).rowcount == 1
        conn.commit()
        assert kb.claim_review_task(conn, tid, claimer=claimer) is not None
    else:
        assert kb.claim_task(conn, tid, claimer=claimer) is not None
    if worker_pid is not None:
        kbd._set_worker_pid(conn, tid, worker_pid)


def _drain_event(conn, tid):
    row = conn.execute(
        "SELECT payload, run_id FROM task_events "
        "WHERE task_id=? AND kind='shutdown_drain' ORDER BY id DESC LIMIT 1",
        (tid,),
    ).fetchone()
    return (json.loads(row["payload"]), row["run_id"]) if row else (None, None)


def _last_run(conn, tid):
    return conn.execute(
        "SELECT status, outcome, ended_at, error FROM task_runs "
        "WHERE task_id=? ORDER BY id DESC LIMIT 1",
        (tid,),
    ).fetchone()


# --- drain_claims_on_shutdown ---------------------------------------------


def test_shutdown_drain_books_dead_worker_cleanly(conn):
    """Dead worker: run closed as reclaimed, task requeued, claim cleared,
    failure counter reset, audit event with the drain facts."""
    tid = kb.create_task(conn, title="ghost", assignee="w")
    _claim(conn, tid, kb._claimer_id(), worker_pid=_dead_pid())
    conn.execute(
        "UPDATE tasks SET consecutive_failures=1, last_failure_error='prior' WHERE id=?",
        (tid,),
    )
    conn.commit()

    assert kb.drain_claims_on_shutdown(conn, reason="gateway_shutdown") == 1

    row = conn.execute(
        "SELECT status, claim_lock, claim_expires, worker_pid, worker_started_at, "
        "consecutive_failures, last_failure_error FROM tasks WHERE id=?",
        (tid,),
    ).fetchone()
    assert row["status"] == "ready"  # never hard-'ready' bypass: retry path says ready
    assert row["claim_lock"] is None and row["claim_expires"] is None
    assert row["worker_pid"] is None and row["worker_started_at"] is None
    assert row["consecutive_failures"] == 0 and row["last_failure_error"] is None

    run = _last_run(conn, tid)
    assert run["status"] == "reclaimed" and run["outcome"] == "reclaimed"
    assert run["ended_at"] is not None
    assert run["error"].startswith("shutdown_drain lock=")

    payload, run_id = _drain_event(conn, tid)
    assert payload["reason"] == "gateway_shutdown"
    assert payload["claim_host_local"] is True
    assert payload["retry_status"] == "ready"
    assert run_id is not None


def test_shutdown_drain_spares_live_worker(conn):
    """A live worker keeps its claim — decoupled workers survive the process."""
    tid = kb.create_task(conn, title="alive", assignee="w")
    with _AlivePid() as pid:
        _claim(conn, tid, kb._claimer_id(), worker_pid=pid)
        assert kb.drain_claims_on_shutdown(conn) == 0
        row = conn.execute(
            "SELECT status, claim_lock, worker_pid FROM tasks WHERE id=?", (tid,)
        ).fetchone()
        assert row["status"] == "running" and row["claim_lock"] == kb._claimer_id()
        assert row["worker_pid"] == pid


def test_shutdown_drain_spares_grace_window(conn):
    """A run inside the crash grace window is skipped: a spawn may be in
    flight with its worker PID not yet registered."""
    monkey_grace = pytest.MonkeyPatch()
    monkey_grace.setattr(kb, "_resolve_crash_grace_seconds", lambda: 3600)
    try:
        tid = kb.create_task(conn, title="in-flight", assignee="w")
        _claim(conn, tid, kb._claimer_id())
        assert kb.drain_claims_on_shutdown(conn) == 0
        # Past the window the same row IS the ghost class: booked.
        conn.execute(
            "UPDATE tasks SET started_at = started_at - 7200 WHERE id=?", (tid,)
        )
        conn.commit()
        assert kb.drain_claims_on_shutdown(conn) == 1
    finally:
        monkey_grace.undo()


def test_shutdown_drain_touches_only_own_lock_identity(conn):
    """Another dispatcher's claim on the same host is never touched."""
    own = kb.create_task(conn, title="mine", assignee="w")
    other = kb.create_task(conn, title="other dispatcher", assignee="w")
    _claim(conn, own, kb._claimer_id(), worker_pid=_dead_pid())
    with _AlivePid() as pid:
        _claim(conn, other, f"{kb._claimer_id().split(':', 1)[0]}:{pid}")

        assert kb.drain_claims_on_shutdown(conn) == 1

        assert conn.execute(
            "SELECT status FROM tasks WHERE id=?", (own,)
        ).fetchone()["status"] == "ready"
        assert conn.execute(
            "SELECT status FROM tasks WHERE id=?", (other,)
        ).fetchone()["status"] == "running"


def test_shutdown_drain_returns_review_source_to_review(conn):
    """A reviewer run is requeued to the review lane, not the ready lane."""
    tid = kb.create_task(conn, title="review drain", assignee="reviewer")
    _claim(conn, tid, kb._claimer_id(), worker_pid=_dead_pid(), review=True)

    assert kb.drain_claims_on_shutdown(conn) == 1

    assert conn.execute(
        "SELECT status FROM tasks WHERE id=?", (tid,)
    ).fetchone()["status"] == "review"
    payload, _ = _drain_event(conn, tid)
    assert payload["retry_status"] == "review"


def test_shutdown_drain_is_a_noop_without_running_workers(conn):
    """Acceptance criterion 4: no running workers → no bookings, no events."""
    kb.create_task(conn, title="untouched", assignee="w")
    assert kb.drain_claims_on_shutdown(conn) == 0
    assert conn.execute(
        "SELECT COUNT(*) AS n FROM task_events WHERE kind='shutdown_drain'"
    ).fetchone()["n"] == 0


def test_shutdown_drain_is_idempotent(conn):
    """A second drain pass finds nothing — CAS bounds make re-runs harmless."""
    tid = kb.create_task(conn, title="once", assignee="w")
    _claim(conn, tid, kb._claimer_id(), worker_pid=_dead_pid())
    assert kb.drain_claims_on_shutdown(conn) == 1
    assert kb.drain_claims_on_shutdown(conn) == 0


# --- reconcile_claims_of_dead_owners ---------------------------------------


def test_startup_reconcile_books_dead_owner_claims(conn):
    """Dead owner + dead/missing worker → booked, with the owner PID in the
    audit event. This is the class the night TTL reclaims caught too late."""
    host = kb._claimer_id().split(":", 1)[0]
    dead_owner = _dead_pid()

    with_pid = kb.create_task(conn, title="dead owner, dead worker", assignee="w")
    _claim(conn, with_pid, f"{host}:{dead_owner}", worker_pid=_dead_pid())
    null_pid = kb.create_task(conn, title="dead owner, no worker", assignee="w")
    _claim(conn, null_pid, f"{host}:{dead_owner}")

    assert kb.reconcile_claims_of_dead_owners(conn) == 2

    for tid in (with_pid, null_pid):
        assert conn.execute(
            "SELECT status FROM tasks WHERE id=?", (tid,)
        ).fetchone()["status"] == "ready"
        run = _last_run(conn, tid)
        assert run["outcome"] == "reclaimed" and run["ended_at"] is not None

    payload, _ = _drain_event(conn, null_pid)
    assert payload["reason"] == "dispatcher_startup_reconcile"
    assert payload["owner_pid"] == dead_owner
    assert payload["claim_host_local"] is True


def test_startup_reconcile_spares_live_worker_under_dead_owner(conn):
    """A live worker outlived its gateway. Its claim is
    still being heartbeated with the old lock — never touched."""
    host = kb._claimer_id().split(":", 1)[0]
    dead_owner = _dead_pid()
    tid = kb.create_task(conn, title="alive under dead owner", assignee="w")
    with _AlivePid() as pid:
        _claim(conn, tid, f"{host}:{dead_owner}", worker_pid=pid)
        assert kb.reconcile_claims_of_dead_owners(conn) == 0
        row = conn.execute(
            "SELECT status, claim_lock, worker_pid FROM tasks WHERE id=?", (tid,)
        ).fetchone()
        assert row["status"] == "running"
        assert row["claim_lock"] == f"{host}:{dead_owner}"
        assert row["worker_pid"] == pid


def test_startup_reconcile_spares_live_owner_and_foreign_hosts(conn):
    """Only provably-dead SAME-HOST owners are booked: a live owner is another
    dispatcher's claim, a foreign host's PID is meaningless here."""
    host = kb._claimer_id().split(":", 1)[0]
    live_owner = kb.create_task(conn, title="owner alive", assignee="w")
    foreign = kb.create_task(conn, title="foreign host", assignee="w")
    malformed = kb.create_task(conn, title="malformed lock", assignee="w")
    with _AlivePid() as pid:
        _claim(conn, live_owner, f"{host}:{pid}", worker_pid=_dead_pid())
        _claim(conn, foreign, f"other-host:{_dead_pid()}", worker_pid=_dead_pid())
        _claim(conn, malformed, f"{host}:not-a-pid", worker_pid=_dead_pid())

        assert kb.reconcile_claims_of_dead_owners(conn) == 0

        for tid in (live_owner, foreign, malformed):
            assert conn.execute(
                "SELECT status FROM tasks WHERE id=?", (tid,)
            ).fetchone()["status"] == "running"


def test_startup_reconcile_never_takes_own_claims(conn):
    """The reconciling dispatcher's own identity is excluded by design."""
    tid = kb.create_task(conn, title="mine", assignee="w")
    _claim(conn, tid, kb._claimer_id(), worker_pid=_dead_pid())
    assert kb.reconcile_claims_of_dead_owners(conn) == 0
    assert conn.execute(
        "SELECT status FROM tasks WHERE id=?", (tid,)
    ).fetchone()["status"] == "running"


# --- wiring ----------------------------------------------------------------


def test_run_daemon_runs_reconcile_before_loop_and_drain_after(kanban_home, monkeypatch):
    """``hermes kanban daemon``: startup reconcile before the first tick,
    shutdown drain after the loop — even when the loop never ticks."""
    calls: list = []
    monkeypatch.setattr(kbd, "dispatch_once", lambda conn, **kw: kb.DispatchResult())
    monkeypatch.setattr(
        kb, "reconcile_claims_of_dead_owners",
        lambda conn: calls.append("reconcile") or 0,
    )

    def fake_drain(conn, *, reason="gateway_shutdown"):
        calls.append(("drain", reason))
        return 0

    monkeypatch.setattr(kb, "drain_claims_on_shutdown", fake_drain)

    stop = threading.Event()
    stop.set()  # loop body never runs
    kbd.run_daemon(interval=0.01, stop_event=stop)

    assert calls[0] == "reconcile"
    assert calls[1] == ("drain", "daemon_shutdown")
    # dispatch_once was never reached (loop skipped) — hooks are loop-independent.
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_gateway_teardown_phase_drains_boards(kanban_home, monkeypatch):
    """The gateway teardown phase drains every board via the shutdown variant."""
    calls: list = []
    monkeypatch.setattr(
        kb, "drain_claims_on_shutdown",
        lambda conn, *, reason="gateway_shutdown": calls.append(reason) or 1,
    )
    runner = GatewayShutdownMixin.__new__(GatewayShutdownMixin)
    ctx = GatewayShutdownMixin._StopContext(deferred_count=lambda: 0)

    await runner._stop_drain_kanban_claims(ctx)

    assert calls == ["gateway_shutdown"]


@pytest.mark.asyncio
async def test_gateway_teardown_phase_survives_drain_failure(kanban_home, monkeypatch):
    """A drain failure must never break teardown (best-effort contract)."""

    def boom(conn, *, reason="gateway_shutdown"):
        raise RuntimeError("drain exploded")

    monkeypatch.setattr(kb, "drain_claims_on_shutdown", boom)
    runner = GatewayShutdownMixin.__new__(GatewayShutdownMixin)
    ctx = GatewayShutdownMixin._StopContext(deferred_count=lambda: 0)

    await runner._stop_drain_kanban_claims(ctx)  # must not raise
