"""Affiliate partner links — retailer pills under a game, and their admin.

Two reader routes, both anon-tolerant like /analytics/track: the links a game
page renders, and the tap count. Six admin routes on get_current_admin: the
list, the click summary, the editor's preview, an edit, and the enable /
disable pair. Enabling is its own POST rather than a PATCH field for the
release-notices reason — the one transition with reader-visible consequences
is its own act — plus one of its own: it can be REFUSED (no credential) and a
refusal belongs on the switch, not buried in a multi-field patch.

Nothing here renders anything until a partner is live; see
services/affiliate_service.py for the rule and Docs/AFFILIATE_LINKS.md for how
an operator makes one so.

Route ORDER within the module: every literal (`/links`, `/click`, `/admin/
partners`, `/admin/clicks`) is declared before the parameterised
`/admin/partners/{partner_id}…` forms, so nothing here can be shadowed.
"""

import asyncio

from fastapi import Depends, Header, Path, Query, Response

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_admin, maybe_supabase_user
from .models import (
    AffiliateClickRequest,
    AffiliateClickSummary,
    AffiliateLinkListResponse,
    AffiliateLinkPreview,
    AffiliatePartner,
    AffiliatePartnerListResponse,
    AffiliatePartnerPatchRequest,
)
from .services import affiliate_service


@router.get(
    "/affiliate/links",
    response_model=AffiliateLinkListResponse,
    status_code=200,
    summary="Where to buy one game — empty until a partner is enabled",
)
async def affiliate_links(
    game_id: str = Query(..., description="Catalog game UUID"),
    authorization: str | None = Header(None),
) -> AffiliateLinkListResponse:
    """One pill per LIVE partner, with the sentence each requires beside it."""
    # Anon-tolerant: a shared game link opens for a stranger, and a pill is
    # the same pill signed in or out. The token is decoded only so a bad one
    # is not silently accepted as "anonymous" elsewhere in the request.
    await maybe_supabase_user(authorization)
    return await asyncio.to_thread(affiliate_service.links_for_game, get_supabase(), game_id)


@router.post(
    "/affiliate/click",
    status_code=204,
    summary="Count a tap on a partner pill (no account identifier)",
)
async def affiliate_click(
    payload: AffiliateClickRequest,
    authorization: str | None = Header(None),
) -> Response:
    """Fire-and-forget from the client; never blocks the outbound navigation."""
    await maybe_supabase_user(authorization)
    await asyncio.to_thread(
        affiliate_service.log_click,
        get_supabase(),
        payload.partner_id,
        payload.game_id,
        payload.surface,
    )
    return Response(status_code=204)


@router.get(
    "/affiliate/admin/partners",
    response_model=AffiliatePartnerListResponse,
    status_code=200,
    summary="Every affiliate partner, live or not (admin)",
)
async def list_affiliate_partners(
    _admin: CurrentUser = Depends(get_current_admin),
) -> AffiliatePartnerListResponse:
    """Admin-only: the editing list, in display order."""
    items = await asyncio.to_thread(affiliate_service.list_all, get_supabase())
    return AffiliatePartnerListResponse(items=items)


@router.get(
    "/affiliate/admin/clicks",
    response_model=AffiliateClickSummary,
    status_code=200,
    summary="Partner tap counts over a window (admin)",
)
async def affiliate_click_summary(
    days: int = Query(30, ge=1, le=365, description="Window in days"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> AffiliateClickSummary:
    """Admin-only: how many taps each partner's pill has taken."""
    return await asyncio.to_thread(affiliate_service.click_summary, get_supabase(), days)


@router.get(
    "/affiliate/admin/partners/{partner_id}/preview",
    response_model=AffiliateLinkPreview,
    status_code=200,
    summary="The URL a partner would produce for a game, live or not (admin)",
)
async def preview_affiliate_partner(
    partner_id: str = Path(..., description="Partner slug"),
    game_id: str | None = Query(None, description="A catalog game to resolve against; a fixed sample when absent"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> AffiliateLinkPreview:
    """Admin-only: what the editor shows so a bad template is caught before enabling."""
    return await asyncio.to_thread(affiliate_service.preview, get_supabase(), partner_id, game_id)


@router.patch(
    "/affiliate/admin/partners/{partner_id}",
    response_model=AffiliatePartner,
    status_code=200,
    summary="Edit a partner's templates, credentials and copy (admin)",
)
async def update_affiliate_partner(
    payload: AffiliatePartnerPatchRequest,
    partner_id: str = Path(..., description="Partner slug"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> AffiliatePartner:
    """Admin-only: never touches `enabled` — that is the switch below."""
    return await asyncio.to_thread(affiliate_service.update, get_supabase(), partner_id, payload)


@router.post(
    "/affiliate/admin/partners/{partner_id}/enable",
    response_model=AffiliatePartner,
    status_code=200,
    summary="Switch a partner on (admin; refused without a credential)",
)
async def enable_affiliate_partner(
    partner_id: str = Path(..., description="Partner slug"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> AffiliatePartner:
    """Admin-only: 422 unless the row holds a tracking tag or a wrapper link."""
    return await asyncio.to_thread(affiliate_service.set_enabled, get_supabase(), partner_id, True)


@router.post(
    "/affiliate/admin/partners/{partner_id}/disable",
    response_model=AffiliatePartner,
    status_code=200,
    summary="Switch a partner off (admin)",
)
async def disable_affiliate_partner(
    partner_id: str = Path(..., description="Partner slug"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> AffiliatePartner:
    """Admin-only: instant, no deploy. Pills disappear on the next page open."""
    return await asyncio.to_thread(affiliate_service.set_enabled, get_supabase(), partner_id, False)
