"""Kanban claim drain shutdown phase for GatewayRunner.

Split out of ``gateway/run_shutdown.py``; bound onto ``GatewayRunner`` via
``GatewayShutdownMixin``. Best-effort by contract: a failure here must never
break teardown.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from gateway.run_shutdown import GatewayShutdownMixin

logger = logging.getLogger("gateway.run")


class GatewayKanbanDrainMixin:
    """Drains this gateway's kanban claims between finalize and runtime release."""

    async def _stop_drain_kanban_claims(self, ctx: "GatewayShutdownMixin._StopContext") -> None:
        """Drain this gateway's kanban claims before the exit state persists.

        The process is going away; its claims (``claim_lock == host:<pid>``)
        would otherwise outlive it as ghost ``running`` rows until the claim
        TTL reclaims them as failures — inflating the capacity count and
        tripping the failure breaker after a rollover. Booked here instead,
        once, between agent finalization and runtime release: every agent
        work item is done by this point, so any remaining own claim is
        genuinely ownerless. Pure board bookkeeping on the board DBs' own
        connections (independent of the session DBs closed later) — claims
        with a live worker are skipped, nothing is signalled.
        """
        from gateway.run import GatewayRunner

        def _drain_all_boards() -> int:
            from gateway.kanban_watchers_common import _board_slugs
            from hermes_cli import kanban_db as _kb
            from hermes_cli import kanban_db_connect as _kbc

            total = 0
            for slug in _board_slugs(_kb):
                conn = None
                try:
                    conn = _kbc.connect(board=slug)
                    total += _kb.drain_claims_on_shutdown(conn, reason="gateway_shutdown")
                except Exception:
                    logger.warning(
                        "Shutdown phase: kanban claim drain failed on board %s", slug, exc_info=True,
                    )
                finally:
                    if conn is not None:
                        with suppress(Exception):
                            conn.close()
            return total

        try:
            drained = await asyncio.to_thread(_drain_all_boards)
            if drained:
                logger.info(
                    "Shutdown phase: kanban claim drain requeued %d claim(s) at +%.2fs",
                    drained, ctx.elapsed(),
                )
        except Exception:
            logger.exception("Shutdown phase: kanban claim drain failed (continuing teardown)")
