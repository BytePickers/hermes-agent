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
