"""Feed assembly — composes play cards + hot games + suggested buddies.
Hits the RPCs added in migration 012."""

from datetime import date, datetime
from typing import Any, Optional, Tuple

from ..models import (
    FeedCard,
    FeedHotGamesCard,
    FeedHotGamesEntry,
    FeedPageResponse,
    FeedPlayCard,
    FeedPlayParticipant,
    FeedPlayUser,
    FeedSuggestedBuddiesCard,
    FeedSuggestedBuddy,
    GameSummary,
    HotGamesResponse,
    OnboardingSuggestionsResponse,
    SuggestedBuddiesResponse,
    SuggestionNetworkGroup,
)
from ..constants import (
    ONBOARDING_NETWORK_LIMIT,
    ONBOARDING_NETWORK_PER_SEED,
    BuddySuggestionSource,
    PlayMode,
)
from ._helpers import fetch_games_by_ids, fetch_profiles_by_ids


def _play_card_from_rpc_row(row: dict[str, Any]) -> FeedPlayCard:
    return FeedPlayCard(
        play_id=row["play_id"],
        user=FeedPlayUser(
            id=row["play_user_id"],
            display_name=row.get("play_user_name") or "Unknown",
            avatar=row.get("play_user_avatar"),
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
        # Default to [] so the route keeps responding against an unmigrated
        # RPC (migration 025 introduces the `participants` jsonb column).
        participants=[
            FeedPlayParticipant(**p) for p in (row.get("participants") or [])
        ],
        # Migration 005. Defaults to 1 the same way `participants` defaults to
        # [], so the route keeps answering against an RPC that predates the
        # column — an unmigrated database serves ordinary cards rather than 500s.
        group_count=int(row.get("group_count") or 1),
        import_group_id=(str(row["import_group_id"]) if row.get("import_group_id") else None),
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


def _suggestion_from_row(
    row: dict,
    profiles: dict,
    *,
    source: Optional[BuddySuggestionSource] = None,
) -> Optional[FeedSuggestedBuddy]:
    """Shape one suggestion row against an already-fetched profile map.

    Returns None when the candidate has no profile row — both RPCs inner-join
    profiles, so this only fires on a delete that landed between the two
    reads. Shared by the rail, the onboarding tiers and the preloaded second
    hop, so all three carry the same fields and a `via` never resolves one way
    on one surface and another way on the next."""
    p = profiles.get(row["user_id"])
    if not p:
        return None
    via_id = row.get("via_user_id")
    via = profiles.get(via_id) if via_id else None
    return FeedSuggestedBuddy(
        user_id=row["user_id"],
        display_name=p["display_name"],
        avatar=p.get("avatar"),
        mutual_count=int(row.get("mutual_count") or 0),
        play_count=int(row.get("play_count") or 0),
        pending_mutual_count=int(row.get("pending_mutual_count") or 0),
        via_user_id=via_id,
        # Null when the via profile did not come back — the tile falls back to
        # a name-free line rather than printing an id.
        via_display_name=via["display_name"] if via else None,
        source=source,
    )


def fetch_suggested_buddies(sb, viewer_id: str, *, limit: int = 5) -> SuggestedBuddiesResponse:
    """Candidates the viewer has played with, then friends-of-friends.

    Every suggestion shares at least one play, one accepted buddy, or one
    person the viewer has sent a request to (migration 072) with the viewer;
    the RPC ranks shared plays first and returns the top `limit`."""
    rows = sb.rpc(
        "bgb_suggested_buddies",
        {"uid": viewer_id, "lim": limit},
    ).execute().data or []
    # The via ids ride the same fetch — a second round trip to name the person
    # a suggestion is explained by would cost more than the suggestions did.
    profiles = fetch_profiles_by_ids(sb, _suggestion_profile_ids(rows))
    suggestions = [
        s for s in (_suggestion_from_row(r, profiles) for r in rows) if s
    ]
    return SuggestedBuddiesResponse(suggestions=suggestions)


def _suggestion_profile_ids(*row_groups: list[dict]) -> list[str]:
    """Every profile id a group of suggestion rows needs: the candidates and
    whoever explains them. Duplicates are fine — fetch_profiles_by_ids dedupes."""
    ids: list[str] = []
    for rows in row_groups:
        for r in rows:
            ids.append(r["user_id"])
            if r.get("via_user_id"):
                ids.append(r["via_user_id"])
    return ids


def fetch_onboarding_buddy_suggestions(
    sb, viewer_id: str, *, limit: int = 12
) -> OnboardingSuggestionsResponse:
    """Candidates for the onboarding "Add buddies" step.

    Deliberately NOT fetch_suggested_buddies with a bigger limit. That one
    floors on an earned signal — a shared play or a shared buddy — which is
    right for the Feed rail and empty for exactly the user this screen exists
    for. bgb_onboarding_buddy_suggestions returns the same earned-signal
    candidates first and then falls back to people who have logged plays
    recently, tagging each row with the tier it came from so the tile can say
    which it is."""
    rows = sb.rpc(
        "bgb_onboarding_buddy_suggestions",
        {"uid": viewer_id, "lim": limit},
    ).execute().data or []

    # The second hop, for the people we are about to suggest. The deck holds
    # it until the user ticks someone and then promotes that person's buddies
    # into the grid with no round trip, which is only possible if it is
    # already here — hence one extra RPC now rather than one per tick later.
    seed_ids = [r["user_id"] for r in rows]
    network_rows = []
    if seed_ids:
        network_rows = sb.rpc(
            "bgb_onboarding_suggestion_network",
            {
                "uid": viewer_id,
                "seed_ids": seed_ids,
                "per_seed": ONBOARDING_NETWORK_PER_SEED,
                "lim": ONBOARDING_NETWORK_LIMIT,
            },
        ).execute().data or []

    # One profile fetch for both sets — the candidates, their vias, and every
    # person the second hop reaches.
    profiles = fetch_profiles_by_ids(
        sb, _suggestion_profile_ids(rows, network_rows)
    )

    suggestions: list[FeedSuggestedBuddy] = []
    for r in rows:
        shaped = _suggestion_from_row(
            r,
            profiles,
            source=BuddySuggestionSource(r.get("source") or BuddySuggestionSource.GRAPH),
        )
        if shaped:
            suggestions.append(shaped)

    # Group the hop by seed, preserving the RPC's rank order within each.
    grouped: dict[str, list[FeedSuggestedBuddy]] = {}
    for r in network_rows:
        shaped = _suggestion_from_row(
            {**r, "via_user_id": r["via_user_id"]},
            profiles,
            source=BuddySuggestionSource.NETWORK,
        )
        if shaped:
            grouped.setdefault(r["via_user_id"], []).append(shaped)
    network = [
        SuggestionNetworkGroup(via_user_id=via, buddies=buddies)
        for via, buddies in grouped.items()
    ]

    return OnboardingSuggestionsResponse(suggestions=suggestions, network=network)


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
    after the first play. Subsequent pages return plays only.
    """
    play_cards, next_cursor = fetch_feed_plays(sb, viewer_id, cursor=cursor, limit=limit)
    cards: list[FeedCard] = []
    first_page = cursor is None
    if first_page:
        hot = fetch_hot_games(sb)
        if hot.games:
            cards.append(FeedHotGamesCard(window_days=hot.window_days, games=hot.games))

    # Interleave suggestions roughly through the page so the feed never feels
    # like a wall of identical units — the order is:
    #   play 1 → suggested-buddies → play 2 → ...
    suggestions_card: Optional[FeedSuggestedBuddiesCard] = None
    if first_page:
        sug = fetch_suggested_buddies(sb, viewer_id)
        if sug.suggestions:
            suggestions_card = FeedSuggestedBuddiesCard(suggestions=sug.suggestions)

    insert_sug_after = 1
    for i, card in enumerate(play_cards):
        cards.append(card)
        if suggestions_card and i + 1 == insert_sug_after:
            cards.append(suggestions_card)
            suggestions_card = None
    # Straggler (page too short to hit the insertion index).
    if suggestions_card:
        cards.append(suggestions_card)

    return FeedPageResponse(cards=cards, next_cursor=next_cursor)
