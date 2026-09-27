"""Unified game search endpoint.

The redesign replaces the previous separate /games?search=... + /games/search-bgg
pair with a single ranked /search endpoint that puts collection hits first,
then DB matches; BGG hits are fetched only when the caller passes
include_bgg=true (used when the user taps "Search BoardGameGeek for more").

Under include_bgg, a query that is a BGG id or a boardgamegeek.com link is
resolved through /thing as well as (or instead of) the name search, so a game
can be reached by the number on its shelf label. See search_service._bgg_hits.
"""

from fastapi import Depends, HTTPException, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import BggThumbnailsResponse, CatalogIndexResponse, UnifiedSearchResponse
from .services import bgg_thumbnails, search_service


@router.get(
    "/search",
    response_model=UnifiedSearchResponse,
    status_code=200,
    summary="Unified game search (collection → DB → optional BGG)",
)
async def unified_search(
    q: str = Query(
        ...,
        min_length=1,
        description=(
            "Search query. Matched against names; under include_bgg a bare "
            "BGG id or a boardgamegeek.com/boardgame/<id> link additionally "
            "resolves that one game."
        ),
    ),
    limit: int = Query(20, ge=1, le=50, description="Max hits per source"),
    include_bgg: bool = Query(
        False,
        description="If true, additionally search BoardGameGeek (slower).",
    ),
    include_expansions: bool = Query(
        False,
        description=(
            "If true, expansion rows are listed alongside base games. Off by "
            "default — expansions belong to a base game's expansion section."
        ),
    ),
    user: CurrentUser = Depends(get_current_user),
) -> UnifiedSearchResponse:
    """Single ranked search list. Pass include_bgg=true to fetch BGG too."""
    return await search_service.unified_search(
        get_supabase(),
        user.user_id,
        q,
        limit=limit,
        include_bgg=include_bgg,
        include_expansions=include_expansions,
    )


@router.get(
    "/search/index",
    response_model=CatalogIndexResponse,
    status_code=200,
    summary="Every base game in the catalog, compact, for client-side search",
)
async def search_index(
    user: CurrentUser = Depends(get_current_user),
) -> CatalogIndexResponse:
    """The Gather picker's whole answer, fetched once and searched on-device.

    Lives under /search rather than /games so no `/games/{game_id}` route can
    swallow it (tests/test_route_ordering.py). Not viewer-specific — the
    response is shared across every caller for its TTL — but authenticated
    like everything else the catalog exposes.
    """
    return await search_service.catalog_index(get_supabase())


@router.get(
    "/search/bgg-thumbnails",
    response_model=BggThumbnailsResponse,
    status_code=200,
    summary="Thumbnails for up to 20 BGG search rows (at most one BGG call)",
)
async def search_bgg_thumbnails(
    ids: str = Query(..., description="Comma-separated BGG ids, at most 20"),
    user: CurrentUser = Depends(get_current_user),
) -> BggThumbnailsResponse:
    """BGG's /search carries no images, so the import sheet asks for the rows it
    shows. Catalog and thumb cache first; BGG only for ids nobody has seen."""
    try:
        wanted = [int(p) for p in ids.split(",") if p.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail="ids must be comma-separated integers")
    if len(wanted) > bgg_thumbnails.MAX_IDS:
        raise HTTPException(
            status_code=422, detail=f"At most {bgg_thumbnails.MAX_IDS} ids per request"
        )
    found = await bgg_thumbnails.bgg_thumbnails(get_supabase(), wanted)
    return BggThumbnailsResponse(thumbnails={str(k): v for k, v in found.items()})
