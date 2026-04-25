"""Play logging and game buddies endpoints."""

from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, Path, HTTPException

from db import get_supabase

from . import router
from .models import (
    BuddyLinkBody,
    BuddyResponse,
    MessageResponse,
    PlayCountResponse,
    PlayCreate,
    PlayDraftBody,
    PlayDraftResponse,
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
    "/games/{game_id}/play-count",
    response_model=PlayCountResponse,
    status_code=200,
    summary="Count plays for a game",
)
async def get_play_count(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayCountResponse:
    """Return the number of plays the current user has logged for this game."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_plays")
        .select("id", count="exact")
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .execute()
    )
    return PlayCountResponse(count=result.count or 0)


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


# ── Play session drafts ──────────────────────────────────────────────────────


def _draft_with_game(row: dict) -> PlayDraftResponse:
    """Hydrate a draft row into a PlayDraftResponse, including game name/thumb."""
    game = row.get("boardgamebuddy_games") or {}
    return PlayDraftResponse(
        game_id=row.get("game_id"),
        played_at=row.get("played_at"),
        notes=row.get("notes"),
        players=row.get("players") or [],
        round_count=row.get("round_count") or 1,
        game_name=game.get("name"),
        game_thumbnail=game.get("thumbnail_url"),
        updated_at=row["updated_at"],
    )


@router.get(
    "/plays/draft",
    response_model=Optional[PlayDraftResponse],
    status_code=200,
    summary="Get the current user's in-progress play session",
)
async def get_play_draft(
    user: CurrentUser = Depends(get_current_user),
) -> Optional[PlayDraftResponse]:
    """Return the current user's draft session, or null if none is active."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_play_drafts")
        .select(
            "game_id, played_at, notes, players, round_count, updated_at, "
            "boardgamebuddy_games(name, thumbnail_url)"
        )
        .eq("user_id", user.user_id)
        .execute()
    )
    if not result.data:
        return None
    return _draft_with_game(result.data[0])


@router.put(
    "/plays/draft",
    response_model=PlayDraftResponse,
    status_code=200,
    summary="Save the current user's in-progress play session",
)
async def upsert_play_draft(
    body: PlayDraftBody,
    user: CurrentUser = Depends(get_current_user),
) -> PlayDraftResponse:
    """Upsert the user's single active draft. Called debounced from the FE."""
    sb = get_supabase()

    payload = {
        "user_id": user.user_id,
        "game_id": body.game_id,
        "played_at": body.played_at.isoformat() if body.played_at else None,
        "notes": body.notes,
        "players": [p.model_dump() for p in body.players],
        "round_count": body.round_count,
        # The DEFAULT only fires on INSERT, so set this explicitly so updates
        # bump the timestamp too.
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    sb.table("boardgamebuddy_play_drafts").upsert(
        payload, on_conflict="user_id"
    ).execute()

    # Re-fetch with the game join so the FE gets game_name/thumbnail back.
    result = (
        sb.table("boardgamebuddy_play_drafts")
        .select(
            "game_id, played_at, notes, players, round_count, updated_at, "
            "boardgamebuddy_games(name, thumbnail_url)"
        )
        .eq("user_id", user.user_id)
        .execute()
    )
    return _draft_with_game(result.data[0])


@router.delete(
    "/plays/draft",
    response_model=MessageResponse,
    status_code=200,
    summary="Discard the current user's in-progress play session",
)
async def delete_play_draft(
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete the user's draft session (called after Save or Discard)."""
    sb = get_supabase()
    sb.table("boardgamebuddy_play_drafts").delete().eq(
        "user_id", user.user_id
    ).execute()
    return MessageResponse(message="Draft discarded")
