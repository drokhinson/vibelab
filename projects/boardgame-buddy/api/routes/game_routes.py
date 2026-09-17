"""Game catalog endpoints — browse, search, detail, BGG proxy."""

import asyncio
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import Depends, Header, Query, Path, HTTPException
from supabase import Client

import cache
import object_store
from db import get_supabase
from shared_models import HealthResponse

from . import router
from .bgg_collection_read import BGG_THROTTLE_SECONDS
from .bgg_client import (
    BGG_USER_AGENT,
    bgg_description_text,
    fetch_bgg,
    invalidate_bgg_thing_cache,
    normalize_image_url,
    parse_bgg_xml,
    parse_thing_stats,
    thing_item_basics,
    thing_item_publishers,
    thing_item_stats,
)
from .constants import EXPANSION_COLOR_PALETTE, CatalogSort, PlayMode, derive_play_mode
from .dependencies import CurrentUser, get_current_admin, get_current_user, maybe_supabase_user
from .models import (
    GameDetail,
    GameListResponse,
    GameSummary,
    RefreshDescriptionsResponse,
    RefreshImagesResponse,
    RulebookUrlUpdate,
)
from .services import game_service
from .services._helpers import chunked, game_select_clause, page_all, parse_csv_param


# Cache namespaces for game-side reads. Both invalidate on admin writes
# (refresh-images, expansion-color override) and on a fresh BGG import.
#
# shared-backend/cache.py is per-worker; a Redis-backed cache (see that
# module's TODO) would make this cluster-wide and let invalidation target one
# key instead of the whole namespace.
# The admin worklists are a page of work, not an inventory — /admin/review
# carries the counts. Explicit, where PostgREST would otherwise cap silently.
_ADMIN_LIST_LIMIT = 500
_CACHE_GAME = "game.detail"          # game_id (str) → boardgamebuddy_games row dict
_CACHE_GAME_TTL_S = 60 * 60          # games are immutable post-import; 1h is plenty

cache.configure(_CACHE_GAME, max_entries=2000)


def _invalidate_game_caches() -> None:
    """One-shot bust called from every admin path that mutates games (and from
    import). Clears the in-process game row cache and the BGG /thing XML cache
    so a subsequent read sees fresh data.
    """
    cache.clear(_CACHE_GAME)
    invalidate_bgg_thing_cache()

logger = logging.getLogger(__name__)

# The Supabase Storage bucket, kept as the fallback when R2 is unconfigured
# (see object_store.py) and because pre-migration rows keep their supabase.co
# URLs, which the client loads unchanged.
STORAGE_BUCKET = "boardgamebuddy-games"
# A cover's path is `{bgg_id}_{kind}.{ext}`, which a re-import overwrites in
# place — so unlike a play photo this is NOT immutable, and a year-long TTL
# would pin a stale cover in every edge cache. A day is long enough that the
# cache does its job and short enough that a corrected cover lands. R2 branch
# only, for the same reason as the photo header: the fallback stays as it was.
_COVER_CACHE_CONTROL = "public, max-age=86400"


async def _upload_to_storage(sb: Client, bgg_id: int, url: str | None, kind: str) -> str | None:
    """Download a BGG image and re-host it; returns the permanent public URL.

    Re-hosts to R2 when it is configured and to Supabase Storage when it is
    not (see object_store.py for why the fallback exists). Unchanged either
    way: a failure anywhere here returns the original BGG URL rather than
    raising, so an import never fails over cover art.
    """
    if not url:
        return None
    try:
        async with httpx.AsyncClient(
            timeout=15.0,
            headers={"User-Agent": BGG_USER_AGENT},
            follow_redirects=True,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("BGG image download failed bgg_id=%s kind=%s: %s", bgg_id, kind, exc)
        return url
    content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(content_type, "jpg")
    path = f"{bgg_id}_{kind}.{ext}"
    try:
        if object_store.configured(object_store.GAMES):
            return object_store.put(
                object_store.GAMES,
                path,
                resp.content,
                content_type,
                cache_control=_COVER_CACHE_CONTROL,
            )
        sb.storage.from_(STORAGE_BUCKET).upload(
            path, resp.content, {"content-type": content_type, "upsert": "true"}
        )
        return sb.storage.from_(STORAGE_BUCKET).get_public_url(path)
    except Exception as exc:
        logger.warning("Storage upload failed %s: %s", path, exc)
        return url


def _extract_expansion_meta(item: ET.Element) -> tuple[bool, int | None]:
    """Detect whether a BGG item is an expansion and identify its base game.

    BGG marks expansions with `type="boardgameexpansion"` on the <item> tag.
    The base game is the inbound `<link type="boardgameexpansion" inbound="true">`
    — BGG uses the same link type for both directions and disambiguates via
    `inbound`. There can be more than one inbound link when the expansion
    extends multiple base games; we keep the first.
    """
    if item.get("type") != "boardgameexpansion":
        return False, None
    for link in item.findall("link[@type='boardgameexpansion']"):
        if link.get("inbound") != "true":
            continue
        try:
            return True, int(link.get("id", "0")) or None
        except (TypeError, ValueError):
            continue
    return True, None


def _next_expansion_color(sb: Client, base_game_bgg_id: int | None) -> str:
    """Pick the next palette color for a new expansion of this base game."""
    if not base_game_bgg_id:
        return EXPANSION_COLOR_PALETTE[0]
    existing = (
        sb.table("boardgamebuddy_games")
        .select("id", count="exact")
        .eq("is_expansion", True)
        .eq("base_game_bgg_id", base_game_bgg_id)
        .execute()
    )
    idx = (existing.count or 0) % len(EXPANSION_COLOR_PALETTE)
    return EXPANSION_COLOR_PALETTE[idx]


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=200,
    summary="Health check",
)
async def health() -> HealthResponse:
    """Returns BoardgameBuddy service status."""
    return HealthResponse(project="boardgame-buddy", status="ok")


def _list_games_bgg_ids_sync(sb: Client, ids: list[int]) -> list[GameSummary]:
    rows = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .in_("bgg_id", ids)
        .execute()
        .data
        or []
    )
    games = [GameSummary(**g) for g in rows]
    _attach_expansion_counts(sb, games)
    return games


@router.get(
    "/games",
    response_model=GameListResponse,
    status_code=200,
    summary="List games",
)
async def list_games(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(24, ge=1, le=100, description="Items per page"),
    search: Optional[str] = Query(None, description="Search by name"),
    category: Optional[str] = Query(None, description="Filter by category"),
    players: Optional[int] = Query(None, ge=1, le=20, description="Exact player count (game's range must include this)"),
    playtime_min: Optional[int] = Query(None, ge=1, description="Min playing time in minutes (inclusive)"),
    playtime_max: Optional[int] = Query(None, ge=1, description="Max playing time in minutes (inclusive)"),
    mechanics: Optional[list[str]] = Query(None, description="Required mechanics (AND logic)"),
    play_mode: Optional[PlayMode] = Query(None, description="Filter by scoring style (competitive / coop / team)"),
    owned_only: bool = Query(False, description="Only games in the caller's owned collection (requires auth; ignored otherwise)"),
    exclude_expansions: bool = Query(False, description="Hide expansion rows; only base games appear in results"),
    prioritize_exact_players: bool = Query(
        False,
        description=(
            "When true AND players is set, surface games whose max_players "
            "exactly equals players above wider-range games. Off by default "
            "so the created_at order stays consistent across pages."
        ),
    ),
    include_expansion_counts: bool = Query(
        True,
        description=(
            "Fill game.expansion_count on each row. Costs a second DB round "
            "trip per page, so callers that don't render the badge (the game "
            "explorer's polaroid grid) should pass false. Defaults true so the "
            "response contract is unchanged for anyone who doesn't opt out."
        ),
    ),
    sort: CatalogSort = Query(
        CatalogSort.NEWEST,
        description=(
            "Row order. `newest` (default) is created_at DESC — what the Game "
            "Explorer and every historical caller expects. `alphabetical` "
            "orders by name, for screens that browse the whole catalog."
        ),
    ),
    bgg_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated list of bgg_ids to include. Used by the search "
            "UI to hydrate base games for orphan expansions on the current "
            "page; bypasses other filters when set and ignores pagination."
        ),
    ),
    authorization: Optional[str] = Header(None),
) -> GameListResponse:
    """List games from the catalog, with optional search and filters."""
    sb = get_supabase()
    offset = (page - 1) * per_page

    # bgg_ids is a direct lookup — pull every match in one shot, no pagination
    # / per_page slicing applied. Other filters are ignored so the caller can
    # reliably retrieve the games they listed.
    if bgg_ids:
        try:
            ids = [int(p) for p in parse_csv_param(bgg_ids)]
        except ValueError:
            return GameListResponse(games=[], total=0, page=page, per_page=per_page)
        if not ids:
            return GameListResponse(games=[], total=0, page=page, per_page=per_page)
        games = await asyncio.to_thread(_list_games_bgg_ids_sync, sb, ids)
        return GameListResponse(games=games, total=len(games), page=1, per_page=len(games) or 1)

    owned_ids: Optional[list[str]] = None
    if owned_only:
        su_user = await maybe_supabase_user(authorization)
        if su_user is None:
            return GameListResponse(games=[], total=0, page=page, per_page=per_page)
        col = await asyncio.to_thread(
            sb.table("boardgamebuddy_collections")
            .select("game_id")
            .eq("user_id", su_user.sub)
            .eq("status", "owned")
            .execute
        )
        owned_ids = [row["game_id"] for row in (col.data or [])]
        if not owned_ids:
            return GameListResponse(games=[], total=0, page=page, per_page=per_page)

    query = sb.table("boardgamebuddy_games").select(
        game_select_clause(), count="exact"
    )

    if owned_ids is not None:
        query = query.in_("id", owned_ids)
    if search:
        query = query.ilike("name", f"%{search}%")
    if category:
        query = query.contains("categories", [category])
    if players is not None:
        query = query.gte("max_players", players)
        if players < 6:
            query = query.lte("min_players", players)
    if playtime_min is not None:
        query = query.gte("playing_time", playtime_min)
    if playtime_max is not None:
        query = query.lte("playing_time", playtime_max)
    if mechanics:
        query = query.contains("mechanics", mechanics)
    if play_mode is not None:
        query = query.eq("play_mode", play_mode.value)
    if exclude_expansions:
        query = query.eq("is_expansion", False)

    # Opt-in: when prioritize_exact_players=true AND players is set, surface
    # games whose max_players exactly equals the picked count before
    # wider-range ones. Ordering by max_players ASC achieves this — the
    # gte(max_players, players) filter above already trimmed everything
    # below players, so the smallest max in the result set IS the exact
    # match. Off by default so the created_at order stays consistent
    # across paginated calls.
    if players is not None and prioritize_exact_players:
        query = query.order("max_players", desc=False)
    # `id` is the tiebreaker on both axes, and it is load-bearing rather than
    # cosmetic: created_at is nullable (001_baseline.sql:60) and bulk BGG
    # imports insert inside one transaction, where now() is the TRANSACTION
    # timestamp — so ties are normal there; two printings of the same game
    # share a name, so they are normal on the alphabetical axis too. Without a
    # deterministic second key paginated calls could repeat or skip games
    # between pages.
    if sort == CatalogSort.ALPHABETICAL:
        query = query.order("name", desc=False).order("id", desc=True)
    else:
        query = query.order("created_at", desc=True).order("id", desc=True)
    query = query.range(offset, offset + per_page - 1)
    result = await asyncio.to_thread(query.execute)

    games = [GameSummary(**g) for g in (result.data or [])]
    if include_expansion_counts:
        await asyncio.to_thread(_attach_expansion_counts, sb, games)
    total = result.count or 0

    return GameListResponse(games=games, total=total, page=page, per_page=per_page)


def _attach_expansion_counts(sb: Client, games: list[GameSummary]) -> None:
    """Fill `expansion_count` for each *base* game in the result page.

    One round-trip — pull every expansion row whose `base_game_bgg_id`
    matches a bgg_id in `games`, then tally locally. Expansions
    themselves keep expansion_count=0.
    """
    base_bgg_ids = [g.bgg_id for g in games if g.bgg_id and not g.is_expansion]
    if not base_bgg_ids:
        return
    rows = (
        sb.table("boardgamebuddy_games")
        .select("base_game_bgg_id")
        .eq("is_expansion", True)
        .in_("base_game_bgg_id", base_bgg_ids)
        .execute()
    )
    counts: dict[int, int] = {}
    for row in (rows.data or []):
        bid = row.get("base_game_bgg_id")
        if bid is None:
            continue
        counts[bid] = counts.get(bid, 0) + 1
    for g in games:
        if g.bgg_id and not g.is_expansion:
            g.expansion_count = counts.get(g.bgg_id, 0)


@router.get(
    "/games/recently-played",
    response_model=list[GameSummary],
    status_code=200,
    summary="Caller's recently-played games",
)
async def recently_played_games(
    limit: int = Query(6, ge=1, le=24, description="Max games to return"),
    user: CurrentUser = Depends(get_current_user),
) -> list[GameSummary]:
    """Distinct games the caller has plays for, sorted by latest played_at DESC."""
    return game_service.recently_played(get_supabase(), user.user_id, limit)


def _get_game_sync(sb: Client, game_id: str) -> GameDetail:
    result = (
        sb.table("boardgamebuddy_games")
        .select("*")
        .eq("id", game_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Game not found")

    row = result.data[0]
    # Resolve the base game on expansion rows so the FE can render a "Back to
    # <base>" link without a second round-trip. base_game_bgg_id is a soft
    # reference (no FK) so we look the row up by bgg_id.
    base_game_id: Optional[str] = None
    base_game_name: Optional[str] = None
    if row.get("is_expansion") and row.get("base_game_bgg_id"):
        base = (
            sb.table("boardgamebuddy_games")
            .select("id, name")
            .eq("bgg_id", row["base_game_bgg_id"])
            .execute()
        )
        if base.data:
            base_game_id = base.data[0]["id"]
            base_game_name = base.data[0]["name"]

    cache.set(
        _CACHE_GAME,
        game_id,
        {"row": row, "base_game_id": base_game_id, "base_game_name": base_game_name},
        ttl_seconds=_CACHE_GAME_TTL_S,
    )
    return GameDetail(
        **row,
        base_game_id=base_game_id,
        base_game_name=base_game_name,
    )


@router.get(
    "/games/{game_id}",
    response_model=GameDetail,
    status_code=200,
    summary="Game detail",
)
async def get_game(
    game_id: str = Path(..., description="Game UUID"),
) -> GameDetail:
    """Get full details for a single game.

    The games row + the base-game lookup are cached for 1h (game data is
    immutable post-import; admin paths bust the cache via
    `_invalidate_game_caches`). Saves 1–2 DB round-trips per Game Detail
    open on repeat visits.
    """
    sb = get_supabase()

    cached = cache.get(_CACHE_GAME, game_id)
    if cached is not None:
        return GameDetail(**cached["row"], base_game_id=cached.get("base_game_id"), base_game_name=cached.get("base_game_name"))
    return await asyncio.to_thread(_get_game_sync, sb, game_id)


@router.get(
    "/games/{game_id}/bundle",
    response_model=dict,
    status_code=200,
    summary="Single-call Game Detail bundle (game + base + status + plays + expansions)",
)
async def get_game_detail_bundle(
    game_id: str = Path(..., description="Game UUID"),
    plays_limit: int = Query(5, ge=1, le=50, description="Recent plays cap"),
    viewer: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return everything Game Detail needs on cold load in one round trip.

    Backed by the `bgb_game_detail_bundle` RPC; mirrors what the FE used to
    fetch via /games/{id}, /collection (for viewer status), /plays?game_id,
    and /games/{id}/expansions.

    Also carries `viewer_stats` (migration 030): the viewer's own record with
    this one game — plays, wins, decided_plays, scored_plays,
    avg_winning_score, your_avg_score, your_best_score, first and last played —
    or None when they have never played it. Same row bgb_user_stats_detail's
    games[] carries, computed here because that payload is the whole play
    history and far too big a read to hang off opening a game.
    """
    sb = get_supabase()
    result = await asyncio.to_thread(
        sb.rpc(
            "bgb_game_detail_bundle",
            {
                "game_uuid": game_id,
                "viewer": viewer.user_id,
                "plays_limit": plays_limit,
            },
        ).execute
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Game not found")
    return result.data


async def import_game_from_bgg(sb: Client, bgg_id: int) -> dict:
    """Fetch a single game from BGG and insert it into boardgamebuddy_games.

    Returns the inserted (or pre-existing) row as a dict — callers can wrap it
    in `GameSummary(**row)` when they need a response model. Pulled out as a
    standalone helper so the BGG account-linking worker can import missing
    games without going through HTTP. Idempotent: returns the existing row if
    the bgg_id is already in the catalog.
    """
    existing = (
        sb.table("boardgamebuddy_games")
        .select("*")
        .eq("bgg_id", bgg_id)
        .execute()
    )
    if existing.data:
        return existing.data[0]

    body = await fetch_bgg(
        "/thing",
        {"id": bgg_id, "stats": 1},
        timeout=15.0,
    )
    root = parse_bgg_xml(body, context=f"thing id={bgg_id}")
    item = root.find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="Game not found on BGG")

    basics = thing_item_basics(item)
    name = basics["name"] or "Unknown"

    min_el = item.find("minplayers")
    max_el = item.find("maxplayers")
    time_el = item.find("playingtime")
    img_el = item.find("image")
    thumb_el = item.find("thumbnail")

    categories = [
        link.get("value", "")
        for link in item.findall("link[@type='boardgamecategory']")
    ]
    mechanics = [
        link.get("value", "")
        for link in item.findall("link[@type='boardgamemechanic']")
    ]

    is_expansion, base_game_bgg_id = _extract_expansion_meta(item)
    expansion_color = _next_expansion_color(sb, base_game_bgg_id) if is_expansion else None

    game_data = {
        "bgg_id": bgg_id,
        "name": name,
        "year_published": basics["year_published"],
        "min_players": int(min_el.get("value", "0")) if min_el is not None else None,
        "max_players": int(max_el.get("value", "0")) if max_el is not None else None,
        "playing_time": int(time_el.get("value", "0")) if time_el is not None else None,
        "image_url": await _upload_to_storage(
            sb, bgg_id, normalize_image_url(img_el.text if img_el is not None else None), "image"
        ),
        "thumbnail_url": await _upload_to_storage(
            sb, bgg_id, normalize_image_url(thumb_el.text if thumb_el is not None else None), "thumb"
        ),
        "description": bgg_description_text(item),
        "categories": categories,
        "mechanics": mechanics,
        # Migration 040. [] rather than NULL even when BGG credits nobody —
        # a fresh import is synced by definition and must not land in the
        # backfill queue.
        "publishers": thing_item_publishers(item),
        "is_expansion": is_expansion,
        "base_game_bgg_id": base_game_bgg_id,
        "expansion_color": expansion_color,
        "play_mode": derive_play_mode(mechanics).value,
        # The request above already asked for stats=1 (play_mode needs the
        # mechanics, and the stats ride the same payload), so a fresh import
        # lands with its rating and rank rather than joining the backfill queue.
        **thing_item_stats(item),
        "bgg_stats_synced_at": _now_iso(),
    }

    result = (
        sb.table("boardgamebuddy_games")
        .insert(game_data)
        .execute()
    )
    # New game added — mechanics list might expand and the catalog grew, so
    # bust the read-side caches. BGG /thing for THIS game is now stale (we
    # just persisted it; further /thing fetches should hit our DB instead).
    _invalidate_game_caches()
    return result.data[0]


@router.post(
    "/games/import-bgg/{bgg_id}",
    response_model=GameSummary,
    status_code=201,
    summary="Import game from BGG",
)
async def import_bgg_game(
    bgg_id: int = Path(..., description="BoardGameGeek game ID"),
    _user: CurrentUser = Depends(get_current_user),
) -> GameSummary:
    """Fetch a game from BGG API and add it to our database."""
    sb = get_supabase()
    row = await import_game_from_bgg(sb, bgg_id)
    return GameSummary(**row)


@router.post(
    "/games/refresh-images",
    response_model=RefreshImagesResponse,
    status_code=200,
    summary="Refresh image URLs for all games (admin)",
)
async def refresh_game_images(
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshImagesResponse:
    """Admin-only: re-host images in Supabase Storage for games with missing or BGG-hosted image URLs."""
    sb = get_supabase()
    # Paged: a catalog past PostgREST's 1000-row cap would silently leave the
    # tail unrefreshed while reporting success.
    rows = await asyncio.to_thread(
        page_all,
        lambda: sb.table("boardgamebuddy_games").select("id, bgg_id, image_url, thumbnail_url"),
        "id", label="refresh images",
    )
    updated = 0
    for game in rows:
        needs_update = (
            not game["image_url"]
            or "geekdo-images.com" in (game["image_url"] or "")
            or not game["thumbnail_url"]
            or "geekdo-images.com" in (game["thumbnail_url"] or "")
        )
        if not needs_update or not game["bgg_id"]:
            continue
        try:
            body = await fetch_bgg("/thing", {"id": game["bgg_id"], "stats": 0}, timeout=10.0)
            root = parse_bgg_xml(body, context=f"refresh bgg_id={game['bgg_id']}")
            item = root.find("item")
            if item is None:
                continue
            img_el = item.find("image")
            thumb_el = item.find("thumbnail")
            raw_img = normalize_image_url(img_el.text if img_el is not None else None)
            raw_thumb = normalize_image_url(thumb_el.text if thumb_el is not None else None)
            sb.table("boardgamebuddy_games").update({
                "image_url": await _upload_to_storage(sb, game["bgg_id"], raw_img, "image"),
                "thumbnail_url": await _upload_to_storage(sb, game["bgg_id"], raw_thumb, "thumb"),
            }).eq("id", game["id"]).execute()
            _sync_denormalized_game_fields(sb, game["id"])
            updated += 1
        except Exception:
            logger.warning("refresh-images: bgg_id=%s skipped", game["bgg_id"], exc_info=True)
        finally:
            # BGG's rate limit is per session; every other sweep here paces
            # itself. In `finally` so a game that returns no <item> — a
            # `continue` out of the try — still waits its turn.
            await asyncio.sleep(BGG_THROTTLE_SECONDS)
    if updated:
        _invalidate_game_caches()
    return RefreshImagesResponse(updated=updated)


# ── Denormalization helpers (migration 020) ──────────────────────────────────
# Plays and collections cache a subset of game fields so list reads stay
# single-table. These helpers build the payload from an in-hand game row
# (no extra round trip) and fan a games-row mutation out to dependents.

# Columns a collection row caches off boardgamebuddy_games. This is a superset
# of what a play row caches (044 left plays with just name + thumbnail), so it
# is also what _sync_denormalized_game_fields selects to build both payloads.
COLLECTION_DENORM_GAME_FIELDS = (
    "bgg_id, name, thumbnail_url, year_published, min_players, max_players, "
    "playing_time, is_expansion, base_game_bgg_id, expansion_color, "
    "play_mode, theme_color"
)


def play_denormalized_from_game(game: dict) -> dict:
    """Translate a boardgamebuddy_games row into the play-denorm payload.

    Only the two columns plays still carries: 044_cleanup.sql dropped
    game_image_url and game_play_mode from boardgamebuddy_plays because nothing
    read them off a play row.
    """
    return {
        "game_name": game["name"],
        "game_thumbnail_url": game.get("thumbnail_url"),
    }


def collection_denormalized_from_game(game: dict) -> dict:
    """Translate a boardgamebuddy_games row into the collection-denorm payload."""
    return {
        "game_name": game["name"],
        "game_thumbnail_url": game.get("thumbnail_url"),
        "game_year_published": game.get("year_published"),
        "game_min_players": game.get("min_players"),
        "game_max_players": game.get("max_players"),
        "game_playing_time": game.get("playing_time"),
        "game_is_expansion": game.get("is_expansion"),
        "game_base_game_bgg_id": game.get("base_game_bgg_id"),
        "game_expansion_color": game.get("expansion_color"),
        "game_play_mode": game.get("play_mode"),
        "game_bgg_id": game.get("bgg_id"),
        "game_theme_color": game.get("theme_color"),
    }


def _sync_denormalized_game_fields(sb: Client, game_id: str) -> None:
    """Propagate a games-row mutation to every plays / collections row that
    caches its fields. Called from the admin paths that mutate games
    (re-host images, override expansion color). New plays/collections write
    the denorm fields inline so they don't need this fan-out.
    """
    res = (
        sb.table("boardgamebuddy_games")
        .select(COLLECTION_DENORM_GAME_FIELDS)
        .eq("id", game_id)
        .execute()
    )
    if not res.data:
        return
    game = res.data[0]
    play_payload = play_denormalized_from_game(game)
    collection_payload = collection_denormalized_from_game(game)
    sb.table("boardgamebuddy_plays").update(play_payload).eq("game_id", game_id).execute()
    sb.table("boardgamebuddy_collections").update(collection_payload).eq("game_id", game_id).execute()


async def _hydrate_images_from_bgg(sb: Client, game_id: str, bgg_id: int) -> None:
    """Fetch box art + thumbnail from BGG, re-host in Storage, and patch the row.

    Raises on any BGG/network/parse failure so callers that need to gate on
    success (admin refresh) can surface the error; the import flow wraps this
    in try/except so a flaky BGG call doesn't block approval.
    """
    body = await fetch_bgg("/thing", {"id": bgg_id, "stats": 0}, timeout=10.0)
    root = parse_bgg_xml(body, context=f"hydrate images bgg_id={bgg_id}")
    item = root.find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="Game not found on BGG")

    img_el = item.find("image")
    thumb_el = item.find("thumbnail")
    raw_img = normalize_image_url(img_el.text if img_el is not None else None)
    raw_thumb = normalize_image_url(thumb_el.text if thumb_el is not None else None)

    sb.table("boardgamebuddy_games").update({
        "image_url": await _upload_to_storage(sb, bgg_id, raw_img, "image"),
        "thumbnail_url": await _upload_to_storage(sb, bgg_id, raw_thumb, "thumb"),
    }).eq("id", game_id).execute()
    _sync_denormalized_game_fields(sb, game_id)
    _invalidate_game_caches()


@router.get(
    "/games/admin/missing-images",
    response_model=list[GameSummary],
    status_code=200,
    summary="List games missing image_url or thumbnail_url (admin)",
)
async def list_games_missing_images(
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[GameSummary]:
    """Admin-only: games whose box art or thumbnail hasn't been hydrated yet."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .or_("image_url.is.null,thumbnail_url.is.null")
        .order("name")
        .limit(_ADMIN_LIST_LIMIT)
        .execute()
    )
    return [GameSummary(**g) for g in (result.data or [])]


@router.post(
    "/games/admin/{game_id}/refresh-images",
    response_model=GameSummary,
    status_code=200,
    summary="Refresh image URLs for a single game from BGG (admin)",
)
async def refresh_single_game_images(
    game_id: str = Path(..., description="Game UUID"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> GameSummary:
    """Admin-only: re-fetch image + thumbnail for one game from BGG and re-host in Storage."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .eq("id", game_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Game not found")
    bgg_id = existing.data[0]["bgg_id"]
    if not bgg_id:
        raise HTTPException(status_code=400, detail="Game has no bgg_id; cannot refresh from BGG")

    await _hydrate_images_from_bgg(sb, game_id, bgg_id)

    refreshed = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .eq("id", game_id)
        .execute()
    )
    if not refreshed.data:
        raise HTTPException(status_code=500, detail="Failed to update game row")
    return GameSummary(**refreshed.data[0])


@router.patch(
    "/games/admin/{game_id}/rulebook-url",
    response_model=GameSummary,
    status_code=200,
    summary="Set or clear a game's rulebook URL (admin)",
)
async def update_game_rulebook_url(
    body: RulebookUrlUpdate,
    game_id: str = Path(..., description="Game UUID"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> GameSummary:
    """Admin-only: write rulebook_url on a game row. Pass null to clear it."""
    sb = get_supabase()
    existing = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("id", game_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Game not found")

    # Minimal http(s) validation — accept null/empty to clear, otherwise must
    # look like a URL. Anything richer than this we leave to the admin's eyes.
    url = body.rulebook_url.strip() if body.rulebook_url else None
    if url and not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="rulebook_url must start with http:// or https://")

    updated = (
        sb.table("boardgamebuddy_games")
        .update({"rulebook_url": url})
        .eq("id", game_id)
        .execute()
    )
    if not updated.data:
        raise HTTPException(status_code=500, detail="Failed to update rulebook_url")
    _invalidate_game_caches()
    return GameSummary(**updated.data[0])


# ── Admin: description backfill ──────────────────────────────────────────────
# The catalog predates description capture on import, so every row imported
# before it has description NULL. These three endpoints mirror the missing-
# images trio above, with one structural difference called out at the bulk
# endpoint: it batches its BGG calls.

# BGG accepts a comma-separated id list on /thing. 20 is the chunk size
# fetch_owner_counts already settled on for the same API.
_DESC_CHUNK_SIZE = 20


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _hydrate_description_from_bgg(sb: Client, game_id: str, bgg_id: int) -> Optional[str]:
    """Fetch one game's description from BGG and patch the row; returns the text.

    Deliberately unlike `_hydrate_images_from_bgg` in one respect: it does NOT
    call `_sync_denormalized_game_fields`. `description` is not in
    COLLECTION_DENORM_GAME_FIELDS — no play or collection row caches it — so
    the fan-out would be two bulk UPDATEs that change nothing.
    """
    body = await fetch_bgg("/thing", {"id": bgg_id, "stats": 0}, timeout=10.0)
    root = parse_bgg_xml(body, context=f"hydrate description bgg_id={bgg_id}")
    item = root.find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="Game not found on BGG")

    description = bgg_description_text(item)
    sb.table("boardgamebuddy_games").update(
        {"description": description}
    ).eq("id", game_id).execute()
    _invalidate_game_caches()
    return description


@router.get(
    "/games/admin/missing-descriptions",
    response_model=list[GameSummary],
    status_code=200,
    summary="List games with no description (admin)",
)
async def list_games_missing_descriptions(
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[GameSummary]:
    """Admin-only: games imported before descriptions were captured from BGG."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .is_("description", "null")
        .order("name")
        .limit(_ADMIN_LIST_LIMIT)
        .execute()
    )
    return [GameSummary(**g) for g in (result.data or [])]


@router.post(
    "/games/admin/{game_id}/refresh-description",
    response_model=GameDetail,
    status_code=200,
    summary="Refresh one game's description from BGG (admin)",
)
async def refresh_single_game_description(
    game_id: str = Path(..., description="Game UUID"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> GameDetail:
    """Admin-only: re-fetch and store one game's description from BGG."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .eq("id", game_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Game not found")
    bgg_id = existing.data[0]["bgg_id"]
    if not bgg_id:
        raise HTTPException(status_code=400, detail="Game has no bgg_id; cannot refresh from BGG")

    await _hydrate_description_from_bgg(sb, game_id, bgg_id)

    # select("*") rather than game_select_clause(): GameDetail carries the
    # description itself, so the admin panel can report what actually landed.
    refreshed = (
        sb.table("boardgamebuddy_games")
        .select("*")
        .eq("id", game_id)
        .execute()
    )
    if not refreshed.data:
        raise HTTPException(status_code=500, detail="Failed to update game row")
    return GameDetail(**refreshed.data[0])


@router.post(
    "/games/admin/backfill-descriptions",
    response_model=RefreshDescriptionsResponse,
    status_code=200,
    summary="Backfill missing descriptions from BGG, in batches (admin)",
)
async def backfill_game_descriptions(
    limit: int = Query(200, ge=1, le=1000, description="Max games to backfill in this call"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshDescriptionsResponse:
    """Admin-only: fill in descriptions for games that have none, oldest first."""
    sb = get_supabase()

    # Paged, so `remaining` counts the whole catalog rather than the first
    # 1000 rows PostgREST would return. Ordered by id: a page boundary needs a
    # total order, and name is not one.
    rows = await asyncio.to_thread(
        page_all,
        lambda: sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .is_("description", "null")
        .not_.is_("bgg_id", "null"),
        "id", label="backfill descriptions",
    )
    total_missing = len(rows)
    batch = rows[:limit]

    # One BGG round trip per 20 games, not per game. The catalog seeds from
    # BGG's top ~1000, so on a cold run every row needs a description: at ~1.5s
    # per call, per-game requests would take 25 minutes and die on the platform
    # request timeout with the catalog half-filled. Chunks go sequentially —
    # this module has no rate-limit guard and _map_bgg_status turns BGG's 429
    # into an exception, so parallel batches would trip it for every user.
    by_bgg_id = {int(r["bgg_id"]): r["id"] for r in batch}
    chunks = list(chunked(batch, _DESC_CHUNK_SIZE))

    updated = 0
    failed = 0
    for chunk in chunks:
        ids = ",".join(str(r["bgg_id"]) for r in chunk)
        try:
            # use_cache=False for the same reason fetch_owner_counts does it:
            # 20 full game records is ~1MB of XML and the bgg.thing namespace
            # caps at 500 entries, so admitting these would evict the per-game
            # entries every page load reads.
            body = await fetch_bgg(
                "/thing", {"id": ids, "stats": 0}, timeout=20.0, use_cache=False
            )
            root = parse_bgg_xml(body, context=f"backfill descriptions ({len(chunk)} ids)")
        except Exception:
            # One bad chunk must not abort a 50-chunk run.
            logger.warning("Description backfill chunk failed (%d ids)", len(chunk), exc_info=True)
            failed += len(chunk)
            continue

        for item in root.findall("item"):
            try:
                item_bgg_id = int(item.get("id", "0"))
            except (TypeError, ValueError):
                continue
            game_id = by_bgg_id.get(item_bgg_id)
            if not game_id:
                continue
            description = bgg_description_text(item)
            if not description:
                # BGG genuinely has no blurb for this game. Leave it NULL so it
                # keeps showing in the panel rather than silently disappearing.
                continue
            try:
                sb.table("boardgamebuddy_games").update(
                    {"description": description}
                ).eq("id", game_id).execute()
                updated += 1
            except Exception:
                logger.warning("Description write failed for game %s", game_id, exc_info=True)
                failed += 1

    # Once at the end, not per game: _invalidate_game_caches does a namespace
    # -wide clear plus invalidate_bgg_thing_cache(), so calling it per row would
    # defeat the /thing cache for every concurrent user for the whole run.
    if updated:
        _invalidate_game_caches()

    return RefreshDescriptionsResponse(
        updated=updated,
        failed=failed,
        remaining=max(0, total_missing - updated),
    )


# ── BGG stats (migration 038) ────────────────────────────────────────────────
# The Discover tab ranks by BGG rating and "New this year" orders by rank, and
# neither existed on the catalog before 038. These three mirror the missing-
# descriptions trio above exactly — same list / one / all shape, same 20-id
# batches — with one addition: a throttle between chunks. A stats=1 record is
# several times the size of a stats=0 one and the module has no rate-limit
# guard, so a 50-chunk cold run at full speed is how the app gets 429'd for
# every user at once.

_STATS_SELECT = game_select_clause() + ", bgg_stats_synced_at"


async def _hydrate_stats_from_bgg(sb: Client, game_id: str, bgg_id: int) -> dict:
    """Fetch one game's stats from BGG and patch the row; returns the columns.

    Stamps bgg_stats_synced_at even when BGG carries no <statistics> for the
    id, so a game BGG will never rate leaves the queue instead of being
    re-requested on every pass. Like descriptions, none of these columns are
    denormalised onto plays or collections, so there is no fan-out.
    """
    body = await fetch_bgg("/thing", {"id": bgg_id, "stats": 1}, timeout=10.0, use_cache=False)
    root = parse_bgg_xml(body, context=f"hydrate stats bgg_id={bgg_id}")
    item = root.find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="Game not found on BGG")
    cols = {**thing_item_stats(item), "bgg_stats_synced_at": _now_iso()}
    sb.table("boardgamebuddy_games").update(cols).eq("id", game_id).execute()
    _invalidate_game_caches()
    return cols


@router.get(
    "/games/admin/missing-stats",
    response_model=list[GameSummary],
    status_code=200,
    summary="List games whose BGG stats have never been synced (admin)",
)
async def list_games_missing_stats(
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[GameSummary]:
    """Admin-only: catalog games with no BGG rating / rank sync yet."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .is_("bgg_stats_synced_at", "null")
        .not_.is_("bgg_id", "null")
        .order("name")
        .limit(_ADMIN_LIST_LIMIT)
        .execute()
    )
    return [GameSummary(**g) for g in (result.data or [])]


@router.post(
    "/games/admin/{game_id}/refresh-stats",
    response_model=GameSummary,
    status_code=200,
    summary="Refresh one game's BGG rating, rank and weight (admin)",
)
async def refresh_single_game_stats(
    game_id: str = Path(..., description="Game UUID"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> GameSummary:
    """Admin-only: re-fetch and store one game's BGG stats."""
    sb = get_supabase()
    existing = (
        sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .eq("id", game_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Game not found")
    bgg_id = existing.data[0]["bgg_id"]
    if not bgg_id:
        raise HTTPException(status_code=400, detail="Game has no bgg_id; cannot refresh from BGG")

    await _hydrate_stats_from_bgg(sb, game_id, bgg_id)

    refreshed = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .eq("id", game_id)
        .execute()
    )
    if not refreshed.data:
        raise HTTPException(status_code=500, detail="Failed to update game row")
    return GameSummary(**refreshed.data[0])


@router.post(
    "/games/admin/backfill-stats",
    response_model=RefreshDescriptionsResponse,
    status_code=200,
    summary="Backfill BGG stats for unsynced games, in throttled batches (admin)",
)
async def backfill_game_stats(
    limit: int = Query(200, ge=1, le=1000, description="Max games to sync in this call"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshDescriptionsResponse:
    """Admin-only: fill in rating / rank / weight for games never synced, oldest first."""
    sb = get_supabase()

    rows = await asyncio.to_thread(
        page_all,
        lambda: sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .is_("bgg_stats_synced_at", "null")
        .not_.is_("bgg_id", "null"),
        "id", label="backfill stats",
    )
    total_missing = len(rows)
    batch = rows[:limit]
    by_bgg_id = {int(r["bgg_id"]): r["id"] for r in batch}
    chunks = list(chunked(batch, _DESC_CHUNK_SIZE))

    updated = 0
    failed = 0
    for i, chunk in enumerate(chunks):
        # Sequential AND spaced: see the section comment. The first chunk goes
        # straight out; every later one waits its turn.
        if i:
            await asyncio.sleep(BGG_THROTTLE_SECONDS)
        ids = ",".join(str(r["bgg_id"]) for r in chunk)
        try:
            body = await fetch_bgg(
                "/thing", {"id": ids, "stats": 1}, timeout=20.0, use_cache=False
            )
            stats = parse_thing_stats(parse_bgg_xml(body, context=f"backfill stats ({len(chunk)} ids)"))
        except Exception:
            logger.warning("Stats backfill chunk failed (%d ids)", len(chunk), exc_info=True)
            failed += len(chunk)
            continue

        synced_at = _now_iso()
        for r in chunk:
            item_bgg_id = int(r["bgg_id"])
            # Absent from the response = BGG has nothing for that id. Stamp it
            # anyway so it leaves the queue; the four stats stay NULL.
            cols = {**stats.get(item_bgg_id, {c: None for c in ("bgg_rating", "bgg_rank", "bgg_weight", "bgg_owned_count")}),
                    "bgg_stats_synced_at": synced_at}
            try:
                sb.table("boardgamebuddy_games").update(cols).eq("id", by_bgg_id[item_bgg_id]).execute()
                updated += 1
            except Exception:
                logger.warning("Stats write failed for game %s", by_bgg_id[item_bgg_id], exc_info=True)
                failed += 1

    if updated:
        _invalidate_game_caches()

    return RefreshDescriptionsResponse(
        updated=updated,
        failed=failed,
        remaining=max(0, total_missing - updated),
    )


# ── Admin: publisher backfill (migration 040) ────────────────────────────────
# Every row imported before 040 has publishers NULL, which is what the game
# page's "Publisher" fact reads — so without this the column would only ever
# fill for games imported from here on. Fourth instance of the same trio as
# images / descriptions / stats, batched like descriptions (stats=0 is enough:
# publishers are plain <link> rows) and throttled like stats.
#
# The queue marker is `publishers IS NULL`, never `= '{}'`: a game BGG credits
# to nobody is synced, and re-asking BGG about it on every run would mean the
# panel never empties.


def _publisher_cols(item: ET.Element) -> dict:
    """The one column this backfill writes, for one /thing <item>."""
    return {"publishers": thing_item_publishers(item)}


async def _hydrate_publishers_from_bgg(sb: Client, game_id: str, bgg_id: int) -> list[str]:
    """Fetch one game's publishers from BGG and patch the row; returns them.

    Like `_hydrate_description_from_bgg`, no `_sync_denormalized_game_fields`
    call: `publishers` is not in COLLECTION_DENORM_GAME_FIELDS, so no play or
    collection row caches it and the fan-out would update nothing.
    """
    body = await fetch_bgg("/thing", {"id": bgg_id, "stats": 0}, timeout=10.0)
    root = parse_bgg_xml(body, context=f"hydrate publishers bgg_id={bgg_id}")
    item = root.find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="Game not found on BGG")

    cols = _publisher_cols(item)
    sb.table("boardgamebuddy_games").update(cols).eq("id", game_id).execute()
    _invalidate_game_caches()
    return cols["publishers"]


@router.get(
    "/games/admin/missing-publishers",
    response_model=list[GameSummary],
    status_code=200,
    summary="List games whose publishers have never been synced (admin)",
)
async def list_games_missing_publishers(
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[GameSummary]:
    """Admin-only: games imported before publishers were captured from BGG."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .is_("publishers", "null")
        .not_.is_("bgg_id", "null")
        .order("name")
        .limit(_ADMIN_LIST_LIMIT)
        .execute()
    )
    return [GameSummary(**g) for g in (result.data or [])]


@router.post(
    "/games/admin/{game_id}/refresh-publishers",
    response_model=GameDetail,
    status_code=200,
    summary="Refresh one game's publishers from BGG (admin)",
)
async def refresh_single_game_publishers(
    game_id: str = Path(..., description="Game UUID"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> GameDetail:
    """Admin-only: re-fetch and store one game's publisher credits."""
    sb = get_supabase()
    existing = (
        sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .eq("id", game_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Game not found")
    bgg_id = existing.data[0]["bgg_id"]
    if not bgg_id:
        raise HTTPException(status_code=400, detail="Game has no bgg_id; cannot refresh from BGG")

    await _hydrate_publishers_from_bgg(sb, game_id, bgg_id)

    # select("*") for the same reason the description refresh does it:
    # GameDetail carries `publishers`, so the admin panel reports what landed.
    refreshed = (
        sb.table("boardgamebuddy_games")
        .select("*")
        .eq("id", game_id)
        .execute()
    )
    if not refreshed.data:
        raise HTTPException(status_code=500, detail="Failed to update game row")
    return GameDetail(**refreshed.data[0])


@router.post(
    "/games/admin/backfill-publishers",
    response_model=RefreshDescriptionsResponse,
    status_code=200,
    summary="Backfill missing publishers from BGG, in throttled batches (admin)",
)
async def backfill_game_publishers(
    limit: int = Query(200, ge=1, le=1000, description="Max games to backfill in this call"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshDescriptionsResponse:
    """Admin-only: fill in publisher credits for games that have none yet."""
    sb = get_supabase()

    rows = await asyncio.to_thread(
        page_all,
        lambda: sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .is_("publishers", "null")
        .not_.is_("bgg_id", "null"),
        "id", label="backfill publishers",
    )
    total_missing = len(rows)
    batch = rows[:limit]
    by_bgg_id = {int(r["bgg_id"]): r["id"] for r in batch}
    chunks = list(chunked(batch, _DESC_CHUNK_SIZE))

    updated = 0
    failed = 0
    for i, chunk in enumerate(chunks):
        if i:
            await asyncio.sleep(BGG_THROTTLE_SECONDS)
        ids = ",".join(str(r["bgg_id"]) for r in chunk)
        try:
            body = await fetch_bgg(
                "/thing", {"id": ids, "stats": 0}, timeout=20.0, use_cache=False
            )
            root = parse_bgg_xml(body, context=f"backfill publishers ({len(chunk)} ids)")
        except Exception:
            # One bad chunk must not abort a 50-chunk run.
            logger.warning("Publisher backfill chunk failed (%d ids)", len(chunk), exc_info=True)
            failed += len(chunk)
            continue

        by_item: dict[int, ET.Element] = {}
        for item in root.findall("item"):
            try:
                by_item[int(item.get("id", "0"))] = item
            except (TypeError, ValueError):
                continue

        for r in chunk:
            item_bgg_id = int(r["bgg_id"])
            item = by_item.get(item_bgg_id)
            # Absent from the response = BGG has nothing under that id. Write
            # '{}' anyway so the row leaves the queue, exactly as the stats
            # backfill stamps bgg_stats_synced_at on a game BGG won't rate.
            cols = _publisher_cols(item) if item is not None else {"publishers": []}
            try:
                sb.table("boardgamebuddy_games").update(cols).eq("id", by_bgg_id[item_bgg_id]).execute()
                updated += 1
            except Exception:
                logger.warning("Publisher write failed for game %s", by_bgg_id[item_bgg_id], exc_info=True)
                failed += 1

    if updated:
        _invalidate_game_caches()

    return RefreshDescriptionsResponse(
        updated=updated,
        failed=failed,
        remaining=max(0, total_missing - updated),
    )
