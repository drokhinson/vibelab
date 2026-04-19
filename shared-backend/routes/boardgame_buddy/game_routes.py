"""Game catalog endpoints — browse, search, detail, BGG proxy."""

import xml.etree.ElementTree as ET
from typing import Optional

import httpx
from fastapi import Query, Path, HTTPException

from db import get_supabase
from shared_models import HealthResponse

from . import router
from .models import GameDetail, GameListResponse, GameSummary, BggSearchResult


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
    async with httpx.AsyncClient(
        timeout=10.0,
        headers={"User-Agent": "vibelab-boardgame-buddy/1.0"},
    ) as client:
        resp = await client.get(
            "https://boardgamegeek.com/xmlapi2/search",
            params={"query": query, "type": "boardgame"},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="BGG API unavailable")

    root = ET.fromstring(resp.text)
    results: list[BggSearchResult] = []

    bgg_ids: list[int] = []
    for item in root.findall("item")[:20]:
        bgg_id = int(item.get("id", "0"))
        name_el = item.find("name")
        year_el = item.find("yearpublished")
        name = name_el.get("value", "") if name_el is not None else ""
        year = int(year_el.get("value", "0")) if year_el is not None else None

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
    async with httpx.AsyncClient(
        timeout=15.0,
        headers={"User-Agent": "vibelab-boardgame-buddy/1.0"},
    ) as client:
        resp = await client.get(
            "https://boardgamegeek.com/xmlapi2/thing",
            params={"id": bgg_id, "stats": 1},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="BGG API unavailable")

    root = ET.fromstring(resp.text)
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
        "image_url": img_el.text if img_el is not None else None,
        "thumbnail_url": thumb_el.text if thumb_el is not None else None,
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
