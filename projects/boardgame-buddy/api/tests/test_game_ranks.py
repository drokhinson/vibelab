"""Game ranking (migration 056): categories, ordering, the writes and the queue.

The RPCs' own position arithmetic is SQL and lives in
db/tests/056_game_ranks.sql; the fake here reproduces it just closely enough
that the service can be driven end to end. What is pinned in Python is
everything the service decides on its own:

  * the category comes from BGG's family, then a fallback, never the client;
  * a ranked game keeps the category it was ranked in;
  * "#N" stacks the tiers love → good → not, whatever the stored positions;
  * the queue is owned ∪ played, minus ranked, minus expansions, A to Z.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from routes import rank_routes as R  # noqa: E402
from routes.constants import RankTier  # noqa: E402
from routes.dependencies import CurrentUser  # noqa: E402
from routes.rank_models import RankWrite  # noqa: E402
from routes.services import rank_service as S  # noqa: E402
from routes.services.rank_category import rank_category  # noqa: E402

ME = "00000000-0000-0000-0000-00000000000a"
USER = CurrentUser(user_id=ME, display_name="Me", username="me", is_admin=False)


def _game(gid, name, *, family=None, cats=(), weight=None, expansion=False, pubs=None,
          min_p=None, max_p=None):
    return {
        "id": gid, "bgg_id": None, "name": name, "is_expansion": expansion,
        "play_mode": "competitive", "bgg_family": family, "categories": list(cats),
        "bgg_weight": weight, "publishers": pubs,
        "min_players": min_p, "max_players": max_p,
    }


class _Q:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        return _Q([r for r in self.rows if r.get(col) == val])

    def in_(self, col, vals):
        return _Q([r for r in self.rows if r.get(col) in set(vals)])

    def order(self, col):
        return _Q(sorted(self.rows, key=lambda r: r.get(col)))

    def range(self, lo, hi):
        return _Q(self.rows[lo:hi + 1])

    def execute(self):
        data = self.rows if isinstance(self.rows, dict) else list(self.rows)
        return type("Res", (), {"data": data})()


class _SB:
    """Tables as lists of dicts; the two rank RPCs mirror 056's SQL."""

    def __init__(self, games, collections=(), plays=(), ranks=()):
        self.tables = {
            "boardgamebuddy_games": list(games),
            "boardgamebuddy_collections": [dict(r) for r in collections],
            "boardgamebuddy_game_ranks": [dict(r) for r in ranks],
        }
        self.plays = list(plays)
        self.calls = []

    def table(self, name):
        return _Q(self.tables[name])

    def rpc(self, name, params):
        self.calls.append((name, params))
        data = getattr(self, "_" + name)(**params)
        return _Q(data)

    def _bgb_play_stats(self, p_viewer, p_game_ids):
        return [{"game_id": g, "play_count": 1, "last_played_at": "2026-01-01"} for g in self.plays]

    def _ranks(self):
        return self.tables["boardgamebuddy_game_ranks"]

    def _bgb_unrank_game(self, p_user, p_game):
        rows = self._ranks()
        old = next((r for r in rows if r["user_id"] == p_user and r["game_id"] == p_game), None)
        if not old:
            return {"removed": False}
        rows.remove(old)
        for r in rows:
            if (r["user_id"], r["category"], r["tier"]) == (p_user, old["category"], old["tier"]) \
                    and r["position"] > old["position"]:
                r["position"] -= 1
        return {"removed": True}

    def _bgb_rank_game(self, p_user, p_game, p_category, p_tier, p_index):
        self._bgb_unrank_game(p_user, p_game)
        rows = self._ranks()
        same = [r for r in rows if (r["user_id"], r["category"], r["tier"]) == (p_user, p_category, p_tier)]
        pos = min(max(p_index, 0), len(same))
        for r in same:
            if r["position"] >= pos:
                r["position"] += 1
        rows.append({"user_id": p_user, "game_id": p_game, "category": p_category,
                     "tier": p_tier, "position": pos})
        return {"category": p_category, "tier": p_tier, "position": pos}


def _rank(gid, cat, tier, pos):
    return {"user_id": ME, "game_id": gid, "category": cat, "tier": tier, "position": pos}


@pytest.fixture
def sb(monkeypatch):
    holder = {}
    monkeypatch.setattr(R, "get_supabase", lambda: holder["sb"])
    return holder


def run(coro):
    return asyncio.run(coro)


# ── Category ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("game,expected", [
    (_game("1", "a", family="familygames"), "family"),
    (_game("1", "a", family="wargames", cats=["Party Game"]), "war"),          # family beats tags
    (_game("1", "a", cats=["Party Game", "Wargame"]), "party"),              # first tag wins
    (_game("1", "a", cats=["Abstract Strategy"]), "abstract"),
    (_game("1", "a", weight=3.4), "strategy"),
    (_game("1", "a", weight="2.49"), "family"),
    (_game("1", "a"), "family"),                                              # nothing known
    (_game("1", "a", family="somethingnew", weight=4), "strategy"),           # unknown family falls through
    # Traditional playing-card games: Card Game tag AND a (Public Domain) credit.
    (_game("1", "euchre", family="familygames", cats=["Card Game", "Trick-taking"],
           pubs=["(Public Domain)", "Bicycle"]), "card"),                    # beats BGG's family
    (_game("1", "dominion", family="strategygames", cats=["Card Game"],
           pubs=["Rio Grande Games"]), "strategy"),                          # the tag alone is not enough
    (_game("1", "chess", cats=["Abstract Strategy"], pubs=["(Public Domain)"]), "abstract"),
    (_game("1", "unsynced", cats=["Card Game"], pubs=None), "family"),       # publishers not synced yet
    # Exactly two players, no more and no fewer.
    (_game("1", "duel", family="strategygames", min_p=2, max_p=2), "two_player"),  # beats BGG's family
    (_game("1", "solo too", family="strategygames", min_p=1, max_p=2), "strategy"),
    (_game("1", "up to 4", min_p=2, max_p=4, weight=3), "strategy"),
    (_game("1", "gin rummy", cats=["Card Game"], pubs=["(Public Domain)"],
           min_p=2, max_p=2), "card"),                                       # Card comes first
])
def test_category_rules(game, expected):
    assert rank_category(game) == expected


# ── Reads ────────────────────────────────────────────────────────────────────

def test_position_stacks_tiers_whatever_the_stored_numbers(sb):
    games = [_game(g, g, family="familygames") for g in "abcd"]
    sb["sb"] = _SB(games, ranks=[
        _rank("c", "family", "not", 0),
        _rank("a", "family", "good", 1),
        _rank("b", "family", "love", 0),
        _rank("d", "family", "good", 0),
    ])
    got = {e.game_id: e.position for e in run(R.list_ranks(user=USER)).ranks}
    assert got == {"b": 1, "d": 2, "a": 3, "c": 4}


def test_positions_are_per_category(sb):
    sb["sb"] = _SB([_game("a", "a"), _game("b", "b")], ranks=[
        _rank("a", "family", "good", 0), _rank("b", "party", "not", 0),
    ])
    ranks = run(R.list_ranks(user=USER)).ranks
    assert {(e.game_id, e.category_label, e.position) for e in ranks} == {("a", "Family", 1), ("b", "Party", 1)}


def test_context_lists_the_category_without_the_game_itself(sb):
    games = [_game("new", "Cascadia", family="familygames"), _game("x", "Azul", family="familygames"),
             _game("y", "Brass", family="strategygames"), _game("z", "Kingdomino", family="familygames")]
    sb["sb"] = _SB(games, ranks=[
        _rank("z", "family", "good", 0), _rank("x", "family", "love", 0), _rank("y", "strategy", "love", 0),
    ])
    ctx = run(R.rank_context(game_id="new", user=USER))
    assert ctx.category == "family" and ctx.category_label == "Family"
    assert ctx.rank is None
    assert [(r.game.name, r.tier, r.position) for r in ctx.ranked] == [
        ("Azul", RankTier.LOVE, 1), ("Kingdomino", RankTier.GOOD, 2),
    ]


def test_a_ranked_game_keeps_its_category_when_bgg_disagrees_later(sb):
    # Ranked as family by the fallback; the backfill has since said strategy.
    sb["sb"] = _SB([_game("g", "Wingspan", family="strategygames")], ranks=[_rank("g", "family", "love", 0)])
    ctx = run(R.rank_context(game_id="g", user=USER))
    assert ctx.category == "family"
    assert ctx.rank.position == 1 and ctx.ranked == []


def test_context_404s_for_an_unknown_game(sb):
    sb["sb"] = _SB([])
    with pytest.raises(HTTPException) as e:
        run(R.rank_context(game_id="nope", user=USER))
    assert e.value.status_code == 404


# ── Writes ───────────────────────────────────────────────────────────────────

def test_place_sends_the_server_decided_category_and_returns_the_new_number(sb):
    games = [_game("new", "Cascadia", family="familygames"), _game("x", "Azul", family="familygames")]
    sb["sb"] = _SB(games, ranks=[_rank("x", "family", "love", 0)])
    entry = run(R.rank_game(body=RankWrite(tier=RankTier.LOVE, index=0), game_id="new", user=USER))
    assert sb["sb"].calls[-1] == ("bgb_rank_game", {
        "p_user": ME, "p_game": "new", "p_category": "family", "p_tier": "love", "p_index": 0,
    })
    assert (entry.position, entry.category_label) == (1, "Family")
    assert {e.game_id: e.position for e in run(R.list_ranks(user=USER)).ranks} == {"new": 1, "x": 2}


def test_rerank_moves_within_the_original_category(sb):
    games = [_game("g", "Wingspan", family="strategygames"), _game("x", "Azul", family="familygames")]
    sb["sb"] = _SB(games, ranks=[_rank("g", "family", "love", 0), _rank("x", "family", "love", 1)])
    entry = run(R.rank_game(body=RankWrite(tier=RankTier.NOT, index=0), game_id="g", user=USER))
    assert sb["sb"].calls[-1][1]["p_category"] == "family"
    assert entry.position == 2
    assert {e.game_id: e.position for e in run(R.list_ranks(user=USER)).ranks} == {"x": 1, "g": 2}


def test_expansions_are_not_ranked(sb):
    sb["sb"] = _SB([_game("e", "Seafarers", expansion=True)])
    with pytest.raises(HTTPException) as e:
        run(R.rank_game(body=RankWrite(tier=RankTier.LOVE, index=0), game_id="e", user=USER))
    assert e.value.status_code == 400
    assert sb["sb"].calls == []


def test_remove(sb):
    sb["sb"] = _SB([_game("a", "a"), _game("b", "b")],
                   ranks=[_rank("a", "family", "love", 0), _rank("b", "family", "love", 1)])
    assert run(R.unrank_game(game_id="a", user=USER)).removed is True
    assert run(R.unrank_game(game_id="a", user=USER)).removed is False
    assert [(e.game_id, e.position) for e in run(R.list_ranks(user=USER)).ranks] == [("b", 1)]


# ── Queue ────────────────────────────────────────────────────────────────────

def test_queue_is_owned_or_played_minus_ranked_and_expansions_a_to_z(sb):
    games = [
        _game("1", "spirit Island", family="strategygames"),
        _game("2", "Azul", family="familygames"),
        _game("3", "Codenames", family="partygames"),
        _game("4", "Seafarers", expansion=True),
        _game("5", "Brass", family="strategygames"),
        _game("6", "Wish", family="familygames"),
        _game("7", "Sold", family="familygames"),
    ]
    collections = [
        {"id": "c1", "user_id": ME, "game_id": "1", "status": "owned"},
        {"id": "c2", "user_id": ME, "game_id": "2", "status": "owned"},
        {"id": "c4", "user_id": ME, "game_id": "4", "status": "owned"},
        {"id": "c5", "user_id": ME, "game_id": "5", "status": "owned"},
        {"id": "c6", "user_id": ME, "game_id": "6", "status": "wishlist"},
        {"id": "c7", "user_id": ME, "game_id": "7", "status": "prev_owned"},
        {"id": "c8", "user_id": "someone-else", "game_id": "6", "status": "owned"},
    ]
    sb["sb"] = _SB(games, collections=collections, plays=["3", "2"], ranks=[_rank("5", "strategy", "love", 0)])
    items = run(R.rank_queue(user=USER)).items
    assert [(i.game.name, i.category_label) for i in items] == [
        ("Azul", "Family"), ("Codenames", "Party"), ("spirit Island", "Strategy"),
    ]
