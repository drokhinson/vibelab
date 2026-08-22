"""Play logging endpoints.

Game-buddy endpoints used to live here under the legacy one-way model. The
new mutual graph lives in buddy_routes.py.
"""

import logging
import uuid
from typing import Optional

from fastapi import Depends, Path, Query, HTTPException, UploadFile, File

from db import get_supabase

from . import router
from .models import (
    MessageResponse,
    PlayCreate,
    PlayExpansionRef,
    PlayLeaveResponse,
    PlayListResponse,
    PlayPhotoAttach,
    PlayPhotoResponse,
    PlayPlayerResponse,
    PlayResponse,
    PlayUpdate,
)
from .dependencies import CurrentUser, get_current_user
from .services import played_with_service
from .services._helpers import raise_for_rpc_error

logger = logging.getLogger(__name__)

# FK hint required: once boardgamebuddy_play_expansions exists, PostgREST sees
# two relationships between plays and games (direct game_id FK + via the
# junction) and refuses to auto-pick — so we name the FK explicitly.
_SELECT_PLAY = (
    "id, user_id, game_id, played_at, notes, photo_url, play_mode, created_at, "
    "boardgamebuddy_games!boardgamebuddy_plays_game_id_fkey(name, thumbnail_url), "
    "boardgamebuddy_profiles!user_id(display_name)"
)

PLAYS_BUCKET = "boardgamebuddy-plays"
_ALLOWED_PHOTO_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif"}
_MAX_PHOTO_BYTES = 5 * 1024 * 1024  # mirrors the bucket's file_size_limit


def _build_play_response(
    play: dict,
    *,
    is_own: bool,
    players_by_play: dict[str, list[PlayPlayerResponse]],
    expansions_by_play: dict[str, list[PlayExpansionRef]] | None = None,
) -> PlayResponse:
    game = play.get("boardgamebuddy_games") or {}
    logger_profile = play.get("boardgamebuddy_profiles") or {}
    return PlayResponse(
        id=play["id"],
        game_id=play["game_id"],
        game_name=game.get("name", "Unknown"),
        game_thumbnail=game.get("thumbnail_url"),
        played_at=play["played_at"],
        notes=play.get("notes"),
        players=players_by_play.get(play["id"], []),
        photo_url=play.get("photo_url"),
        expansions=(expansions_by_play or {}).get(play["id"], []),
        created_at=play["created_at"],
        play_mode=play.get("play_mode") or "competitive",
        logged_by_id=play["user_id"],
        logged_by_name=logger_profile.get("display_name", "Unknown"),
        is_own=is_own,
    )


def _fetch_players(sb, play_ids: list[str]) -> dict[str, list[PlayPlayerResponse]]:
    """Bulk-fetch players for a list of play IDs (no N+1).

    Reads from the post-migration-009 columns directly so the response survives
    migration 013 dropping buddy_id. The legacy buddies-table join is gone;
    real-account players resolve their display name from their profile, and
    free-text ghost players use player_display_name.
    """
    players_by_play: dict[str, list[PlayPlayerResponse]] = {pid: [] for pid in play_ids}
    if not play_ids:
        return players_by_play

    pps = (
        sb.table("boardgamebuddy_play_players")
        .select("play_id, player_user_id, player_display_name, is_winner, score, round_scores")
        .in_("play_id", play_ids)
        .execute()
    )
    rows = pps.data or []

    profile_ids = [r["player_user_id"] for r in rows if r.get("player_user_id")]
    profile_lookup: dict[str, dict] = {}
    if profile_ids:
        prof = (
            sb.table("boardgamebuddy_profiles")
            .select("id, display_name, avatar")
            .in_("id", list(set(profile_ids)))
            .execute()
        )
        profile_lookup = {p["id"]: p for p in (prof.data or [])}

    for row in rows:
        uid = row.get("player_user_id")
        prof_row = profile_lookup.get(uid) if uid else None
        name = (
            (prof_row.get("display_name") if prof_row else None)
            or row.get("player_display_name")
            or "Unknown"
        )
        players_by_play.setdefault(row["play_id"], []).append(
            PlayPlayerResponse(
                user_id=uid,
                name=name,
                avatar=(prof_row or {}).get("avatar"),
                is_winner=row.get("is_winner", False),
                score=row.get("score"),
                round_scores=row.get("round_scores"),
            )
        )
    return players_by_play


def _fetch_play_expansions(
    sb, play_ids: list[str]
) -> dict[str, list[PlayExpansionRef]]:
    """Bulk-fetch expansions used for a list of plays (no N+1)."""
    out: dict[str, list[PlayExpansionRef]] = {pid: [] for pid in play_ids}
    if not play_ids:
        return out
    rows = (
        sb.table("boardgamebuddy_play_expansions")
        .select(
            "play_id, expansion_game_id, "
            "boardgamebuddy_games(name, expansion_color)"
        )
        .in_("play_id", play_ids)
        .execute()
    )
    for row in rows.data or []:
        game = row.get("boardgamebuddy_games") or {}
        out.setdefault(row["play_id"], []).append(
            PlayExpansionRef(
                expansion_game_id=row["expansion_game_id"],
                name=game.get("name", "Unknown"),
                color=game.get("expansion_color"),
            )
        )
    return out


def _load_play_response(sb, play_id: str, viewer_id: str) -> PlayResponse:
    """Read one stored play back and shape it as a PlayResponse.

    Shared by GET /plays/{id} and by log_play's duplicate branch, where the
    client re-sent a client_key we already have a row for: what it MEANT to
    write can differ from what actually landed, so the answer has to come from
    the stored row rather than from the payload in hand.
    """
    res = (
        sb.table("boardgamebuddy_plays")
        .select(_SELECT_PLAY)
        .eq("id", play_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Play not found")
    row = res.data[0]
    return _build_play_response(
        row,
        is_own=row["user_id"] == viewer_id,
        players_by_play=_fetch_players(sb, [play_id]),
        expansions_by_play=_fetch_play_expansions(sb, [play_id]),
    )


def _write_play_players(sb, play_id: str, players: list) -> list[PlayPlayerResponse]:
    """Insert the play_players rows for a play in ONE bulk statement.

    Writes go through the new (post-migration-009) columns directly:
    player_user_id for real-account players, player_display_name as the
    free-text label. This was previously one round trip PER PLAYER (a
    5-player log = 10 round trips, paid again by every session finalize).
    """
    out: list[PlayPlayerResponse] = []
    if not players:
        return out

    rows: list[dict] = []
    for p in players:
        round_scores = getattr(p, "round_scores", None)
        row: dict = {
            "play_id": play_id,
            "is_winner": p.is_winner,
            "score": p.score,
            "player_display_name": p.name,
            "round_scores": round_scores,
        }
        player_uid = getattr(p, "user_id", None)
        if player_uid:
            row["player_user_id"] = player_uid
        rows.append(row)
        out.append(PlayPlayerResponse(
            user_id=player_uid,
            name=p.name,
            is_winner=p.is_winner,
            score=p.score,
            round_scores=round_scores,
        ))
    sb.table("boardgamebuddy_play_players").insert(rows).execute()
    return out


def _write_play_expansions(sb, play_id: str, expansion_ids: list[str]) -> None:
    """Bulk-insert the expansion-game junction rows. Skips empties."""
    rows = [
        {"play_id": play_id, "expansion_game_id": eid}
        for eid in expansion_ids
        if eid
    ]
    if rows:
        sb.table("boardgamebuddy_play_expansions").insert(rows).execute()


@router.get(
    "/plays",
    response_model=PlayListResponse,
    status_code=200,
    summary="List play history (own + shared)",
)
async def list_plays(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    game_id: Optional[str] = Query(None, description="Filter by game UUID"),
    buddy_id: Optional[str] = Query(None, description="Filter by buddy participant UUID"),
    search: Optional[str] = Query(
        None,
        description="Free-text filter: matches game name OR any player's display name",
    ),
    user_id: Optional[str] = Query(
        None,
        description="Target user (profiles are public); defaults to the viewer",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> PlayListResponse:
    """List plays the target user logged + participated in (paginated, latest first)."""
    sb = get_supabase()
    target_user_id = user_id or user.user_id

    # Single RPC (migration 039). The old path fetched EVERY visible play
    # tuple, merged/sorted/paginated in Python, then hydrated players and
    # expansions — 8-11 sequential round trips per History-tab page.
    data = (
        sb.rpc("bgb_plays_page", {
            "p_target": target_user_id,
            "p_page": page,
            "p_per_page": per_page,
            "p_game": game_id,
            "p_buddy": buddy_id,
            "p_search": search,
        })
        .execute()
        .data
        or {}
    )
    plays = [PlayResponse.model_validate(p) for p in data.get("plays") or []]
    return PlayListResponse(
        plays=plays,
        total=data.get("total") or 0,
        page=page,
        per_page=per_page,
    )


@router.post(
    "/plays",
    response_model=PlayResponse,
    status_code=201,
    summary="Log a play",
)
async def log_play(
    body: PlayCreate,
    user: CurrentUser = Depends(get_current_user),
) -> PlayResponse:
    """Record a game play with players and winner (idempotent when client_key is set).

    One round trip: bgb_log_play (migration 042) resolves the game, inserts
    the play with its denormalized game columns and bulk-writes the player and
    expansion rows, returning the PlayResponse-shaped payload — replacing six
    sequential PostgREST calls.

    When the body carries a client_key (migration 048), a repeat of a key
    already stored returns the original play instead of writing a second one.
    That is what makes the offline outbox safe to retry after a lost response.
    """
    sb = get_supabase()
    data = (
        sb.rpc("bgb_log_play", {
            "p_user": user.user_id,
            "p_payload": body.model_dump(mode="json"),
        })
        .execute()
        .data
    )
    raise_for_rpc_error(data, "Log play")
    # A client_key we already hold a play for (migration 048) — an offline
    # outbox retry after a lost response. The RPC wrote nothing and handed
    # back the original row's id; answer with the play that actually exists
    # rather than the payload this attempt carried. Still 201: from the
    # client's side the play is recorded either way.
    if isinstance(data, dict) and data.get("duplicate"):
        return _load_play_response(sb, data["id"], user.user_id)
    return PlayResponse.model_validate(data)


@router.get(
    "/plays/{play_id}",
    response_model=PlayResponse,
    status_code=200,
    summary="Get a single play",
)
async def get_play(
    play_id: str = Path(..., description="Play UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayResponse:
    """Return a single play with players, scores, expansions, and photo."""
    # Any authenticated user can read a play — the feed surfaces a buddy's
    # play even when the viewer wasn't a participant, and tapping through
    # should succeed. Writes/deletes stay owner-only (gated inline in
    # update_play / delete_play); `is_own` tells the frontend which is which.
    return _load_play_response(get_supabase(), play_id, user.user_id)


@router.put(
    "/plays/{play_id}",
    response_model=PlayResponse,
    status_code=200,
    summary="Update a play",
)
async def update_play(
    body: PlayUpdate,
    play_id: str = Path(..., description="Play UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayResponse:
    """Replace a play's top-level fields and its players/expansions lists (owner only)."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_plays")
        .select("id, user_id, game_id")
        .eq("id", play_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Play not found")
    if existing.data[0]["user_id"] != user.user_id:
        raise HTTPException(status_code=403, detail="Not allowed")

    # Update the top-level row. play_mode is only written when the request
    # carries one — omitting it leaves whatever was already on the play.
    update_payload: dict[str, object] = {
        "played_at": body.played_at.isoformat(),
        "notes": body.notes,
        "photo_url": body.photo_url,
    }
    if body.play_mode is not None:
        update_payload["play_mode"] = body.play_mode.value
    sb.table("boardgamebuddy_plays").update(update_payload).eq("id", play_id).execute()

    # Full-replace the nested lists.
    sb.table("boardgamebuddy_play_players").delete().eq("play_id", play_id).execute()
    sb.table("boardgamebuddy_play_expansions").delete().eq("play_id", play_id).execute()
    _write_play_players(sb, play_id, body.players)
    _write_play_expansions(sb, play_id, body.expansion_ids)

    res = (
        sb.table("boardgamebuddy_plays")
        .select(_SELECT_PLAY)
        .eq("id", play_id)
        .execute()
    )
    row = res.data[0]
    players_by_play = _fetch_players(sb, [play_id])
    expansions_by_play = _fetch_play_expansions(sb, [play_id])
    return _build_play_response(
        row,
        is_own=True,
        players_by_play=players_by_play,
        expansions_by_play=expansions_by_play,
    )


@router.post(
    "/plays/photo",
    response_model=PlayPhotoResponse,
    status_code=201,
    summary="Upload a play photo",
)
async def upload_play_photo(
    file: UploadFile = File(..., description="Image file (jpg/png/webp/gif, ≤5 MiB)"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayPhotoResponse:
    """Upload a single image to the play-photos bucket and return its public URL."""
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in _ALLOWED_PHOTO_MIME:
        raise HTTPException(status_code=400, detail="Unsupported image type")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > _MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds 5 MB limit")

    ext = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(content_type, "jpg")
    path = f"{user.user_id}/{uuid.uuid4().hex}.{ext}"

    sb = get_supabase()
    try:
        sb.storage.from_(PLAYS_BUCKET).upload(
            path, data, {"content-type": content_type, "upsert": "true"}
        )
    except Exception as exc:  # storage SDK raises a custom exception type
        logger.warning("Play photo upload failed %s: %s", path, exc)
        raise HTTPException(status_code=502, detail="Upload failed")
    return PlayPhotoResponse(photo_url=sb.storage.from_(PLAYS_BUCKET).get_public_url(path))


@router.patch(
    "/plays/{play_id}/photo",
    response_model=MessageResponse,
    status_code=200,
    summary="Attach a photo URL to a play (owner only)",
)
async def attach_play_photo(
    body: PlayPhotoAttach,
    play_id: str = Path(..., description="Play UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Set a play's photo_url without touching its players or expansions.

    The log-play flow saves the play first and uploads the photo alongside
    it, so all that's left is writing one column. Routing that through
    PUT /plays/{id} cost twelve round trips and tore down and re-inserted
    every player and expansion row; this is one.

    Ownership is enforced by the WHERE clause rather than a prior SELECT —
    PostgREST returns the updated rows, so an empty result means the play is
    missing or belongs to someone else. Both are reported as 404 so the
    endpoint doesn't confirm the existence of other users' plays.
    """
    res = (
        get_supabase()
        .table("boardgamebuddy_plays")
        .update({"photo_url": body.photo_url})
        .eq("id", play_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Play not found")
    return MessageResponse(message="Photo attached")


@router.delete(
    "/plays/{play_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a play",
)
async def delete_play(
    play_id: str = Path(..., description="Play UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a play log entry.

    Ownership rides in the WHERE clause, so a missing play and someone else's
    both report 404 rather than reporting success for a delete that did
    nothing. There is deliberately no separate play_players delete:
    play_players.play_id is ON DELETE CASCADE (001_baseline.sql:190), and the
    explicit version this replaces was scoped by play_id ALONE — any signed-in
    user could strip every player, winner and score off anyone's play, and the
    endpoint still answered 200. RLS is not a backstop here; the backend holds
    the service-role key.
    """
    res = (
        get_supabase()
        .table("boardgamebuddy_plays")
        .delete()
        .eq("id", play_id)
        .eq("user_id", user.user_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Play not found")

    return MessageResponse(message="Play deleted")


@router.post(
    "/plays/{play_id}/leave",
    response_model=PlayLeaveResponse,
    status_code=200,
    summary="Remove yourself from a play",
)
async def leave_play(
    play_id: str = Path(..., description="Play UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayLeaveResponse:
    """Self-remove from a play you didn't take part in: turns your player row
    into a ghost (nulls player_user_id, keeps the name) instead of deleting the
    play. The owner keeps the play; you drop out of your own history."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_plays")
        .select("id, user_id")
        .eq("id", play_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Play not found")
    if existing.data[0]["user_id"] == user.user_id:
        raise HTTPException(
            status_code=400,
            detail="You logged this play — edit or delete it instead.",
        )

    n = played_with_service.ghost_out_of_play(
        sb, user.user_id, play_id, user.display_name
    )
    if n == 0:
        raise HTTPException(status_code=404, detail="You are not a player in this play")
    return PlayLeaveResponse(rows_updated=n)


