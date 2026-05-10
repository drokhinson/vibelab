"""Favorites compat shim for release/sauceboss-1.0.

The release-branch web/native still calls GET /favorites, PUT /favorites/{id},
and DELETE /favorites/{id}. The favorites table was dropped in migration 013;
these routes are thin aliases over sauceboss_user_saucebook so the live
release keeps working until it ships an updated client. Remove this file
once release/sauceboss-1.0 is retired.
"""

from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import FavoriteListResponse, MessageResponse


@router.get(
    "/favorites",
    response_model=FavoriteListResponse,
    status_code=200,
    summary="List the caller's favorited sauces (alias of /saucebook for release/sauceboss-1.0)",
)
async def list_favorites(
    user: CurrentUser = Depends(get_current_user),
) -> FavoriteListResponse:
    """Read the caller's saucebook and return it in the legacy favorites shape."""
    sb = get_supabase()
    result = (
        sb.table("sauceboss_user_saucebook")
        .select("sauce_id, added_at")
        .eq("user_id", user.user_id)
        .execute()
    )
    return FavoriteListResponse(
        favorites=[
            {"sauceId": row["sauce_id"], "createdAt": row.get("added_at")}
            for row in (result.data or [])
        ]
    )


@router.put(
    "/favorites/{sauce_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Mark a sauce as favorite (alias for adding to the saucebook)",
)
async def add_favorite(
    sauce_id: str = Path(..., description="Sauce id to favorite."),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Idempotently add (user_id, sauce_id) to sauceboss_user_saucebook."""
    sb = get_supabase()
    exists = sb.table("sauceboss_sauce").select("id").eq("id", sauce_id).execute()
    if not exists.data:
        raise HTTPException(404, "Sauce not found")
    try:
        sb.table("sauceboss_user_saucebook").upsert(
            {"user_id": user.user_id, "sauce_id": sauce_id},
            on_conflict="user_id,sauce_id",
        ).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return MessageResponse(message="Added to saucebook")


@router.delete(
    "/favorites/{sauce_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Remove a favorite (alias for removing from the saucebook)",
)
async def remove_favorite(
    sauce_id: str = Path(..., description="Sauce id to unfavorite."),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete the (user_id, sauce_id) row. No error if it doesn't exist."""
    sb = get_supabase()
    try:
        sb.table("sauceboss_user_saucebook").delete().eq("user_id", user.user_id).eq("sauce_id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return MessageResponse(message="Removed from saucebook")
