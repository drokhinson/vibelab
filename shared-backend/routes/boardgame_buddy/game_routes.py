"""Game catalog endpoints — browse, search, detail, BGG proxy."""

import logging
import xml.etree.ElementTree as ET
from typing import Optional

import httpx
from fastapi import Depends, Header, Query, Path, HTTPException
from fastapi.responses import Response
from supabase import Client

from db import get_supabase
from shared_models import HealthResponse

from . import router
from .bgg_client import (
    BGG_USER_AGENT,
    fetch_bgg,
    normalize_image_url,
    parse_bgg_xml,
)
from .constants import EXPANSION_COLOR_PALETTE
from .dependencies import CurrentUser, get_current_admin, maybe_supabase_user
from .models import GameDetail, GameListResponse, GameSummary, BggSearchResult, RefreshImagesResponse

logger = logging.getLogger(__name__)

STORAGE_BUCKET = "boardgamebuddy-games"


async def _upload_to_storage(sb: Client, bgg_id: int, url: str | None, kind: str) -> str | None:
    """Download a BGG image and re-host it in Supabase Storage; returns the permanent public URL."""
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
    owned_only: bool = Query(False, description="Only games in the caller's owned collection (requires auth; ignored otherwise)"),
    authorization: Optional[str] = Header(None),
) -> GameListResponse:
    """List games from the catalog, with optional search and filters."""
    sb = get_supabase()
    offset = (page - 1) * per_page

    owned_ids: Optional[list[str]] = None
    if owned_only:
        su_user = await maybe_supabase_user(authorization)
        if su_user is None:
            return GameListResponse(games=[], total=0, page=page, per_page=per_page)
        col = (
            sb.table("boardgamebuddy_collections")
            .select("game_id")
            .eq("user_id", su_user.sub)
            .eq("status", "owned")
            .execute()
        )
        owned_ids = [row["game_id"] for row in (col.data or [])]
        if not owned_ids:
            return GameListResponse(games=[], total=0, page=page, per_page=per_page)

    query = sb.table("boardgamebuddy_games").select(
        "id, bgg_id, name, year_published, min_players, max_players, "
        "playing_time, thumbnail_url, image_url, theme_color, "
        "is_expansion, base_game_bgg_id, expansion_color, rulebook_url",
        count="exact",
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

    query = query.order("name")
    result = query.range(offset, offset + per_page - 1).execute()

    games = [GameSummary(**g) for g in (result.data or [])]
    total = result.count or 0

    return GameListResponse(games=games, total=total, page=page, per_page=per_page)


@router.get(
    "/games/search-bgg",
    response_model=list[BggSearchResult],
    status_code=200,
    summary="Search BoardGameGeek",
)
async def search_bgg(
    query: str = Query(..., min_length=2, description="Search query"),
) -> list[BggSearchResult]:
    """Proxy search to BGG XML API for games not yet in our database."""
    body = await fetch_bgg(
        "/search",
        {"query": query, "type": "boardgame"},
        timeout=10.0,
    )
    root = parse_bgg_xml(body, context=f"search query={query!r}")

    results: list[BggSearchResult] = []
    bgg_ids: list[int] = []
    for item in root.findall("item")[:20]:
        try:
            bgg_id = int(item.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_id:
            continue
        name_el = item.find("name")
        year_el = item.find("yearpublished")
        name = name_el.get("value", "") if name_el is not None else ""
        year = None
        if year_el is not None:
            try:
                year = int(year_el.get("value", "0")) or None
            except (TypeError, ValueError):
                year = None

        bgg_ids.append(bgg_id)
        results.append(BggSearchResult(
            bgg_id=bgg_id,
            name=name,
            year_published=year,
        ))

    # Check which are already in our DB
    if bgg_ids:
        sb = get_supabase()
        existing = (
            sb.table("boardgamebuddy_games")
            .select("bgg_id")
            .in_("bgg_id", bgg_ids)
            .execute()
        )
        existing_set = {r["bgg_id"] for r in (existing.data or [])}
        for r in results:
            r.already_in_db = r.bgg_id in existing_set

    return results


@router.get(
    "/games/mechanics",
    response_model=list[str],
    status_code=200,
    summary="Distinct mechanics",
)
async def list_mechanics() -> list[str]:
    """Return a sorted list of all distinct mechanic strings across all games."""
    sb = get_supabase()
    rows = sb.table("boardgamebuddy_games").select("mechanics").execute()
    seen: set[str] = set()
    for row in rows.data or []:
        for m in row.get("mechanics") or []:
            if m:
                seen.add(m)
    return sorted(seen)


@router.get(
    "/games/{game_id}",
    response_model=GameDetail,
    status_code=200,
    summary="Game detail",
)
async def get_game(
    game_id: str = Path(..., description="Game UUID"),
) -> GameDetail:
    """Get full details for a single game."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_games")
        .select("*")
        .eq("id", game_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Game not found")

    return GameDetail(**result.data[0])


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

    name_el = item.find("name[@type='primary']")
    name = name_el.get("value", "") if name_el is not None else "Unknown"

    year_el = item.find("yearpublished")
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
        "year_published": int(year_el.get("value", "0")) if year_el is not None else None,
        "min_players": int(min_el.get("value", "0")) if min_el is not None else None,
        "max_players": int(max_el.get("value", "0")) if max_el is not None else None,
        "playing_time": int(time_el.get("value", "0")) if time_el is not None else None,
        "image_url": await _upload_to_storage(
            sb, bgg_id, normalize_image_url(img_el.text if img_el is not None else None), "image"
        ),
        "thumbnail_url": await _upload_to_storage(
            sb, bgg_id, normalize_image_url(thumb_el.text if thumb_el is not None else None), "thumb"
        ),
        "categories": categories,
        "mechanics": mechanics,
        "is_expansion": is_expansion,
        "base_game_bgg_id": base_game_bgg_id,
        "expansion_color": expansion_color,
    }

    result = (
        sb.table("boardgamebuddy_games")
        .insert(game_data)
        .execute()
    )
    return result.data[0]


@router.post(
    "/games/import-bgg/{bgg_id}",
    response_model=GameSummary,
    status_code=201,
    summary="Import game from BGG",
)
async def import_bgg_game(
    bgg_id: int = Path(..., description="BoardGameGeek game ID"),
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
    result = sb.table("boardgamebuddy_games").select("id, bgg_id, image_url, thumbnail_url").execute()
    updated = 0
    for game in result.data or []:
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
            updated += 1
        except Exception:
            continue
    return RefreshImagesResponse(updated=updated)


_GAME_SUMMARY_FIELDS = (
    "id, bgg_id, name, year_published, min_players, max_players, "
    "playing_time, thumbnail_url, image_url, theme_color, "
    "is_expansion, base_game_bgg_id, expansion_color, rulebook_url"
)
# Legacy alias kept so existing call sites read identically.
_MISSING_IMAGES_FIELDS = _GAME_SUMMARY_FIELDS


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


@router.get(
    "/games/lookup-by-bgg/{bgg_id}",
    response_model=Optional[GameSummary],
    status_code=200,
    summary="Look up an existing catalog game by BGG id",
)
async def lookup_game_by_bgg(
    bgg_id: int = Path(..., description="BoardGameGeek game id"),
) -> Optional[GameSummary]:
    """Return the catalog row for this BGG id if it's already imported, else null."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_games")
        .select(_GAME_SUMMARY_FIELDS)
        .eq("bgg_id", bgg_id)
        .execute()
    )
    if not result.data:
        return None
    return GameSummary(**result.data[0])


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
        .select(_MISSING_IMAGES_FIELDS)
        .or_("image_url.is.null,thumbnail_url.is.null")
        .order("name")
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
        .select(_GAME_SUMMARY_FIELDS)
        .eq("id", game_id)
        .execute()
    )
    if not refreshed.data:
        raise HTTPException(status_code=500, detail="Failed to update game row")
    return GameSummary(**refreshed.data[0])


@router.get(
    "/games/image-proxy",
    status_code=200,
    summary="Proxy a BGG CDN image to avoid hotlink blocking",
)
async def proxy_bgg_image(
    url: str = Query(..., description="BGG CDN image URL to proxy"),
) -> Response:
    """Fetch a BGG image server-side and stream it back to the browser."""
    if url.startswith("//"):
        url = "https:" + url
    if not url.startswith("https://cf.geekdo-images.com/"):
        raise HTTPException(status_code=400, detail="Only BGG CDN images are supported")
    try:
        async with httpx.AsyncClient(
            timeout=10.0,
            headers={"User-Agent": BGG_USER_AGENT},
            follow_redirects=True,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch image: {exc}")
    content_type = resp.headers.get("content-type", "image/jpeg")
    return Response(
        content=resp.content,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )
