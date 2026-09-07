"""Notifications — the things that happened TO you.

Three signals share one feed, one cursor and one read watermark: somebody
seated you in a play they logged, somebody asked to be your buddy, somebody
accepted the request you sent.

The list is DERIVED, not stored. `bgb_notifications` reads plays where the
viewer is a player and somebody else is the logger, plus the viewer's own rows
in `bgb_buddy_edges`. There is no events table on purpose — a "you were linked"
row would be a second source of truth about a fact play_players already holds,
written by four separate play-write paths (live save, offline flush, note
importer, BGG sync) and correct only if all four remember, and a "they accepted"
row would duplicate a column the edge already carries. Deriving it also means
each kind empties itself by construction: unlinking drops a play row, and
accepting or declining drops a request row.

What cannot be derived is three facts, and they are the only stored state:
`play_players.linked_at` (when a seat happened — NOT the play's created_at,
because linking a ghost to an account retroactively re-seats plays that are
years old), `profiles.link_notifications_seen_at` (how far the viewer has read,
named for plays but covering all three kinds since migration 009), and
`buddy_edges.accepted_by` (who said yes, which a QR-scanned edge makes
underivable).
"""

import asyncio
from datetime import datetime

from ..models import (
    Notification,
    NotificationsResponse,
    NotificationsSeenResponse,
)


async def list_notifications(
    sb,
    viewer_id: str,
    limit: int = 20,
    before: datetime | None = None,
    before_key: str | None = None,
) -> NotificationsResponse:
    """One page of the merged feed, newest first, plus the account-wide unread
    total.

    Two round trips, but they cost one. The count is not derivable from the page
    — it spans everything the account has, and it feeds the header bell, which
    must be right before anything is scrolled — so both have to happen; what
    they do not have to do is queue behind each other. The supabase client is
    synchronous, so each goes to its own thread and the wall time is the slower
    of the two rather than their sum.

    That threading is also what keeps this endpoint off the event loop.
    Called inline from an `async def` route, a synchronous PostgREST call blocks
    every other in-flight request in the worker for its whole duration — the
    same reasoning bootstrap_routes.py spells out for its own gather.
    """
    rows, unread = await asyncio.gather(
        asyncio.to_thread(fetch_page, sb, viewer_id, limit, before, before_key),
        asyncio.to_thread(unread_count, sb, viewer_id),
    )

    items = [Notification.model_validate(r) for r in rows]

    # A short page is the end of the list. Paging on the last row's
    # (occurred_at, entry_key) rather than an offset, because rows disappear as
    # the user unlinks and answers requests, and an offset would skip whatever
    # slid up into the gap. The key travels with the timestamp because three
    # sources feeding one ordering makes ties ordinary, and a cursor on the
    # timestamp alone drops every row sharing a page boundary.
    full = len(items) == limit and bool(items)
    return NotificationsResponse(
        items=items,
        next_cursor=items[-1].occurred_at if full else None,
        next_cursor_key=items[-1].entry_key if full else None,
        unread=unread,
    )


def fetch_page(
    sb,
    viewer_id: str,
    limit: int = 20,
    before: datetime | None = None,
    before_key: str | None = None,
) -> list[dict]:
    """The raw page rows. Split out so it can be handed to a worker thread."""
    return (
        sb.rpc(
            "bgb_notifications",
            {
                "p_viewer": viewer_id,
                "p_limit": limit,
                "p_before": before.isoformat() if before else None,
                "p_before_key": before_key,
            },
        )
        .execute()
        .data
        or []
    )


def unread_count(sb, viewer_id: str) -> int:
    """Everything unread across all three kinds. Counts play ENTRIES, not plays."""
    res = sb.rpc("bgb_notifications_unread", {"p_viewer": viewer_id}).execute()
    return int(res.data or 0)


def mark_seen(
    sb, viewer_id: str, through: datetime | None = None
) -> NotificationsSeenResponse:
    """Advance the watermark to `through` (default now), monotonically.

    Still the RPC 008 shipped: it writes the watermark and never knew which
    kinds it covered, so covering three needed no change. The RPC does the
    GREATEST, so a retry with a stale value cannot walk the watermark backwards
    and re-light the bell over notifications already read.
    """
    res = sb.rpc(
        "bgb_mark_link_notifications_seen",
        {
            "p_viewer": viewer_id,
            "p_through": through.isoformat() if through else None,
        },
    ).execute()
    return NotificationsSeenResponse(
        seen_at=res.data,
        unread=unread_count(sb, viewer_id),
    )
