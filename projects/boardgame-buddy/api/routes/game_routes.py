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
from .constants import (
    EXPANSION_COLOR_PALETTE,
    AdminBackfillPhase,
    AdminRunLevel,
    AdminRunTool,
    CatalogSort,
    PlayMode,
    derive_play_mode,
)
from .dependencies import CurrentUser, get_current_admin, get_current_user, maybe_supabase_user
from .models import (
    GameDetail,
    GameListResponse,
    GameSummary,
    RefreshDescriptionsResponse,
    RefreshImagesResponse,
    RulebookUrlUpdate,
)
from .services import admin_run_progress, game_service
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


# ── Admin run narration ──────────────────────────────────────────────────────
# Shared by the four catalog backfills below. Declared up here rather than
# beside them because `_PASS_NO` is a Query DEFAULT, and a default is
# evaluated when the function is defined — the first backfill that reads it
# (`refresh_game_images`) is three hundred lines above where these used to sit.

# Every bulk backfill takes this. `pass_no` is the browser's drain counter and
# the server asks it exactly one question: is this the FIRST request of a run?
# 0 opens a fresh ledger, anything else continues the one the previous pass
# left — which is what makes twenty-five requests read as one log. It defaults
# to 0 so a bare curl, or any caller that does not care about narration, still
# behaves exactly as it did before this existed.
_PASS_NO = Query(
    0, ge=0,
    description="Drain pass number. 0 starts a new run log; >0 continues the current one.",
)


def _name_of(row: dict) -> str:
    """A game's name for the run log, falling back to whatever identifies it.

    A log line reading "41f2c8… failed" is one an admin has to go and decode,
    which is most of why the old logger.warning output went unread. Every
    backfill's select carries `name` for this.
    """
    return row.get("name") or (f"BGG {row['bgg_id']}" if row.get("bgg_id") else str(row.get("id")))


def _name_list(rows: list[dict], *, show: int = 3) -> str:
    """"Gloomhaven, Brass: Birmingham, Ark Nova and 17 more" — for a line about
    a whole batch, where naming all twenty would bury the next line."""
    names = [_name_of(r) for r in rows[:show]]
    rest = len(rows) - len(names)
    joined = ", ".join(names)
    return f"{joined} and {rest} more" if rest > 0 else joined


# The four sentences every backfill's checklist says. Written once because they
# are the SAME sentence — the noun is the only thing that differs, which is the
# argument views/admin-backfill-view.js makes for the four being one screen.

def _scan_detail(total_missing: int, batch_size: int, noun: str) -> str:
    """"412 games are missing BGG stats — taking 200 this pass".

    Says the size of the whole queue AND this pass's bite, because the two
    differ for most of a drain and an admin watching only the second one has no
    idea how far through they are.
    """
    if not total_missing:
        return f"Nothing is missing {noun}"
    plural = "game is" if total_missing == 1 else "games are"
    head = f"{total_missing} {plural} missing {noun}"
    return f"{head} — taking {batch_size} this pass" if batch_size < total_missing else head


def _batch_detail(index: int, chunks: int, saved: int) -> str:
    return f"batch {index + 1} of {chunks} · {saved} saved so far"


def _saved_line(index: int, chunks: int, wrote: int, size: int) -> str:
    return f"Batch {index + 1} of {chunks} — {wrote} of {size} saved"


def _caches_detail(updated: int) -> str:
    # Said even when it did nothing: a phase that silently no-ops reads as a
    # step that hung.
    return "Catalog caches cleared" if updated else "Nothing changed, caches left alone"
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


def _needs_images(game: dict) -> bool:
    """Is this row's box art still missing, or still pointing at BoardGameGeek?

    Extracted so the bulk re-host and its run log agree on what the queue IS —
    `remaining` is meaningless otherwise.

    NOTE, because the number an admin sees in two places does not match: the
    missing-images LIST endpoint and the Settings review-count both ask only
    `image_url IS NULL OR thumbnail_url IS NULL`, so they do not count rows
    that have a working but BGG-hosted URL. Those rows are real work for this
    endpoint — re-hosting is the whole point — so the bulk queue is the larger
    set of the two. The run log says so out loud rather than leaving the
    discrepancy to be discovered; widening the other two is a change to a
    global header badge and belongs in its own commit.
    """
    def stale(url: str | None) -> bool:
        return (not url) or ("geekdo-images.com" in url)

    return stale(game.get("image_url")) or stale(game.get("thumbnail_url"))


@router.post(
    "/games/refresh-images",
    response_model=RefreshImagesResponse,
    status_code=200,
    summary="Re-host image URLs for games that need it, in bounded passes (admin)",
)
async def refresh_game_images(
    limit: int = Query(200, ge=1, le=1000, description="Max games to re-host in this call"),
    pass_no: int = _PASS_NO,
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshImagesResponse:
    """Admin-only: re-host images in object storage for games with missing or BGG-hosted URLs.

    BOUNDED, unlike the version this replaces. This is one BGG call plus two
    downloads and two uploads per needy game, spaced by the BGG throttle — on a
    cold thousand-game catalog that is well past half an hour, so a single
    unbounded pass could not finish: it died on the platform's request timeout
    with the work half done and reported `updated` for whatever it had managed.
    It also reported no `remaining`, and the client's drain loop breaks on a
    falsy one, so it ran exactly once and there was no way to continue.

    Now it takes `limit`, reports `remaining`, and drains in passes like the
    other three backfills — and narrates itself into the run ledger while it
    does, readable at /admin/runs/bgg-images.
    """
    sb = get_supabase()
    P = AdminBackfillPhase
    with admin_run_progress.run_pass(
        AdminRunTool.BGG_IMAGES, started_by=_admin.display_name, pass_no=pass_no
    ) as prog:
        prog.begin(P.SCAN)
        # Paged: a catalog past PostgREST's 1000-row cap would silently leave the
        # tail unrefreshed while reporting success.
        rows = await asyncio.to_thread(
            page_all,
            lambda: sb.table("boardgamebuddy_games").select("id, bgg_id, name, image_url, thumbnail_url"),
            "id", label="refresh images",
        )
        # Filtered here rather than in the query because the predicate is not
        # expressible as a cheap PostgREST filter — and because `remaining` has
        # to count the same set the loop below works on, or the drain never ends.
        needy = [g for g in rows if g.get("bgg_id") and _needs_images(g)]
        total_missing = len(needy)
        batch = needy[:limit]
        prog.tick(
            P.SCAN, 0,
            detail=_scan_detail(total_missing, len(batch), "an image we host"),
        )

        updated = 0
        failed = 0
        if not batch:
            prog.skip(P.FETCH, detail="Nothing left to re-host")
        else:
            prog.begin(P.FETCH, total=len(batch))
        for n, game in enumerate(batch):
            prog.tick(P.FETCH, n, detail=_name_of(game))
            try:
                body = await fetch_bgg("/thing", {"id": game["bgg_id"], "stats": 0}, timeout=10.0)
                root = parse_bgg_xml(body, context=f"refresh bgg_id={game['bgg_id']}")
                item = root.find("item")
                if item is None:
                    # Not an error and not a success: the row stays in the queue
                    # and the next pass will try it again, so say so or the
                    # count looks stuck for no reason.
                    prog.event(
                        P.FETCH,
                        f"{_name_of(game)} — BoardGameGeek returned nothing under that id",
                        level=AdminRunLevel.WARN,
                    )
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
                prog.event(P.FETCH, f"Re-hosted {_name_of(game)}")
            except Exception as exc:
                logger.warning("refresh-images: bgg_id=%s skipped", game["bgg_id"], exc_info=True)
                failed += 1
                prog.event(
                    P.FETCH,
                    f"{_name_of(game)} — {exc}",
                    level=AdminRunLevel.ERROR,
                )
            finally:
                # BGG's rate limit is per session; every other sweep here paces
                # itself. In `finally` so a game that returns no <item> — a
                # `continue` out of the try — still waits its turn. Rows that
                # need no work never reach here: they were filtered out above.
                await asyncio.sleep(BGG_THROTTLE_SECONDS)
        if batch:
            prog.tick(P.FETCH, len(batch), detail=f"{updated} re-hosted")

        remaining = max(0, total_missing - updated)
        prog.begin(P.CACHES)
        if updated:
            _invalidate_game_caches()
        prog.tick(P.CACHES, 0, detail=_caches_detail(updated))
        prog.add_totals(updated=updated, failed=failed, remaining=remaining)

        return RefreshImagesResponse(updated=updated, failed=failed, remaining=remaining)


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
    pass_no: int = _PASS_NO,
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshDescriptionsResponse:
    """Admin-only: fill in descriptions for games that have none, oldest first.

    Narrated into the run ledger as it goes, and readable at
    /admin/runs/bgg-descriptions while it runs and for ten minutes after. The
    ledger spans passes, so a cold catalog's twenty-odd calls read as one log.
    """
    sb = get_supabase()
    P = AdminBackfillPhase
    with admin_run_progress.run_pass(
        AdminRunTool.BGG_DESCRIPTIONS,
        started_by=_admin.display_name,
        pass_no=pass_no,
    ) as prog:
        prog.begin(P.SCAN)
        # Paged, so `remaining` counts the whole catalog rather than the first
        # 1000 rows PostgREST would return. Ordered by id: a page boundary needs a
        # total order, and name is not one. `name` rides along for the log.
        rows = await asyncio.to_thread(
            page_all,
            lambda: sb.table("boardgamebuddy_games")
            .select("id, bgg_id, name")
            .is_("description", "null")
            .not_.is_("bgg_id", "null"),
            "id", label="backfill descriptions",
        )
        total_missing = len(rows)
        batch = rows[:limit]
        prog.tick(P.SCAN, 0, detail=_scan_detail(total_missing, len(batch), "a description"))

        # One BGG round trip per 20 games, not per game. The catalog seeds from
        # BGG's top ~1000, so on a cold run every row needs a description: at ~1.5s
        # per call, per-game requests would take 25 minutes and die on the platform
        # request timeout with the catalog half-filled. Chunks go sequentially —
        # this module has no rate-limit guard and _map_bgg_status turns BGG's 429
        # into an exception, so parallel batches would trip it for every user.
        by_bgg_id = {int(r["bgg_id"]): r for r in batch}
        chunks = list(chunked(batch, _DESC_CHUNK_SIZE))

        updated = 0
        failed = 0
        if not chunks:
            prog.skip(P.FETCH, detail="Nothing left to fetch")
        else:
            prog.begin(P.FETCH, total=len(chunks))
        for i, chunk in enumerate(chunks):
            prog.tick(P.FETCH, i, detail=_batch_detail(i, len(chunks), updated))
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
            except Exception as exc:
                # One bad chunk must not abort a 50-chunk run.
                logger.warning("Description backfill chunk failed (%d ids)", len(chunk), exc_info=True)
                failed += len(chunk)
                prog.event(
                    P.FETCH,
                    f"Batch {i + 1} failed ({_name_list(chunk)}) — {exc}",
                    level=AdminRunLevel.ERROR,
                )
                continue

            wrote = 0
            blank = 0
            for item in root.findall("item"):
                try:
                    item_bgg_id = int(item.get("id", "0"))
                except (TypeError, ValueError):
                    continue
                row = by_bgg_id.get(item_bgg_id)
                if not row:
                    continue
                description = bgg_description_text(item)
                if not description:
                    # BGG genuinely has no blurb for this game. Leave it NULL so it
                    # keeps showing in the panel rather than silently disappearing.
                    blank += 1
                    continue
                try:
                    sb.table("boardgamebuddy_games").update(
                        {"description": description}
                    ).eq("id", row["id"]).execute()
                    updated += 1
                    wrote += 1
                except Exception as exc:
                    logger.warning("Description write failed for game %s", row["id"], exc_info=True)
                    failed += 1
                    prog.event(
                        P.FETCH,
                        f"{_name_of(row)} — could not save: {exc}",
                        level=AdminRunLevel.ERROR,
                    )
            prog.event(P.FETCH, _saved_line(i, len(chunks), wrote, len(chunk)))
            if blank:
                # Not a failure — these rows stay in the queue on purpose, and
                # an admin watching the count not move deserves to know why.
                prog.event(
                    P.FETCH,
                    f"{blank} of this batch have no description on BoardGameGeek "
                    f"and will keep showing in the panel",
                    level=AdminRunLevel.WARN,
                )
        if chunks:
            prog.tick(P.FETCH, len(chunks), detail=f"{updated} saved")

        # Once at the end, not per game: _invalidate_game_caches does a namespace
        # -wide clear plus invalidate_bgg_thing_cache(), so calling it per row would
        # defeat the /thing cache for every concurrent user for the whole run.
        remaining = max(0, total_missing - updated)
        prog.begin(P.CACHES)
        if updated:
            _invalidate_game_caches()
        prog.tick(P.CACHES, 0, detail=_caches_detail(updated))
        prog.add_totals(updated=updated, failed=failed, remaining=remaining)

        return RefreshDescriptionsResponse(
            updated=updated,
            failed=failed,
            remaining=remaining,
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
    pass_no: int = _PASS_NO,
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshDescriptionsResponse:
    """Admin-only: fill in rating / rank / weight for games never synced, oldest first.

    Narrated into the run ledger; readable at /admin/runs/bgg-stats. See
    backfill_game_descriptions for the pass/ledger contract, which is the same.
    """
    sb = get_supabase()
    P = AdminBackfillPhase
    with admin_run_progress.run_pass(
        AdminRunTool.BGG_STATS, started_by=_admin.display_name, pass_no=pass_no
    ) as prog:
        prog.begin(P.SCAN)
        rows = await asyncio.to_thread(
            page_all,
            lambda: sb.table("boardgamebuddy_games")
            .select("id, bgg_id, name")
            .is_("bgg_stats_synced_at", "null")
            .not_.is_("bgg_id", "null"),
            "id", label="backfill stats",
        )
        total_missing = len(rows)
        batch = rows[:limit]
        prog.tick(P.SCAN, 0, detail=_scan_detail(total_missing, len(batch), "BGG stats"))
        by_bgg_id = {int(r["bgg_id"]): r["id"] for r in batch}
        chunks = list(chunked(batch, _DESC_CHUNK_SIZE))

        updated = 0
        failed = 0
        if not chunks:
            prog.skip(P.FETCH, detail="Nothing left to fetch")
        else:
            prog.begin(P.FETCH, total=len(chunks))
        for i, chunk in enumerate(chunks):
            prog.tick(P.FETCH, i, detail=_batch_detail(i, len(chunks), updated))
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
            except Exception as exc:
                logger.warning("Stats backfill chunk failed (%d ids)", len(chunk), exc_info=True)
                failed += len(chunk)
                prog.event(
                    P.FETCH,
                    f"Batch {i + 1} failed ({_name_list(chunk)}) — {exc}",
                    level=AdminRunLevel.ERROR,
                )
                continue

            synced_at = _now_iso()
            wrote = 0
            unrated = 0
            for r in chunk:
                item_bgg_id = int(r["bgg_id"])
                # Absent from the response = BGG has nothing for that id. Stamp it
                # anyway so it leaves the queue; the four stats stay NULL.
                if item_bgg_id not in stats:
                    unrated += 1
                cols = {**stats.get(item_bgg_id, {c: None for c in ("bgg_rating", "bgg_rank", "bgg_weight", "bgg_owned_count")}),
                        "bgg_stats_synced_at": synced_at}
                try:
                    sb.table("boardgamebuddy_games").update(cols).eq("id", by_bgg_id[item_bgg_id]).execute()
                    updated += 1
                    wrote += 1
                except Exception as exc:
                    logger.warning("Stats write failed for game %s", by_bgg_id[item_bgg_id], exc_info=True)
                    failed += 1
                    prog.event(
                        P.FETCH,
                        f"{_name_of(r)} — could not save: {exc}",
                        level=AdminRunLevel.ERROR,
                    )
            prog.event(P.FETCH, _saved_line(i, len(chunks), wrote, len(chunk)))
            if unrated:
                # Stamped and gone from the queue with no stats on them. Worth a
                # line: the count moves but the catalog gains nothing.
                prog.event(
                    P.FETCH,
                    f"{unrated} of this batch have no stats on BoardGameGeek — "
                    f"stamped so they leave the queue",
                    level=AdminRunLevel.WARN,
                )
        if chunks:
            prog.tick(P.FETCH, len(chunks), detail=f"{updated} saved")

        remaining = max(0, total_missing - updated)
        prog.begin(P.CACHES)
        if updated:
            _invalidate_game_caches()
        prog.tick(P.CACHES, 0, detail=_caches_detail(updated))
        prog.add_totals(updated=updated, failed=failed, remaining=remaining)

        return RefreshDescriptionsResponse(
            updated=updated,
            failed=failed,
            remaining=remaining,
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
    pass_no: int = _PASS_NO,
    _admin: CurrentUser = Depends(get_current_admin),
) -> RefreshDescriptionsResponse:
    """Admin-only: fill in publisher credits for games that have none yet.

    Narrated into the run ledger; readable at /admin/runs/bgg-publishers. See
    backfill_game_descriptions for the pass/ledger contract, which is the same.
    """
    sb = get_supabase()
    P = AdminBackfillPhase
    with admin_run_progress.run_pass(
        AdminRunTool.BGG_PUBLISHERS, started_by=_admin.display_name, pass_no=pass_no
    ) as prog:
        prog.begin(P.SCAN)
        rows = await asyncio.to_thread(
            page_all,
            lambda: sb.table("boardgamebuddy_games")
            .select("id, bgg_id, name")
            .is_("publishers", "null")
            .not_.is_("bgg_id", "null"),
            "id", label="backfill publishers",
        )
        total_missing = len(rows)
        batch = rows[:limit]
        prog.tick(P.SCAN, 0, detail=_scan_detail(total_missing, len(batch), "publisher credits"))
        by_bgg_id = {int(r["bgg_id"]): r["id"] for r in batch}
        chunks = list(chunked(batch, _DESC_CHUNK_SIZE))

        updated = 0
        failed = 0
        if not chunks:
            prog.skip(P.FETCH, detail="Nothing left to fetch")
        else:
            prog.begin(P.FETCH, total=len(chunks))
        for i, chunk in enumerate(chunks):
            prog.tick(P.FETCH, i, detail=_batch_detail(i, len(chunks), updated))
            if i:
                await asyncio.sleep(BGG_THROTTLE_SECONDS)
            ids = ",".join(str(r["bgg_id"]) for r in chunk)
            try:
                body = await fetch_bgg(
                    "/thing", {"id": ids, "stats": 0}, timeout=20.0, use_cache=False
                )
                root = parse_bgg_xml(body, context=f"backfill publishers ({len(chunk)} ids)")
            except Exception as exc:
                # One bad chunk must not abort a 50-chunk run.
                logger.warning("Publisher backfill chunk failed (%d ids)", len(chunk), exc_info=True)
                failed += len(chunk)
                prog.event(
                    P.FETCH,
                    f"Batch {i + 1} failed ({_name_list(chunk)}) — {exc}",
                    level=AdminRunLevel.ERROR,
                )
                continue

            by_item: dict[int, ET.Element] = {}
            for item in root.findall("item"):
                try:
                    by_item[int(item.get("id", "0"))] = item
                except (TypeError, ValueError):
                    continue

            wrote = 0
            uncredited = 0
            for r in chunk:
                item_bgg_id = int(r["bgg_id"])
                item = by_item.get(item_bgg_id)
                # Absent from the response = BGG has nothing under that id. Write
                # '{}' anyway so the row leaves the queue, exactly as the stats
                # backfill stamps bgg_stats_synced_at on a game BGG won't rate.
                if item is None:
                    uncredited += 1
                cols = _publisher_cols(item) if item is not None else {"publishers": []}
                try:
                    sb.table("boardgamebuddy_games").update(cols).eq("id", by_bgg_id[item_bgg_id]).execute()
                    updated += 1
                    wrote += 1
                except Exception as exc:
                    logger.warning("Publisher write failed for game %s", by_bgg_id[item_bgg_id], exc_info=True)
                    failed += 1
                    prog.event(
                        P.FETCH,
                        f"{_name_of(r)} — could not save: {exc}",
                        level=AdminRunLevel.ERROR,
                    )
            prog.event(P.FETCH, _saved_line(i, len(chunks), wrote, len(chunk)))
            if uncredited:
                prog.event(
                    P.FETCH,
                    f"{uncredited} of this batch are not on BoardGameGeek under that id — "
                    f"credited to nobody so they leave the queue",
                    level=AdminRunLevel.WARN,
                )
        if chunks:
            prog.tick(P.FETCH, len(chunks), detail=f"{updated} saved")

        remaining = max(0, total_missing - updated)
        prog.begin(P.CACHES)
        if updated:
            _invalidate_game_caches()
        prog.tick(P.CACHES, 0, detail=_caches_detail(updated))
        prog.add_totals(updated=updated, failed=failed, remaining=remaining)

        return RefreshDescriptionsResponse(
            updated=updated,
            failed=failed,
            remaining=remaining,
        )
