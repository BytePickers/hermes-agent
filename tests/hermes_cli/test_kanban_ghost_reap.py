"""Ghost-run harvest + live spawn-budget counting (t_56037ffe).

Every existing reclaim sweep keys on ``tasks.status = 'running'``. A card that
departs ``running`` (parked, completed, re-claimed elsewhere) before its run
row ends leaves that row ``running`` forever — heartbeats are bound to the
running card — and every running-count inflates until real spawn capacity is
gone (runs 8819/9213/9621/10087: 2.2-6.8 days old, board at 12-14 against a
cap of 8). These tests pin the three fixes:

1. ``reap_orphaned_runs`` closes departed-card run rows as ``failed`` /
   ``reaped_orphan`` with a visible ``ghost_run_reaped`` event, releasing the
   card's stale claim pointer in the same transaction — never a live host-local
   worker, never a fresh (pre-hysteresis) run, never a ``done`` card's fields.
2. ``release_orphaned_task_claims`` clears claim remnants on non-running cards
   whose run is already over (the run-10814 class), leaving ``done`` cards'
   forensics fields alone.
3. The spawn budget and the per-profile cap count only rows with a live
   process behind them (``count_live_running_tasks`` /
   ``count_live_running_per_profile``), and a tick whose only activity is a
   harvest reports ``ok``, not ``idle``.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_db_dispatch as kbd
from hermes_cli import kanban_ops as kops

# Well past both hysteresis thresholds (heartbeat 3600s, min age 900s).
DEAD_HEARTBEAT_AGO = kb.DEFAULT_CLAIM_HEARTBEAT_MAX_STALE_SECONDS + 3600
OLD_AGE_AGO = kbd.GHOST_RUN_MIN_AGE_SECONDS + 3600


@pytest.fixture
def conn(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    db_path = kb.kanban_db_path(board="default")
    kb._INITIALIZED_PATHS.discard(str(db_path.resolve()))
    kb.init_db()
    with kbc.connect() as c:
        yield c


@pytest.fixture
def captured_ticks(monkeypatch):
    """Register a capturing callback for the dispatch tick hook."""
    from hermes_cli.plugins import get_plugin_manager

    mgr = get_plugin_manager()
    events: list[dict] = []
    saved = {k: list(v) for k, v in mgr._hooks.items()}
    mgr._hooks.setdefault("on_kanban_dispatch_tick", []).append(
        lambda **kw: events.append(kw)
    )
    try:
        yield events
    finally:
        mgr._hooks = saved


def _sleeper():
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.2)
    return proc


def _dead_pid():
    proc = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    proc.wait(timeout=10)
    return proc.pid


def _claimed_card(conn, title="ghost", assignee="coder"):
    """A claimed card with its active run row (status 'running' on both)."""
    tid = kb.create_task(conn, title=title, assignee=assignee)
    assert kb.claim_task(conn, tid, claimer=kb._claimer_id()) is not None
    run_id = kb._current_run_id(conn, tid)
    assert run_id is not None
    return tid, run_id


def _depart(conn, tid, run_id, *, task_status="ready", age_ago=OLD_AGE_AGO,
            heartbeat_ago=DEAD_HEARTBEAT_AGO, worker_pid=None):
    """Card departs 'running' while its run row stays open — the ghost shape."""
    now = int(time.time())
    conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (task_status, tid))
    if worker_pid is not None:
        kbd._set_worker_pid(conn, tid, worker_pid)
    conn.execute(
        "UPDATE task_runs SET started_at = ?, last_heartbeat_at = ? WHERE id = ?",
        (now - age_ago, now - heartbeat_ago if heartbeat_ago is not None else None, run_id),
    )


def _run_row(conn, run_id):
    return conn.execute("SELECT * FROM task_runs WHERE id = ?", (run_id,)).fetchone()


def _event_kinds(conn, tid):
    return [r["kind"] for r in conn.execute(
        "SELECT kind FROM task_events WHERE task_id = ?", (tid,)
    )]


# ---------------------------------------------------------------------------
# T1 — four-ghost fixture: harvest, event, forensics kept, idempotent
# ---------------------------------------------------------------------------

def test_ghost_run_is_reaped_with_event_and_forensics_kept(conn):
    tid, run_id = _claimed_card(conn)
    dead = _dead_pid()
    _depart(conn, tid, run_id, task_status="ready", worker_pid=dead)

    assert kbd.reap_orphaned_runs(conn) == [run_id]

    run = _run_row(conn, run_id)
    assert run["status"] == "failed" and run["outcome"] == "reaped_orphan"
    assert run["ended_at"] is not None
    # Forensics contract: evidence of the OS process stays on the closed row.
    assert run["worker_pid"] == dead and run["worker_started_at"] is not None
    assert run["claim_lock"] is not None
    metadata = json.loads(run["metadata"])
    assert metadata["reap_reason"] == "ghost_run_card_departed"
    assert metadata["reap_by"] == "dispatcher"
    kinds = _event_kinds(conn, tid)
    assert "ghost_run_reaped" in kinds
    # Idempotent: the second tick harvests nothing.
    assert kbd.reap_orphaned_runs(conn) == []


def test_ghost_on_done_card_keeps_card_claim_fields(conn):
    """The coupled release skips done cards (forensics contract, plan §3.3):
    the run row is closed, but the card's claim pointer stays untouched."""
    tid, run_id = _claimed_card(conn)
    _depart(conn, tid, run_id, task_status="done")

    assert kbd.reap_orphaned_runs(conn) == [run_id]
    card = conn.execute("SELECT current_run_id, claim_lock, claim_expires FROM tasks WHERE id = ?", (tid,)).fetchone()
    assert card["current_run_id"] == run_id and card["claim_lock"] is not None


def test_ghost_on_ready_card_releases_card_claim_fields(conn):
    """Coupled release: the card leaves the tick spawnable again."""
    tid, run_id = _claimed_card(conn)
    _depart(conn, tid, run_id, task_status="ready")

    assert kbd.reap_orphaned_runs(conn) == [run_id]
    card = conn.execute("SELECT current_run_id, claim_lock, claim_expires, status FROM tasks WHERE id = ?", (tid,)).fetchone()
    assert card["status"] == "ready"  # no status change — bookkeeping only
    assert card["current_run_id"] is None
    assert card["claim_lock"] is None and card["claim_expires"] is None


# ---------------------------------------------------------------------------
# T2 — hysteresis: fresh zombies survive, both thresholds crossed -> reaped
# ---------------------------------------------------------------------------

def test_fresh_zombie_survives_until_both_thresholds_pass(conn):
    tid, run_id = _claimed_card(conn)
    dead = _dead_pid()
    # Phase 1: run too young (heartbeat already dead) -> untouched.
    _depart(conn, tid, run_id, task_status="blocked", age_ago=60, worker_pid=dead)
    assert kbd.reap_orphaned_runs(conn) == []
    # Phase 2: old enough but heartbeat fresh -> untouched.
    now = int(time.time())
    conn.execute(
        "UPDATE task_runs SET started_at = ?, last_heartbeat_at = ? WHERE id = ?",
        (now - OLD_AGE_AGO, now - 60, run_id),
    )
    assert kbd.reap_orphaned_runs(conn) == []
    # Phase 3: both thresholds crossed -> harvested.
    conn.execute(
        "UPDATE task_runs SET last_heartbeat_at = ? WHERE id = ?",
        (now - DEAD_HEARTBEAT_AGO, run_id),
    )
    assert kbd.reap_orphaned_runs(conn) == [run_id]


# ---------------------------------------------------------------------------
# T3 — a live host-local worker is never harvested
# ---------------------------------------------------------------------------

def test_live_worker_survives_the_harvest(conn):
    proc = _sleeper()
    try:
        tid, run_id = _claimed_card(conn)
        _depart(conn, tid, run_id, task_status="blocked", worker_pid=proc.pid)

        assert kbd.reap_orphaned_runs(conn) == []
        assert _run_row(conn, run_id)["status"] == "running"
        assert "ghost_run_reaped" not in _event_kinds(conn, tid)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


# ---------------------------------------------------------------------------
# T4 — the cap counts only live rows
# ---------------------------------------------------------------------------

def _running_card_with_expired_claim(conn, assignee="coder", worker_pid=None):
    tid, run_id = _claimed_card(conn, assignee=assignee)
    now = int(time.time())
    conn.execute("UPDATE tasks SET claim_expires = ? WHERE id = ?", (now - 600, tid))
    if worker_pid is not None:
        kbd._set_worker_pid(conn, tid, worker_pid)
    return tid, run_id


def test_cap_counts_ghost_row_not_but_fresh_claim_yes(conn):
    # Ghost: running card, expired claim, no worker -> NOT counted.
    ghost_tid, _ = _running_card_with_expired_claim(conn)
    assert kbd.count_live_running_tasks(conn) == 0
    assert kbd.count_live_running_per_profile(conn) == {}
    # Fresh claim on a running card -> counted.
    fresh_tid, _ = _claimed_card(conn, title="fresh", assignee="coder")
    assert kbd.count_live_running_tasks(conn) == 1
    assert kbd.count_live_running_per_profile(conn) == {"coder": 1}


def test_live_worker_under_expired_claim_still_counts(conn):
    """Extension branch: the worker outlived its TTL but is alive — it keeps
    its slot, or the cap would spawn a duplicate beside it."""
    proc = _sleeper()
    try:
        _running_card_with_expired_claim(conn, worker_pid=proc.pid)
        assert kbd.count_live_running_tasks(conn) == 1
        assert kbd.count_live_running_per_profile(conn) == {"coder": 1}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_spawn_budget_sees_through_ghost_row(conn, monkeypatch):
    """Regression: the budget must not treat a ghost row as a live worker.
    With the raw count this tick returns (False, None) — nothing spawns."""
    monkeypatch.setattr(kbd, "_memory_pressure_level", lambda: "unknown")
    _running_card_with_expired_claim(conn)
    result = kb.DispatchResult()
    may_spawn, budget = kbd._tick_spawn_budget(
        conn, result, max_spawn=1, max_in_progress=None, board=None,
    )
    assert (may_spawn, budget) == (True, 1)


def test_dispatch_tick_spawns_despite_ghost_row(conn, all_assignees_spawnable):
    """End to end: the tick reclaims the departed card and spawns again."""
    spawns: list = []
    ghost_tid, _ = _running_card_with_expired_claim(conn)
    result = kbd.dispatch_once(
        conn, spawn_fn=lambda task, ws, board=None: (spawns.append(task.id), 42)[1],
        max_spawn=1,
    )
    assert spawns == [ghost_tid]
    assert result.reclaimed >= 1  # the expired claim was cleaned up on the way


# ---------------------------------------------------------------------------
# T5/T6 — the run-10814 class: claim remnants on cards whose run is over
# ---------------------------------------------------------------------------

def test_orphaned_claim_released_with_event(conn):
    tid, run_id = _claimed_card(conn)
    now = int(time.time())
    # The run row was already reaped; the card kept the stale pointer (10814).
    conn.execute(
        "UPDATE task_runs SET status = 'reclaimed', ended_at = ? WHERE id = ?",
        (now - 3600, run_id),
    )
    conn.execute(
        "UPDATE tasks SET status = 'ready', claim_expires = ? WHERE id = ?",
        (now - 1800, tid),
    )

    assert kbd.release_orphaned_task_claims(conn) == [tid]
    card = conn.execute("SELECT current_run_id, claim_lock, claim_expires, status FROM tasks WHERE id = ?", (tid,)).fetchone()
    assert card["status"] == "ready"
    assert card["current_run_id"] is None
    assert card["claim_lock"] is None and card["claim_expires"] is None
    released = [e for e in conn.execute(
        "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'orphaned_claim_released'",
        (tid,),
    )]
    assert len(released) == 1
    payload = json.loads(released[0]["payload"])
    assert payload["reason"] == "orphaned_claim"
    assert payload["current_run_id"] == run_id
    # No failure counting: the consecutive-failures counter stays at its value.
    assert conn.execute("SELECT consecutive_failures FROM tasks WHERE id = ?", (tid,)).fetchone()["consecutive_failures"] == 0


def test_orphaned_claim_done_card_untouched(conn):
    """done cards keep their fields — forensics over tidiness (plan §3.3)."""
    tid, run_id = _claimed_card(conn)
    now = int(time.time())
    conn.execute(
        "UPDATE task_runs SET status = 'done', ended_at = ? WHERE id = ?",
        (now - 3600, run_id),
    )
    conn.execute(
        "UPDATE tasks SET status = 'done', completed_at = ?, claim_expires = ? WHERE id = ?",
        (now - 3500, now - 1800, tid),
    )
    assert kbd.release_orphaned_task_claims(conn) == []
    card = conn.execute("SELECT current_run_id, claim_lock FROM tasks WHERE id = ?", (tid,)).fetchone()
    assert card["current_run_id"] == run_id and card["claim_lock"] is not None


def test_fresh_claim_on_runless_card_is_not_touched(conn):
    """An unexpired claim is not ours to clear — the TTL path owns it."""
    tid, run_id = _claimed_card(conn)
    now = int(time.time())
    conn.execute(
        "UPDATE task_runs SET status = 'reclaimed', ended_at = ? WHERE id = ?",
        (now - 3600, run_id),
    )
    conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (tid,))
    assert kbd.release_orphaned_task_claims(conn) == []
    assert conn.execute("SELECT claim_lock FROM tasks WHERE id = ?", (tid,)).fetchone()["claim_lock"] is not None


# ---------------------------------------------------------------------------
# T7 — healthy board: no-op
# ---------------------------------------------------------------------------

def test_healthy_board_is_a_no_op(conn):
    proc = _sleeper()
    try:
        tid, run_id = _claimed_card(conn)
        kbd._set_worker_pid(conn, tid, proc.pid)  # live worker, fresh claim
        assert kbd.reap_orphaned_runs(conn) == []
        assert kbd.release_orphaned_task_claims(conn) == []
        assert _run_row(conn, run_id)["status"] == "running"
        assert "ghost_run_reaped" not in _event_kinds(conn, tid)
        assert "orphaned_claim_released" not in _event_kinds(conn, tid)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


# ---------------------------------------------------------------------------
# T8 — a harvest-only tick is activity, not idle; ops summary carries counters
# ---------------------------------------------------------------------------

def test_harvest_only_tick_reports_ok_not_idle(conn, captured_ticks):
    tid, run_id = _claimed_card(conn)
    _depart(conn, tid, run_id, task_status="ready")

    result = kbd.dispatch_once(conn, spawn_fn=lambda *a, **k: 0, dry_run=True, max_spawn=0)

    assert result.reaped_orphan_runs == [run_id]
    ok_ticks = [kw for kw in captured_ticks if kw["outcome"] == "ok"]
    assert ok_ticks, f"expected an ok tick, got {[kw['outcome'] for kw in captured_ticks]}"
    assert ok_ticks[-1]["result"].reaped_orphan_runs == [run_id]


def test_ops_json_summary_carries_both_counters(conn, monkeypatch, capsys):
    res = kb.DispatchResult()
    res.reaped_orphan_runs = [8819, 9213]
    res.released_orphan_claims = ["t_a", "t_b"]
    monkeypatch.setattr(kbd, "dispatch_once", lambda *a, **k: res)

    assert kops._cmd_dispatch(argparse.Namespace(dry_run=False, json=True, max=None)) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["reaped_orphan_runs"] == [8819, 9213]
    assert payload["released_orphan_claims"] == ["t_a", "t_b"]


def test_ops_plain_summary_carries_both_counters(conn, monkeypatch, capsys):
    res = kb.DispatchResult()
    res.reaped_orphan_runs = [8819]
    res.released_orphan_claims = ["t_a"]
    monkeypatch.setattr(kbd, "dispatch_once", lambda *a, **k: res)

    assert kops._cmd_dispatch(argparse.Namespace(dry_run=False, json=False, max=None)) == 0
    out = capsys.readouterr().out
    assert "Reaped ghost runs: 8819" in out
    assert "Released orphan claims: t_a" in out
