"""Link notification endpoints — "somebody put me in a play".

Its own module rather than three more routes on play_routes.py, which is
already well past the ~300-line ceiling: this is its own object with its own
lifecycle (a list, a watermark, a bulk write), and it happens to read plays the
way the feed does.

Route ORDER matters here for the same reason it does in ghost_claim_routes.py:
/link-notifications/seen and /unlink are declared as literal paths and nothing
in this module matches /link-notifications/{something}, so they cannot be
shadowed — keep it that way if a parameterised route is ever added.

The unlink lives here rather than beside POST /plays/{id}/leave because it is
this screen's action, keyed by a set of play ids rather than by one play in a
path. Both go through the same service function and the same RPC; what differs
is the error contract. The single-play route 404s an unknown play and 400s one
you logged yourself, because the play-detail popup shows those to the user. A
batch cannot do that — a set of sixty ids can legitimately contain a few that
are already unlinked — so it reports a count instead and lets the client
reconcile.
"""

from datetime import datetime

from fastapi import Depends, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    LinkNotificationsResponse,
    LinkNotificationsSeenRequest,
    LinkNotificationsSeenResponse,
    LinkUnlinkRequest,
    PlayLeaveResponse,
)
from .services import link_notification_service, played_with_service


@router.get(
    "/link-notifications",
    response_model=LinkNotificationsResponse,
    status_code=200,
    summary="Plays other people have added you to",
)
async def list_link_notifications(
    limit: int = Query(20, ge=1, le=100, description="Max entries to return"),
    before: datetime | None = Query(
        None, description="Keyset cursor: return entries older than this created_at"
    ),
    user: CurrentUser = Depends(get_current_user),
) -> LinkNotificationsResponse:
    """One page of entries plus the account's unread total. Empty is normal."""
    return link_notification_service.list_notifications(
        get_supabase(), user.user_id, limit=limit, before=before
    )


@router.post(
    "/link-notifications/seen",
    response_model=LinkNotificationsSeenResponse,
    status_code=200,
    summary="Mark every link notification as seen",
)
async def mark_link_notifications_seen(
    payload: LinkNotificationsSeenRequest | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> LinkNotificationsSeenResponse:
    """Advance the read watermark, clearing the header bell's dot."""
    return link_notification_service.mark_seen(
        get_supabase(), user.user_id, through=payload.through if payload else None
    )


@router.post(
    "/link-notifications/unlink",
    response_model=PlayLeaveResponse,
    status_code=200,
    summary="Remove yourself from several plays at once",
)
async def unlink_from_plays(
    payload: LinkUnlinkRequest,
    user: CurrentUser = Depends(get_current_user),
) -> PlayLeaveResponse:
    """Turn your seat on each named play, run or import into a named ghost."""
    n = played_with_service.ghost_out_of_plays(
        get_supabase(),
        user.user_id,
        play_ids=payload.play_ids,
        group_ids=payload.import_group_ids,
        batch_ids=payload.import_batch_ids,
    )
    return PlayLeaveResponse(rows_updated=n)
