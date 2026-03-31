"""User collection endpoints — closet / played / wishlist."""

from typing import Optional

from fastapi import Depends, Path, Query, HTTPException

from db import get_supabase

from . import router
from .models import (
    CollectionAdd,
    CollectionItem,
    CollectionUpdate,
    GameSummary,
    MessageResponse,
)
from .constants import CollectionStatus
from .dependencies import CurrentUser, get_current_user


@router.get(
    "/collection",
    response_model=list[CollectionItem],
    status_code=200,
    summary="Get user collection",
)
async def get_collection(
    status: Optional[CollectionStatus] = Query(None, description="Filter by status"),
    user: CurrentUser = Depends(get_current_user),
) -> list[CollectionItem]:
    """List all games in the current user's collection."""
    sb = get_supabase()

    query = (
        sb.table("boardgamebuddy_collections")
        .select(
            "id, game_id, status, added_at, "
            "boardgamebuddy_games(id, bgg_id, name, year_published, min_players, "
            "max_players, playing_time, thumbnail_url, bgg_rank, bgg_rating, theme_color)"
        )
        .eq("user_id", user.user_id)
        .order("added_at", desc=True)
    )

    if status:
        query = query.eq("status", status.value)

    result = query.execute()

    items: list[CollectionItem] = []
    for row in result.data or []:
        game_data = row.get("boardgamebuddy_games", {})
        if game_data:
            items.append(CollectionItem(
                id=row["id"],
                game_id=row["game_id"],
                status=row["status"],
                added_at=row["added_at"],
                game=GameSummary(**game_data),
            ))

    return items


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
    sb = get_supabase()

    # Verify game exists
    game = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("id", body.game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    # Upsert collection entry
    sb.table("boardgamebuddy_collections").upsert({
        "user_id": user.user_id,
        "game_id": body.game_id,
        "status": body.status.value,
    }, on_conflict="user_id,game_id").execute()

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
    sb = get_supabase()

    result = (
        sb.table("boardgamebuddy_collections")
        .update({"status": body.status.value})
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Game not in collection")

    return MessageResponse(message=f"Status updated to {body.status.value}")


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
    """Remove a game from the user's collection."""
    sb = get_supabase()

    sb.table("boardgamebuddy_collections").delete().eq(
        "user_id", user.user_id
    ).eq("game_id", game_id).execute()

    return MessageResponse(message="Game removed from collection")
