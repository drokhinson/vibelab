"""Short-code play-session endpoints.

The "join a play in progress" flow. Host's phone calls POST /sessions to get
a 5-char code; other phones call POST /sessions/{code}/join to enter the
lobby. Both ends poll GET /sessions/{code} to refresh the participant list.
The host calls POST /sessions/{code}/finalize with a PlayCreate body to turn
the session into a real boardgamebuddy_plays row.

Finalize composes session_service (mark-finalized) with the existing
play-creation pipeline (delegated via a small helper here to avoid pulling
play_routes into a circular import).
"""

import uuid

from fastapi import Body, Depends, HTTPException, Path

from db import get_supabase

from . import router
from .constants import PlaySessionStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    MessageResponse,
    PlayCreate,
    PlayResponse,
    SessionCreate,
    SessionJoinBody,
    SessionResponse,
)
from .services import session_service


@router.post(
    "/sessions",
    response_model=SessionResponse,
    status_code=201,
    summary="Open a new play session (short code)",
)
async def create_session(
    body: SessionCreate,
    user: CurrentUser = Depends(get_current_user),
) -> SessionResponse:
    """Allocate a short code and seat the host as participant #1."""
    return session_service.create_session(
        get_supabase(),
        user.user_id,
        user.display_name,
        game_id=body.game_id,
    )


@router.get(
    "/sessions/{code}",
    response_model=SessionResponse,
    status_code=200,
    summary="Fetch an open play session by code (poll target)",
)
async def get_session(
    code: str = Path(..., min_length=4, max_length=12, description="Session code"),
) -> SessionResponse:
    """Read endpoint. Open to any caller — knowing the code is the access
    token for the lobby."""
    return session_service.get_session(get_supabase(), code)


@router.post(
    "/sessions/{code}/join",
    response_model=SessionResponse,
    status_code=200,
    summary="Join a play session",
)
async def join_session(
    body: SessionJoinBody,
    code: str = Path(..., description="Session code"),
    user: CurrentUser = Depends(get_current_user),
) -> SessionResponse:
    """Idempotent join — authed user goes in by account; if they pass
    display_name we still take it from their profile."""
    return session_service.join_session(
        get_supabase(),
        code,
        user_id=user.user_id,
        user_display_name=user.display_name,
        guest_display_name=body.display_name,
    )


@router.delete(
    "/sessions/{code}",
    response_model=MessageResponse,
    status_code=200,
    summary="Abandon an open play session",
)
async def abandon_session(
    code: str = Path(..., description="Session code"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Only the host can abandon."""
    session_service.abandon_session(get_supabase(), user.user_id, code)
    return MessageResponse(message="Session abandoned")


@router.post(
    "/sessions/{code}/finalize",
    response_model=PlayResponse,
    status_code=201,
    summary="Convert a session to a play record",
)
async def finalize_session(
    body: PlayCreate,
    code: str = Path(..., description="Session code"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayResponse:
    """Write a single boardgamebuddy_plays row from the session's participants
    and mark the session finalized.

    The host's PlayCreate body wins for game_id / played_at / players / etc.
    Session participants are surfaced through the FE so the host can edit
    them before calling finalize.
    """
    sb = get_supabase()
    session = session_service.get_session(sb, code)
    if session.host_user_id != user.user_id:
        raise HTTPException(status_code=403, detail="Only the host can finalize")

    # Defer to play_routes.log_play for the write — keeps the player /
    # expansion bookkeeping in one place. Local import dodges the circular
    # import at module load.
    from .play_routes import log_play  # noqa: WPS433
    play = await log_play(body, user)
    session_service.mark_finalized(sb, session.id, play.id)
    return play
