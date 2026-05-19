"""Short-code play-session service.

Owns boardgamebuddy_play_sessions + participants. The host's phone calls
create_session(); other phones call join_session(code, ...). When the host
hits Save, finalize_session() writes the canonical boardgamebuddy_plays row
(via play_routes' existing logic) and marks the session 'finalized'.
"""

import secrets
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

from ..constants import (
    BuddyEdgeStatus,
    PLAY_SESSION_CODE_ALPHABET,
    PLAY_SESSION_CODE_LENGTH,
    PlaySessionStatus,
)
from ..models import (
    SessionParticipantResponse,
    SessionResponse,
)
from ._helpers import fetch_games_by_ids, fetch_profiles_by_ids


_MAX_CODE_ATTEMPTS = 6


def _generate_code() -> str:
    return "".join(
        secrets.choice(PLAY_SESSION_CODE_ALPHABET)
        for _ in range(PLAY_SESSION_CODE_LENGTH)
    )


def _build_response(sb, session_row: dict[str, Any]) -> SessionResponse:
    participants_rows = (
        sb.table("boardgamebuddy_play_session_participants")
        .select("id, user_id, display_name, joined_at")
        .eq("session_id", session_row["id"])
        .order("joined_at")
        .execute()
        .data
        or []
    )
    profile_ids = [p["user_id"] for p in participants_rows if p.get("user_id")]
    profiles = fetch_profiles_by_ids(sb, profile_ids)
    participants = [
        SessionParticipantResponse(
            id=p["id"],
            user_id=p.get("user_id"),
            display_name=p["display_name"],
            joined_at=p["joined_at"],
            avatar_url=(profiles.get(p.get("user_id") or "") or {}).get("avatar_url"),
        )
        for p in participants_rows
    ]

    game_summary = None
    if session_row.get("game_id"):
        games = fetch_games_by_ids(sb, [session_row["game_id"]])
        game_summary = games.get(session_row["game_id"])

    return SessionResponse(
        id=session_row["id"],
        code=session_row["code"],
        status=PlaySessionStatus(session_row["status"]),
        host_user_id=session_row["host_user_id"],
        game_id=session_row.get("game_id"),
        game=game_summary,
        participants=participants,
        created_at=session_row["created_at"],
        expires_at=session_row["expires_at"],
        finalized_play_id=session_row.get("finalized_play_id"),
    )


def create_session(
    sb,
    host_user_id: str,
    host_display_name: str,
    *,
    game_id: Optional[str] = None,
) -> SessionResponse:
    """Allocate a short code and seat the host as participant #1."""
    last_err: Optional[Exception] = None
    for _ in range(_MAX_CODE_ATTEMPTS):
        code = _generate_code()
        try:
            inserted = (
                sb.table("boardgamebuddy_play_sessions")
                .insert({
                    "code": code,
                    "host_user_id": host_user_id,
                    "game_id": game_id,
                    "status": PlaySessionStatus.OPEN.value,
                })
                .execute()
            )
            row = inserted.data[0]
            sb.table("boardgamebuddy_play_session_participants").insert({
                "session_id": row["id"],
                "user_id": host_user_id,
                "display_name": host_display_name,
            }).execute()
            return _build_response(sb, row)
        except Exception as exc:
            # The partial unique index on (code) WHERE status='open' rejects
            # collisions; retry with a new code.
            last_err = exc
            continue
    raise HTTPException(status_code=503, detail=f"Could not allocate session code: {last_err}")


def _fetch_open_session(sb, code: str) -> dict[str, Any]:
    rows = (
        sb.table("boardgamebuddy_play_sessions")
        .select("id, code, host_user_id, game_id, status, created_at, expires_at, finalized_play_id, finalized_at")
        .eq("code", code.upper())
        .eq("status", PlaySessionStatus.OPEN.value)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Session not found")
    session = rows.data[0]
    expires_at = session["expires_at"]
    expires_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00")) if isinstance(expires_at, str) else expires_at
    if expires_dt < datetime.now(timezone.utc):
        sb.table("boardgamebuddy_play_sessions").update(
            {"status": PlaySessionStatus.ABANDONED.value}
        ).eq("id", session["id"]).execute()
        raise HTTPException(status_code=410, detail="Session expired")
    return session


def get_session(sb, code: str) -> SessionResponse:
    session = _fetch_open_session(sb, code)
    return _build_response(sb, session)


def join_session(
    sb,
    code: str,
    *,
    user_id: Optional[str],
    user_display_name: Optional[str],
    guest_display_name: Optional[str],
) -> SessionResponse:
    """Idempotent join. Authed callers join as a real account; anon callers as a guest."""
    session = _fetch_open_session(sb, code)

    if user_id:
        existing = (
            sb.table("boardgamebuddy_play_session_participants")
            .select("id")
            .eq("session_id", session["id"])
            .eq("user_id", user_id)
            .execute()
        )
        if not existing.data:
            sb.table("boardgamebuddy_play_session_participants").insert({
                "session_id": session["id"],
                "user_id": user_id,
                "display_name": user_display_name or "Player",
            }).execute()
    else:
        name = (guest_display_name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="display_name is required for guests")
        # Dedup guests by case-insensitive display_name within the session.
        existing = (
            sb.table("boardgamebuddy_play_session_participants")
            .select("id")
            .eq("session_id", session["id"])
            .ilike("display_name", name)
            .execute()
        )
        if not existing.data:
            sb.table("boardgamebuddy_play_session_participants").insert({
                "session_id": session["id"],
                "display_name": name,
            }).execute()

    return _build_response(sb, session)


def update_session_game(
    sb,
    *,
    viewer_id: str,
    code: str,
    game_id: Optional[str],
) -> SessionResponse:
    """Host-only: change the game on an open lobby (or clear it).

    Lets joiners see the pick live via their poll loop — without this the
    game_id on the row was frozen at create time. Idempotent: skip the write
    when the value is unchanged.
    """
    session = _fetch_open_session(sb, code)
    if session["host_user_id"] != viewer_id:
        raise HTTPException(status_code=403, detail="Only the host can update the session")
    if session.get("game_id") != game_id:
        sb.table("boardgamebuddy_play_sessions").update(
            {"game_id": game_id}
        ).eq("id", session["id"]).execute()
        session["game_id"] = game_id
    return _build_response(sb, session)


def abandon_session(sb, viewer_id: str, code: str) -> None:
    session = _fetch_open_session(sb, code)
    if session["host_user_id"] != viewer_id:
        raise HTTPException(status_code=403, detail="Only the host can abandon a session")
    sb.table("boardgamebuddy_play_sessions").update(
        {"status": PlaySessionStatus.ABANDONED.value}
    ).eq("id", session["id"]).execute()


def mark_finalized(sb, session_id: str, play_id: str) -> None:
    """Called from play_routes after a session-backed play is saved."""
    sb.table("boardgamebuddy_play_sessions").update({
        "status": PlaySessionStatus.FINALIZED.value,
        "finalized_play_id": play_id,
        "finalized_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", session_id).execute()
