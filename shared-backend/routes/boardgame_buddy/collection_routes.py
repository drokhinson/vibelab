"""User collection endpoints — closet / played / wishlist."""

from typing import Optional

from fastapi import Depends, Path, Query, HTTPException

from db import get_supabase

from . import router
from .models import (
    CollectionAdd,
    CollectionItem,
    CollectionPageResponse,
    CollectionUpdate,
    GameSummary,
    MessageResponse,
)
from .constants import CollectionSort, CollectionStatus
from .dependencies import CurrentUser, get_current_user


_GAME_FIELDS = (
    "id, bgg_id, name, year_published, min_players, max_players, "
    "playing_time, thumbnail_url, bgg_rank, bgg_rating, theme_color"
)


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

    plays_result = (
        sb.table("boardgamebuddy_plays")
        .select("game_id, played_at")
        .eq("user_id", user.user_id)
        .order("played_at", desc=True)
        .execute()
    )
    last_played_by_game: dict[str, str] = {}
    for play in plays_result.data or []:
        gid = play["game_id"]
        if gid not in last_played_by_game:
            last_played_by_game[gid] = play["played_at"]

    items: list[CollectionItem] = []
    owned_game_ids: set[str] = set()
    for row in result.data or []:
        game_data = row.get("boardgamebuddy_games", {})
        if game_data:
            items.append(CollectionItem(
                id=row["id"],
                game_id=row["game_id"],
                status=row["status"],
                added_at=row["added_at"],
                last_played_at=last_played_by_game.get(row["game_id"]),
                game=GameSummary(**game_data),
            ))
            if row["status"] == CollectionStatus.OWNED.value:
                owned_game_ids.add(row["game_id"])

    # Derive a synthetic "played" row for every game the user has logged a play
    # for and does NOT own. Played is no longer a user-selectable status —
    # it's computed from play history. Wishlist-ed games with plays still get
    # a derived played row (they'll show up in both tabs).
    if status is None or status == CollectionStatus.PLAYED:
        missing_ids = [gid for gid in last_played_by_game if gid not in owned_game_ids]
        if missing_ids:
            games = (
                sb.table("boardgamebuddy_games")
                .select(
                    "id, bgg_id, name, year_published, min_players, max_players, "
                    "playing_time, thumbnail_url, bgg_rank, bgg_rating, theme_color"
                )
                .in_("id", missing_ids)
                .execute()
            )
            for g in games.data or []:
                last_played = last_played_by_game[g["id"]]
                items.append(CollectionItem(
                    id=f"derived-{g['id']}",
                    game_id=g["id"],
                    status=CollectionStatus.PLAYED.value,
                    added_at=f"{last_played}T00:00:00+00:00",
                    last_played_at=last_played,
                    game=GameSummary(**g),
                ))

    return items


@router.get(
    "/collection/shelf",
    response_model=CollectionPageResponse,
    status_code=200,
    summary="Get one shelf of the collection (paginated)",
)
async def get_collection_shelf(
    status: CollectionStatus = Query(..., description="Shelf to fetch"),
    page: int = Query(1, ge=1, description="1-indexed page"),
    per_page: int = Query(20, ge=1, le=50, description="Items per page"),
    sort: CollectionSort = Query(CollectionSort.LAST_PLAYED, description="Sort order"),
    user: CurrentUser = Depends(get_current_user),
) -> CollectionPageResponse:
    """Return one page of the requested shelf for the current user."""
    sb = get_supabase()
    offset = (page - 1) * per_page

    # Played shelf is derived from boardgamebuddy_plays minus owned game_ids.
    if status == CollectionStatus.PLAYED:
        plays = (
            sb.table("boardgamebuddy_plays")
            .select("game_id, played_at")
            .eq("user_id", user.user_id)
            .order("played_at", desc=True)
            .execute()
        )
        last_played: dict[str, str] = {}
        for p in plays.data or []:
            gid = p["game_id"]
            if gid not in last_played:
                last_played[gid] = p["played_at"]

        owned = (
            sb.table("boardgamebuddy_collections")
            .select("game_id")
            .eq("user_id", user.user_id)
            .eq("status", CollectionStatus.OWNED.value)
            .execute()
        )
        owned_ids = {row["game_id"] for row in owned.data or []}

        pairs = [(gid, lp) for gid, lp in last_played.items() if gid not in owned_ids]
        total = len(pairs)

        if sort == CollectionSort.LAST_PLAYED:
            pairs.sort(key=lambda p: p[1], reverse=True)
        else:  # ALPHABETICAL — need names to sort
            all_ids = [gid for gid, _ in pairs]
            names = (
                sb.table("boardgamebuddy_games")
                .select("id, name")
                .in_("id", all_ids)
                .execute()
            ) if all_ids else None
            name_by_id = {g["id"]: g["name"] for g in (names.data if names else []) or []}
            pairs.sort(key=lambda p: (name_by_id.get(p[0]) or "").lower())

        page_pairs = pairs[offset : offset + per_page]
        page_ids = [gid for gid, _ in page_pairs]

        items: list[CollectionItem] = []
        if page_ids:
            games = (
                sb.table("boardgamebuddy_games")
                .select(_GAME_FIELDS)
                .in_("id", page_ids)
                .execute()
            )
            games_by_id = {g["id"]: g for g in games.data or []}
            for gid, lp in page_pairs:
                g = games_by_id.get(gid)
                if not g:
                    continue
                items.append(CollectionItem(
                    id=f"derived-{gid}",
                    game_id=gid,
                    status=CollectionStatus.PLAYED.value,
                    added_at=f"{lp}T00:00:00+00:00",
                    last_played_at=lp,
                    game=GameSummary(**g),
                ))

        return CollectionPageResponse(items=items, total=total, page=page, per_page=per_page)

    # Owned / wishlist.
    # For alphabetical sort we can push it down to PostgREST via embedded
    # FK ordering. For last_played we need to join against plays and sort
    # globally, so we do a lightweight ids-only fetch first, then page.
    if sort == CollectionSort.ALPHABETICAL:
        query = (
            sb.table("boardgamebuddy_collections")
            .select(
                f"id, game_id, status, added_at, boardgamebuddy_games({_GAME_FIELDS})",
                count="exact",
            )
            .eq("user_id", user.user_id)
            .eq("status", status.value)
            .order("boardgamebuddy_games(name)", desc=False)
            .range(offset, offset + per_page - 1)
        )
        result = query.execute()
        total = result.count or 0
        page_game_ids = [row["game_id"] for row in result.data or []]

        last_played_by_game: dict[str, str] = {}
        if page_game_ids:
            plays = (
                sb.table("boardgamebuddy_plays")
                .select("game_id, played_at")
                .eq("user_id", user.user_id)
                .in_("game_id", page_game_ids)
                .order("played_at", desc=True)
                .execute()
            )
            for p in plays.data or []:
                gid = p["game_id"]
                if gid not in last_played_by_game:
                    last_played_by_game[gid] = p["played_at"]

        items: list[CollectionItem] = []
        for row in result.data or []:
            game_data = row.get("boardgamebuddy_games")
            if not game_data:
                continue
            items.append(CollectionItem(
                id=row["id"],
                game_id=row["game_id"],
                status=row["status"],
                added_at=row["added_at"],
                last_played_at=last_played_by_game.get(row["game_id"]),
                game=GameSummary(**game_data),
            ))
        return CollectionPageResponse(items=items, total=total, page=page, per_page=per_page)

    # sort == LAST_PLAYED (default)
    ids_rows = (
        sb.table("boardgamebuddy_collections")
        .select("id, game_id, added_at")
        .eq("user_id", user.user_id)
        .eq("status", status.value)
        .execute()
    )
    all_rows = ids_rows.data or []
    total = len(all_rows)

    if total == 0:
        return CollectionPageResponse(items=[], total=0, page=page, per_page=per_page)

    plays = (
        sb.table("boardgamebuddy_plays")
        .select("game_id, played_at")
        .eq("user_id", user.user_id)
        .order("played_at", desc=True)
        .execute()
    )
    last_played_by_game: dict[str, str] = {}
    for p in plays.data or []:
        gid = p["game_id"]
        if gid not in last_played_by_game:
            last_played_by_game[gid] = p["played_at"]

    # Never-played rows fall to the bottom; ties broken by added_at desc.
    all_rows.sort(
        key=lambda r: (
            last_played_by_game.get(r["game_id"]) or "",
            r["added_at"] or "",
        ),
        reverse=True,
    )
    page_rows = all_rows[offset : offset + per_page]
    page_ids = [r["game_id"] for r in page_rows]

    games_by_id: dict[str, dict] = {}
    if page_ids:
        games = (
            sb.table("boardgamebuddy_games")
            .select(_GAME_FIELDS)
            .in_("id", page_ids)
            .execute()
        )
        games_by_id = {g["id"]: g for g in games.data or []}

    items: list[CollectionItem] = []
    for r in page_rows:
        g = games_by_id.get(r["game_id"])
        if not g:
            continue
        items.append(CollectionItem(
            id=r["id"],
            game_id=r["game_id"],
            status=status.value,
            added_at=r["added_at"],
            last_played_at=last_played_by_game.get(r["game_id"]),
            game=GameSummary(**g),
        ))

    return CollectionPageResponse(items=items, total=total, page=page, per_page=per_page)


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

    game = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    sb.table("boardgamebuddy_collections").upsert({
        "user_id": user.user_id,
        "game_id": game_id,
        "status": body.status.value,
    }, on_conflict="user_id,game_id").execute()

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
