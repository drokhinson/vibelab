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
    summary="List play history (own + shared)",
)
async def list_plays(
    user: CurrentUser = Depends(get_current_user),
) -> list[PlayResponse]:
    """
    List plays the current user has logged, plus plays where they were a
    linked buddy (read-only on the FE, see is_own=False).
    """
    sb = get_supabase()

    # 1) Plays the current user logged themselves.
    own = (
        sb.table("boardgamebuddy_plays")
        .select(
            "id, user_id, game_id, played_at, notes, created_at, "
            "boardgamebuddy_games(name, thumbnail_url), "
            "boardgamebuddy_profiles!user_id(display_name)"
        )
        .eq("user_id", user.user_id)
        .execute()
    )

    # 2) Plays where the current user appears as a linked buddy.
    linked_buddies = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("linked_user_id", user.user_id)
        .execute()
    )
    buddy_ids = [b["id"] for b in (linked_buddies.data or [])]

    shared_play_ids: list[str] = []
    if buddy_ids:
        pps = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id")
            .in_("buddy_id", buddy_ids)
            .execute()
        )
        shared_play_ids = list({p["play_id"] for p in (pps.data or [])})

    shared_rows: list[dict] = []
    if shared_play_ids:
        shared = (
            sb.table("boardgamebuddy_plays")
            .select(
                "id, user_id, game_id, played_at, notes, created_at, "
                "boardgamebuddy_games(name, thumbnail_url), "
                "boardgamebuddy_profiles!user_id(display_name)"
            )
            .in_("id", shared_play_ids)
            .neq("user_id", user.user_id)  # avoid double-counting own plays
            .execute()
        )
        shared_rows = shared.data or []

    # Bulk-fetch players for all involved plays in one query (no N+1).
    all_play_ids = [p["id"] for p in (own.data or [])] + [p["id"] for p in shared_rows]
    players_by_play: dict[str, list[PlayPlayerResponse]] = {pid: [] for pid in all_play_ids}
    if all_play_ids:
        pps = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id, buddy_id, is_winner, boardgamebuddy_buddies(name)")
            .in_("play_id", all_play_ids)
            .execute()
        )
        for row in pps.data or []:
            players_by_play.setdefault(row["play_id"], []).append(
                PlayPlayerResponse(
                    buddy_id=row["buddy_id"],
                    name=(row.get("boardgamebuddy_buddies") or {}).get("name", "Unknown"),
                    is_winner=row.get("is_winner", False),
                )
            )

    def _to_response(play: dict, *, is_own: bool) -> PlayResponse:
        game = play.get("boardgamebuddy_games") or {}
        logger_profile = play.get("boardgamebuddy_profiles") or {}
        return PlayResponse(
            id=play["id"],
            game_id=play["game_id"],
            game_name=game.get("name", "Unknown"),
            game_thumbnail=game.get("thumbnail_url"),
            played_at=play["played_at"],
            notes=play.get("notes"),
            players=players_by_play.get(play["id"], []),
            created_at=play["created_at"],
            logged_by_id=play["user_id"],
            logged_by_name=logger_profile.get("display_name", "Unknown"),
            is_own=is_own,
        )

    result = [_to_response(p, is_own=True) for p in (own.data or [])]
    result.extend(_to_response(p, is_own=False) for p in shared_rows)
    result.sort(key=lambda r: (r.played_at, r.created_at), reverse=True)
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
        logged_by_id=user.user_id,
        logged_by_name=user.display_name,
        is_own=True,
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
    """
    List all game buddies for the current user, with the linked profile's
    display name (when linked) and the play_count across all sessions.
    """
    sb = get_supabase()

    rows = (
        sb.table("boardgamebuddy_buddies")
        .select(
            "id, name, linked_user_id, created_at, "
            "boardgamebuddy_profiles!linked_user_id(display_name), "
            "boardgamebuddy_play_players(count)"
        )
        .eq("owner_id", user.user_id)
        .execute()
    )

    out: list[BuddyResponse] = []
    for r in rows.data or []:
        linked_profile = r.get("boardgamebuddy_profiles") or {}
        # Embedded count is returned as [{"count": N}] from PostgREST.
        pp = r.get("boardgamebuddy_play_players") or []
        play_count = pp[0]["count"] if pp and isinstance(pp, list) else 0
        out.append(BuddyResponse(
            id=r["id"],
            name=r["name"],
            linked_user_id=r.get("linked_user_id"),
            linked_display_name=linked_profile.get("display_name"),
            play_count=play_count,
            created_at=r["created_at"],
        ))

    # Sort alphabetically by the display name the user actually sees.
    out.sort(key=lambda b: (b.linked_display_name or b.name).lower())
    return out


@router.post(
    "/buddies",
    response_model=BuddyResponse,
    status_code=201,
    summary="Add a buddy by user account",
)
async def add_buddy(
    body: BuddyLinkBody,
    user: CurrentUser = Depends(get_current_user),
) -> BuddyResponse:
    """Create a new buddy directly linked to an existing user account."""
    sb = get_supabase()

    if body.user_id == user.user_id:
        raise HTTPException(status_code=400, detail="Cannot add yourself as a buddy")

    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name")
        .eq("id", body.user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="User not found")
    target_name: str = target.data[0]["display_name"]

    # Idempotent: already linked to this user
    existing = (
        sb.table("boardgamebuddy_buddies")
        .select("id, name, linked_user_id, created_at, boardgamebuddy_play_players(count)")
        .eq("owner_id", user.user_id)
        .eq("linked_user_id", body.user_id)
        .execute()
    )
    if existing.data:
        r = existing.data[0]
        pp = r.get("boardgamebuddy_play_players") or []
        return BuddyResponse(
            id=r["id"],
            name=r["name"],
            linked_user_id=r.get("linked_user_id"),
            linked_display_name=target_name,
            play_count=pp[0]["count"] if pp else 0,
            created_at=r["created_at"],
        )

    # Name collision: link an existing unlinked buddy with the same name
    collision = (
        sb.table("boardgamebuddy_buddies")
        .select("id, name, created_at, boardgamebuddy_play_players(count)")
        .eq("owner_id", user.user_id)
        .eq("name", target_name)
        .is_("linked_user_id", "null")
        .execute()
    )
    if collision.data:
        c = collision.data[0]
        sb.table("boardgamebuddy_buddies").update(
            {"linked_user_id": body.user_id}
        ).eq("id", c["id"]).execute()
        pp = c.get("boardgamebuddy_play_players") or []
        return BuddyResponse(
            id=c["id"],
            name=c["name"],
            linked_user_id=body.user_id,
            linked_display_name=target_name,
            play_count=pp[0]["count"] if pp else 0,
            created_at=c["created_at"],
        )

    # Default: create new buddy row linked to the target account
    result = (
        sb.table("boardgamebuddy_buddies")
        .insert({
            "owner_id": user.user_id,
            "name": target_name,
            "linked_user_id": body.user_id,
        })
        .execute()
    )
    r = result.data[0]
    return BuddyResponse(
        id=r["id"],
        name=r["name"],
        linked_user_id=body.user_id,
        linked_display_name=target_name,
        play_count=0,
        created_at=r["created_at"],
    )


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
    """
    Link a free-text buddy to another user's BoardgameBuddy account.

    Linking is one-way and consolidates duplicates: if the current user already
    has another buddy linked to the same target, all play_players from this
    buddy are re-pointed to the existing one and this buddy row is deleted.
    """
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

    # Verify target user exists, capture display_name so future autocomplete
    # picks of that name reuse this same buddy row.
    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name")
        .eq("id", body.user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="Target user not found")
    target_name = target.data[0]["display_name"]

    # Find an existing buddy by this owner already linked to the target.
    existing = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("owner_id", user.user_id)
        .eq("linked_user_id", body.user_id)
        .neq("id", buddy_id)
        .execute()
    )
    if existing.data:
        # MERGE: re-point all play_players from this buddy to the existing one,
        # then delete this buddy row.
        target_buddy_id = existing.data[0]["id"]
        sb.table("boardgamebuddy_play_players").update(
            {"buddy_id": target_buddy_id}
        ).eq("buddy_id", buddy_id).execute()
        sb.table("boardgamebuddy_buddies").delete().eq("id", buddy_id).execute()
        return MessageResponse(message="Buddy merged into linked account")

    # If the target's display_name collides with another (unlinked) buddy of
    # the same owner, merge that one in first to preserve UNIQUE(owner,name).
    if target_name:
        collision = (
            sb.table("boardgamebuddy_buddies")
            .select("id")
            .eq("owner_id", user.user_id)
            .eq("name", target_name)
            .neq("id", buddy_id)
            .execute()
        )
        if collision.data:
            collision_id = collision.data[0]["id"]
            sb.table("boardgamebuddy_play_players").update(
                {"buddy_id": buddy_id}
            ).eq("buddy_id", collision_id).execute()
            sb.table("boardgamebuddy_buddies").delete().eq("id", collision_id).execute()

    # Plain link — set linked_user_id and rename to the linked display_name so
    # autocomplete picks of that name reuse this buddy on subsequent plays.
    sb.table("boardgamebuddy_buddies").update({
        "linked_user_id": body.user_id,
        "name": target_name,
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
