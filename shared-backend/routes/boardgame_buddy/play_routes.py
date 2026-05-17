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
from .game_routes import play_denormalized_from_game
from .models import (
    MessageResponse,
    PlayCountResponse,
    PlayCreate,
    PlayExpansionRef,
    PlayFilterOption,
    PlayFilterOptions,
    PlayListResponse,
    PlayPhotoResponse,
    PlayPlayerResponse,
    PlayResponse,
    PlayUpdate,
)
from .dependencies import CurrentUser, get_current_user

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
        .select("play_id, player_user_id, player_display_name, is_winner, score")
        .in_("play_id", play_ids)
        .execute()
    )
    rows = pps.data or []

    profile_ids = [r["player_user_id"] for r in rows if r.get("player_user_id")]
    profile_names: dict[str, str] = {}
    if profile_ids:
        prof = (
            sb.table("boardgamebuddy_profiles")
            .select("id, display_name")
            .in_("id", list(set(profile_ids)))
            .execute()
        )
        profile_names = {p["id"]: p["display_name"] for p in (prof.data or [])}

    for row in rows:
        uid = row.get("player_user_id")
        name = (
            profile_names.get(uid)
            if uid else None
        ) or row.get("player_display_name") or "Unknown"
        players_by_play.setdefault(row["play_id"], []).append(
            PlayPlayerResponse(
                buddy_id=None,
                user_id=uid,
                name=name,
                is_winner=row.get("is_winner", False),
                score=row.get("score"),
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


def _upsert_buddy(sb, user_id: str, name: str) -> dict:
    """Find or create a buddy row for (owner_id=user_id, name)."""
    result = (
        sb.table("boardgamebuddy_buddies")
        .upsert(
            {"owner_id": user_id, "name": name},
            on_conflict="owner_id,name",
        )
        .execute()
    )
    return result.data[0]


def _write_play_players(sb, play_id: str, user_id: str, players: list) -> list[PlayPlayerResponse]:
    """Insert one play_players row per player.

    Writes go through the new (post-migration-009) columns directly:
    player_user_id for real-account players, player_display_name as the
    free-text label. The legacy boardgamebuddy_buddies upsert is kept so the
    Plays-by-buddy filter in the legacy admin tools still has a roster to
    pick from, but the play_players row no longer references it.
    """
    out: list[PlayPlayerResponse] = []
    for p in players:
        # Keep populating the legacy buddies roster for the current owner so
        # the autocomplete picker in admin tools still has something to show.
        _upsert_buddy(sb, user_id, p.name)
        row: dict = {
            "play_id": play_id,
            "is_winner": p.is_winner,
            "score": p.score,
            "player_display_name": p.name,
        }
        player_uid = getattr(p, "user_id", None)
        if player_uid:
            row["player_user_id"] = player_uid
        sb.table("boardgamebuddy_play_players").insert(row).execute()
        out.append(PlayPlayerResponse(
            buddy_id=None,
            user_id=player_uid,
            name=p.name,
            is_winner=p.is_winner,
            score=p.score,
        ))
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


async def _user_can_view_play(sb, user, play_row: dict) -> bool:
    """Allow the play's owner or any participant resolved to a real account."""
    if play_row["user_id"] == user.user_id:
        return True
    # After migration 009, play_players carries player_user_id directly — no
    # need to go through the legacy per-owner buddies table.
    pp = (
        sb.table("boardgamebuddy_play_players")
        .select("play_id")
        .eq("play_id", play_row["id"])
        .eq("player_user_id", user.user_id)
        .execute()
    )
    return bool(pp.data)


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
    offset = (page - 1) * per_page
    target_user_id = user_id or user.user_id

    # Pre-compute the set of play_ids that match the free-text search across
    # game names and player display names. Done in one pass each so the main
    # own_q / shared_q queries can just intersect.
    search_play_ids: set[str] | None = None
    if search and search.strip():
        s = search.strip()
        game_match_play_ids: set[str] = set()
        game_rows = (
            sb.table("boardgamebuddy_games")
            .select("id")
            .ilike("name", f"%{s}%")
            .execute()
        )
        game_ids_match = [g["id"] for g in (game_rows.data or [])]
        if game_ids_match:
            gp = (
                sb.table("boardgamebuddy_plays")
                .select("id")
                .in_("game_id", game_ids_match)
                .execute()
            )
            game_match_play_ids = {r["id"] for r in (gp.data or [])}
        player_match = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id")
            .ilike("player_display_name", f"%{s}%")
            .execute()
        )
        player_match_play_ids = {r["play_id"] for r in (player_match.data or [])}
        search_play_ids = game_match_play_ids | player_match_play_ids
        if not search_play_ids:
            return PlayListResponse(plays=[], total=0, page=page, per_page=per_page)

    # Pre-fetch play_ids where the filtered player participated (used as an
    # ID filter below). The query param is named buddy_id for FE compat but
    # is now treated as a player_user_id lookup post-migration-009.
    buddy_play_ids: set[str] | None = None
    if buddy_id:
        bpp = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id")
            .eq("player_user_id", buddy_id)
            .execute()
        )
        buddy_play_ids = {r["play_id"] for r in bpp.data or []}
        if not buddy_play_ids:
            return PlayListResponse(plays=[], total=0, page=page, per_page=per_page)

    # ── Collect lightweight (id, played_at, created_at, is_own) tuples ────────
    own_q = (
        sb.table("boardgamebuddy_plays")
        .select("id, played_at, created_at")
        .eq("user_id", target_user_id)
    )
    if game_id:
        own_q = own_q.eq("game_id", game_id)
    if buddy_play_ids is not None:
        own_q = own_q.in_("id", list(buddy_play_ids))
    if search_play_ids is not None:
        own_q = own_q.in_("id", list(search_play_ids))
    own_tuples: list[tuple[str, str, str, bool]] = [
        (r["id"], r["played_at"], r["created_at"], True)
        for r in (own_q.execute().data or [])
    ]
    own_ids_set = {t[0] for t in own_tuples}

    # Shared plays: target user appears as a play participant (via
    # player_user_id, set by either the new write path or the migration-009
    # backfill from buddies.linked_user_id).
    shared_tuples: list[tuple[str, str, str, bool]] = []
    shared_pp = (
        sb.table("boardgamebuddy_play_players")
        .select("play_id")
        .eq("player_user_id", target_user_id)
        .execute()
    )
    shared_play_ids_raw = {r["play_id"] for r in shared_pp.data or []}
    if shared_play_ids_raw:
        candidate_ids = shared_play_ids_raw - own_ids_set
        if buddy_play_ids is not None:
            candidate_ids &= buddy_play_ids
        if search_play_ids is not None:
            candidate_ids &= search_play_ids
        if candidate_ids:
            shared_q = (
                sb.table("boardgamebuddy_plays")
                .select("id, played_at, created_at")
                .in_("id", list(candidate_ids))
                .neq("user_id", target_user_id)
            )
            if game_id:
                shared_q = shared_q.eq("game_id", game_id)
            shared_tuples = [
                (r["id"], r["played_at"], r["created_at"], False)
                for r in (shared_q.execute().data or [])
            ]

    # ── Merge, sort, paginate ────────────────────────────────────────────────
    all_tuples = own_tuples + shared_tuples
    all_tuples.sort(key=lambda t: (t[1], t[2]), reverse=True)
    total = len(all_tuples)
    page_tuples = all_tuples[offset : offset + per_page]

    if not page_tuples:
        return PlayListResponse(plays=[], total=total, page=page, per_page=per_page)

    # ── Fetch full rows only for this page ───────────────────────────────────
    page_own_ids = [t[0] for t in page_tuples if t[3]]
    page_shared_ids = [t[0] for t in page_tuples if not t[3]]

    rows_by_id: dict[str, tuple[dict, bool]] = {}
    if page_own_ids:
        res = sb.table("boardgamebuddy_plays").select(_SELECT_PLAY).in_("id", page_own_ids).execute()
        for r in res.data or []:
            rows_by_id[r["id"]] = (r, True)
    if page_shared_ids:
        res = sb.table("boardgamebuddy_plays").select(_SELECT_PLAY).in_("id", page_shared_ids).execute()
        for r in res.data or []:
            rows_by_id[r["id"]] = (r, False)

    page_ids = [t[0] for t in page_tuples]
    players_by_play = _fetch_players(sb, page_ids)
    expansions_by_play = _fetch_play_expansions(sb, page_ids)

    result = []
    for play_id, _, _, _ in page_tuples:
        if play_id in rows_by_id:
            row, is_own = rows_by_id[play_id]
            result.append(_build_play_response(
                row,
                is_own=is_own,
                players_by_play=players_by_play,
                expansions_by_play=expansions_by_play,
            ))
    return PlayListResponse(plays=result, total=total, page=page, per_page=per_page)


@router.get(
    "/plays/filter-options",
    response_model=PlayFilterOptions,
    status_code=200,
    summary="Filter options for play log",
)
async def get_play_filter_options(
    user: CurrentUser = Depends(get_current_user),
) -> PlayFilterOptions:
    """Return distinct games and buddies for the play log filter dropdowns."""
    sb = get_supabase()

    games_q = (
        sb.table("boardgamebuddy_plays")
        .select(
            "game_id, "
            "boardgamebuddy_games!boardgamebuddy_plays_game_id_fkey(name)"
        )
        .eq("user_id", user.user_id)
        .execute()
    )
    games_seen: dict[str, str] = {}
    for r in games_q.data or []:
        gid = r["game_id"]
        if gid not in games_seen:
            games_seen[gid] = (r.get("boardgamebuddy_games") or {}).get("name", "Unknown")
    games = sorted(
        [PlayFilterOption(id=gid, name=name) for gid, name in games_seen.items()],
        key=lambda g: g.name.lower(),
    )

    buddies_q = (
        sb.table("boardgamebuddy_buddies")
        .select("id, name")
        .eq("owner_id", user.user_id)
        .execute()
    )
    buddies = sorted(
        [PlayFilterOption(id=r["id"], name=r["name"]) for r in buddies_q.data or []],
        key=lambda b: b.name.lower(),
    )

    return PlayFilterOptions(games=games, buddies=buddies)


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
    """Record a game play with players and winner."""
    sb = get_supabase()

    # Verify game exists; also fetch its play_mode so we can inherit it
    # when the request didn't override + image_url for the new play row's
    # denormalized cache (migration 020).
    game = (
        sb.table("boardgamebuddy_games")
        .select("id, name, thumbnail_url, image_url, play_mode")
        .eq("id", body.game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    game_row = game.data[0]
    effective_mode = (
        body.play_mode.value
        if body.play_mode is not None
        else (game_row.get("play_mode") or "competitive")
    )

    # Create play
    play_result = (
        sb.table("boardgamebuddy_plays")
        .insert({
            "user_id": user.user_id,
            "game_id": body.game_id,
            "played_at": body.played_at.isoformat(),
            "notes": body.notes,
            "photo_url": body.photo_url,
            "play_mode": effective_mode,
            **play_denormalized_from_game(game_row),
        })
        .execute()
    )
    play = play_result.data[0]

    players = _write_play_players(sb, play["id"], user.user_id, body.players)
    _write_play_expansions(sb, play["id"], body.expansion_ids)

    expansions = _fetch_play_expansions(sb, [play["id"]]).get(play["id"], [])

    return PlayResponse(
        id=play["id"],
        game_id=play["game_id"],
        game_name=game_row["name"],
        game_thumbnail=game_row.get("thumbnail_url"),
        played_at=play["played_at"],
        notes=play.get("notes"),
        players=players,
        photo_url=play.get("photo_url"),
        expansions=expansions,
        created_at=play["created_at"],
        play_mode=play.get("play_mode") or effective_mode,
        logged_by_id=user.user_id,
        logged_by_name=user.display_name,
        is_own=True,
    )


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
    sb = get_supabase()
    res = (
        sb.table("boardgamebuddy_plays")
        .select(_SELECT_PLAY)
        .eq("id", play_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Play not found")
    row = res.data[0]
    if not await _user_can_view_play(sb, user, row):
        raise HTTPException(status_code=403, detail="Not allowed")

    players_by_play = _fetch_players(sb, [play_id])
    expansions_by_play = _fetch_play_expansions(sb, [play_id])
    return _build_play_response(
        row,
        is_own=row["user_id"] == user.user_id,
        players_by_play=players_by_play,
        expansions_by_play=expansions_by_play,
    )


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
    _write_play_players(sb, play_id, user.user_id, body.players)
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
        raise HTTPException(status_code=413, detail="Image exceeds 5 MiB limit")

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
    """Delete a play log entry."""
    sb = get_supabase()

    # Delete play players first (cascade should handle this, but be explicit)
    sb.table("boardgamebuddy_play_players").delete().eq("play_id", play_id).execute()
    sb.table("boardgamebuddy_plays").delete().eq("id", play_id).eq(
        "user_id", user.user_id
    ).execute()

    return MessageResponse(message="Play deleted")


@router.get(
    "/games/{game_id}/play-count",
    response_model=PlayCountResponse,
    status_code=200,
    summary="Count plays for a game",
)
async def get_play_count(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayCountResponse:
    """Return the number of plays the current user has logged for this game."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_plays")
        .select("id", count="exact")
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .execute()
    )
    return PlayCountResponse(count=result.count or 0)


@router.get(
    "/games/{game_id}/plays",
    response_model=list[PlayResponse],
    status_code=200,
    summary="Play history for a game",
)
async def get_game_plays(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> list[PlayResponse]:
    """Return plays the current user logged for a specific game, newest first."""
    sb = get_supabase()

    rows = (
        sb.table("boardgamebuddy_plays")
        .select(_SELECT_PLAY)
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .order("played_at", desc=True)
        .order("created_at", desc=True)
        .execute()
    )

    play_ids = [r["id"] for r in rows.data or []]
    players_by_play = _fetch_players(sb, play_ids)
    expansions_by_play = _fetch_play_expansions(sb, play_ids)

    return [
        _build_play_response(
            r,
            is_own=True,
            players_by_play=players_by_play,
            expansions_by_play=expansions_by_play,
        )
        for r in rows.data or []
    ]


# Legacy buddy endpoints (GET/POST /buddies, POST /buddies/{id}/link) have
# moved to buddy_routes.py under the mutual-edge model. The legacy
# boardgamebuddy_buddies table is now strictly for free-text ghost players.
