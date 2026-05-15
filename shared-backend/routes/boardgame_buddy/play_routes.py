"""Play logging and game buddies endpoints."""

import logging
import uuid
from typing import Optional

from fastapi import Depends, Path, Query, HTTPException, UploadFile, File

from db import get_supabase

from . import router
from .models import (
    BuddyLinkBody,
    BuddyResponse,
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
    "id, user_id, game_id, played_at, notes, photo_url, created_at, "
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
        logged_by_id=play["user_id"],
        logged_by_name=logger_profile.get("display_name", "Unknown"),
        is_own=is_own,
    )


def _fetch_players(sb, play_ids: list[str]) -> dict[str, list[PlayPlayerResponse]]:
    """Bulk-fetch players for a list of play IDs (no N+1)."""
    players_by_play: dict[str, list[PlayPlayerResponse]] = {pid: [] for pid in play_ids}
    if play_ids:
        pps = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id, buddy_id, is_winner, score, boardgamebuddy_buddies(name)")
            .in_("play_id", play_ids)
            .execute()
        )
        for row in pps.data or []:
            players_by_play.setdefault(row["play_id"], []).append(
                PlayPlayerResponse(
                    buddy_id=row["buddy_id"],
                    name=(row.get("boardgamebuddy_buddies") or {}).get("name", "Unknown"),
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
    """Create buddy rows as needed and insert play_players for a single play."""
    out: list[PlayPlayerResponse] = []
    for p in players:
        buddy = _upsert_buddy(sb, user_id, p.name)
        sb.table("boardgamebuddy_play_players").insert({
            "play_id": play_id,
            "buddy_id": buddy["id"],
            "is_winner": p.is_winner,
            "score": p.score,
        }).execute()
        out.append(PlayPlayerResponse(
            buddy_id=buddy["id"],
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
    """Allow the play's owner or any linked-buddy participant to read it."""
    if play_row["user_id"] == user.user_id:
        return True
    # Find buddies owned by this play's logger that link to the current user.
    linked = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("linked_user_id", user.user_id)
        .execute()
    )
    buddy_ids = [b["id"] for b in linked.data or []]
    if not buddy_ids:
        return False
    pp = (
        sb.table("boardgamebuddy_play_players")
        .select("play_id")
        .eq("play_id", play_row["id"])
        .in_("buddy_id", buddy_ids)
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
    user: CurrentUser = Depends(get_current_user),
) -> PlayListResponse:
    """List plays the current user logged (paginated, latest first), with optional filters."""
    sb = get_supabase()
    offset = (page - 1) * per_page

    # Pre-fetch play_ids where the filtered buddy participated (used as an ID filter below).
    buddy_play_ids: set[str] | None = None
    if buddy_id:
        bpp = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id")
            .eq("buddy_id", buddy_id)
            .execute()
        )
        buddy_play_ids = {r["play_id"] for r in bpp.data or []}
        if not buddy_play_ids:
            return PlayListResponse(plays=[], total=0, page=page, per_page=per_page)

    # ── Collect lightweight (id, played_at, created_at, is_own) tuples ────────
    own_q = (
        sb.table("boardgamebuddy_plays")
        .select("id, played_at, created_at")
        .eq("user_id", user.user_id)
    )
    if game_id:
        own_q = own_q.eq("game_id", game_id)
    if buddy_play_ids is not None:
        own_q = own_q.in_("id", list(buddy_play_ids))
    own_tuples: list[tuple[str, str, str, bool]] = [
        (r["id"], r["played_at"], r["created_at"], True)
        for r in (own_q.execute().data or [])
    ]
    own_ids_set = {t[0] for t in own_tuples}

    # Shared plays: current user appears as a linked buddy.
    linked = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("linked_user_id", user.user_id)
        .execute()
    )
    user_buddy_ids = [b["id"] for b in linked.data or []]
    shared_tuples: list[tuple[str, str, str, bool]] = []

    if user_buddy_ids:
        shared_pp = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id")
            .in_("buddy_id", user_buddy_ids)
            .execute()
        )
        candidate_ids = {r["play_id"] for r in shared_pp.data or []} - own_ids_set
        if buddy_play_ids is not None:
            candidate_ids &= buddy_play_ids
        if candidate_ids:
            shared_q = (
                sb.table("boardgamebuddy_plays")
                .select("id, played_at, created_at")
                .in_("id", list(candidate_ids))
                .neq("user_id", user.user_id)
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

    # Verify game exists
    game = (
        sb.table("boardgamebuddy_games")
        .select("id, name, thumbnail_url")
        .eq("id", body.game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    game_row = game.data[0]

    # Create play
    play_result = (
        sb.table("boardgamebuddy_plays")
        .insert({
            "user_id": user.user_id,
            "game_id": body.game_id,
            "played_at": body.played_at.isoformat(),
            "notes": body.notes,
            "photo_url": body.photo_url,
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

    # Update the top-level row.
    sb.table("boardgamebuddy_plays").update({
        "played_at": body.played_at.isoformat(),
        "notes": body.notes,
        "photo_url": body.photo_url,
    }).eq("id", play_id).execute()

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


@router.get(
    "/buddies",
    response_model=list[BuddyResponse],
    status_code=200,
    summary="List game buddies",
)
async def list_buddies(
    user: CurrentUser = Depends(get_current_user),
) -> list[BuddyResponse]:
    """
    List all game buddies for the current user, with the linked profile's
    display name (when linked) and the play_count across all sessions.
    """
    sb = get_supabase()

    rows = (
        sb.table("boardgamebuddy_buddies")
        .select(
            "id, name, linked_user_id, created_at, "
            "boardgamebuddy_profiles!linked_user_id(display_name), "
            "boardgamebuddy_play_players(count)"
        )
        .eq("owner_id", user.user_id)
        .execute()
    )

    out: list[BuddyResponse] = []
    for r in rows.data or []:
        linked_profile = r.get("boardgamebuddy_profiles") or {}
        # Embedded count is returned as [{"count": N}] from PostgREST.
        pp = r.get("boardgamebuddy_play_players") or []
        play_count = pp[0]["count"] if pp and isinstance(pp, list) else 0
        out.append(BuddyResponse(
            id=r["id"],
            name=r["name"],
            linked_user_id=r.get("linked_user_id"),
            linked_display_name=linked_profile.get("display_name"),
            play_count=play_count,
            created_at=r["created_at"],
        ))

    # Sort alphabetically by the display name the user actually sees.
    out.sort(key=lambda b: (b.linked_display_name or b.name).lower())
    return out


@router.post(
    "/buddies",
    response_model=BuddyResponse,
    status_code=201,
    summary="Add a buddy by user account",
)
async def add_buddy(
    body: BuddyLinkBody,
    user: CurrentUser = Depends(get_current_user),
) -> BuddyResponse:
    """Create a new buddy directly linked to an existing user account."""
    sb = get_supabase()

    if body.user_id == user.user_id:
        raise HTTPException(status_code=400, detail="Cannot add yourself as a buddy")

    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name")
        .eq("id", body.user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="User not found")
    target_name: str = target.data[0]["display_name"]

    # Idempotent: already linked to this user
    existing = (
        sb.table("boardgamebuddy_buddies")
        .select("id, name, linked_user_id, created_at, boardgamebuddy_play_players(count)")
        .eq("owner_id", user.user_id)
        .eq("linked_user_id", body.user_id)
        .execute()
    )
    if existing.data:
        r = existing.data[0]
        pp = r.get("boardgamebuddy_play_players") or []
        return BuddyResponse(
            id=r["id"],
            name=r["name"],
            linked_user_id=r.get("linked_user_id"),
            linked_display_name=target_name,
            play_count=pp[0]["count"] if pp else 0,
            created_at=r["created_at"],
        )

    # Name collision: link an existing unlinked buddy with the same name
    collision = (
        sb.table("boardgamebuddy_buddies")
        .select("id, name, created_at, boardgamebuddy_play_players(count)")
        .eq("owner_id", user.user_id)
        .eq("name", target_name)
        .is_("linked_user_id", "null")
        .execute()
    )
    if collision.data:
        c = collision.data[0]
        sb.table("boardgamebuddy_buddies").update(
            {"linked_user_id": body.user_id}
        ).eq("id", c["id"]).execute()
        pp = c.get("boardgamebuddy_play_players") or []
        return BuddyResponse(
            id=c["id"],
            name=c["name"],
            linked_user_id=body.user_id,
            linked_display_name=target_name,
            play_count=pp[0]["count"] if pp else 0,
            created_at=c["created_at"],
        )

    # Default: create new buddy row linked to the target account
    result = (
        sb.table("boardgamebuddy_buddies")
        .insert({
            "owner_id": user.user_id,
            "name": target_name,
            "linked_user_id": body.user_id,
        })
        .execute()
    )
    r = result.data[0]
    return BuddyResponse(
        id=r["id"],
        name=r["name"],
        linked_user_id=body.user_id,
        linked_display_name=target_name,
        play_count=0,
        created_at=r["created_at"],
    )


@router.post(
    "/buddies/{buddy_id}/link",
    response_model=MessageResponse,
    status_code=200,
    summary="Link buddy to user account",
)
async def link_buddy(
    body: BuddyLinkBody,
    buddy_id: str = Path(..., description="Buddy UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """
    Link a free-text buddy to another user's BoardgameBuddy account.

    Linking is one-way and consolidates duplicates: if the current user already
    has another buddy linked to the same target, all play_players from this
    buddy are re-pointed to the existing one and this buddy row is deleted.
    """
    sb = get_supabase()

    # Verify buddy belongs to current user
    buddy = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("id", buddy_id)
        .eq("owner_id", user.user_id)
        .execute()
    )
    if not buddy.data:
        raise HTTPException(status_code=404, detail="Buddy not found")

    # Verify target user exists, capture display_name so future autocomplete
    # picks of that name reuse this same buddy row.
    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name")
        .eq("id", body.user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="Target user not found")
    target_name = target.data[0]["display_name"]

    # Find an existing buddy by this owner already linked to the target.
    existing = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("owner_id", user.user_id)
        .eq("linked_user_id", body.user_id)
        .neq("id", buddy_id)
        .execute()
    )
    if existing.data:
        # MERGE: re-point all play_players from this buddy to the existing one,
        # then delete this buddy row.
        target_buddy_id = existing.data[0]["id"]
        sb.table("boardgamebuddy_play_players").update(
            {"buddy_id": target_buddy_id}
        ).eq("buddy_id", buddy_id).execute()
        sb.table("boardgamebuddy_buddies").delete().eq("id", buddy_id).execute()
        return MessageResponse(message="Buddy merged into linked account")

    # If the target's display_name collides with another (unlinked) buddy of
    # the same owner, merge that one in first to preserve UNIQUE(owner,name).
    if target_name:
        collision = (
            sb.table("boardgamebuddy_buddies")
            .select("id")
            .eq("owner_id", user.user_id)
            .eq("name", target_name)
            .neq("id", buddy_id)
            .execute()
        )
        if collision.data:
            collision_id = collision.data[0]["id"]
            sb.table("boardgamebuddy_play_players").update(
                {"buddy_id": buddy_id}
            ).eq("buddy_id", collision_id).execute()
            sb.table("boardgamebuddy_buddies").delete().eq("id", collision_id).execute()

    # Plain link — set linked_user_id and rename to the linked display_name so
    # autocomplete picks of that name reuse this buddy on subsequent plays.
    sb.table("boardgamebuddy_buddies").update({
        "linked_user_id": body.user_id,
        "name": target_name,
    }).eq("id", buddy_id).execute()

    return MessageResponse(message="Buddy linked to user account")
