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
    "playing_time, thumbnail_url, theme_color, is_expansion, "
    "base_game_bgg_id, expansion_color"
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
            "max_players, playing_time, thumbnail_url, theme_color)"
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
    play_counts: dict[str, int] = {}
    for play in plays_result.data or []:
        gid = play["game_id"]
        play_counts[gid] = play_counts.get(gid, 0) + 1
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
                play_count=play_counts.get(row["game_id"], 0),
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
                    "playing_time, thumbnail_url, theme_color"
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
                    play_count=play_counts.get(g["id"], 0),
                    game=GameSummary(**g),
                ))

    return items


def _index_plays(plays: list[dict]) -> tuple[dict[str, str], dict[str, int]]:
    """Build last_played-by-game and play-count-by-game maps from raw play rows."""
    last_played: dict[str, str] = {}
    counts: dict[str, int] = {}
    for p in plays:
        gid = p["game_id"]
        counts[gid] = counts.get(gid, 0) + 1
        if gid not in last_played:
            last_played[gid] = p["played_at"]
    return last_played, counts


def _build_shelf_items(
    rows: list[dict],
    last_played_by_game: dict[str, str],
    play_counts: dict[str, int],
    sort: CollectionSort,
    offset: int,
    per_page: int,
) -> tuple[list[CollectionItem], int]:
    """Partition rows into primaries (bases + orphan expansions) and grouped
    expansions, sort + paginate the primaries, then embed each base's owned
    expansions inline. Pagination is over primaries only — expansions never
    consume a page slot, so the FE always sees a base together with its
    expansions on the same load.

    Each row must shape like: {id, game_id, status, added_at, boardgamebuddy_games: {GameSummary fields}}.
    """
    base_bgg_ids: set[int] = set()
    for r in rows:
        g = r.get("boardgamebuddy_games") or {}
        if not g.get("is_expansion") and g.get("bgg_id") is not None:
            base_bgg_ids.add(g["bgg_id"])

    primary: list[dict] = []
    expansions_by_base: dict[int, list[dict]] = {}
    for r in rows:
        g = r.get("boardgamebuddy_games") or {}
        base_bgg = g.get("base_game_bgg_id")
        if g.get("is_expansion") and base_bgg in base_bgg_ids:
            expansions_by_base.setdefault(base_bgg, []).append(r)
            continue
        primary.append(r)

    if sort == CollectionSort.ALPHABETICAL:
        primary.sort(key=lambda r: ((r.get("boardgamebuddy_games") or {}).get("name") or "").lower())
    else:  # LAST_PLAYED — never-played rows fall to bottom, tied by added_at desc
        primary.sort(
            key=lambda r: (
                last_played_by_game.get(r["game_id"]) or "",
                r["added_at"] or "",
            ),
            reverse=True,
        )

    total = len(primary)
    page_rows = primary[offset:offset + per_page]

    def to_item(r: dict, embed: bool) -> CollectionItem:
        g = r.get("boardgamebuddy_games") or {}
        embedded: list[CollectionItem] = []
        if embed:
            base_bgg = g.get("bgg_id")
            if base_bgg is not None and base_bgg in expansions_by_base:
                exp_rows = sorted(
                    expansions_by_base[base_bgg],
                    key=lambda er: ((er.get("boardgamebuddy_games") or {}).get("name") or "").lower(),
                )
                embedded = [to_item(er, embed=False) for er in exp_rows]
        return CollectionItem(
            id=r["id"],
            game_id=r["game_id"],
            status=r["status"],
            added_at=r["added_at"],
            last_played_at=last_played_by_game.get(r["game_id"]),
            play_count=play_counts.get(r["game_id"], 0),
            game=GameSummary(**g),
            expansions=embedded,
        )

    items = [to_item(r, embed=True) for r in page_rows]
    return items, total


@router.get(
    "/collection/shelf",
    response_model=CollectionPageResponse,
    status_code=200,
    summary="Get one shelf of the collection (paginated)",
)
async def get_collection_shelf(
    status: CollectionStatus = Query(..., description="Shelf to fetch"),
    page: int = Query(1, ge=1, description="1-indexed page"),
    per_page: int = Query(20, ge=1, le=500, description="Items per page"),
    sort: CollectionSort = Query(CollectionSort.LAST_PLAYED, description="Sort order"),
    user: CurrentUser = Depends(get_current_user),
) -> CollectionPageResponse:
    """Return one page of the requested shelf for the current user.

    Pagination is over base games + orphan expansions; each base's owned
    expansions ride inline on its row via `expansions`.
    """
    sb = get_supabase()
    offset = (page - 1) * per_page

    plays_result = (
        sb.table("boardgamebuddy_plays")
        .select("game_id, played_at")
        .eq("user_id", user.user_id)
        .order("played_at", desc=True)
        .execute()
    )
    last_played_by_game, play_counts = _index_plays(plays_result.data or [])

    if status == CollectionStatus.PLAYED:
        owned = (
            sb.table("boardgamebuddy_collections")
            .select("game_id")
            .eq("user_id", user.user_id)
            .eq("status", CollectionStatus.OWNED.value)
            .execute()
        )
        owned_ids = {row["game_id"] for row in owned.data or []}

        played_ids = [gid for gid in last_played_by_game if gid not in owned_ids]
        if not played_ids:
            return CollectionPageResponse(items=[], total=0, page=page, per_page=per_page)

        games = (
            sb.table("boardgamebuddy_games")
            .select(_GAME_FIELDS)
            .in_("id", played_ids)
            .execute()
        )
        games_by_id = {g["id"]: g for g in games.data or []}

        # Reshape derived plays into the same row shape as a collections row
        # so _build_shelf_items can treat both code paths uniformly.
        rows: list[dict] = []
        for gid in played_ids:
            g = games_by_id.get(gid)
            if not g:
                continue
            lp = last_played_by_game[gid]
            rows.append({
                "id": f"derived-{gid}",
                "game_id": gid,
                "status": CollectionStatus.PLAYED.value,
                "added_at": f"{lp}T00:00:00+00:00",
                "boardgamebuddy_games": g,
            })

        items, total = _build_shelf_items(rows, last_played_by_game, play_counts, sort, offset, per_page)
        return CollectionPageResponse(items=items, total=total, page=page, per_page=per_page)

    # Owned / wishlist — fetch every row once with embedded game data, then
    # let _build_shelf_items handle partitioning, sort, pagination, and
    # expansion-embedding. We trade DB-side pagination for one upfront query
    # so expansions can be bundled with their base regardless of page size.
    rows = (
        sb.table("boardgamebuddy_collections")
        .select(f"id, game_id, status, added_at, boardgamebuddy_games({_GAME_FIELDS})")
        .eq("user_id", user.user_id)
        .eq("status", status.value)
        .execute()
    ).data or []

    items, total = _build_shelf_items(rows, last_played_by_game, play_counts, sort, offset, per_page)
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
