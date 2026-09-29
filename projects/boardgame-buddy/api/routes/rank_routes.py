"""Rank your games.

The game page's rank pill, the Collection card's count and the rank queue all
read from here. A category is never chosen by the client: it is decided in
services/rank_category.py from BGG's family ranks, and a game keeps the list it
was first ranked in.
"""

import asyncio
from typing import Annotated

from fastapi import Depends, Path, Query

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .rank_models import (
    RankContext,
    RankDeferResponse,
    RankPlaced,
    RankQueueResponse,
    RankRemoveResponse,
    RanksResponse,
    RankWrite,
)
from .services import rank_service


@router.get(
    "/ranks",
    response_model=RanksResponse,
    status_code=200,
    summary="Every game the viewer has ranked",
)
async def list_ranks(user: CurrentUser = Depends(get_current_user)) -> RanksResponse:
    ranks = await asyncio.to_thread(rank_service.list_ranks, get_supabase(), user.user_id)
    return RanksResponse(ranks=ranks)


@router.get(
    "/ranks/queue",
    response_model=RankQueueResponse,
    status_code=200,
    summary="Owned or played games the viewer has not ranked yet",
)
async def rank_queue(user: CurrentUser = Depends(get_current_user)) -> RankQueueResponse:
    items = await asyncio.to_thread(rank_service.queue, get_supabase(), user.user_id)
    return RankQueueResponse(items=items)


@router.get(
    "/ranks/games/{game_id}",
    response_model=RankContext,
    status_code=200,
    summary="A game's category, its current rank, and the list it ranks against",
)
async def rank_context(
    game_id: str = Path(..., description="Game UUID"),
    current: Annotated[bool, Query(description="List the category the game belongs in now (Re-rank)")] = False,
    user: CurrentUser = Depends(get_current_user),
) -> RankContext:
    return await asyncio.to_thread(rank_service.context, get_supabase(), user.user_id, game_id, current)


@router.put(
    "/ranks/games/{game_id}",
    response_model=RankPlaced,
    status_code=200,
    summary="Rank a game, or move it",
)
async def rank_game(
    body: RankWrite,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> RankPlaced:
    return await asyncio.to_thread(
        rank_service.place, get_supabase(), user.user_id, game_id, body.tier, body.index,
        body.recategorize,
    )


@router.delete(
    "/ranks/games/{game_id}",
    response_model=RankRemoveResponse,
    status_code=200,
    summary="Take a game out of the ranking",
)
async def unrank_game(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> RankRemoveResponse:
    removed = await asyncio.to_thread(rank_service.remove, get_supabase(), user.user_id, game_id)
    return RankRemoveResponse(removed=removed)


@router.put(
    "/ranks/games/{game_id}/defer",
    response_model=RankDeferResponse,
    status_code=200,
    summary="Rank a game after its next play",
)
async def defer_rank(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> RankDeferResponse:
    await asyncio.to_thread(rank_service.defer, get_supabase(), user.user_id, game_id)
    return RankDeferResponse(deferred=True)
