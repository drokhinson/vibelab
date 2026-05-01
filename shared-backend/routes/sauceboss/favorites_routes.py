"""Per-user sauce favorite endpoints for SauceBoss."""

from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import FavoriteListResponse, MessageResponse


@router.get(
    "/favorites",
    response_model=FavoriteListResponse,
    status_code=200,
    summary="List the current user's favorited sauce IDs",
)
async def list_favorites(
    user: CurrentUser = Depends(get_current_user),
) -> FavoriteListResponse:
    """Return every sauce_id the current user has marked as a favorite."""
    sb = get_supabase()
    result = (
        sb.table("sauceboss_favorites")
        .select("sauce_id")
        .eq("user_id", user.user_id)
        .execute()
    )
    favorites = [row["sauce_id"] for row in (result.data or [])]
    return FavoriteListResponse(favorites=favorites)


@router.put(
    "/favorites/{sauce_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Mark a sauce as favorite",
)
async def add_favorite(
    sauce_id: str = Path(..., description="Target sauce id"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Idempotently insert a (user, sauce) favorite row."""
    sb = get_supabase()
    exists = (
        sb.table("sauceboss_sauces").select("id").eq("id", sauce_id).execute()
    )
    if not exists.data:
        raise HTTPException(status_code=404, detail="Sauce not found")
    sb.table("sauceboss_favorites").upsert(
        {"user_id": user.user_id, "sauce_id": sauce_id},
        on_conflict="user_id,sauce_id",
    ).execute()
    return MessageResponse(message="Favorited")


@router.delete(
    "/favorites/{sauce_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Remove a sauce from favorites",
)
async def remove_favorite(
    sauce_id: str = Path(..., description="Target sauce id"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Idempotently delete a (user, sauce) favorite row."""
    sb = get_supabase()
    sb.table("sauceboss_favorites").delete().eq("user_id", user.user_id).eq("sauce_id", sauce_id).execute()
    return MessageResponse(message="Unfavorited")
