"""Short-code play-session endpoints.

The "join a play in progress" flow. Host's phone calls POST /sessions to get
a 5-char code; other phones call POST /sessions/{code}/join to enter the
lobby. Both ends poll GET /sessions/{code} to refresh the participant list.
The host walks the lobby through gather → play → settle via PATCH
/sessions/{code}/phase, and joiners pick up phase changes via Supabase
Realtime. POST /sessions/{code}/finalize converts the lobby to a real
boardgamebuddy_plays row, merging in any live per-round scores the joiners
wrote during the Play phase.

Route order note: /sessions/joinable is declared before /sessions/{code} so
the literal path wins over the slug.
"""

import uuid

from fastapi import Body, Depends, HTTPException, Path

from db import get_supabase

from . import router
from .constants import PlaySessionStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    JoinableSessionsResponse,
    MessageResponse,
    PlayCreate,
    PlayResponse,
    SessionCreate,
    SessionJoinBody,
    SessionPhaseUpdate,
    SessionResponse,
    SessionUpdateBody,
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
    "/sessions/joinable",
    response_model=JoinableSessionsResponse,
    status_code=200,
    summary="List active sessions the caller can join",
)
async def list_joinable_sessions(
    user: CurrentUser = Depends(get_current_user),
) -> JoinableSessionsResponse:
    """Drives the Join chooser screen — sessions in phase=gather where the
    caller is a participant, the host, or a buddy of the host."""
    sessions = session_service.list_joinable(get_supabase(), user.user_id)
    return JoinableSessionsResponse(sessions=sessions)


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


@router.patch(
    "/sessions/{code}",
    response_model=SessionResponse,
    status_code=200,
    summary="Update an open play session (host-only, game pick)",
)
async def update_session(
    body: SessionUpdateBody,
    code: str = Path(..., description="Session code"),
    user: CurrentUser = Depends(get_current_user),
) -> SessionResponse:
    """Host edits the lobby — currently only the game pick. Pass game_id=null
    to clear. Joiners pick this up on their next poll."""
    return session_service.update_session_game(
        get_supabase(),
        viewer_id=user.user_id,
        code=code,
        game_id=body.game_id,
    )


@router.patch(
    "/sessions/{code}/phase",
    response_model=SessionResponse,
    status_code=200,
    summary="Advance the session phase (host-only)",
)
async def update_session_phase(
    body: SessionPhaseUpdate,
    code: str = Path(..., description="Session code"),
    user: CurrentUser = Depends(get_current_user),
) -> SessionResponse:
    """Move the host's lobby along gather → play → settle, or abandon it.
    Joiners watch the phase column via Realtime and auto-advance their
    read-only mirror when the host moves forward."""
    return session_service.update_phase(
        get_supabase(),
        viewer_id=user.user_id,
        code=code,
        next_phase=body.phase,
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

    The host's PlayCreate body provides the game / players / mode / notes.
    Live-scoring rows written by joiners during phase='play' are merged in
    here: each authenticated player's `score` is overwritten by the sum of
    their live rounds. Guest players (no user_id) keep the host's locally-
    typed scores.
    """
    sb = get_supabase()
    session = session_service.get_session(sb, code)
    if session.host_user_id != user.user_id:
        raise HTTPException(status_code=403, detail="Only the host can finalize")

    merged_players = session_service.merge_live_scores_into_players(
        sb, session_id=session.id, players=body.players
    )
    merged_body = body.model_copy(update={"players": merged_players})

    # Defer to play_routes.log_play for the write — keeps the player /
    # expansion bookkeeping in one place. Local import dodges the circular
    # import at module load.
    from .play_routes import log_play  # noqa: WPS433
    play = await log_play(merged_body, user)
    session_service.mark_finalized(sb, session.id, play.id)
    return play
