"""Play logging and game buddies endpoints."""

from typing import Optional

from fastapi import Depends, Path, Query, HTTPException

from db import get_supabase

from . import router
from .models import (
    BuddyLinkBody,
    BuddyResponse,
    MessageResponse,
    PlayCountResponse,
    PlayCreate,
    PlayFilterOption,
    PlayFilterOptions,
    PlayListResponse,
    PlayPlayerResponse,
    PlayResponse,
)
from .dependencies import CurrentUser, get_current_user

_SELECT_PLAY = (
    "id, user_id, game_id, played_at, notes, created_at, "
    "boardgamebuddy_games(name, thumbnail_url), "
    "boardgamebuddy_profiles!user_id(display_name)"
)


def _build_play_response(
    play: dict,
    *,
    is_own: bool,
    players_by_play: dict[str, list[PlayPlayerResponse]],
) -> PlayResponse:
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


def _fetch_players(sb, play_ids: list[str]) -> dict[str, list[PlayPlayerResponse]]:
    """Bulk-fetch players for a list of play IDs (no N+1)."""
    players_by_play: dict[str, list[PlayPlayerResponse]] = {pid: [] for pid in play_ids}
    if play_ids:
        pps = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id, buddy_id, is_winner, boardgamebuddy_buddies(name)")
            .in_("play_id", play_ids)
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
    return players_by_play


@router.get(
    "/plays",
    response_model=PlayListResponse,
    status_code=200,
    summary="List play history (own + shared)",
)
async def list_plays(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=100, description="Items per page"),
    game_id: Optional[str] = Query(None, description="Filter by game UUID"),
    buddy_id: Optional[str] = Query(None, description="Filter by buddy participant UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayListResponse:
    """List plays the current user logged (paginated, latest first), with optional filters."""
    sb = get_supabase()
    offset = (page - 1) * per_page

    # Pre-fetch play_ids where the filtered buddy participated (used as an ID filter below).
    buddy_play_ids: set[str] | None = None
    if buddy_id:
        bpp = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id")
            .eq("buddy_id", buddy_id)
            .execute()
        )
        buddy_play_ids = {r["play_id"] for r in bpp.data or []}
        if not buddy_play_ids:
            return PlayListResponse(plays=[], total=0, page=page, per_page=per_page)

    # ── Collect lightweight (id, played_at, created_at, is_own) tuples ────────
    own_q = (
        sb.table("boardgamebuddy_plays")
        .select("id, played_at, created_at")
        .eq("user_id", user.user_id)
    )
    if game_id:
        own_q = own_q.eq("game_id", game_id)
    if buddy_play_ids is not None:
        own_q = own_q.in_("id", list(buddy_play_ids))
    own_tuples: list[tuple[str, str, str, bool]] = [
        (r["id"], r["played_at"], r["created_at"], True)
        for r in (own_q.execute().data or [])
    ]
    own_ids_set = {t[0] for t in own_tuples}

    # Shared plays: current user appears as a linked buddy.
    linked = (
        sb.table("boardgamebuddy_buddies")
        .select("id")
        .eq("linked_user_id", user.user_id)
        .execute()
    )
    user_buddy_ids = [b["id"] for b in linked.data or []]
    shared_tuples: list[tuple[str, str, str, bool]] = []

    if user_buddy_ids:
        shared_pp = (
            sb.table("boardgamebuddy_play_players")
            .select("play_id")
            .in_("buddy_id", user_buddy_ids)
            .execute()
        )
        candidate_ids = {r["play_id"] for r in shared_pp.data or []} - own_ids_set
        if buddy_play_ids is not None:
            candidate_ids &= buddy_play_ids
        if candidate_ids:
            shared_q = (
                sb.table("boardgamebuddy_plays")
                .select("id, played_at, created_at")
                .in_("id", list(candidate_ids))
                .neq("user_id", user.user_id)
            )
            if game_id:
                shared_q = shared_q.eq("game_id", game_id)
            shared_tuples = [
                (r["id"], r["played_at"], r["created_at"], False)
                for r in (shared_q.execute().data or [])
            ]

    # ── Merge, sort, paginate ────────────────────────────────────────────────
    all_tuples = own_tuples + shared_tuples
    all_tuples.sort(key=lambda t: (t[1], t[2]), reverse=True)
    total = len(all_tuples)
    page_tuples = all_tuples[offset : offset + per_page]

    if not page_tuples:
        return PlayListResponse(plays=[], total=total, page=page, per_page=per_page)

    # ── Fetch full rows only for this page ───────────────────────────────────
    page_own_ids = [t[0] for t in page_tuples if t[3]]
    page_shared_ids = [t[0] for t in page_tuples if not t[3]]

    rows_by_id: dict[str, tuple[dict, bool]] = {}
    if page_own_ids:
        res = sb.table("boardgamebuddy_plays").select(_SELECT_PLAY).in_("id", page_own_ids).execute()
        for r in res.data or []:
            rows_by_id[r["id"]] = (r, True)
    if page_shared_ids:
        res = sb.table("boardgamebuddy_plays").select(_SELECT_PLAY).in_("id", page_shared_ids).execute()
        for r in res.data or []:
            rows_by_id[r["id"]] = (r, False)

    page_ids = [t[0] for t in page_tuples]
    players_by_play = _fetch_players(sb, page_ids)

    result = []
    for play_id, _, _, _ in page_tuples:
        if play_id in rows_by_id:
            row, is_own = rows_by_id[play_id]
            result.append(_build_play_response(row, is_own=is_own, players_by_play=players_by_play))
    return PlayListResponse(plays=result, total=total, page=page, per_page=per_page)


@router.get(
    "/plays/filter-options",
    response_model=PlayFilterOptions,
    status_code=200,
    summary="Filter options for play log",
)
async def get_play_filter_options(
    user: CurrentUser = Depends(get_current_user),
) -> PlayFilterOptions:
    """Return distinct games and buddies for the play log filter dropdowns."""
    sb = get_supabase()

    games_q = (
        sb.table("boardgamebuddy_plays")
        .select("game_id, boardgamebuddy_games(name)")
        .eq("user_id", user.user_id)
        .execute()
    )
    games_seen: dict[str, str] = {}
    for r in games_q.data or []:
        gid = r["game_id"]
        if gid not in games_seen:
            games_seen[gid] = (r.get("boardgamebuddy_games") or {}).get("name", "Unknown")
    games = sorted(
        [PlayFilterOption(id=gid, name=name) for gid, name in games_seen.items()],
        key=lambda g: g.name.lower(),
    )

    buddies_q = (
        sb.table("boardgamebuddy_buddies")
        .select("id, name")
        .eq("owner_id", user.user_id)
        .execute()
    )
    buddies = sorted(
        [PlayFilterOption(id=r["id"], name=r["name"]) for r in buddies_q.data or []],
        key=lambda b: b.name.lower(),
    )

    return PlayFilterOptions(games=games, buddies=buddies)


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
    "/games/{game_id}/plays",
    response_model=list[PlayResponse],
    status_code=200,
    summary="Play history for a game",
)
async def get_game_plays(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> list[PlayResponse]:
    """Return plays the current user logged for a specific game, newest first."""
    sb = get_supabase()

    rows = (
        sb.table("boardgamebuddy_plays")
        .select(_SELECT_PLAY)
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .order("played_at", desc=True)
        .order("created_at", desc=True)
        .execute()
    )

    play_ids = [r["id"] for r in rows.data or []]
    players_by_play = _fetch_players(sb, play_ids)

    return [
        _build_play_response(r, is_own=True, players_by_play=players_by_play)
        for r in rows.data or []
    ]


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
