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
    ALLOWED_PHASE_TRANSITIONS,
    BuddyEdgeStatus,
    PLAY_SESSION_CODE_ALPHABET,
    PLAY_SESSION_CODE_LENGTH,
    PlaySessionStatus,
    SessionPhase,
)
from ..models import (
    JoinableSession,
    PlayerEntry,
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
            avatar=(profiles.get(p.get("user_id") or "") or {}).get("avatar"),
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
        phase=SessionPhase(session_row.get("phase") or SessionPhase.GATHER.value),
        host_user_id=session_row["host_user_id"],
        game_id=session_row.get("game_id"),
        game=game_summary,
        participants=participants,
        created_at=session_row["created_at"],
        expires_at=session_row["expires_at"],
        finalized_play_id=session_row.get("finalized_play_id"),
    )


def _close_open_sessions_for_host(sb, host_user_id: str) -> None:
    """Abandon any pre-existing open sessions owned by this host.

    The Log Play tab always opens a new session on entry to Gather, so a
    host who navigates away and comes back would otherwise leave orphan
    rows accumulating. Run before insert in create_session() to keep the
    table tidy without relying solely on the 2h expires_at cleanup.
    """
    sb.table("boardgamebuddy_play_sessions").update({
        "status": PlaySessionStatus.ABANDONED.value,
        "phase": SessionPhase.ABANDONED.value,
    }).eq("host_user_id", host_user_id).eq(
        "status", PlaySessionStatus.OPEN.value
    ).execute()


def create_session(
    sb,
    host_user_id: str,
    host_display_name: str,
    *,
    game_id: Optional[str] = None,
) -> SessionResponse:
    """Allocate a short code and seat the host as participant #1."""
    _close_open_sessions_for_host(sb, host_user_id)
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
                    "phase": SessionPhase.GATHER.value,
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
    """Idempotent join. Authed callers join as a real account; anon callers as a guest.

    Joining during Gather adds the caller to the participants table — the
    host's poll then promotes them to a player row in the live draft.
    Joining after Gather (Play / Settle) is allowed too but does NOT touch
    the participants table: the caller is a spectator with the same
    read-only session-viewer view as joiners-during-gather, just absent
    from the host's player list.
    """
    session = _fetch_open_session(sb, code)
    in_gather = (session.get("phase") or SessionPhase.GATHER.value) == SessionPhase.GATHER.value

    if in_gather and user_id:
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
    elif in_gather:
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
