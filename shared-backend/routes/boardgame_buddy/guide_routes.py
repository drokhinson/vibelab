"""Quick reference guide endpoints."""

from fastapi import Depends, Path, HTTPException

from db import get_supabase

from . import router
from .models import GuideCreate, GuideResponse, MessageResponse
from .dependencies import CurrentUser, get_current_user


@router.get(
    "/games/{game_id}/guide",
    response_model=GuideResponse,
    status_code=200,
    summary="Get game guide",
)
async def get_guide(
    game_id: str = Path(..., description="Game UUID"),
) -> GuideResponse:
    """Get the quick reference guide for a game."""
    sb = get_supabase()

    result = (
        sb.table("boardgamebuddy_guides")
        .select("*")
        .eq("game_id", game_id)
        .order("is_official", desc=True)
        .limit(1)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="No guide available for this game")

    return GuideResponse(**result.data[0])


@router.post(
    "/games/{game_id}/guide",
    response_model=MessageResponse,
    status_code=201,
    summary="Submit or update guide",
)
async def submit_guide(
    body: GuideCreate,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Submit or update a quick reference guide for a game."""
    sb = get_supabase()

    # Verify game exists
    game = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    # Check if user already has a guide for this game
    existing = (
        sb.table("boardgamebuddy_guides")
        .select("id")
        .eq("game_id", game_id)
        .eq("contributed_by", user.user_id)
        .execute()
    )

    guide_data = {
        "game_id": game_id,
        "contributed_by": user.user_id,
        "quick_setup": body.quick_setup,
        "player_guide": body.player_guide,
        "rulebook_url": body.rulebook_url,
        "is_official": False,
        "updated_at": "now()",
    }

    if existing.data:
        sb.table("boardgamebuddy_guides").update(guide_data).eq(
            "id", existing.data[0]["id"]
        ).execute()
        return MessageResponse(message="Guide updated")
    else:
        sb.table("boardgamebuddy_guides").insert(guide_data).execute()
        return MessageResponse(message="Guide submitted")
