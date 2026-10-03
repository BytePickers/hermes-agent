"""Kernel-side tests for the optional ``reason`` on ``unblock_task``.

``unblock_task`` writes the ``unblocked`` event. A stated ground (e.g. typed
into the dashboard's unblock prompt and forwarded through the board API) must
land on that event's payload; without one the payload shape stays exactly as
before (``None`` for the plain blocked-from-ready lift).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc


@pytest.fixture
def kanban_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated HERMES_HOME with an empty kanban DB."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _blocked_task(title: str) -> str:
    with kbc.connect() as conn:
        tid = kb.create_task(conn, title=title)
        kb.claim_task(conn, tid)
        assert kb.block_task(
            conn, tid,
            reason="review-required: hold for inspection",
            expected_run_id=kb.get_task(conn, tid).current_run_id,
        )
        assert kb.get_task(conn, tid).status == "blocked"
        return tid


def _last_unblocked_payload(task_id: str):
    with kbc.connect() as conn:
        events = [e for e in kb.list_events(conn, task_id) if e.kind == "unblocked"]
        assert events, "unblocked event missing"
        return events[-1].payload


def test_unblock_with_reason_records_ground_on_event(kanban_home):
    tid = _blocked_task("lift with ground")
    with kbc.connect() as conn:
        assert kb.unblock_task(conn, tid, reason="  operator confirmed the fix  ")
    payload = _last_unblocked_payload(tid)
    assert payload is not None
    assert payload["reason"] == "operator confirmed the fix"


def test_unblock_without_reason_keeps_payload_shape(kanban_home):
    tid = _blocked_task("lift without ground")
    with kbc.connect() as conn:
        assert kb.unblock_task(conn, tid)
    payload = _last_unblocked_payload(tid)
    assert "reason" not in (payload or {})


def test_unblock_blank_reason_treated_as_absent(kanban_home):
    tid = _blocked_task("lift with blank ground")
    with kbc.connect() as conn:
        assert kb.unblock_task(conn, tid, reason="   ")
    payload = _last_unblocked_payload(tid)
    assert "reason" not in (payload or {})
