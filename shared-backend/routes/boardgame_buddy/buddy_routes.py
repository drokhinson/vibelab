"""Mutual buddy graph endpoints.

Replaces the legacy one-way /buddies routes that used to live in
play_routes.py. The new model is friend-request based: send_request →
incoming/outgoing pending → accept/reject → accepted edge.
"""

from fastapi import Depends, Path

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    BuddyEdgeResponse,
    BuddyRequestCreate,
    BuddyRequestResponse,
    BuddyRequestsResponse,
    GhostLinkRequest,
    GhostLinkResponse,
    GhostPlayer,
    MessageResponse,
    PlayedWithUser,
)
from .services import buddy_service, played_with_service


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
