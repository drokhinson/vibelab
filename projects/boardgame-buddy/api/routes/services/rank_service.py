"""Game ranking: where the viewer's games sit, and moving them (migration 056).

Rows hold (category, tier, position-within-tier). Everything the player sees is
derived here: "#3 Family" is the game's place in its category with the tiers
stacked love → good → not. The writes go through two RPCs so the dense
positions inside a tier never gain a hole or a collision.
"""

from typing import Any

from fastapi import HTTPException
from supabase import Client

from ..constants import RANK_TIER_ORDER, RankTier
from ..rank_models import (
    RankContext,
    RankedGame,
    RankEntry,
    RankQueueItem,
)
from ._helpers import (
    chunked,
    game_select_clause,
    game_summary_from_row,
    page_all,
    raise_for_rpc_error,
)
from .rank_category import category_label, rank_category

TABLE = "boardgamebuddy_game_ranks"
_TIER_INDEX = {t.value: i for i, t in enumerate(RANK_TIER_ORDER)}
# The category decision reads these on top of the GameSummary columns.
_GAME_COLS = game_select_clause() + ", categories, publishers, bgg_weight, bgg_family"
_IN_CHUNK = 150


def _rank_rows(sb: Client, user_id: str) -> list[dict[str, Any]]:
    return (
        sb.table(TABLE)
        .select("game_id, category, tier, position")
        .eq("user_id", user_id)
        .execute()
        .data
        or []
    )


def _ordered(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One category's rows in ranking order."""
    return sorted(rows, key=lambda r: (_TIER_INDEX.get(r["tier"], 99), r["position"]))


# Each tier owns a band of the 10-point scale, best game at the top of it.
# The bands never overlap, so a game the player loves always outscores one
# they merely liked, however long either list gets.
_SCORE_BANDS = {
    RankTier.LOVE.value: (10.0, 7.0),
    RankTier.GOOD.value: (6.9, 4.0),
    RankTier.NOT.value: (3.9, 1.0),
}


def _score(tier: str, index: int, count: int) -> float:
    """A rating out of 10 for the game at `index` of `count` in its tier,
    spread evenly down the tier's band. A tier of one sits at its top."""
    hi, lo = _SCORE_BANDS[tier]
    if count <= 1:
        return hi
    return round(hi - (hi - lo) * index / (count - 1), 1)


def _entries(rows: list[dict[str, Any]]) -> list[RankEntry]:
    by_cat: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_cat.setdefault(r["category"], []).append(r)
    out: list[RankEntry] = []
    for cat, cat_rows in by_cat.items():
        ordered = _ordered(cat_rows)
        tier_sizes: dict[str, int] = {}
        for r in ordered:
            tier_sizes[r["tier"]] = tier_sizes.get(r["tier"], 0) + 1
        seen: dict[str, int] = {}
        for i, r in enumerate(ordered):
            idx = seen.get(r["tier"], 0)
            seen[r["tier"]] = idx + 1
            out.append(RankEntry(
                game_id=r["game_id"], category=cat, category_label=category_label(cat),
                tier=RankTier(r["tier"]), position=i + 1,
                score=_score(r["tier"], idx, tier_sizes[r["tier"]]),
            ))
    return out


def _game_rows(sb: Client, ids: list[str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for chunk in chunked(list(dict.fromkeys(ids)), _IN_CHUNK):
        for row in sb.table("boardgamebuddy_games").select(_GAME_COLS).in_("id", chunk).execute().data or []:
            out[row["id"]] = row
    return out


def _game_row(sb: Client, game_id: str) -> dict[str, Any]:
    rows = sb.table("boardgamebuddy_games").select(_GAME_COLS).eq("id", game_id).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Game not found")
    return rows[0]


def _category_for(game: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    """A ranked game stays in the list it was ranked in; BGG's family landing
    later (the metadata backfill) must not move it under the player."""
    for r in rows:
        if r["game_id"] == game["id"]:
            return r["category"]
    return rank_category(game)


def list_ranks(sb: Client, user_id: str) -> list[RankEntry]:
    return _entries(_rank_rows(sb, user_id))


def context(sb: Client, user_id: str, game_id: str) -> RankContext:
    game = _game_row(sb, game_id)
    rows = _rank_rows(sb, user_id)
    category = _category_for(game, rows)
    mine = next((e for e in _entries(rows) if e.game_id == game_id), None)
    others = _ordered([r for r in rows if r["category"] == category and r["game_id"] != game_id])
    games = _game_rows(sb, [r["game_id"] for r in others])
    ranked = [
        RankedGame(game=game_summary_from_row(games[r["game_id"]]), tier=RankTier(r["tier"]), position=i + 1)
        for i, r in enumerate(others)
        if r["game_id"] in games
    ]
    return RankContext(
        game=game_summary_from_row(game), category=category,
        category_label=category_label(category), rank=mine, ranked=ranked,
    )


def place(sb: Client, user_id: str, game_id: str, tier: RankTier, index: int) -> RankEntry:
    game = _game_row(sb, game_id)
    if game.get("is_expansion"):
        raise HTTPException(status_code=400, detail="Expansions are ranked with their base game")
    category = _category_for(game, _rank_rows(sb, user_id))
    data = sb.rpc("bgb_rank_game", {
        "p_user": user_id, "p_game": game_id, "p_category": category,
        "p_tier": tier.value, "p_index": index,
    }).execute().data
    raise_for_rpc_error(data, "Rank game")
    entry = next((e for e in list_ranks(sb, user_id) if e.game_id == game_id), None)
    if entry is None:
        raise HTTPException(status_code=500, detail="Rank was not saved")
    return entry


def remove(sb: Client, user_id: str, game_id: str) -> bool:
    data = sb.rpc("bgb_unrank_game", {"p_user": user_id, "p_game": game_id}).execute().data
    raise_for_rpc_error(data, "Unrank game")
    return bool(data.get("removed"))


def queue(sb: Client, user_id: str) -> list[RankQueueItem]:
    """Owned or played base games without a rank, A to Z.

    Played is the rule every play-derived surface uses — plays the viewer
    logged or is seated in — read through bgb_play_stats. Wishlist and
    previously-owned games are left out unless the viewer has played them.
    """
    owned = page_all(
        lambda: sb.table("boardgamebuddy_collections")
        .select("id, game_id")
        .eq("user_id", user_id)
        .eq("status", "owned"),
        "id", label="rank queue owned",
    )
    stats = sb.rpc("bgb_play_stats", {"p_viewer": user_id, "p_game_ids": None}).execute().data or []
    played = [r["game_id"] for r in stats if (r.get("play_count") or 0) > 0 or r.get("last_played_at")]
    ranked = {r["game_id"] for r in _rank_rows(sb, user_id)}
    ids = [gid for gid in dict.fromkeys([r["game_id"] for r in owned] + played) if gid not in ranked]
    games = _game_rows(sb, ids)
    items = []
    for gid in ids:
        g = games.get(gid)
        if not g or g.get("is_expansion"):
            continue
        cat = rank_category(g)
        items.append(RankQueueItem(game=game_summary_from_row(g), category=cat, category_label=category_label(cat)))
    items.sort(key=lambda i: (i.game.name.casefold(), i.game.id))
    return items
