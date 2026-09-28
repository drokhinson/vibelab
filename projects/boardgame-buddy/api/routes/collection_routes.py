"""User collection endpoints — closet / played / wishlist.

Every handler runs its Supabase round trips through `asyncio.to_thread` — the
client is synchronous and this service runs one uvicorn worker, so a read left
on the loop stalls every other request in flight.
"""

import asyncio
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, Path, Query, HTTPException
from supabase import Client

from db import get_supabase

from . import router
from .models import (
    CollectionAdd,
    CollectionItem,
    CollectionPageResponse,
    CollectionPlayedBefore,
    CollectionShelfResponse,
    CollectionStatusMapResponse,
    CollectionUpdate,
    MessageResponse,
)
from .constants import (
    CollectionSort,
    CollectionStatus,
    PlayMode,
)
from .dependencies import CurrentUser, get_current_user
from .game_routes import (
    COLLECTION_DENORM_GAME_FIELDS,
    collection_denormalized_from_game,
)
from .services._helpers import raise_for_rpc_error


def _game_denorm(sb: Client, game_id: str) -> dict:
    """The game's denormalized game_* columns for a collection row; 404 if the
    game does not exist."""
    game = (
        sb.table("boardgamebuddy_games")
        .select(COLLECTION_DENORM_GAME_FIELDS)
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")
    return collection_denormalized_from_game(game.data[0])


def _collection_row(sb: Client, user_id: str, game_id: str) -> dict | None:
    rows = (
        sb.table("boardgamebuddy_collections")
        .select("status, played_before_at")
        .eq("user_id", user_id)
        .eq("game_id", game_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


def _upsert_collection(sb: Client, user_id: str, game_id: str, status: str) -> None:
    """Set one game's shelf status for one user.

    Verifies the game exists AND fetches its denormalized fields in one round
    trip, so the upsert can populate the game_* cache columns without a second
    select. Upsert rather than update because the row may not pre-exist — a
    wishlist->owned bump from a surface that never added the game.

    'played' is not a shelf and cannot be set here: it is the row that holds
    the played mark for a game on no shelf, and only _set_played_mark writes
    it. The upsert never names played_before_at, so a shelf change leaves the
    mark where it is — a marked game that is then bought stays marked.
    """
    if status == CollectionStatus.PLAYED.value:
        raise HTTPException(
            status_code=400,
            detail="'played' is not a shelf — set the played mark instead",
        )
    sb.table("boardgamebuddy_collections").upsert({
        "user_id": user_id,
        "game_id": game_id,
        "status": status,
        **_game_denorm(sb, game_id),
    }, on_conflict="user_id,game_id").execute()


def _set_played_mark(sb: Client, user_id: str, game_id: str, on: bool) -> None:
    """The played mark (migration 057): "played it, somewhere I didn't log it".

    One mark behind both switches — the collection sheet's and the Stats Shelf
    of Shame's — stored as played_before_at on the game's row, whatever its
    status. A game on no shelf gets a status 'played' row to hold it, and that
    row goes when the mark is cleared; any other row just loses the stamp.
    An existing stamp is kept rather than refreshed, so it still says when the
    claim was first made.
    """
    row = _collection_row(sb, user_id, game_id)
    table = sb.table("boardgamebuddy_collections")
    if on:
        if row is None:
            table.insert({
                "user_id": user_id,
                "game_id": game_id,
                "status": CollectionStatus.PLAYED.value,
                "played_before_at": datetime.now(timezone.utc).isoformat(),
                **_game_denorm(sb, game_id),
            }).execute()
        elif not row.get("played_before_at"):
            (table.update({"played_before_at": datetime.now(timezone.utc).isoformat()})
             .eq("user_id", user_id).eq("game_id", game_id).execute())
        return
    if row is None:
        return
    if row.get("status") == CollectionStatus.PLAYED.value:
        table.delete().eq("user_id", user_id).eq("game_id", game_id).execute()
    elif row.get("played_before_at"):
        (table.update({"played_before_at": None})
         .eq("user_id", user_id).eq("game_id", game_id).execute())


def _remove_from_shelf(sb: Client, user_id: str, game_id: str) -> None:
    """Take a game off its shelf. A marked game keeps its mark: the row stays
    as status 'played', so the game moves to the Played shelf rather than
    vanishing. An unmarked row is deleted."""
    row = _collection_row(sb, user_id, game_id)
    if row is None:
        return
    table = sb.table("boardgamebuddy_collections")
    if row.get("played_before_at"):
        if row.get("status") != CollectionStatus.PLAYED.value:
            (table.update({"status": CollectionStatus.PLAYED.value})
             .eq("user_id", user_id).eq("game_id", game_id).execute())
        return
    table.delete().eq("user_id", user_id).eq("game_id", game_id).execute()


@router.post(
    "/collection",
    response_model=MessageResponse,
    status_code=201,
    summary="Add game to collection",
)
async def add_to_collection(
    body: CollectionAdd,
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Add a game to the user's collection."""
    await asyncio.to_thread(
        _upsert_collection, get_supabase(), user.user_id, body.game_id, body.status.value
    )
    return MessageResponse(message=f"Game added as {body.status.value}")


@router.patch(
    "/collection/{game_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Update collection status",
)
async def update_collection(
    body: CollectionUpdate,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Change the status of a game in the user's collection."""
    await asyncio.to_thread(
        _upsert_collection, get_supabase(), user.user_id, game_id, body.status.value
    )
    return MessageResponse(message=f"Status updated to {body.status.value}")


@router.patch(
    "/collection/{game_id}/played-before",
    response_model=MessageResponse,
    status_code=200,
    summary="Mark a game as played without a logged play",
)
async def set_played_before(
    body: CollectionPlayedBefore,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Set or clear the played mark — see _set_played_mark.

    Readers: the Played shelf (a game on no shelf), the Shelf of Shame block of
    bgb_user_stats_detail (an owned game), the rank queue
    (services/rank_service.queue) and the status map's played_marks. It is
    never a play.
    """
    await asyncio.to_thread(
        _set_played_mark, get_supabase(), user.user_id, game_id, body.played_before
    )
    return MessageResponse(
        message="Marked as played" if body.played_before else "Mark removed"
    )


@router.delete(
    "/collection/{game_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Remove from collection",
)
async def remove_from_collection(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Take a game off its shelf; a played mark survives — see _remove_from_shelf."""
    await asyncio.to_thread(_remove_from_shelf, get_supabase(), user.user_id, game_id)
    return MessageResponse(message="Game removed from collection")


# ── Collection reads ──────────────────────────────────────────────────────────
# Three tailored reads for the Profile view's collection plate, each one RPC:
# the status map (pills and expansion badges), the whole shelf (client-side
# paging), and the paginated grid. All three sort by last_played DESC NULLS
# LAST then added_at DESC, so the user's most-recently-played base games
# surface first and the newest additions follow.

@router.get(
    "/collection/status-map",
    response_model=CollectionStatusMapResponse,
    status_code=200,
    summary="Viewer's game->status map and owned-expansion counts",
)
async def collection_status_map(
    user: CurrentUser = Depends(get_current_user),
) -> CollectionStatusMapResponse:
    """The status pills and expansion badges, in one DB round trip.

    Replaced a flat collection read that cost three unbounded round trips to
    produce two dicts. This read re-fires roughly once a minute of active
    navigation.
    """
    result = await asyncio.to_thread(
        get_supabase().rpc("bgb_collection_status_map", {"p_viewer": user.user_id}).execute
    )
    data = result.data or {}
    return CollectionStatusMapResponse(
        status_map=data.get("status_map") or {},
        expansion_counts={str(k): int(v) for k, v in (data.get("expansion_counts") or {}).items()},
        played_marks=[str(g) for g in (data.get("played_marks") or [])],
    )


# ── Whole-shelf read (client-side paging) ─────────────────────────────────────
# The web client pulls a shelf once through this endpoint, caches it, and
# derives every page, filter and search locally — so a page turn costs no round
# trip at all. /collection/grid is the paginated, server-filtered sibling the
# game explorer pages against, and the fallback once a shelf outgrows the row
# cap below.

_SHELF_DEFAULT_LIMIT = 1000
_SHELF_MAX_LIMIT = 5000


@router.get(
    "/collection/shelf",
    response_model=CollectionShelfResponse,
    status_code=200,
    summary="Whole collection shelf in one response (for client-side paging)",
)
async def collection_shelf(
    status: CollectionStatus = Query(
        CollectionStatus.OWNED,
        description=(
            "Which shelf to return — owned (default), wishlist, or played "
            "(games the user has plays for but does not own / wishlist). "
            "Wishlist is only returned to its owner. `owned` also returns "
            "prev_owned rows — a game you sold is still on your Owned shelf — "
            "and `parted_total` says how many of them there are."
        ),
    ),
    exclude_expansions: bool = Query(
        True,
        description="When true (default) expansions are hidden — surfaced separately on the Profile.",
    ),
    limit: int = Query(
        _SHELF_DEFAULT_LIMIT,
        ge=1,
        le=_SHELF_MAX_LIMIT,
        description=(
            "Hard row cap. When the shelf is larger, `items` is a prefix and "
            "`truncated` is true so the caller can fall back to /collection/grid."
        ),
    ),
    user_id: Optional[str] = Query(
        None,
        description="Target user (profiles are public); defaults to the viewer.",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> CollectionShelfResponse:
    """One shelf, whole, pre-sorted — so the client can page without refetching.

    Ordering matches /collection/grid's default so the caller can slice
    directly: owned/played by last_played DESC NULLS LAST then added_at DESC,
    wishlist by added_at DESC. No search/filter parameters by design — they
    would multiply the client's cache keys, and every filter the grid applies
    is a pure function of fields already on each returned row.
    """
    result = await asyncio.to_thread(
        get_supabase().rpc(
            "bgb_collection_shelf",
            {
                "viewer": user.user_id,
                "target": user_id or user.user_id,
                "p_status": status.value,
                "p_exclude_expansions": exclude_expansions,
                "p_limit": limit,
            },
        ).execute
    )

    data = result.data or {}
    return CollectionShelfResponse(
        items=[CollectionItem(**row) for row in (data.get("items") or [])],
        total=data.get("total") or 0,
        parted_total=data.get("parted_total") or 0,
        truncated=bool(data.get("truncated")),
        generated_at=datetime.now(timezone.utc),
    )


@router.get(
    "/collection/grid",
    response_model=CollectionPageResponse,
    status_code=200,
    summary="Paginated collection grid (owned default; wishlist / played also supported)",
)
async def collection_grid(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(12, ge=1, le=100, description="Tiles per page"),
    status: CollectionStatus = Query(
        CollectionStatus.OWNED,
        description=(
            "Which shelf to return — owned (default), wishlist, or played "
            "(games the user has plays for — logged by them or by someone who "
            "listed them as a player — but does not currently own / wishlist)."
        ),
    ),
    search: Optional[str] = Query(None, description="Case-insensitive game-name match"),
    players: Optional[int] = Query(None, ge=1, le=20),
    playtime_min: Optional[int] = Query(None, ge=1),
    playtime_max: Optional[int] = Query(None, ge=1),
    play_mode: Optional[PlayMode] = Query(None, description="competitive / coop / team"),
    exclude_expansions: bool = Query(
        True,
        description="When true (default) expansions are hidden — surfaced separately on the Profile.",
    ),
    sort: CollectionSort = Query(
        CollectionSort.LAST_PLAYED,
        description="Sort order — last_played (default), added_at, or alphabetical.",
    ),
    prioritize_exact_players: bool = Query(
        False,
        description=(
            "When true AND players is set, surface games whose max_players "
            "exactly equals players above wider-range games. Off by default "
            "so the chosen sort stays consistent across pages."
        ),
    ),
    user_id: Optional[str] = Query(
        None,
        description="Target user (profiles are public); defaults to the viewer.",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> CollectionPageResponse:
    """Collection shelf sorted by `sort` (default last_played DESC NULLS LAST, then added_at DESC).

    One RPC: bgb_collection_page (migration 024) filters, sorts, counts and
    slices in Postgres. This used to read the WHOLE shelf on every page turn
    and do all four in Python, across two round trips (owned/wishlist) or three
    (played) — and worse than slow, the reads were unbounded, PostgREST
    silently caps those at 1000 rows, and the filter ran after the truncation,
    so on a large shelf a matching game could be missing because it sat past
    row 1000. The wishlist gate and the played shelf's synthetic ids live in
    the function now; its header states the equivalence rules.
    """
    result = await asyncio.to_thread(
        get_supabase().rpc(
            "bgb_collection_page",
            {
                "viewer": user.user_id,
                "target": user_id or user.user_id,
                "p_status": status.value,
                "p_search": search,
                "p_players": players,
                "p_playtime_min": playtime_min,
                "p_playtime_max": playtime_max,
                "p_play_mode": play_mode.value if play_mode else None,
                "p_exclude_expansions": exclude_expansions,
                "p_sort": sort.value,
                "p_prioritize_exact_players": prioritize_exact_players,
                "p_page": page,
                "p_per_page": per_page,
            },
        ).execute
    )
    raise_for_rpc_error(result.data, "Collection grid")

    data = result.data
    return CollectionPageResponse(
        items=[CollectionItem(**row) for row in (data.get("items") or [])],
        total=data.get("total") or 0,
        parted_total=data.get("parted_total") or 0,
        page=page,
        per_page=per_page,
    )
