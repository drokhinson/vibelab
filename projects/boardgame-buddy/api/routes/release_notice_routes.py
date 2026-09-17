"""Release notices — the what's-new popup, its watermark, and its authoring.

Its own module rather than a corner of admin_routes.py, which says outright
that it exists for the ONE thing spanning domains (the review counts behind the
gear's dot) and nothing else. A release notice is its own object with its own
lifecycle: a list, a per-user watermark, and an authoring surface.

The popup's own delivery is NOT here. The unseen list rides GET /bootstrap,
which runs on every visit — the warm boot path paints from cache and still
calls it in the background — so a second boot endpoint would be a round trip
bought for nothing. What is here is everything else: the archive, the
watermark write, and the eight-route admin surface.

Route ORDER matters, for the reason notification_routes.py and
test_route_ordering.py both spell out. This module declares no top-level
/release-notices/{id}, and its literals (/seen, /admin) are declared before the
parameterised /admin/{notice_id} forms — so nothing here can be shadowed. Keep
it that way if a parameterised route is ever added.

Publish and unpublish are separate POSTs rather than a field on the PATCH so
that `published_at` is never client-supplied, and so the one transition with
user-visible consequences is its own act.
"""

import asyncio

from fastapi import Depends, Path, Query

from db import get_supabase

from . import router
from .constants import ReleaseNoticeStatus
from .dependencies import CurrentUser, get_current_admin, get_current_user
from .models import (
    MessageResponse,
    ReleaseNotice,
    ReleaseNoticeListResponse,
    ReleaseNoticePatchRequest,
    ReleaseNoticesSeenRequest,
    ReleaseNoticesSeenResponse,
    ReleaseNoticeWriteRequest,
)
from .services import release_notice_service


@router.get(
    "/release-notices",
    response_model=ReleaseNoticeListResponse,
    status_code=200,
    summary="Published release notices, newest first",
)
async def list_release_notices(
    _user: CurrentUser = Depends(get_current_user),
) -> ReleaseNoticeListResponse:
    """Everything that has shipped — the Settings "What's new" archive."""
    items = await asyncio.to_thread(release_notice_service.list_published, get_supabase())
    return ReleaseNoticeListResponse(items=items)


@router.post(
    "/release-notices/seen",
    response_model=ReleaseNoticesSeenResponse,
    status_code=200,
    summary="Mark release notices as seen",
)
async def mark_release_notices_seen(
    payload: ReleaseNoticesSeenRequest | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> ReleaseNoticesSeenResponse:
    """Advance the read watermark so the popup does not return."""
    return await asyncio.to_thread(
        release_notice_service.mark_seen,
        get_supabase(),
        user.user_id,
        payload.through if payload else None,
    )


@router.get(
    "/release-notices/admin",
    response_model=ReleaseNoticeListResponse,
    status_code=200,
    summary="Every release notice, draft and published (admin)",
)
async def list_release_notices_admin(
    status: ReleaseNoticeStatus = Query(
        ReleaseNoticeStatus.ALL,
        description="Which notices to list: all, drafts only, or published only.",
    ),
    _admin: CurrentUser = Depends(get_current_admin),
) -> ReleaseNoticeListResponse:
    """Admin-only: the authoring list, drafts first."""
    items = await asyncio.to_thread(
        release_notice_service.list_all, get_supabase(), status
    )
    return ReleaseNoticeListResponse(items=items)


@router.post(
    "/release-notices/admin",
    response_model=ReleaseNotice,
    status_code=201,
    summary="Create a release notice draft (admin)",
)
async def create_release_notice(
    payload: ReleaseNoticeWriteRequest,
    admin: CurrentUser = Depends(get_current_admin),
) -> ReleaseNotice:
    """Admin-only: write a notice. It stays a draft until it is published."""
    return await asyncio.to_thread(
        release_notice_service.create, get_supabase(), admin.user_id, payload
    )


@router.post(
    "/release-notices/admin/{notice_id}/publish",
    response_model=ReleaseNotice,
    status_code=200,
    summary="Publish a release notice (admin)",
)
async def publish_release_notice(
    notice_id: str = Path(..., description="The notice to publish."),
    _admin: CurrentUser = Depends(get_current_admin),
) -> ReleaseNotice:
    """Admin-only: stamp the notice live so it reaches everyone's next visit."""
    return await asyncio.to_thread(
        release_notice_service.set_published, get_supabase(), notice_id, True
    )


@router.post(
    "/release-notices/admin/{notice_id}/unpublish",
    response_model=ReleaseNotice,
    status_code=200,
    summary="Unpublish a release notice (admin)",
)
async def unpublish_release_notice(
    notice_id: str = Path(..., description="The notice to pull back to a draft."),
    _admin: CurrentUser = Depends(get_current_admin),
) -> ReleaseNotice:
    """Admin-only: hide a notice from anyone who has not already seen it."""
    return await asyncio.to_thread(
        release_notice_service.set_published, get_supabase(), notice_id, False
    )


@router.patch(
    "/release-notices/admin/{notice_id}",
    response_model=ReleaseNotice,
    status_code=200,
    summary="Edit a release notice (admin)",
)
async def update_release_notice(
    payload: ReleaseNoticePatchRequest,
    notice_id: str = Path(..., description="The notice to edit."),
    _admin: CurrentUser = Depends(get_current_admin),
) -> ReleaseNotice:
    """Admin-only: change a notice's copy or its link, published or not."""
    return await asyncio.to_thread(
        release_notice_service.update, get_supabase(), notice_id, payload
    )


@router.delete(
    "/release-notices/admin/{notice_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a release notice (admin)",
)
async def delete_release_notice(
    notice_id: str = Path(..., description="The notice to delete."),
    _admin: CurrentUser = Depends(get_current_admin),
) -> MessageResponse:
    """Admin-only: remove a notice. Anyone who already saw it keeps having seen it."""
    await asyncio.to_thread(release_notice_service.delete, get_supabase(), notice_id)
    return MessageResponse(message="Release notice deleted")
