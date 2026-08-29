"""Short-code play-session service.

Owns boardgamebuddy_play_sessions + participants. The host's phone calls
create_session(); other phones call join_session(code, ...). When the host
hits Save, finalize_session() writes the canonical boardgamebuddy_plays row
and marks the session 'finalized'.

Every path through this module is a single Postgres RPC: create / join /
the 2s GET poll (migration 036), the Save (042), and the host's Gather-time
writes — add and remove a participant, swap the game, move the phase cursor,
abandon (046). Each previously fanned out 2-10 sequential PostgREST round
trips, which made host/join taps, the Gather screen and the wrap-up crawl
at cross-region RTTs. The RPCs return SessionResponse- or PlayResponse-shaped
JSONB, or {"error": "<code>"} for gate failures, which raise_for_rpc_error
maps to the same HTTPExceptions the routes have always raised.
"""

from typing import Any, Optional

from fastapi import HTTPException

from ..constants import (
    ALLOWED_PHASE_TRANSITIONS,
    SessionPhase,
)
from ..models import (
    JoinableSession,
    PlayResponse,
    SessionResponse,
)
from ._helpers import raise_for_rpc_error


def _reject_non_host(data: Any, detail: str) -> None:
    """Map migration 046's generic `host_only` envelope onto this endpoint's
    own 403 wording — it surfaces to the user in a toast, so "can't add
    participants" shouldn't become "can't update the session"."""
    if isinstance(data, dict) and data.get("error") == "host_only":
        raise HTTPException(status_code=403, detail=detail)


def _bundle_to_response(data: Any) -> SessionResponse:
    """Parse a session-RPC JSONB payload, mapping error codes to HTTP."""
    raise_for_rpc_error(data, "Session")
    return SessionResponse.model_validate(data)


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

    Gather-only — once Play starts the roster is frozen. One RPC:
    bgb_add_participant (migration 046) gates, dedups and seats in a single
    round trip, where this used to cost four.
    """
    data = (
        sb.rpc("bgb_add_participant", {
            "p_host": viewer_id,
            "p_code": code,
            "p_user": user_id,
            "p_display_name": display_name,
        })
        .execute()
        .data
    )
    _reject_non_host(data, "Only the host can add participants")
    return _bundle_to_response(data)


def reorder_participants(
    sb,
    *,
    viewer_id: str,
    code: str,
    participant_ids: list[str],
) -> SessionResponse:
    """Host-only: set the roster's column order. Gather-only.

    The participants array's order IS the scoring grid's column order on every
    surface — widgets/round-score-grid.js keys each cell off the array index,
    and the spectator's mirror builds its grid straight from this array — so
    this is what makes a row the host dragged in Gather move on everybody
    else's screen too. Without it the drag is local to the host's phone.

    One RPC: bgb_reorder_participants (migration 056), on the same gate
    add/remove use, so it answers with the same host_only / roster_locked
    vocabulary _helpers already maps.
    """
    data = (
        sb.rpc("bgb_reorder_participants", {
            "p_host": viewer_id,
            "p_code": code,
            "p_order": participant_ids,
        })
        .execute()
        .data
    )
    _reject_non_host(data, "Only the host can reorder participants")
    return _bundle_to_response(data)


def remove_participant(
    sb,
    *,
    viewer_id: str,
    code: str,
    participant_id: str,
) -> SessionResponse:
    """Host-only: remove a participant from the lobby roster. Gather-only.

    Refuses to remove the host themselves — abandon_session is the way to
    end a session. One RPC (bgb_remove_participant, migration 046).
    """
    data = (
        sb.rpc("bgb_remove_participant", {
            "p_host": viewer_id,
            "p_code": code,
            "p_participant": participant_id,
        })
        .execute()
        .data
    )
    _reject_non_host(data, "Only the host can remove participants")
    return _bundle_to_response(data)


def update_session_game(
    sb,
    *,
    viewer_id: str,
    code: str,
    game_id: Optional[str],
) -> SessionResponse:
    """Host-only: change the game on an open lobby (or clear it).

    Lets joiners see the pick live via their poll loop — without this the
    game_id on the row was frozen at create time. Idempotent: the RPC skips
    the write when the value is unchanged. Allowed in any open phase, not
    just Gather — the host flow's picker relies on that.
    """
    data = (
        sb.rpc("bgb_update_session_game", {
            "p_host": viewer_id,
            "p_code": code,
            "p_game": game_id,
        })
        .execute()
        .data
    )
    return _bundle_to_response(data)


def abandon_session(sb, viewer_id: str, code: str) -> None:
    """Host-only: close an open lobby. One RPC (migration 046)."""
    data = (
        sb.rpc("bgb_abandon_session", {"p_host": viewer_id, "p_code": code})
        .execute()
        .data
    )
    _reject_non_host(data, "Only the host can abandon a session")
    raise_for_rpc_error(data, "Session")


def finalize_session(sb, *, host_user_id: str, code: str, payload: dict[str, Any]) -> PlayResponse:
    """Turn an open lobby into a play row in ONE round trip.

    bgb_finalize_session (migration 042) does the open/expiry/host gating,
    overlays the joiners' live-scoring totals onto the host's player list,
    writes the play (via bgb_log_play) and marks the session finalized — the
    work that used to be four service calls and ten sequential PostgREST
    round trips.

    `payload` is a PlayCreate dumped in JSON mode (dates as ISO strings).
    """
    data = (
        sb.rpc("bgb_finalize_session", {
            "p_host": host_user_id,
            "p_code": code,
            "p_payload": payload,
        })
        .execute()
        .data
    )
    raise_for_rpc_error(data, "Finalize")
    # A client_key (migration 048) we already hold a play for. bgb_log_play
    # short-circuits and hands back {"duplicate": true, "id": <uuid>};
    # bgb_finalize_session passes that straight through, having tested only for
    # `error` — and `v_play->>'id'` still resolves, so the session is correctly
    # stamped finalized against the original play. What the envelope is NOT is a
    # PlayResponse, so read the stored row back the way log_play does.
    #
    # Reached when the host taps Save, the response is lost, and play-flow hands
    # the same payload — same key — to the upload queue.
    if isinstance(data, dict) and data.get("duplicate"):
        # Imported here, not at module scope: play_routes imports .services, so
        # a top-level import would close the cycle.
        from ..play_routes import load_play_response

        return load_play_response(sb, data["id"], host_user_id)
    return PlayResponse.model_validate(data)


# ALLOWED_PHASE_TRANSITIONS, in the shape bgb_advance_phase wants. Passing the
# table to the RPC rather than encoding it in SQL keeps constants.py the single
# source of truth — 036/038's comments, still pointing at code constants that
# no longer exist, are what the alternative looks like after a few migrations.
def _transitions_payload() -> dict[str, list[str]]:
    return {
        phase.value: sorted(nxt.value for nxt in allowed)
        for phase, allowed in ALLOWED_PHASE_TRANSITIONS.items()
    }


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

    One RPC (bgb_advance_phase, migration 046) — gate, transition check and
    write together. Re-asserting the current phase is a no-op, as before.
    """
    data = (
        sb.rpc("bgb_advance_phase", {
            "p_host": viewer_id,
            "p_code": code,
            "p_phase": next_phase.value,
            "p_transitions": _transitions_payload(),
        })
        .execute()
        .data
    )
    _reject_non_host(data, "Only the host can update the phase")
    # Composed here rather than in RPC_ERROR_STATUS because the message names
    # both ends of the rejected move — same 400 body the route always sent.
    if isinstance(data, dict) and data.get("error") == "invalid_transition":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot transition from {data.get('from')} to {data.get('to')}",
        )
    return _bundle_to_response(data)


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
    are excluded. All the filtering (visibility, expiry, buddy edges)
    lives in bgb_joinable_sessions (migration 037) — one RPC instead of
    the five queries this used to fan out.
    """
    data = sb.rpc("bgb_joinable_sessions", {"p_viewer": viewer_id}).execute().data
    return [JoinableSession.model_validate(item) for item in (data or [])]
