"""Feed assembly — composes play cards + hot games + suggested buddies +
featured-from-collection. Hits the RPCs added in migration 012."""

from datetime import date, datetime
from typing import Any, Optional, Tuple

from ..models import (
    FeedCard,
    FeedFeaturedFromCollectionCard,
    FeedFeaturedFromCollectionEntry,
    FeedHotGamesCard,
    FeedHotGamesEntry,
    FeedPageResponse,
    FeedPlayCard,
    FeedPlayUser,
    FeedSuggestedBuddiesCard,
    FeedSuggestedBuddy,
    FeaturedFromCollectionResponse,
    GameSummary,
    HotGamesResponse,
    SuggestedBuddiesResponse,
)
from ..constants import PlayMode
from ._helpers import fetch_games_by_ids, fetch_profiles_by_ids, game_summary_from_row


def _play_card_from_rpc_row(row: dict[str, Any]) -> FeedPlayCard:
    return FeedPlayCard(
        play_id=row["play_id"],
        user=FeedPlayUser(
            id=row["play_user_id"],
            display_name=row.get("play_user_name") or "Unknown",
            avatar_url=row.get("play_user_avatar"),
        ),
        game=GameSummary(
            id=row["game_id"],
            name=row.get("game_name") or "Unknown",
            image_url=row.get("game_image_url"),
            thumbnail_url=row.get("game_thumbnail_url"),
        ),
        played_at=row["played_at"],
        created_at=row["created_at"],
        notes=row.get("notes"),
        photo_url=row.get("photo_url"),
        play_mode=PlayMode(row.get("play_mode") or PlayMode.COMPETITIVE.value),
        winner_display_name=row.get("winner_display_name"),
        participant_count=int(row.get("participant_count") or 0),
    )


def _encode_cursor(played_at: date, created_at: datetime) -> str:
    """Composite "played_at|created_at" string the FE round-trips back."""
    return f"{played_at.isoformat()}|{created_at.isoformat()}"


def _decode_cursor(cursor: Optional[str]) -> Tuple[Optional[date], Optional[datetime]]:
    if not cursor:
        return None, None
    if "|" not in cursor:
        # Tolerate legacy single-timestamp cursors from before migration 014.
        try:
            return None, datetime.fromisoformat(cursor.replace("Z", "+00:00"))
        except ValueError:
            return None, None
    played_str, created_str = cursor.split("|", 1)
    try:
        played = date.fromisoformat(played_str)
    except ValueError:
        played = None
    try:
        created = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
    except ValueError:
        created = None
    return played, created


def fetch_feed_plays(
    sb,
    viewer_id: str,
    *,
    cursor: Optional[str] = None,
    limit: int = 20,
) -> tuple[list[FeedPlayCard], Optional[str]]:
    """Returns (cards, next_cursor). next_cursor is "played_at|created_at"
    of the last row; None means no more pages."""
    before_played, before_created = _decode_cursor(cursor)
    params: dict[str, Any] = {"viewer": viewer_id, "lim": limit}
    if before_played is not None:
        params["before_played_at"] = before_played.isoformat()
    if before_created is not None:
        params["before_created_at"] = before_created.isoformat()
    rows = sb.rpc("bgb_feed_plays", params).execute().data or []
    cards = [_play_card_from_rpc_row(r) for r in rows]
    next_cursor: Optional[str] = None
    if len(rows) == limit and rows:
        last = cards[-1]
        next_cursor = _encode_cursor(last.played_at, last.created_at)
    return cards, next_cursor


def fetch_hot_games(sb, *, window_days: int = 7, limit: int = 10) -> HotGamesResponse:
    rows = sb.rpc(
        "bgb_hot_games",
        {"window_days": window_days, "lim": limit},
    ).execute().data or []
    game_ids = [r["game_id"] for r in rows]
    games = fetch_games_by_ids(sb, game_ids)
    entries: list[FeedHotGamesEntry] = []
    for r in rows:
        g = games.get(r["game_id"])
        if not g:
            continue
        entries.append(FeedHotGamesEntry(game=g, play_count=int(r.get("play_count") or 0)))
    return HotGamesResponse(games=entries, window_days=window_days)


def fetch_suggested_buddies(sb, viewer_id: str, *, limit: int = 10) -> SuggestedBuddiesResponse:
    rows = sb.rpc(
        "bgb_suggested_buddies",
        {"uid": viewer_id, "lim": limit},
    ).execute().data or []
    user_ids = [r["user_id"] for r in rows]
    profiles = fetch_profiles_by_ids(sb, user_ids)
    suggestions: list[FeedSuggestedBuddy] = []
    for r in rows:
        p = profiles.get(r["user_id"])
        if not p:
            continue
        suggestions.append(FeedSuggestedBuddy(
            user_id=r["user_id"],
            display_name=p["display_name"],
            avatar_url=p.get("avatar_url"),
            mutual_count=int(r.get("mutual_count") or 0),
        ))
    return SuggestedBuddiesResponse(suggestions=suggestions)


def fetch_featured_from_collection(
    sb,
    viewer_id: str,
    *,
    days_since: int = 60,
    limit: int = 5,
) -> FeaturedFromCollectionResponse:
    rows = sb.rpc(
        "bgb_dormant_collection",
        {"uid": viewer_id, "days_since": days_since, "lim": limit},
    ).execute().data or []
    game_ids = [r["game_id"] for r in rows]
    games = fetch_games_by_ids(sb, game_ids)
    entries: list[FeedFeaturedFromCollectionEntry] = []
    for r in rows:
        g = games.get(r["game_id"])
        if not g:
            continue
        entries.append(FeedFeaturedFromCollectionEntry(
            game=g,
            last_played_at=r.get("last_played_at"),
        ))
    return FeaturedFromCollectionResponse(games=entries)


def build_feed_page(
    sb,
    viewer_id: str,
    *,
    cursor: Optional[str] = None,
    limit: int = 20,
) -> FeedPageResponse:
    """Assemble a single page of mixed feed cards.

    Composition rule (v1): plays form the spine; on the first page (cursor is
    None), prepend a Hot Games card and intersperse a Suggested Buddies card
    after the first play and a Featured-From-Collection card mid-page.
    Subsequent pages return plays only.
    """
    play_cards, next_cursor = fetch_feed_plays(sb, viewer_id, cursor=cursor, limit=limit)
    cards: list[FeedCard] = []
    first_page = cursor is None
    if first_page:
        hot = fetch_hot_games(sb)
        if hot.games:
            cards.append(FeedHotGamesCard(window_days=hot.window_days, games=hot.games))

    # Interleave suggestions / featured roughly through the page so the feed
    # never feels like a wall of identical units.
    suggestions_card: Optional[FeedSuggestedBuddiesCard] = None
    featured_card: Optional[FeedFeaturedFromCollectionCard] = None
    if first_page:
        sug = fetch_suggested_buddies(sb, viewer_id)
        if sug.suggestions:
            suggestions_card = FeedSuggestedBuddiesCard(suggestions=sug.suggestions)
        feat = fetch_featured_from_collection(sb, viewer_id)
        if feat.games:
            featured_card = FeedFeaturedFromCollectionCard(games=feat.games)

    insert_sug_after = 1
    insert_feat_after = 5
    for i, card in enumerate(play_cards):
        cards.append(card)
        if suggestions_card and i + 1 == insert_sug_after:
            cards.append(suggestions_card)
            suggestions_card = None
        if featured_card and i + 1 == insert_feat_after:
            cards.append(featured_card)
            featured_card = None
    # Stragglers (page too short to hit the insertion index).
    if suggestions_card:
        cards.append(suggestions_card)
    if featured_card:
        cards.append(featured_card)

    return FeedPageResponse(cards=cards, next_cursor=next_cursor)
