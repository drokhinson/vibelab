"""Play logging and game buddies endpoints."""

from fastapi import Depends, Path, HTTPException

from db import get_supabase

from . import router
from .models import (
    BuddyLinkBody,
    BuddyResponse,
    MessageResponse,
    PlayCreate,
    PlayPlayerResponse,
    PlayResponse,
)
from .dependencies import CurrentUser, get_current_user


@router.get(
    "/plays",
    response_model=list[PlayResponse],
    status_code=200,
    summary="List play history",
)
async def list_plays(
    user: CurrentUser = Depends(get_current_user),
) -> list[PlayResponse]:
    """List all plays logged by the current user."""
    sb = get_supabase()

    plays = (
        sb.table("boardgamebuddy_plays")
        .select(
            "id, game_id, played_at, notes, created_at, "
            "boardgamebuddy_games(name, thumbnail_url)"
        )
        .eq("user_id", user.user_id)
        .order("played_at", desc=True)
        .execute()
    )

    result: list[PlayResponse] = []
    for play in plays.data or []:
        game = play.get("boardgamebuddy_games", {})

        # Fetch players for this play
        players_data = (
            sb.table("boardgamebuddy_play_players")
            .select("buddy_id, is_winner, boardgamebuddy_buddies(name)")
            .eq("play_id", play["id"])
            .execute()
        )

        players = [
            PlayPlayerResponse(
                buddy_id=p["buddy_id"],
                name=p.get("boardgamebuddy_buddies", {}).get("name", "Unknown"),
                is_winner=p["is_winner"],
            )
            for p in (players_data.data or [])
        ]

        result.append(PlayResponse(
            id=play["id"],
            game_id=play["game_id"],
            game_name=game.get("name", "Unknown"),
            game_thumbnail=game.get("thumbnail_url"),
            played_at=play["played_at"],
            notes=play.get("notes"),
            players=players,
            created_at=play["created_at"],
        ))

    return result


@router.post(
    "/plays",
    response_model=PlayResponse,
    status_code=201,
    summary="Log a play",
)
async def log_play(
    body: PlayCreate,
    user: CurrentUser = Depends(get_current_user),
) -> PlayResponse:
    """Record a game play with players and winner."""
    sb = get_supabase()

    # Verify game exists
    game = (
        sb.table("boardgamebuddy_games")
        .select("id, name, thumbnail_url")
        .eq("id", body.game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    game_row = game.data[0]

    # Create play
    play_result = (
        sb.table("boardgamebuddy_plays")
        .insert({
            "user_id": user.user_id,
            "game_id": body.game_id,
            "played_at": body.played_at.isoformat(),
            "notes": body.notes,
        })
        .execute()
    )
    play = play_result.data[0]

    # Create/find buddies and link to play
    players: list[PlayPlayerResponse] = []
    for p in body.players:
        # Upsert buddy
        buddy_result = (
            sb.table("boardgamebuddy_buddies")
            .upsert(
                {"owner_id": user.user_id, "name": p.name},
                on_conflict="owner_id,name",
            )
            .execute()
        )
        buddy = buddy_result.data[0]

        # Link player to play
        sb.table("boardgamebuddy_play_players").insert({
            "play_id": play["id"],
            "buddy_id": buddy["id"],
            "is_winner": p.is_winner,
        }).execute()

        players.append(PlayPlayerResponse(
            buddy_id=buddy["id"],
            name=p.name,
            is_winner=p.is_winner,
        ))

    return PlayResponse(
        id=play["id"],
        game_id=play["game_id"],
        game_name=game_row["name"],
        game_thumbnail=game_row.get("thumbnail_url"),
        played_at=play["played_at"],
        notes=play.get("notes"),
        players=players,
        created_at=play["created_at"],
    )


@router.delete(
    "/plays/{play_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a play",
)
async def delete_play(
    play_id: str = Path(..., description="Play UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a play log entry."""
    sb = get_supabase()

    # Delete play players first (cascade should handle this, but be explicit)
    sb.table("boardgamebuddy_play_players").delete().eq("play_id", play_id).execute()
    sb.table("boardgamebuddy_plays").delete().eq("id", play_id).eq(
        "user_id", user.user_id
    ).execute()

    return MessageResponse(message="Play deleted")


@router.get(
    "/buddies",
    response_model=list[BuddyResponse],
    status_code=200,
    summary="List game buddies",
)
async def list_buddies(
    user: CurrentUser = Depends(get_current_user),
) -> list[BuddyResponse]:
    """List all game buddies for the current user."""
    sb = get_supabase()

    result = (
        sb.table("boardgamebuddy_buddies")
        .select("id, name, linked_user_id, created_at")
        .eq("owner_id", user.user_id)
        .order("name")
        .execute()
    )

    return [BuddyResponse(**b) for b in (result.data or [])]


@router.post(
    "/buddies/{buddy_id}/link",
    response_model=MessageResponse,
    status_code=200,
    summary="Link buddy to user account",
)
async def link_buddy(
    body: BuddyLinkBody,
    buddy_id: str = Path(..., description="Buddy UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Link a game buddy to another user's account."""
    sb = get_supabase()

    # Verify buddy belongs to current user
    buddy = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("id", buddy_id)
        .eq("owner_id", user.user_id)
        .execute()
    )
    if not buddy.data:
        raise HTTPException(status_code=404, detail="Buddy not found")

    # Verify target user exists
    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id")
        .eq("id", body.user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="Target user not found")

    sb.table("boardgamebuddy_buddies").update({
        "linked_user_id": body.user_id,
    }).eq("id", buddy_id).execute()

    return MessageResponse(message="Buddy linked to user account")
