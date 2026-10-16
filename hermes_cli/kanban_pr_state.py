"""GitHub PR state probes for the dispatcher's ``active_pr`` respawn guard.

Topical sibling of ``kanban_db_dispatch`` (facade + siblings layout): the
dispatcher decides *when* to probe — only on the ``active_pr`` hold path, per
held card — while this module owns *how*: URL parsing, per-PR state lookup
with a process cache and a short subprocess timeout, and the fail-closed
release verdict (t_ebaaee1c: a merged/closed PR must release the hold without
a handoff event, while any open or unknown linked PR keeps it).

Failure semantics are deliberately one-directional: without network proof
that a PR is terminal, the verdict is "not terminal" (the hold stands).
Release requires evidence; doubt never releases.
"""

from __future__ import annotations

import re
import subprocess
import time
from typing import Optional

# Identical in shape to ``kanban_db_dispatch._RESPAWN_GUARD_PR_URL_RE`` — the
# dispatcher's comment anchor check and the URL extraction here must agree
# exactly (pinned by test_kanban_active_pr_release.py). Matching is
# case-insensitive; owner/repo are normalized to lowercase for dedup/lookup.
PR_URL_RE = re.compile(
    r"https?://github\.com/[^/\s]+/[^/\s]+/pull/\d+",
    re.IGNORECASE,
)

# Per-URL process cache TTL (B3): a held card pays at most one probe per PR
# per TTL window per dispatcher process. Failed probes cache for a SHORTER
# window (Gate-A build note on PLAN-t_ebaaee1c): an outage must not turn
# every tick into a timeout-shaped stall, but must also not suppress a real
# state change for the full success window.
_PR_STATE_CACHE_TTL = 300.0  # seconds, successful probes
_PR_STATE_NEGATIVE_TTL = 60.0  # seconds, failed probes

# Subprocess timeout (B3: 2-3 s) — fail closed when GitHub does not answer.
_PR_STATE_PROBE_TIMEOUT = 2.5

_TERMINAL = "closed"
_OPEN = "open"
_ERROR = "error"

# (owner, repo, number) -> (monotonic checked_at, "closed" | "open" | "error")
_STATE_CACHE: dict[tuple[str, str, int], tuple[float, str]] = {}


def parse_pr_urls(text: Optional[str]) -> list[tuple[str, str, int]]:
    """Extract deduplicated ``(owner, repo, number)`` triples from PR URLs.

    Pure parser (no I/O, no config): the same PR linked twice — in any
    owner/repo casing — counts once. The regex guarantees the URL shape, so
    every match parses.
    """
    triples: list[tuple[str, str, int]] = []
    seen: set[tuple[str, str, int]] = set()
    for match in PR_URL_RE.finditer(text or ""):
        # "https://github.com/<owner>/<repo>/pull/<digits>" -> five segments
        # after the "scheme://" split, all of them fixed by the regex.
        _host, owner, repo, _pull, number_raw = match.group(0).split("//", 1)[1].split("/")
        key = (owner.lower(), repo.lower(), int(number_raw))
        if key not in seen:
            seen.add(key)
            triples.append(key)
    return triples


def _fetch_pr_state(owner: str, repo: str, number: int) -> Optional[str]:
    """Transport seam for ONE PR: its state string, or ``None``/raise.

    The seam signals "unknown" either by returning ``None`` or by raising —
    :func:`probe_pr_state` maps both to the fail-closed ``"error"`` state.
    Unknown covers no ``gh``, no auth, timeout, API error and unexpected
    payloads. Subprocess shape follows ``kanban_pr_acceptance._api``; stderr
    is captured but never persisted (it can carry credential/host details).
    Tests monkeypatch this module attribute instead of hitting the network.
    """
    command = [
        "gh", "api", f"repos/{owner}/{repo}/pulls/{number}",
        "--hostname", "github.com", "--jq", ".state",
    ]
    result = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=_PR_STATE_PROBE_TIMEOUT,
        check=False,
    )
    if result.returncode != 0:
        return None
    state = (result.stdout or "").strip().lower()
    return state if state in (_OPEN, _TERMINAL) else None


def _ttl_for(state: str) -> float:
    return _PR_STATE_NEGATIVE_TTL if state == _ERROR else _PR_STATE_CACHE_TTL


def probe_pr_state(owner: str, repo: str, number: int) -> str:
    """Cached single-PR state: ``"closed"``, ``"open"`` or ``"error"``."""
    now = time.monotonic()
    key = (owner, repo, number)
    cached = _STATE_CACHE.get(key)
    if cached is not None and (now - cached[0]) < _ttl_for(cached[1]):
        return cached[1]
    try:
        fetched = _fetch_pr_state(owner, repo, number)
    except Exception:  # a raising transport seam is "unknown", never evidence
        fetched = None
    state = fetched if fetched is not None else _ERROR
    _STATE_CACHE[key] = (now, state)
    return state


def all_prs_terminal(urls: list[tuple[str, str, int]]) -> bool:
    """True only when EVERY linked PR is provably MERGED or CLOSED.

    Vacuously True for an empty list (nothing open left to duplicate); False
    for any open PR, any probe failure and any unknown state. The dispatcher
    calls this only on the ``active_pr`` hold path, so a False simply keeps
    the existing hold (fail closed, R3 of PLAN-t_ebaaee1c).
    """
    for owner, repo, number in urls:
        if probe_pr_state(owner, repo, number) != _TERMINAL:
            return False
    return True


def clear_state_cache() -> None:
    """Drop every cached PR state (process-global cache hygiene for tests)."""
    _STATE_CACHE.clear()
