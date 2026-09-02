"""Link notifications — "somebody put me in a play".

The list is DERIVED, not stored: `bgb_link_notifications` reads the plays where
the viewer is a player and somebody else is the logger. There is no events
table on purpose — a "you were linked" row would be a second source of truth
about a fact play_players already holds, written by four separate play-write
paths (live save, offline flush, note importer, BGG sync) and correct only if
all four remember. Deriving it also means unlinking empties the list by
construction, and a deleted play takes its entry with it.

What cannot be derived is two timestamps, and migration 008 adds both:
`play_players.linked_at` (when a seat happened — NOT the play's created_at,
because linking a ghost to an account retroactively re-seats plays that are
years old) and `profiles.link_notifications_seen_at` (how far the viewer has
read).
"""

from datetime import datetime

from ..models import (
    LinkNotification,
    LinkNotificationsResponse,
    LinkNotificationsSeenResponse,
)


def list_notifications(
    sb,
    viewer_id: str,
    limit: int = 20,
    before: datetime | None = None,
) -> LinkNotificationsResponse:
    """One page of entries, newest first, plus the account-wide unread total.

    Two round trips rather than one: the page and the unread count. The count
    is not derivable from the page — it spans everything the account has, and
    it feeds the header bell, which must be right before anything is scrolled.
    """
    rows = (
        sb.rpc(
            "bgb_link_notifications",
            {
                "p_viewer": viewer_id,
                "p_limit": limit,
                "p_before": before.isoformat() if before else None,
            },
        )
        .execute()
        .data
        or []
    )

    items = [LinkNotification.model_validate(r) for r in rows]

    # A short page is the end of the list. Paging on the oldest linked_at we
    # returned rather than an offset, because rows disappear as the user
    # unlinks and an offset would skip whatever slid up into the gap.
    next_cursor = items[-1].linked_at if len(items) == limit and items else None

    return LinkNotificationsResponse(
        items=items,
        next_cursor=next_cursor,
        unread=unread_count(sb, viewer_id),
    )


def unread_count(sb, viewer_id: str) -> int:
    """Entries linked since the watermark. Counts acts, not plays."""
    res = sb.rpc("bgb_link_notifications_unread", {"p_viewer": viewer_id}).execute()
    return int(res.data or 0)


def mark_seen(
    sb, viewer_id: str, through: datetime | None = None
) -> LinkNotificationsSeenResponse:
    """Advance the watermark to `through` (default now), monotonically.

    The RPC does the GREATEST, so a retry with a stale value cannot walk the
    watermark backwards and re-light the bell over notifications already read.
    """
    res = sb.rpc(
        "bgb_mark_link_notifications_seen",
        {
            "p_viewer": viewer_id,
            "p_through": through.isoformat() if through else None,
        },
    ).execute()
    return LinkNotificationsSeenResponse(
        seen_at=res.data,
        unread=unread_count(sb, viewer_id),
    )
