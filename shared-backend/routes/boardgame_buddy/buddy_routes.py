"""Mutual buddy graph endpoints.

Replaces the legacy one-way /buddies routes that used to live in
play_routes.py. The new model is friend-request based: send_request →
incoming/outgoing pending → accept/reject → accepted edge.
"""

from fastapi import Depends, Path, Query

from db import get_supabase

from . import router
from .constants import QR_TOKEN_TTL_SECONDS
from .dependencies import CurrentUser, get_current_user
from .models import (
    BuddyEdgeResponse,
    BuddyQrAddRequest,
    BuddyQrAddResponse,
    BuddyQrPeekRequest,
    BuddyQrPeekResponse,
    BuddyQrTokenResponse,
    BuddyRequestCreate,
    BuddyRequestResponse,
    BuddyRequestsResponse,
    BulkBuddyRequestCreate,
    BulkBuddyRequestResponse,
    GhostLinkRequest,
    GhostLinkResponse,
    GhostMergeRequest,
    GhostMergeResponse,
    GhostPlayer,
    MessageResponse,
    PlayedWithUser,
    PlayPartnersResponse,
    SuggestedBuddiesResponse,
)
from .services import buddy_qr_service, buddy_service, feed_service, played_with_service


@router.get(
    "/buddies",
    response_model=list[BuddyEdgeResponse],
    status_code=200,
    summary="List accepted mutual buddies",
)
async def list_buddies_v2(
    user: CurrentUser = Depends(get_current_user),
) -> list[BuddyEdgeResponse]:
    """Accepted mutual edges for the current user."""
    return buddy_service.list_accepted_buddies(get_supabase(), user.user_id)


@router.get(
    "/buddies/requests",
    response_model=BuddyRequestsResponse,
    status_code=200,
    summary="List pending buddy requests",
)
async def list_buddy_requests(
    user: CurrentUser = Depends(get_current_user),
) -> BuddyRequestsResponse:
    """Pending buddy requests for the current user, split incoming / outgoing."""
    return buddy_service.list_requests(get_supabase(), user.user_id)


@router.get(
    "/buddies/suggested",
    response_model=SuggestedBuddiesResponse,
    status_code=200,
    summary="Suggest people the current user may know",
)
async def list_suggested_buddies(
    limit: int = Query(12, ge=1, le=50, description="Maximum suggestions to return"),
    user: CurrentUser = Depends(get_current_user),
) -> SuggestedBuddiesResponse:
    """Same ranked candidates the feed's "Buddies you may know" rail renders.

    Shared as a standalone endpoint so the Buddies page can show the rail
    without pulling a whole feed page."""
    return feed_service.fetch_suggested_buddies(
        get_supabase(), user.user_id, limit=limit
    )


@router.get(
    "/buddies/suggested/onboarding",
    response_model=SuggestedBuddiesResponse,
    status_code=200,
    summary="Suggest buddies for a brand-new account",
)
async def list_onboarding_buddy_suggestions(
    limit: int = Query(12, ge=1, le=50, description="Maximum suggestions to return"),
    user: CurrentUser = Depends(get_current_user),
) -> SuggestedBuddiesResponse:
    """Candidates for the onboarding "Add buddies" step, shown once the
    first-time profile modal is saved.

    Not the same list as /buddies/suggested: that one only returns people the
    viewer shares a play or a buddy with, which is the empty set for the
    account that has just been created. This falls back to recently active
    users once those run out, and tags each candidate with which tier it came
    from so the client can label it honestly."""
    return feed_service.fetch_onboarding_buddy_suggestions(
        get_supabase(), user.user_id, limit=limit
    )


@router.post(
    "/buddies/request",
    response_model=BuddyRequestResponse,
    status_code=201,
    summary="Send a buddy request",
)
async def send_buddy_request(
    body: BuddyRequestCreate,
    user: CurrentUser = Depends(get_current_user),
) -> BuddyRequestResponse:
    """Send a request to another user. Auto-accepts if a reverse request exists."""
    return buddy_service.send_request(get_supabase(), user.user_id, body.target_user_id)


@router.post(
    "/buddies/requests/bulk",
    response_model=BulkBuddyRequestResponse,
    status_code=200,
    summary="Send buddy requests to several users at once",
)
async def send_buddy_requests_bulk(
    body: BulkBuddyRequestCreate,
    user: CurrentUser = Depends(get_current_user),
) -> BulkBuddyRequestResponse:
    """Send one request per target, reporting each outcome separately.

    Backs the onboarding step's multi-select. Partial success is the expected
    shape, not an error: targets that fail (already buddies, blocked, account
    gone) come back in `failed` while the rest are sent, so 200 is correct
    even when some did not land."""
    return buddy_service.send_requests_bulk(
        get_supabase(), user.user_id, body.target_user_ids
    )


@router.post(
    "/buddies/qr-token",
    response_model=BuddyQrTokenResponse,
    status_code=200,
    summary="Mint a short-lived add-me QR token",
)
async def mint_buddy_qr_token(
    user: CurrentUser = Depends(get_current_user),
) -> BuddyQrTokenResponse:
    """Sign a token the caller's QR code encodes. Stateless; expires in ~3 minutes."""
    token, expires_at = buddy_qr_service.mint_qr_token(user.user_id)
    return BuddyQrTokenResponse(
        token=token,
        expires_at=expires_at,
        ttl_seconds=QR_TOKEN_TTL_SECONDS,
    )


@router.post(
    "/buddies/qr-peek",
    response_model=BuddyQrPeekResponse,
    status_code=200,
    summary="Resolve a scanned QR code to the person who minted it",
)
async def peek_buddy_qr(
    body: BuddyQrPeekRequest,
    user: CurrentUser = Depends(get_current_user),
) -> BuddyQrPeekResponse:
    """Say who a scanned code belongs to. Writes nothing.

    The scan screen shows the person and lets the scanner choose — open their
    profile, or become buddies — so it needs to resolve a token without
    redeeming it. /buddies/qr-add below still does both in one call and is what
    "Buddy up" calls with the same token.
    """
    issuer_id = buddy_qr_service.issuer_from_qr_token(body.token)
    return buddy_qr_service.peek_qr_issuer(get_supabase(), user.user_id, issuer_id)


@router.post(
    "/buddies/qr-add",
    response_model=BuddyQrAddResponse,
    status_code=200,
    summary="Become buddies by scanning someone's QR code",
)
async def add_buddy_by_qr(
    body: BuddyQrAddRequest,
    user: CurrentUser = Depends(get_current_user),
) -> BuddyQrAddResponse:
    """Redeem a scanned QR token — both users become buddies immediately."""
    issuer_id = buddy_qr_service.issuer_from_qr_token(body.token)
    edge, created = buddy_qr_service.add_buddy_mutually(
        get_supabase(), user.user_id, issuer_id
    )
    return BuddyQrAddResponse(edge=edge, created=created)


@router.post(
    "/buddies/{request_id}/accept",
    response_model=BuddyEdgeResponse,
    status_code=200,
    summary="Accept a buddy request",
)
async def accept_buddy_request(
    request_id: str = Path(..., description="Edge UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> BuddyEdgeResponse:
    """Accept an incoming request and return the resulting accepted edge."""
    return buddy_service.accept_request(get_supabase(), user.user_id, request_id)


@router.post(
    "/buddies/{request_id}/reject",
    response_model=MessageResponse,
    status_code=200,
    summary="Reject a buddy request",
)
async def reject_buddy_request(
    request_id: str = Path(..., description="Edge UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Reject (delete) an incoming pending request."""
    buddy_service.reject_request(get_supabase(), user.user_id, request_id)
    return MessageResponse(message="Request rejected")


@router.post(
    "/buddies/{request_id}/cancel",
    response_model=MessageResponse,
    status_code=200,
    summary="Cancel an outgoing buddy request",
)
async def cancel_buddy_request(
    request_id: str = Path(..., description="Edge UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Withdraw a pending request the current user sent. Sender only —
    the recipient declines instead."""
    buddy_service.cancel_request(get_supabase(), user.user_id, request_id)
    return MessageResponse(message="Request cancelled")


@router.delete(
    "/buddies/{edge_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Unfriend a buddy",
)
async def delete_buddy_edge(
    edge_id: str = Path(..., description="Edge UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove an accepted mutual edge. Either party can call this."""
    buddy_service.unfriend(get_supabase(), user.user_id, edge_id)
    return MessageResponse(message="Unfriended")


@router.get(
    "/play-partners",
    response_model=PlayPartnersResponse,
    status_code=200,
    summary="Buddies + ghosts + played-with in one call (Gather player picker)",
)
async def list_play_partners(
    user: CurrentUser = Depends(get_current_user),
) -> PlayPartnersResponse:
    """The three lists the Gather player picker renders, from one RPC.

    The picker used to open all three of the endpoints below in parallel:
    three requests, twelve DB round trips, three profile lookups for auth.
    """
    return played_with_service.fetch_play_partners(get_supabase(), user.user_id)


@router.get(
    "/played-with",
    response_model=list[PlayedWithUser],
    status_code=200,
    summary="List real-account players the viewer has shared a play with",
)
async def list_played_with(
    user: CurrentUser = Depends(get_current_user),
) -> list[PlayedWithUser]:
    """Played-with discovery: anyone whose account appears in the viewer's
    plays (either as the logger or via player_user_id)."""
    return played_with_service.fetch_played_with(get_supabase(), user.user_id)


@router.get(
    "/ghost-players",
    response_model=list[GhostPlayer],
    status_code=200,
    summary="List free-text ghost players the viewer has recorded",
)
async def list_ghost_players(
    user: CurrentUser = Depends(get_current_user),
) -> list[GhostPlayer]:
    """Nicknames the viewer logged for players without accounts. Grouped by
    name with a play count and last-played date for context."""
    return played_with_service.fetch_ghost_players(get_supabase(), user.user_id)


@router.post(
    "/ghost-players/link",
    response_model=GhostLinkResponse,
    status_code=200,
    summary="Promote a ghost player to a real account",
)
async def link_ghost_player(
    body: GhostLinkRequest,
    user: CurrentUser = Depends(get_current_user),
) -> GhostLinkResponse:
    """Stamp `target_user_id` onto every matching ghost play_players row.
    Subsequent reads of those plays surface the real account's display
    name and the play counts toward the played-with leaderboard."""
    n = played_with_service.link_ghost(
        get_supabase(), user.user_id, body.display_name, body.target_user_id
    )
    return GhostLinkResponse(rows_updated=n)


@router.post(
    "/ghost-players/merge",
    response_model=GhostMergeResponse,
    status_code=200,
    summary="Merge one ghost display name into another",
)
async def merge_ghost_players(
    body: GhostMergeRequest,
    user: CurrentUser = Depends(get_current_user),
) -> GhostMergeResponse:
    """Rename every viewer-logged ghost row matching `source_display_name`
    (case-insensitive) to `target_display_name`. Useful when the same
    friend was typed under different spellings across plays."""
    n = played_with_service.merge_ghosts(
        get_supabase(),
        user.user_id,
        body.source_display_name,
        body.target_display_name,
    )
    return GhostMergeResponse(rows_updated=n)
