"""The comparison a check produced, parked for the sync it was made for.

WHAT THIS FIXES. `POST /bgg/check` spends ten to forty seconds on eight
throttled BoardGameGeek reads, plus up to eight more resolving collids, to
build one ComparePlan. Both sync buttons then used to throw it away and do the
work again: `POST /bgg/push` re-ran `build_plan` from scratch, and
`POST /bgg/sync` re-swept the same collection inside `_run_sync`. One button
press, two identical sweeps, and the user watching the same checklist crawl
past a second time for a comparison they had just been shown.

So the check parks its result here and both syncs read it back.

WHY IN-PROCESS AND NOT A TABLE — the same argument bgg_progress makes: the
sweep is in-handler work that dies with the request that ran it, so a durable
row would outlive the only thing that could vouch for it. A miss here is not a
failure either; both callers fall back to sweeping, which is exactly what they
did before this module existed.

WHAT EACH CALLER TAKES, and why they are not the same thing:

  * The PUSH takes the PLAN — a reviewed list of writes against somebody's real
    BoardGameGeek account. It is handed back only when `checked_at` matches the
    comparison the user actually looked at, because a plan they did not approve
    is not the one to send. The client still cannot dictate the list: it names
    a timestamp, and the server answers with its own stored plan or with
    nothing.
  * The PULL takes the SWEEP — the raw collection items. Those are data, not a
    decision: a read of BGG from the same few minutes is the same read
    `_run_sync` would go and make. No stamp match needed.

READING CONSUMES. Both callers pop. A plan is spent the moment it is acted on
— the FE drops its copy of the diff for the same reason — and the next run
deserves a fresh look at an account that has just been written to.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

import cache

from ..bgg_collection_read import BggCollectionItem
from .bgg_compare_service import ComparePlan

logger = logging.getLogger(__name__)

_NS = "bgg.check.plan"

# Matches DIFF_MAX_AGE_MS in web/domain/bgg-sync-flow.js. The frontend already
# refuses to offer a comparison older than five minutes; a server that held one
# longer would only be keeping something no screen can reach.
_TTL_SECONDS = 300.0

# How far apart the client's `checked_at` and the stored one may be and still
# be the same comparison. They come from the same server-side value round-
# tripped through JSON, so this only absorbs sub-second serialisation drift.
_STAMP_TOLERANCE = timedelta(seconds=1)

# One entry per user, and a check 409s while another check, an import or a push
# is running, so a user can only ever hold one.
cache.configure(_NS, max_entries=500)


@dataclass(frozen=True)
class CachedCheck:
    """One finished comparison: when it was taken, what it decided, what it saw."""
    checked_at: datetime
    plan: ComparePlan


def store(user_id: str, *, checked_at: datetime, plan: ComparePlan) -> None:
    """Park a finished comparison for the sync the user is about to choose."""
    cache.set(_NS, user_id, CachedCheck(checked_at=checked_at, plan=plan), _TTL_SECONDS)


def peek(user_id: str) -> Optional[CachedCheck]:
    """The stored comparison without consuming it. For logging and tests."""
    return cache.get(_NS, user_id)


def invalidate(user_id: str) -> None:
    """Forget the stored comparison. Safe when there is nothing stored."""
    cache.delete(_NS, user_id)


def pop_plan(user_id: str, *, checked_at: Optional[datetime]) -> Optional[ComparePlan]:
    """The plan the user reviewed, or None if we cannot prove it is that one.

    None means "go and sweep": no stored plan, or one whose stamp does not
    match what the client says it reviewed. Never a guess — a mismatched stamp
    is the case where re-planning is exactly the right answer.
    """
    entry: Optional[CachedCheck] = cache.get(_NS, user_id)
    if entry is None:
        return None
    if checked_at is None:
        logger.info("BGG push: client named no comparison for user=%s; re-planning", user_id)
        return None
    if abs(entry.checked_at - checked_at) > _STAMP_TOLERANCE:
        logger.info(
            "BGG push: stored comparison %s is not the reviewed one %s for user=%s; re-planning",
            entry.checked_at.isoformat(), checked_at.isoformat(), user_id,
        )
        return None
    cache.delete(_NS, user_id)
    return entry.plan


def pop_sweep(user_id: str) -> Optional[list[BggCollectionItem]]:
    """The collection items the last check read, or None to go and read them.

    A sweep that ran out of warm-up retries is never handed back: it returned
    ZERO items for at least one batch, which an import would write as a
    collection that has shrunk.
    """
    entry: Optional[CachedCheck] = cache.get(_NS, user_id)
    if entry is None:
        return None
    if entry.plan.warm_up_failed:
        logger.info("BGG import: stored sweep for user=%s is partial; re-reading", user_id)
        return None
    cache.delete(_NS, user_id)
    return entry.plan.remote_items
