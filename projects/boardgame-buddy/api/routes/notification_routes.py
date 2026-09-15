"""Notification endpoints — the things that happened TO you.

Its own module rather than three more routes on play_routes.py, which is
already well past the ~300-line ceiling: this is its own object with its own
lifecycle (a list, a watermark, a bulk write), and it happens to read plays the
way the feed does and buddy edges the way the Buddies screen does.

Route ORDER matters here for the same reason it does in ghost_claim_routes.py:
/notifications/seen and /unlink are declared as literal paths and nothing in
this module matches /notifications/{something}, so they cannot be shadowed —
keep it that way if a parameterised route is ever added.

The unlink lives here rather than beside POST /plays/{id}/leave because it is
this screen's action, keyed by a set of play ids rather than by one play in a
path. Both go through the same service function and the same RPC; what differs
is the error contract. The single-play route 404s an unknown play and 400s one
you logged yourself, because the play-detail popup shows those to the user. A
batch cannot do that — a set of sixty ids can legitimately contain a few that
are already unlinked — so it reports a count instead and lets the client
reconcile.

The feed's OTHER two kinds have no write of their own here on purpose. A buddy
request is answered through POST /buddies/{id}/accept and /reject, which the
Buddies screen already calls; a notification row simply carries `edge_id` so it
can call the same two. One destination, one pair of routes.
"""

import asyncio
from datetime import datetime

from fastapi import Depends, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    LinkUnlinkRequest,
    NotificationsResponse,
    NotificationsSeenRequest,
    NotificationsSeenResponse,
    PlayLeaveResponse,
)
from .services import notification_service, played_with_service


@router.get(
    "/notifications",
    response_model=NotificationsResponse,
    status_code=200,
    summary="Plays you were added to, buddy requests, and requests accepted",
)
async def list_notifications(
    limit: int = Query(20, ge=1, le=100, description="Max entries to return"),
    before: datetime | None = Query(
        None, description="Keyset cursor: return entries older than this occurred_at"
    ),
    before_key: str | None = Query(
        None,
        description=(
            "Keyset tiebreak: the entry_key of the last row on the previous "
            "page. Required alongside `before` to page correctly when several "
            "notifications share a timestamp."
        ),
    ),
    user: CurrentUser = Depends(get_current_user),
) -> NotificationsResponse:
    """One page of the merged feed plus the account's unread total. Empty is normal."""
    return await notification_service.list_notifications(
        get_supabase(), user.user_id, limit=limit, before=before, before_key=before_key
    )


@router.post(
    "/notifications/seen",
    response_model=NotificationsSeenResponse,
    status_code=200,
    summary="Mark every notification as seen",
)
async def mark_notifications_seen(
    payload: NotificationsSeenRequest | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> NotificationsSeenResponse:
    """Advance the read watermark, clearing the header bell's dot."""
    # One thread for the pair, not two: the recount has to see the watermark
    # this call just wrote, so unlike the GET's two reads these cannot overlap.
    # Off the event loop all the same — see list_notifications' docstring.
    return await asyncio.to_thread(
        notification_service.mark_seen,
        get_supabase(),
        user.user_id,
        payload.through if payload else None,
    )


@router.post(
    "/notifications/unlink",
    response_model=PlayLeaveResponse,
    status_code=200,
    summary="Remove yourself from several plays at once",
)
async def unlink_from_plays(
    payload: LinkUnlinkRequest,
    user: CurrentUser = Depends(get_current_user),
) -> PlayLeaveResponse:
    """Turn your seat on each named play, run or import into a named ghost."""
    n = await asyncio.to_thread(
        lambda: played_with_service.ghost_out_of_plays(
            get_supabase(),
            user.user_id,
            play_ids=payload.play_ids,
            group_ids=payload.import_group_ids,
            batch_ids=payload.import_batch_ids,
        )
    )
    return PlayLeaveResponse(rows_updated=n)
