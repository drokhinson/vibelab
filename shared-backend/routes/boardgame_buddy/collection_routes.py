"""User collection endpoints — closet / played / wishlist."""

from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, Path, Query, HTTPException
from supabase import Client

from db import get_supabase

from . import router
from .models import (
    CollectionAdd,
    CollectionItem,
    CollectionPageResponse,
    CollectionShelfResponse,
    CollectionStatusMapResponse,
    CollectionUpdate,
    GameSummary,
    MessageResponse,
)
from .constants import CollectionSort, CollectionStatus, PlayMode
from .dependencies import CurrentUser, get_current_user
from .game_routes import (
    COLLECTION_DENORM_GAME_FIELDS,
    _attach_expansion_counts,
    collection_denormalized_from_game,
)
from .services._helpers import game_select_clause


# Deliberately narrower than game_select_clause(): /collection renders plain
# tiles, so it skips the expansion and rulebook columns the grid and detail
# surfaces need. image_url IS carried: the tiles crop square with object-fit,
# which upscales BGG's ~200px thumbnail on any modern DPR.
#
# The web client no longer reads this endpoint at all — it derives its status
# map and expansion counts from /collection/status-map, which is one bounded
# round trip instead of three unbounded ones. What remains here serves the
# native app, whose only consumer (app/src/store/AppContext.js:262) reads
# `status` and `game_id`.
_TILE_GAME_FIELDS = (
    "id, bgg_id, name, year_published, min_players, max_players, "
    "playing_time, thumbnail_url, image_url, theme_color"
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
        .select(f"id, game_id, status, added_at, boardgamebuddy_games({_TILE_GAME_FIELDS})")
        .eq("user_id", user.user_id)
        .order("added_at", desc=True)
    )

    if status:
        query = query.eq("status", status.value)

    result = query.execute()

    # When the caller only wants owned/wishlist, we don't need the full
    # cross-user play visibility map — just stats for the games already on
    # the shelf, so we can populate last_played_at / play_count on each tile.
    shelf_game_ids: set[str] = {row["game_id"] for row in (result.data or [])}
    if status is None or status == CollectionStatus.PLAYED:
        last_played_by_game, play_counts = _play_stats(sb, user.user_id)
    else:
        last_played_by_game, play_counts = _play_stats(
            sb, user.user_id, list(shelf_game_ids)
        )

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

    # Derive a synthetic "played" row for every game the user has a play for —
    # logged by them or by someone who listed them as a player — and does NOT
    # own. Played is no longer a user-selectable status; it's computed from
    # play history. Wishlist-ed games with plays still get a derived played
    # row (they'll show up in both tabs).
    if status is None or status == CollectionStatus.PLAYED:
        missing_ids = [gid for gid in last_played_by_game if gid not in owned_game_ids]
        if missing_ids:
            games = (
                sb.table("boardgamebuddy_games")
                .select(_TILE_GAME_FIELDS)
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


def _play_stats(
    sb: Client,
    user_id: str,
    game_ids: Optional[list[str]] = None,
) -> tuple[dict[str, str], dict[str, int]]:
    """last_played-by-game and play-count-by-game maps for every play the
    user has been part of — logged themselves, OR appearing as a participant
    on someone else's play. This is the rule every play-derived surface uses
    (bgb_user_stats, bgb_profile_bundle, bgb_game_detail_bundle's status pill,
    the play log), so a play that shows up in History also drives the Played
    shelf and the counts on every tile.

    One bgb_play_stats RPC (migration 039, SQL GROUP BY). The old path
    fetched EVERY visible play row across up to 3 round trips and counted
    them in Python — unbounded for BGG-synced users with thousands of plays.

    `game_ids`, when provided, scopes the stats to those games — for callers
    that only need the tiles already on the shelf.
    """
    if game_ids is not None and not game_ids:
        return {}, {}
    rows = (
        sb.rpc("bgb_play_stats", {"p_viewer": user_id, "p_game_ids": game_ids})
        .execute()
        .data
        or []
    )
    last_played = {r["game_id"]: r["last_played_at"] for r in rows}
    counts = {r["game_id"]: int(r["play_count"] or 0) for r in rows}
    return last_played, counts


def _upsert_collection(sb: Client, user_id: str, game_id: str, status: str) -> None:
    """Set one game's collection status for one user.

    Verifies the game exists AND fetches its denormalized fields in one round
    trip, so the upsert can populate the game_* cache columns without a second
    select. Upsert rather than update because the row may not pre-exist — a
    wishlist->owned bump from a surface that never added the game.
    """
    game = (
        sb.table("boardgamebuddy_games")
        .select(COLLECTION_DENORM_GAME_FIELDS)
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    sb.table("boardgamebuddy_collections").upsert({
        "user_id": user_id,
        "game_id": game_id,
        "status": status,
        **collection_denormalized_from_game(game.data[0]),
    }, on_conflict="user_id,game_id").execute()


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
    _upsert_collection(get_supabase(), user.user_id, body.game_id, body.status.value)
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
    _upsert_collection(get_supabase(), user.user_id, game_id, body.status.value)
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


# ── Profile / Collection grid ─────────────────────────────────────────────────
# Tailored read for the Profile view's collection plate. Two round-trips
# (collection+game join, then plays for last_played_at) and sorts in Python
# by (last_played DESC NULLS LAST, added_at DESC) so the user's most-
# recently-played base games surface first, then the newest additions.
#
# Replaces the previous "/games?owned_only=true" call which ordered by
# games.created_at (the catalog timestamp) and had nothing per-user to
# anchor the sort on.

def _attach_page_expansion_counts(sb: Client, items: list[CollectionItem]) -> None:
    """Fill `game.expansion_count` on one page of grid items.

    The tile badge counts every expansion the *catalog* holds for that base
    game — the same number the game page's "Expansions (N)" heading shows —
    not just the ones the viewer owns. Expansions arrive via the import popup
    without touching anyone's collection, so an owned-only count reads as
    zero for a game that plainly has eleven of them.

    Reuses game_routes._attach_expansion_counts, which tallies the whole page
    in one round-trip and leaves expansion rows at 0.
    """
    if items:
        _attach_expansion_counts(sb, [it.game for it in items])


def _passes_grid_filters(
    game: dict,
    *,
    search: Optional[str],
    players: Optional[int],
    playtime_min: Optional[int],
    playtime_max: Optional[int],
    play_mode: Optional[str],
    exclude_expansions: bool,
) -> bool:
    if exclude_expansions and game.get("is_expansion"):
        return False
    name = (game.get("name") or "").lower()
    if search and search.lower() not in name:
        return False
    if players is not None:
        mn, mx = game.get("min_players"), game.get("max_players")
        if mx is not None and mx < players:
            return False
        if players < 6 and mn is not None and mn > players:
            return False
    pt = game.get("playing_time") or 0
    if playtime_min is not None and pt < playtime_min:
        return False
    if playtime_max is not None and pt > playtime_max:
        return False
    if play_mode is not None and game.get("play_mode") != play_mode:
        return False
    return True


@router.get(
    "/collection/status-map",
    response_model=CollectionStatusMapResponse,
    status_code=200,
    summary="Viewer's game->status map and owned-expansion counts",
)
async def collection_status_map(
    user: CurrentUser = Depends(get_current_user),
) -> CollectionStatusMapResponse:
    """The status pills and expansion badges, in one DB round trip.

    The web client used to derive these from GET /collection, which costs three
    unbounded round trips — the whole collection with a games join, play stats
    over the viewer's entire visible history, then an IN-query to hydrate
    played-not-owned games — and then threw away everything except these two
    dicts. That read re-fires roughly once a minute of active navigation.

    GET /collection is unchanged: the native app consumes its row shape.
    """
    data = get_supabase().rpc(
        "bgb_collection_status_map", {"p_viewer": user.user_id}
    ).execute().data or {}
    return CollectionStatusMapResponse(
        status_map=data.get("status_map") or {},
        expansion_counts={str(k): int(v) for k, v in (data.get("expansion_counts") or {}).items()},
    )


# ── Whole-shelf read (client-side paging) ─────────────────────────────────────
# /collection/grid materializes the entire shelf on every request and slices it
# in Python, so a page turn costs the same as a first load — ~1s on mobile. The
# web client instead pulls a shelf once through this endpoint, caches it, and
# derives every page, filter and search locally. One DB round trip, down from
# the grid's two (owned/wishlist) or three (played).
#
# /collection/grid is deliberately left untouched: the native app
# (app/src/api/client.js) and the game explorer still page against it.

_SHELF_DEFAULT_LIMIT = 1000
_SHELF_MAX_LIMIT = 5000


@router.get(
    "/collection/shelf",
    response_model=CollectionShelfResponse,
    status_code=200,
    summary="Whole collection shelf in one response (for client-side paging)",
)
async def collection_shelf(
    status: CollectionStatus = Query(
        CollectionStatus.OWNED,
        description=(
            "Which shelf to return — owned (default), wishlist, or played "
            "(games the user has plays for but does not own / wishlist). "
            "Wishlist is only returned to its owner."
        ),
    ),
    exclude_expansions: bool = Query(
        True,
        description="When true (default) expansions are hidden — surfaced separately on the Profile.",
    ),
    limit: int = Query(
        _SHELF_DEFAULT_LIMIT,
        ge=1,
        le=_SHELF_MAX_LIMIT,
        description=(
            "Hard row cap. When the shelf is larger, `items` is a prefix and "
            "`truncated` is true so the caller can fall back to /collection/grid."
        ),
    ),
    user_id: Optional[str] = Query(
        None,
        description="Target user (profiles are public); defaults to the viewer.",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> CollectionShelfResponse:
    """One shelf, whole, pre-sorted — so the client can page without refetching.

    Ordering matches /collection/grid's default so the caller can slice
    directly: owned/played by last_played DESC NULLS LAST then added_at DESC,
    wishlist by added_at DESC. No search/filter parameters by design — they
    would multiply the client's cache keys, and every filter the grid applies
    is a pure function of fields already on each returned row.
    """
    result = get_supabase().rpc(
        "bgb_collection_shelf",
        {
            "viewer": user.user_id,
            "target": user_id or user.user_id,
            "p_status": status.value,
            "p_exclude_expansions": exclude_expansions,
            "p_limit": limit,
        },
    ).execute()

    data = result.data or {}
    return CollectionShelfResponse(
        items=[CollectionItem(**row) for row in (data.get("items") or [])],
        total=data.get("total") or 0,
        truncated=bool(data.get("truncated")),
        generated_at=datetime.now(timezone.utc),
    )


@router.get(
    "/collection/grid",
    response_model=CollectionPageResponse,
    status_code=200,
    summary="Paginated collection grid (owned default; wishlist / played also supported)",
)
async def collection_grid(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(12, ge=1, le=100, description="Tiles per page"),
    status: CollectionStatus = Query(
        CollectionStatus.OWNED,
        description=(
            "Which shelf to return — owned (default), wishlist, or played "
            "(games the user has plays for — logged by them or by someone who "
            "listed them as a player — but does not currently own / wishlist)."
        ),
    ),
    search: Optional[str] = Query(None, description="Case-insensitive game-name match"),
    players: Optional[int] = Query(None, ge=1, le=20),
    playtime_min: Optional[int] = Query(None, ge=1),
    playtime_max: Optional[int] = Query(None, ge=1),
    play_mode: Optional[PlayMode] = Query(None, description="competitive / coop / team"),
    exclude_expansions: bool = Query(
        True,
        description="When true (default) expansions are hidden — surfaced separately on the Profile.",
    ),
    sort: CollectionSort = Query(
        CollectionSort.LAST_PLAYED,
        description="Sort order — last_played (default), added_at, or alphabetical.",
    ),
    prioritize_exact_players: bool = Query(
        False,
        description=(
            "When true AND players is set, surface games whose max_players "
            "exactly equals players above wider-range games. Off by default "
            "so the chosen sort stays consistent across pages."
        ),
    ),
    user_id: Optional[str] = Query(
        None,
        description="Target user (profiles are public); defaults to the viewer.",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> CollectionPageResponse:
    """Collection shelf sorted by `sort` (default last_played DESC NULLS LAST, then added_at DESC)."""
    sb = get_supabase()
    target_user_id = user_id or user.user_id
    status_value = status.value
    mode_value = play_mode.value if play_mode else None

    if status == CollectionStatus.PLAYED:
        # Played-not-owned shelf: every game the user has a play for — logged
        # by them or by someone who listed them as a player — that doesn't
        # currently sit on their owned OR wishlist shelf. Lets the Profile
        # surface games-they-play-but-don't-have as a distinct row without
        # duplicating anything from the other two shelves above it.
        last_played, play_counts = _play_stats(sb, target_user_id)
        if not last_played:
            return CollectionPageResponse(items=[], total=0, page=page, per_page=per_page)

        # Any collection row excludes the game from this shelf — both owned
        # and wishlist live in the same table, so a single fetch covers both.
        coll = (
            sb.table("boardgamebuddy_collections")
            .select("game_id")
            .eq("user_id", target_user_id)
            .execute()
            .data
            or []
        )
        collected_ids = {r["game_id"] for r in coll}
        candidate_ids = [gid for gid in last_played if gid not in collected_ids]
        if not candidate_ids:
            return CollectionPageResponse(items=[], total=0, page=page, per_page=per_page)

        games = (
            sb.table("boardgamebuddy_games")
            .select(game_select_clause())
            .in_("id", candidate_ids)
            .execute()
            .data
            or []
        )
        filtered_games = [
            g for g in games
            if _passes_grid_filters(
                g,
                search=search,
                players=players,
                playtime_min=playtime_min,
                playtime_max=playtime_max,
                play_mode=mode_value,
                exclude_expansions=exclude_expansions,
            )
        ]
        total = len(filtered_games)
        if total == 0:
            return CollectionPageResponse(items=[], total=0, page=page, per_page=per_page)

        # Same sort axis as the owned grid below: most-recently-played first.
        filtered_games.sort(
            key=lambda g: last_played.get(g["id"], ""),
            reverse=True,
        )
        offset = (page - 1) * per_page
        page_games = filtered_games[offset : offset + per_page]
        items = [
            CollectionItem(
                id=f"played-{g['id']}",
                game_id=g["id"],
                status=CollectionStatus.PLAYED.value,
                added_at=f"{last_played[g['id']]}T00:00:00+00:00",
                last_played_at=last_played.get(g["id"]),
                play_count=play_counts.get(g["id"], 0),
                game=GameSummary(**g),
            )
            for g in page_games
        ]
        _attach_page_expansion_counts(sb, items)
        return CollectionPageResponse(items=items, total=total, page=page, per_page=per_page)

    # Round-trip 1: every shelf row, with the joined game payload embedded.
    coll_rows = (
        sb.table("boardgamebuddy_collections")
        .select(
            "id, added_at, game_id, "
            f"boardgamebuddy_games({game_select_clause()})"
        )
        .eq("user_id", target_user_id)
        .eq("status", status_value)
        .execute()
        .data
        or []
    )

    # In-Python filter (PostgREST can't filter on the embedded fields).
    filtered: list[dict] = []
    for r in coll_rows:
        g = r.get("boardgamebuddy_games") or {}
        if not g:
            continue
        if not _passes_grid_filters(
            g,
            search=search,
            players=players,
            playtime_min=playtime_min,
            playtime_max=playtime_max,
            play_mode=mode_value,
            exclude_expansions=exclude_expansions,
        ):
            continue
        filtered.append(r)

    total = len(filtered)
    if total == 0:
        return CollectionPageResponse(items=[], total=0, page=page, per_page=per_page)

    # Round-trip 2: last_played_at + play_count per game, scoped to the user's
    # plays of the filtered game set. One query — keeps the endpoint at two
    # round-trips total.
    game_ids = [r["game_id"] for r in filtered]
    last_played, play_counts = _play_stats(sb, target_user_id, game_ids)

    if sort == CollectionSort.ADDED_AT:
        ordered = sorted(filtered, key=lambda r: r.get("added_at") or "", reverse=True)
    elif sort == CollectionSort.ALPHABETICAL:
        ordered = sorted(
            filtered,
            key=lambda r: ((r.get("boardgamebuddy_games") or {}).get("name") or "").lower(),
        )
    else:
        # last_played DESC NULLS LAST, then added_at DESC. Split into
        # has-play and never-played buckets so NULLS LAST is trivial; each
        # bucket sorts by its own secondary key.
        has_plays = [r for r in filtered if r["game_id"] in last_played]
        no_plays = [r for r in filtered if r["game_id"] not in last_played]
        has_plays.sort(
            key=lambda r: (last_played[r["game_id"]], r.get("added_at") or ""),
            reverse=True,
        )
        no_plays.sort(key=lambda r: r.get("added_at") or "", reverse=True)
        ordered = has_plays + no_plays

    # Opt-in: when prioritize_exact_players=true AND players is set, surface
    # exact-fit games (max_players == players) above wider-range ones. The
    # stable sort preserves the chosen `sort` ordering inside each bucket.
    # Off by default so the chosen `sort` stays consistent across pages.
    if players is not None and prioritize_exact_players:
        ordered = sorted(
            ordered,
            key=lambda r: 0 if ((r.get("boardgamebuddy_games") or {}).get("max_players") == players) else 1,
        )

    offset = (page - 1) * per_page
    page_rows = ordered[offset : offset + per_page]
    items = [
        CollectionItem(
            id=r["id"],
            game_id=r["game_id"],
            status=status_value,
            added_at=r["added_at"],
            last_played_at=last_played.get(r["game_id"]),
            play_count=play_counts.get(r["game_id"], 0),
            game=GameSummary(**r["boardgamebuddy_games"]),
        )
        for r in page_rows
    ]
    _attach_page_expansion_counts(sb, items)
    return CollectionPageResponse(items=items, total=total, page=page, per_page=per_page)
