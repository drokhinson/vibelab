"""Game catalog endpoints — browse, search, detail, BGG proxy."""

import logging
import xml.etree.ElementTree as ET
from typing import Optional

import httpx
from fastapi import Query, Path, HTTPException
from fastapi.responses import Response
from supabase import Client

from db import get_supabase
from shared_models import HealthResponse

from . import router
from .models import GameDetail, GameListResponse, GameSummary, BggSearchResult, RefreshImagesResponse

logger = logging.getLogger(__name__)

BGG_API_BASE = "https://boardgamegeek.com/xmlapi2"
BGG_USER_AGENT = "vibelab-boardgame-buddy/1.0"
STORAGE_BUCKET = "boardgamebuddy-games"


def _normalize_image_url(url: str | None) -> str | None:
    """Ensure BGG image URLs have an explicit https: scheme (BGG returns protocol-relative URLs)."""
    if not url:
        return None
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    return url


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


async def _fetch_bgg(path: str, params: dict, *, timeout: float) -> str:
    """GET an XML document from the BGG API with consistent error mapping."""
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": BGG_USER_AGENT},
        ) as client:
            resp = await client.get(f"{BGG_API_BASE}{path}", params=params)
    except httpx.HTTPError as exc:
        logger.warning("BGG network error on %s %s: %s", path, params, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )

    if resp.status_code == 202:
        # BGG returns 202 when the result is being generated (cold cache).
        logger.info("BGG 202 (warming up) for %s %s", path, params)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is warming up this result. Retry in a few seconds.",
        )
    if resp.status_code == 429:
        logger.warning("BGG 429 rate limit for %s %s", path, params)
        raise HTTPException(
            status_code=429,
            detail="BoardGameGeek rate-limited us. Wait a few seconds and try again.",
        )
    if resp.status_code != 200:
        logger.warning(
            "BGG returned %s for %s %s: %s",
            resp.status_code, path, params, resp.text[:200],
        )
        raise HTTPException(
            status_code=502,
            detail=f"BoardGameGeek returned HTTP {resp.status_code}.",
        )

    return resp.text


def _parse_bgg_xml(body: str, *, context: str) -> ET.Element:
    """Parse a BGG XML payload; map parse errors to a 502."""
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        logger.warning(
            "BGG XML parse error (%s): %s\nbody[:300]=%r",
            context, exc, body[:300],
        )
        raise HTTPException(
            status_code=502,
            detail="Could not parse BoardGameGeek response.",
        )


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
) -> GameListResponse:
    """List games from the catalog, with optional search and filters."""
    sb = get_supabase()
    offset = (page - 1) * per_page

    query = sb.table("boardgamebuddy_games").select(
        "id, bgg_id, name, year_published, min_players, max_players, "
        "playing_time, thumbnail_url, bgg_rank, bgg_rating, theme_color",
        count="exact",
    )

    if search:
        query = query.ilike("name", f"%{search}%")
    if category:
        query = query.contains("categories", [category])

    query = query.order("bgg_rank")
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
    body = await _fetch_bgg(
        "/search",
        {"query": query, "type": "boardgame"},
        timeout=10.0,
    )
    root = _parse_bgg_xml(body, context=f"search query={query!r}")

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

    # Check if already exists
    existing = (
        sb.table("boardgamebuddy_games")
        .select("*")
        .eq("bgg_id", bgg_id)
        .execute()
    )
    if existing.data:
        return GameSummary(**existing.data[0])

    # Fetch from BGG
    body = await _fetch_bgg(
        "/thing",
        {"id": bgg_id, "stats": 1},
        timeout=15.0,
    )
    root = _parse_bgg_xml(body, context=f"thing id={bgg_id}")
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

    # Extract rating
    rating_el = item.find(".//ratings/average")
    rating = None
    if rating_el is not None:
        try:
            rating = round(float(rating_el.get("value", "0")), 2)
        except (ValueError, TypeError):
            pass

    # Extract categories and mechanics
    categories = [
        link.get("value", "")
        for link in item.findall("link[@type='boardgamecategory']")
    ]
    mechanics = [
        link.get("value", "")
        for link in item.findall("link[@type='boardgamemechanic']")
    ]

    game_data = {
        "bgg_id": bgg_id,
        "name": name,
        "year_published": int(year_el.get("value", "0")) if year_el is not None else None,
        "min_players": int(min_el.get("value", "0")) if min_el is not None else None,
        "max_players": int(max_el.get("value", "0")) if max_el is not None else None,
        "playing_time": int(time_el.get("value", "0")) if time_el is not None else None,
        "image_url": await _upload_to_storage(
            sb, bgg_id, _normalize_image_url(img_el.text if img_el is not None else None), "image"
        ),
        "thumbnail_url": await _upload_to_storage(
            sb, bgg_id, _normalize_image_url(thumb_el.text if thumb_el is not None else None), "thumb"
        ),
        "bgg_rating": rating,
        "categories": categories,
        "mechanics": mechanics,
    }

    result = (
        sb.table("boardgamebuddy_games")
        .insert(game_data)
        .execute()
    )

    return GameSummary(**result.data[0])


@router.post(
    "/games/refresh-images",
    response_model=RefreshImagesResponse,
    status_code=200,
    summary="Refresh image URLs for all games",
)
async def refresh_game_images() -> RefreshImagesResponse:
    """Re-host images in Supabase Storage for games with missing or BGG-hosted image URLs."""
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
            body = await _fetch_bgg("/thing", {"id": game["bgg_id"], "stats": 0}, timeout=10.0)
            root = _parse_bgg_xml(body, context=f"refresh bgg_id={game['bgg_id']}")
            item = root.find("item")
            if item is None:
                continue
            img_el = item.find("image")
            thumb_el = item.find("thumbnail")
            raw_img = _normalize_image_url(img_el.text if img_el is not None else None)
            raw_thumb = _normalize_image_url(thumb_el.text if thumb_el is not None else None)
            sb.table("boardgamebuddy_games").update({
                "image_url": await _upload_to_storage(sb, game["bgg_id"], raw_img, "image"),
                "thumbnail_url": await _upload_to_storage(sb, game["bgg_id"], raw_thumb, "thumb"),
            }).eq("id", game["id"]).execute()
            updated += 1
        except Exception:
            continue
    return RefreshImagesResponse(updated=updated)


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
