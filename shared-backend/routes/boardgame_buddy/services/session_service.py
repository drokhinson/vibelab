"""Short-code play-session service.

Owns boardgamebuddy_play_sessions + participants. The host's phone calls
create_session(); other phones call join_session(code, ...). When the host
hits Save, finalize_session() writes the canonical boardgamebuddy_plays row
(via play_routes' existing logic) and marks the session 'finalized'.

The hot paths (create / join / the 2s GET poll) are single Postgres RPCs
(migration 036) — each previously fanned out 4-6 sequential PostgREST
round trips, which made host/join taps crawl at cross-region RTTs. The
RPCs return SessionResponse-shaped JSONB, or {"error": "<code>"} for gate
failures, which _bundle_to_response maps to the same HTTPExceptions the
routes have always raised.
"""

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

from ..constants import (
    ALLOWED_PHASE_TRANSITIONS,
    BuddyEdgeStatus,
    PlaySessionStatus,
    SessionPhase,
)
from ..models import (
    JoinableSession,
    PlayerEntry,
    SessionResponse,
)
from ._helpers import fetch_games_by_ids, fetch_profiles_by_ids


_BUNDLE_ERROR_STATUS: dict[str, tuple[int, str]] = {
    "not_found": (404, "Session not found"),
    "expired": (410, "Session expired"),
    "guest_name_required": (400, "display_name is required for guests"),
    "code_allocation_failed": (503, "Could not allocate session code"),
}


def _bundle_to_response(data: Any) -> SessionResponse:
    """Parse a session-RPC JSONB payload, mapping error codes to HTTP."""
    if not isinstance(data, dict) or not data:
        raise HTTPException(status_code=502, detail="Empty session RPC response")
    error = data.get("error")
    if error:
        status, detail = _BUNDLE_ERROR_STATUS.get(
            error, (500, f"Session RPC error: {error}")
        )
        raise HTTPException(status_code=status, detail=detail)
    return SessionResponse.model_validate(data)


def _build_response(sb, session_row: dict[str, Any]) -> SessionResponse:
    data = (
        sb.rpc("bgb_session_bundle", {"p_session_id": session_row["id"]})
        .execute()
        .data
    )
    return _bundle_to_response(data)


def create_session(
    sb,
    host_user_id: str,
    host_display_name: str,
    *,
    game_id: Optional[str] = None,
) -> SessionResponse:
    """Allocate a short code and seat the host as participant #1.

    One RPC: bgb_create_session abandons the host's stale open sessions,
    generates a code (retrying against the partial unique index on (code)
    WHERE status='open'), seats the host, and returns the lobby bundle.
    """
    data = (
        sb.rpc("bgb_create_session", {
            "p_host": host_user_id,
            "p_host_display_name": host_display_name,
            "p_game": game_id,
        })
        .execute()
        .data
    )
    return _bundle_to_response(data)


_SESSION_SELECT = (
    "id, code, host_user_id, game_id, status, phase, created_at, expires_at, "
    "finalized_play_id, finalized_at"
)


def _fetch_open_session(sb, code: str) -> dict[str, Any]:
    rows = (
        sb.table("boardgamebuddy_play_sessions")
        .select(_SESSION_SELECT)
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
    """The 2s poll target — one RPC instead of four round trips."""
    data = sb.rpc("bgb_get_session", {"p_code": code}).execute().data
    return _bundle_to_response(data)


def join_session(
    sb,
    code: str,
    *,
    user_id: Optional[str],
    user_display_name: Optional[str],
    guest_display_name: Optional[str],
) -> SessionResponse:
    """Idempotent join. Authed callers join as a real account; anon callers as a guest.

    Joining during Gather adds the caller to the participants table — the
    host's poll then promotes them to a player row in the live draft.
    Joining after Gather (Play / Settle) is allowed too but does NOT touch
    the participants table: the caller is a spectator with the same
    read-only session-viewer view as joiners-during-gather, just absent
    from the host's player list. All of that lives in bgb_join_session.
    """
    data = (
        sb.rpc("bgb_join_session", {
            "p_code": code,
            "p_user": user_id,
            "p_user_display_name": user_display_name,
            "p_guest_display_name": guest_display_name,
        })
        .execute()
        .data
    )
    return _bundle_to_response(data)


def add_participant(
    sb,
    *,
    viewer_id: str,
    code: str,
    user_id: Optional[str],
    display_name: str,
) -> SessionResponse:
    """Host-only: add a buddy or ghost to the lobby roster.

    Mirrors join_session's dedup semantics but is initiated by the host
    rather than the joining user. Without this endpoint, players the host
    types into the picker live only in the host's local draft, so other
    joiners never see them in their participants list.

    Gather-only — once Play starts the roster is frozen.
    """
    session = _fetch_open_session(sb, code)
    if session["host_user_id"] != viewer_id:
        raise HTTPException(status_code=403, detail="Only the host can add participants")
    if (session.get("phase") or SessionPhase.GATHER.value) != SessionPhase.GATHER.value:
        raise HTTPException(status_code=409, detail="Roster is locked once Play starts")
    name = (display_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="display_name is required")

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
                "display_name": name,
            }).execute()
    else:
        # Ghost dedup by case-insensitive display_name within the session.
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


def remove_participant(
    sb,
    *,
    viewer_id: str,
    code: str,
    participant_id: str,
) -> SessionResponse:
    """Host-only: remove a participant from the lobby roster. Gather-only.

    Refuses to remove the host themselves — abandon_session is the way to
    end a session.
    """
    session = _fetch_open_session(sb, code)
    if session["host_user_id"] != viewer_id:
        raise HTTPException(status_code=403, detail="Only the host can remove participants")
    if (session.get("phase") or SessionPhase.GATHER.value) != SessionPhase.GATHER.value:
        raise HTTPException(status_code=409, detail="Roster is locked once Play starts")

    row = (
        sb.table("boardgamebuddy_play_session_participants")
        .select("id, user_id")
        .eq("id", participant_id)
        .eq("session_id", session["id"])
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=404, detail="Participant not found")
    if row.data[0].get("user_id") == session["host_user_id"]:
        raise HTTPException(status_code=400, detail="Cannot remove the host")

    sb.table("boardgamebuddy_play_session_participants").delete().eq(
        "id", participant_id
    ).eq("session_id", session["id"]).execute()
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
    sb.table("boardgamebuddy_play_sessions").update({
        "status": PlaySessionStatus.ABANDONED.value,
        "phase": SessionPhase.ABANDONED.value,
    }).eq("id", session["id"]).execute()


def mark_finalized(sb, session_id: str, play_id: str) -> None:
    """Called from play_routes after a session-backed play is saved."""
    sb.table("boardgamebuddy_play_sessions").update({
        "status": PlaySessionStatus.FINALIZED.value,
        "phase": SessionPhase.FINALIZED.value,
        "finalized_play_id": play_id,
        "finalized_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", session_id).execute()


def update_phase(
    sb,
    *,
    viewer_id: str,
    code: str,
    next_phase: SessionPhase,
) -> SessionResponse:
    """Host-only: advance the session phase. Validates transitions against
    ALLOWED_PHASE_TRANSITIONS so a misbehaving client can't skip Play and
    jump straight from Gather to Settle, or resurrect a terminal session.
    """
    session = _fetch_open_session(sb, code)
    if session["host_user_id"] != viewer_id:
        raise HTTPException(status_code=403, detail="Only the host can update the phase")

    current = SessionPhase(session.get("phase") or SessionPhase.GATHER.value)
    if next_phase == current:
        return _build_response(sb, session)
    allowed = ALLOWED_PHASE_TRANSITIONS.get(current, frozenset())
    if next_phase not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot transition from {current.value} to {next_phase.value}",
        )

    updates: dict[str, Any] = {"phase": next_phase.value}
    # Keep `status` in sync for the abandoned shortcut (mirrors abandon_session)
    # — finalized is set later by mark_finalized once the play row is written.
    if next_phase == SessionPhase.ABANDONED:
        updates["status"] = PlaySessionStatus.ABANDONED.value

    sb.table("boardgamebuddy_play_sessions").update(updates).eq(
        "id", session["id"]
    ).execute()
    session.update(updates)
    return _build_response(sb, session)


def list_joinable(sb, viewer_id: str) -> list[JoinableSession]:
    """Open sessions the viewer can land on from the Join chooser.

    Includes any open in-progress session (phase ∈ gather/play/settle)
    that the viewer has visibility into:
      - their own hosted sessions (refresh recovery),
      - sessions they've already joined (disconnect recovery), or
      - sessions hosted by an accepted buddy.

    Gather sessions can be joined as a player; Play/Settle sessions are
    spectator-only — the FE surfaces a "Spectate" badge so the user
    knows what they're stepping into. Finalized and abandoned sessions
    are excluded.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = (
        sb.table("boardgamebuddy_play_sessions")
        .select(_SESSION_SELECT)
        .eq("status", PlaySessionStatus.OPEN.value)
        .in_(
            "phase",
            [
                SessionPhase.GATHER.value,
                SessionPhase.PLAY.value,
                SessionPhase.SETTLE.value,
            ],
        )
        .gt("expires_at", now_iso)
        .order("created_at", desc=True)
        .execute()
    )
    sessions_rows = rows.data or []
    if not sessions_rows:
        return []

    session_ids = [s["id"] for s in sessions_rows]
    host_ids = [s["host_user_id"] for s in sessions_rows]
    game_ids = [s["game_id"] for s in sessions_rows if s.get("game_id")]

    # Bulk lookup: hosts, games, and participant rows in three queries.
    profiles = fetch_profiles_by_ids(sb, host_ids)
    games = fetch_games_by_ids(sb, game_ids)
    parts = (
        sb.table("boardgamebuddy_play_session_participants")
        .select("session_id, user_id")
        .in_("session_id", session_ids)
        .execute()
        .data
        or []
    )
    participants_by_session: dict[str, list[dict[str, Any]]] = {}
    for p in parts:
        participants_by_session.setdefault(p["session_id"], []).append(p)

    # Buddy edges with the viewer — one query, both directions.
    edges = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("user_a, user_b")
        .eq("status", BuddyEdgeStatus.ACCEPTED.value)
        .or_(f"user_a.eq.{viewer_id},user_b.eq.{viewer_id}")
        .execute()
        .data
        or []
    )
    buddy_ids: set[str] = set()
    for e in edges:
        buddy_ids.add(e["user_b"] if e["user_a"] == viewer_id else e["user_a"])

    out: list[JoinableSession] = []
    for s in sessions_rows:
        sid = s["id"]
        plist = participants_by_session.get(sid, [])
        is_participant = any(p.get("user_id") == viewer_id for p in plist)
        is_host = s["host_user_id"] == viewer_id
        is_host_buddy = s["host_user_id"] in buddy_ids
        if not (is_participant or is_host or is_host_buddy):
            continue
        prof = profiles.get(s["host_user_id"]) or {}
        out.append(JoinableSession(
            id=sid,
            code=s["code"],
            host_user_id=s["host_user_id"],
            host_display_name=prof.get("display_name") or "Host",
            host_avatar=prof.get("avatar"),
            game=games.get(s["game_id"]) if s.get("game_id") else None,
            phase=SessionPhase(s.get("phase") or SessionPhase.GATHER.value),
            participant_count=len(plist),
            is_participant=is_participant,
            is_host_buddy=is_host_buddy,
            created_at=s["created_at"],
        ))
    return out


def merge_live_scores_into_players(
    sb,
    *,
    session_id: str,
    players: list[PlayerEntry],
) -> list[PlayerEntry]:
    """Overlay live-scoring writes onto the host's PlayCreate payload.

    Authenticated joiners stream cell updates into
    boardgamebuddy_play_session_scores during phase='play'. At finalize
    time we sum each player's rows and overwrite the matching
    PlayerEntry.score (matched by user_id). Guest players (user_id is
    None) are never in the scores table; their host-typed scores ride
    through unchanged.
    """
    rows = (
        sb.table("boardgamebuddy_play_session_scores")
        .select("player_user_id, score")
        .eq("session_id", session_id)
        .execute()
        .data
        or []
    )
    if not rows:
        return players
    totals: dict[str, int] = {}
    for r in rows:
        uid = r.get("player_user_id")
        if not uid:
            continue
        totals[uid] = totals.get(uid, 0) + int(r.get("score") or 0)
    if not totals:
        return players
    merged: list[PlayerEntry] = []
    for p in players:
        if p.user_id and p.user_id in totals:
            merged.append(p.model_copy(update={"score": totals[p.user_id]}))
        else:
            merged.append(p)
    return merged
