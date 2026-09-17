"""The play history a sync read, parked for the importer it hands the user to.

WHAT THIS FIXES. `POST /bgg/sync` walks every page of BGG's `/plays` to count
what BgB is missing, and then its done screen offers "Import N plays" straight
into the importer — which would otherwise walk every one of those pages again,
throttled, while the user sits on a loading step watching a read that finished
thirty seconds ago. So the sync parks what it read and the importer reads it
back.

TWO THINGS SEPARATE THIS FROM bgg_check_cache, and both are deliberate:

  * IT IS PEEKED, NOT POPPED. A check's plan is a DECISION, spent the moment
    it is acted on. This is DATA. The path into the importer is a real loop —
    pick a source, back out, come back, refresh mid-wizard — and popping would
    make the second visit pay the full page walk for no reason. The TTL is what
    ends the entry's life, not the first reader.

  * ONLY THE RAW READ IS CACHED, never the "not in BgB yet" filter over it.
    That filter runs live against the database on every request, so a play the
    importer just wrote is gone from the next preview even when the BGG bytes
    are reused. Caching the filtered list would offer the user plays they have
    already imported, which is the exact bug the whole dedup story exists to
    prevent.

A read that ran out of warm-up retries is never stored. It returned nothing for
a history that may well be full, and an importer told "nothing new" about that
is worse than one that spends the requests.

WHY IN-PROCESS AND NOT A TABLE — the same argument bgg_check_cache and
bgg_progress make: this is in-handler work that dies with the request that ran
it, and a miss is not a failure. The importer falls back to reading BGG itself,
which is what it would have done if this module did not exist.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime


import cache

logger = logging.getLogger(__name__)

_NS = "bgg.plays.read"

# Matches bgg_check_cache: long enough to cover a user reading a done screen and
# tapping through to the importer, short enough that a BoardGameGeek account
# which has moved is re-read rather than described from memory.
_TTL_SECONDS = 300.0

# One entry per user, and both the sync and the preview 409 while another BGG
# job is running, so a user can only ever hold one.
cache.configure(_NS, max_entries=500)


@dataclass(frozen=True)
class CachedPlays:
    """One finished /plays walk: when it was taken and every row it parsed."""
    fetched_at: datetime
    plays: list[dict]


def store(user_id: str, *, fetched_at: datetime, plays: list[dict]) -> None:
    """Park a finished read for the importer the user is about to be offered."""
    cache.set(
        _NS, user_id,
        CachedPlays(fetched_at=fetched_at, plays=plays),
        _TTL_SECONDS,
    )


def peek(user_id: str) -> CachedPlays | None:
    """The stored read, WITHOUT consuming it — see the header.

    None means "go and read BGG", which is always a correct answer here.
    """
    return cache.get(_NS, user_id)


def invalidate(user_id: str) -> None:
    """Forget the stored read. Safe when there is nothing stored."""
    cache.delete(_NS, user_id)
