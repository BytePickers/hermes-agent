"""active_pr release tests: re-queue events and terminal PR state lift the hold.

The respawn guard holds a ready card when a GitHub PR URL appears in a recent
comment (duplicate-PR protection, #111910). Two release paths are pinned here
(PLAN-t_ebaaee1c, approved by Gate A):

* R1 — an explicit re-queue event (status/promoted/unblocked/reclaimed)
  STRICTLY after the newest PR comment is a deliberate "run it again" order
  (content of upstream PRs #162/#163). Same-second ties stay fail-closed.
* R2 — when EVERY PR linked in the window is already merged/closed (probed
  via ``kanban_pr_state``, cached, short timeout) the hold releases; any open
  or unknown PR keeps it (fail closed, R3).

The pre-existing handoff release (#111910) must keep working unchanged, and
the dispatcher's default_assignee write must never release the hold.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli import kanban_db_dispatch as kbd
from hermes_cli import kanban_pr_state as kps


@pytest.fixture
def kanban_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated HERMES_HOME with an empty kanban DB."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture(autouse=True)
def _isolated_pr_state_cache():
    """The probe cache is process-global — no PR state may leak between tests."""
    kps.clear_state_cache()
    yield
    kps.clear_state_cache()


def _patch_probe(
    monkeypatch: pytest.MonkeyPatch,
    states: dict[int, str | None] | str | None,
) -> list[tuple[str, str, int]]:
    """Replace the single-PR transport seam (no network) and count calls.

    ``states`` maps PR number -> probe result ("closed"/"open") or None for a
    failed probe; a bare value applies to every PR. Unknown numbers fail.
    """
    calls: list[tuple[str, str, int]] = []

    def _fake(owner: str, repo: str, number: int) -> str | None:
        calls.append((owner, repo, number))
        if isinstance(states, dict):
            return states.get(number)
        return states

    monkeypatch.setattr(kps, "_fetch_pr_state", _fake)
    return calls


def _patch_dispatch_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Spawnable profiles + default config, as in the review-lifecycle suite."""
    import hermes_cli.config as cfgmod
    import hermes_cli.profiles as profmod

    monkeypatch.setattr(profmod, "profile_exists", lambda name: True)
    monkeypatch.setattr(cfgmod, "load_config", lambda *a, **k: {})


def _ready_card_with_pr(
    conn,
    title: str,
    pr_numbers: list[int],
    *,
    comment_at: int | None = None,
    author: str = "worker",
) -> str:
    """Ready card whose PR-URL comment is pinned to ``comment_at`` (epoch s)."""
    body = " ".join(
        f"https://github.com/example/repo/pull/{n}" for n in pr_numbers
    )
    tid = kb.create_task(conn, title=title, assignee="worker")
    kb.add_comment(conn, tid, author=author, body=body)
    if comment_at is not None:
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE task_comments SET created_at = ? WHERE task_id = ?",
                (comment_at, tid),
            )
    return tid


def _append_event(
    conn,
    tid: str,
    kind: str,
    *,
    created_at: int,
    payload: dict | None = None,
) -> None:
    with kb.write_txn(conn):
        conn.execute(
            "INSERT INTO task_events (task_id, kind, payload, created_at) "
            "VALUES (?, ?, ?, ?)",
            (
                tid,
                kind,
                json.dumps(payload) if payload is not None else None,
                created_at,
            ),
        )


# ---------------------------------------------------------------------------
# R1 — re-queue release (#162/#163)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", sorted(kbd._RESPAWN_GUARD_REQUEUE_KINDS))
def test_each_requeue_kind_releases_after_pr_comment(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """Every re-queue kind strictly after the newest PR comment releases."""
    _patch_probe(monkeypatch, "open")
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, f"requeued via {kind}", [101], comment_at=now - 60)
        _append_event(conn, tid, kind, created_at=now - 59)
        assert kbd.check_respawn_guard(conn, tid) is None


def test_requeue_release_spawns_and_pays_no_probe(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T1: the re-queue-released card lands in the spawned bucket — and the
    release happens BEFORE any state probe (B3: the event path is free)."""
    _patch_dispatch_env(monkeypatch)
    calls = _patch_probe(monkeypatch, "open")
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "requeued after pr", [102], comment_at=now - 60)
        _append_event(conn, tid, "unblocked", created_at=now - 59)
        assert kbd.check_respawn_guard(conn, tid) is None
        res = kbd.dispatch_once(conn, dry_run=True)
        assert tid in [s[0] for s in res.spawned]
        assert calls == []


def test_same_second_requeue_tie_stays_guarded(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T2: a re-queue event in the SAME second as the PR comment does not
    release — ``created_at > ?`` is strict (fail-closed tie, #163 semantics)."""
    _patch_probe(monkeypatch, "open")
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "tie", [103], comment_at=now - 60)
        _append_event(conn, tid, "unblocked", created_at=now - 60)
        assert kbd.check_respawn_guard(conn, tid) == "active_pr"


def test_pr_comment_without_followup_stays_guarded(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T3 baseline: a PR comment alone holds the card (probe says open)."""
    _patch_probe(monkeypatch, "open")
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "open pr", [104], comment_at=now - 60)
        assert kbd.check_respawn_guard(conn, tid) == "active_pr"


def test_default_assignee_write_after_pr_comment_stays_guarded(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T4: the dispatcher's default_assignee ``assigned`` event is neither a
    handoff (source guard) nor a re-queue — it must not release."""
    _patch_probe(monkeypatch, "open")
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "default assignee", [105], comment_at=now - 60)
        _append_event(
            conn,
            tid,
            "assigned",
            payload={
                "source": "kanban.default_assignee",
                "assignee": "worker",
                "from": "operator",
            },
            created_at=now - 59,
        )
        assert kbd.check_respawn_guard(conn, tid) == "active_pr"


# ---------------------------------------------------------------------------
# R2/R3 — state-based release, fail closed
# ---------------------------------------------------------------------------


def test_all_linked_prs_terminal_releases(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T5/R2: when EVERY PR linked on the card is merged/closed, a fresh run
    cannot duplicate open work — the hold releases without any handoff."""
    _patch_dispatch_env(monkeypatch)
    calls = _patch_probe(monkeypatch, {51: "closed", 52: "closed"})
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "both merged", [51, 52], comment_at=now - 60)
        assert kbd.check_respawn_guard(conn, tid) is None
        res = kbd.dispatch_once(conn, dry_run=True)
        assert tid in [s[0] for s in res.spawned]
        assert sorted(number for _, _, number in calls) == [51, 52]


def test_one_open_linked_pr_keeps_guard_across_comments(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T6/B2: two linked PRs across two comments, one still open -> held.
    URLs from ALL window comments count — not only the newest comment's."""
    _patch_probe(monkeypatch, {61: "open", 62: "closed"})
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "one still open", [62], comment_at=now - 120)
        kb.add_comment(
            conn, tid, author="worker",
            body="also https://github.com/example/repo/pull/61",
        )
        assert kbd.check_respawn_guard(conn, tid) == "active_pr"


def test_probe_failure_keeps_guard_fail_closed(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T7/R3: an errored probe is NO proof — the hold stands. Also covers the
    transport's exception mapping (a timeout at the seam must not escape)."""
    _patch_probe(monkeypatch, {71: None})
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "probe fails", [71], comment_at=now - 60)
        assert kbd.check_respawn_guard(conn, tid) == "active_pr"

    def _boom(owner: str, repo: str, number: int) -> str | None:
        raise subprocess.TimeoutExpired(cmd="gh", timeout=2.5)

    monkeypatch.setattr(kps, "_fetch_pr_state", _boom)
    now2 = int(time.time())
    with kbc.connect() as conn:
        tid2 = _ready_card_with_pr(conn, "probe times out", [72], comment_at=now2 - 60)
        assert kbd.check_respawn_guard(conn, tid2) == "active_pr"


def test_url_less_comments_after_merged_pr_do_not_re_anchor(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T8: a merged PR's hold releases even when later URL-less comments exist
    — only PR-URL comments anchor the guard (URL regex window)."""
    _patch_probe(monkeypatch, {81: "closed"})
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "merged, then chatter", [81], comment_at=now - 600)
        kb.add_comment(conn, tid, author="worker", body="progress update, no links")
        kb.add_comment(conn, tid, author="worker", body="still going")
        assert kbd.check_respawn_guard(conn, tid) is None


# ---------------------------------------------------------------------------
# Regression — existing release paths untouched
# ---------------------------------------------------------------------------


def test_real_handoff_release_unchanged(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T9: the pre-existing #111910 handoff release must survive — a real
    from≠to assignment after the PR comment still lifts the guard, free of
    probes."""
    _patch_dispatch_env(monkeypatch)
    calls = _patch_probe(monkeypatch, "open")
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "handed off", [44], comment_at=now - 60)
        assert kb.assign_task(conn, tid, "closer") is True
        assert kbd.check_respawn_guard(conn, tid) is None
        assert calls == []


# ---------------------------------------------------------------------------
# Cache behaviour (B3 + Gate-A build note)
# ---------------------------------------------------------------------------


def test_probe_cache_within_ttl_no_repeat(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T10: a second guard call within the cache TTL does not re-probe."""
    calls = _patch_probe(monkeypatch, {91: "closed"})
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "cache hit", [91], comment_at=now - 60)
        assert kbd.check_respawn_guard(conn, tid) is None
        assert kbd.check_respawn_guard(conn, tid) is None
    assert len(calls) == 1


def test_failed_probe_negative_cache_shorter_ttl(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Gate-A build note: failed probes cache for the SHORTER negative TTL —
    an outage must not re-pay the timeout every tick, yet must not suppress a
    real state change for the full success window."""
    calls = _patch_probe(monkeypatch, {92: None})
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "negative cache", [92], comment_at=now - 60)
        assert kbd.check_respawn_guard(conn, tid) == "active_pr"
        assert kbd.check_respawn_guard(conn, tid) == "active_pr"
    assert len(calls) == 1  # second call served from the negative cache


def test_cache_expires_after_ttl(
    kanban_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TTL expiry actually expires: advancing the clock past the window
    re-probes instead of serving the cached verdict forever."""
    clock = SimpleNamespace(t=1_000_000.0)
    monkeypatch.setattr(kps, "time", SimpleNamespace(monotonic=lambda: clock.t))
    calls = _patch_probe(monkeypatch, {93: "closed"})
    now = int(time.time())
    with kbc.connect() as conn:
        tid = _ready_card_with_pr(conn, "ttl expiry", [93], comment_at=now - 60)
        assert kbd.check_respawn_guard(conn, tid) is None
        assert len(calls) == 1
        clock.t += kps._PR_STATE_CACHE_TTL + 1
        assert kbd.check_respawn_guard(conn, tid) is None
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# Parser + regex identity contract
# ---------------------------------------------------------------------------


def test_parse_pr_urls_dedups_case_and_trailing_punctuation() -> None:
    text = (
        "See https://github.com/Example/Repo/pull/7, then "
        "https://github.com/example/repo/pull/7 and "
        "https://github.com/example/repo/pull/12."
    )
    assert kps.parse_pr_urls(text) == [("example", "repo", 7), ("example", "repo", 12)]


def test_parse_pr_urls_without_urls_is_empty() -> None:
    assert kps.parse_pr_urls("no links here") == []
    assert kps.parse_pr_urls(None) == []


def test_all_prs_terminal_vacuously_true_for_empty_list() -> None:
    """No linked PR -> nothing open to duplicate (the dispatcher never calls
    this with an empty list; the contract is still pinned)."""
    assert kps.all_prs_terminal([]) is True


def test_url_regex_matches_dispatcher_anchor_regex() -> None:
    """The dispatcher's comment anchor check and the sibling's URL extraction
    must agree exactly: a comment that anchors the guard always yields at
    least one parseable PR, and vice versa."""
    samples = [
        "Opened https://github.com/example/repo/pull/44 for review.",
        "HTTPS://GITHUB.COM/Example/Repo/Pull/7 trailing.",
        "two: https://github.com/a/b/pull/1 https://github.com/c/d/pull/2",
        "not a pr: https://github.com/example/repo/issues/9",
        "no url at all",
    ]
    for text in samples:
        assert (
            [m.group(0) for m in kbd._RESPAWN_GUARD_PR_URL_RE.finditer(text)]
            == [m.group(0) for m in kps.PR_URL_RE.finditer(text)]
        )
