"""The Discover bundle degrades one rail at a time, never the whole tab.

Four sections, four independent sources. What is pinned here: a hot-list game
the catalog does not have arrives as a stub (game=None) rather than being
dropped; a BGG outage flags the trending rail and leaves the personal picks
intact — and is NOT cached, so the next viewer gets a fresh try; an expansion
on the hot list is skipped, as everywhere else in the app; and an account with
no shelf and no plays gets catalog-rank picks marked cold_start instead of an
empty rail.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio  # noqa: E402

import pytest  # noqa: E402

import cache  # noqa: E402
from routes.services import discovery_service as D  # noqa: E402


def _game(i, **over):
    row = {
        "id": f"g{i}", "bgg_id": 1000 + i, "name": f"Game {i}", "year_published": 2026,
        "min_players": 2, "max_players": 4, "playing_time": 60, "thumbnail_url": None,
        "image_url": None, "theme_color": None, "is_expansion": False,
        "base_game_bgg_id": None, "expansion_color": None, "rulebook_url": None,
        "play_mode": "competitive", "bgg_rating": 7.5, "bgg_rank": i,
    }
    row.update(over)
    return row


class _Query:
    def __init__(self, rows):
        self.rows = rows
        self._in = None
        self._eq = {}

    def select(self, *_a, **_k):
        return self

    def in_(self, col, vals):
        self._in = (col, set(vals))
        return self

    def eq(self, col, val):
        self._eq[col] = val
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = self.rows
        if self._in:
            col, vals = self._in
            rows = [r for r in rows if r.get(col) in vals]
        for col, val in self._eq.items():
            rows = [r for r in rows if r.get(col) == val]
        return type("R", (), {"data": rows[: getattr(self, "_limit", None)]})()


class _SB:
    """Catalog rows plus canned RPC answers, keyed by function name."""

    def __init__(self, games, rpc):
        self.games, self.rpc_answers = games, rpc

    def table(self, name):
        assert name == "boardgamebuddy_games"
        return _Query(self.games)

    def rpc(self, name, params):
        rows = self.rpc_answers.get(name, [])
        return type("Q", (), {"execute": lambda _s: type("R", (), {"data": rows})()})()


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear(D._NS)
    yield
    cache.clear(D._NS)


def _run(coro):
    return asyncio.run(coro)


def _sb(*, picks=None, dormant=None, games=None):
    return _SB(
        games if games is not None else [_game(1), _game(2), _game(3, is_expansion=True)],
        {
            "bgb_discover_recommendations": picks if picks is not None else [
                {"game_id": "g1", "score": 0.9, "reason_kind": "because_you_play",
                 "reason_game_id": "seed", "reason_game_name": "Wingspan",
                 "shared_mechanics": ["Drafting", "Set Collection"], "shared_categories": []},
            ],
            "bgb_dormant_collection": dormant if dormant is not None else [
                {"game_id": "g2", "last_played_at": "2026-01-05"},
            ],
        },
    )


def test_hot_list_game_missing_from_catalog_is_a_stub_not_dropped(monkeypatch):
    async def hot(**_k):
        return [
            {"bgg_id": 1001, "rank": 1, "name": "Game 1 (BGG)", "year_published": 2025, "thumbnail_url": "t1"},
            {"bgg_id": 5555, "rank": 2, "name": "Unknown Hotness", "year_published": 2026, "thumbnail_url": "t2"},
            {"bgg_id": 1003, "rank": 3, "name": "An Expansion", "year_published": 2026, "thumbnail_url": "t3"},
        ]

    monkeypatch.setattr(D, "fetch_hot_games", hot)
    bundle = _run(D.build_bundle(_sb(), "u1"))
    assert bundle.trending_error is False
    ranks = [(e.bgg_id, e.game is not None) for e in bundle.trending]
    # The catalog row wins for #1; #2 is a stub; the expansion at #3 is gone.
    assert ranks == [(1001, True), (5555, False)]
    assert bundle.trending[0].name == "Game 1"          # catalog spelling, not BGG's
    assert bundle.trending[1].thumbnail_url == "t2"      # BGG's art for the stub


def test_bgg_outage_flags_trending_keeps_picks_and_is_not_cached(monkeypatch):
    async def down(**_k):
        return []

    monkeypatch.setattr(D, "fetch_hot_games", down)
    bundle = _run(D.build_bundle(_sb(), "u1"))
    assert bundle.trending == [] and bundle.trending_error is True
    assert [p.game.id for p in bundle.picks] == ["g1"]
    assert bundle.picks[0].reason_label == "Because you play Wingspan"
    assert bundle.picks[0].cold_start is False
    assert [d.game.id for d in bundle.back_on_shelf] == ["g2"]
    assert str(bundle.back_on_shelf[0].last_played_at) == "2026-01-05"
    # Not remembered: the next call gets another try at BGG.
    assert cache.get(D._NS, "u1") is None


def test_cold_start_falls_back_to_catalog_rank(monkeypatch):
    async def hot(**_k):
        return [{"bgg_id": 1001, "rank": 1, "name": "x", "year_published": None, "thumbnail_url": None}]

    monkeypatch.setattr(D, "fetch_hot_games", hot)
    bundle = _run(D.build_bundle(_sb(picks=[], dormant=[]), "new-user"))
    assert bundle.picks and all(p.cold_start for p in bundle.picks)
    assert all(p.reason_label == "Highly rated on BoardGameGeek" for p in bundle.picks)
    # Expansions never surface as picks, cold start included.
    assert all(not p.game.is_expansion for p in bundle.picks)
    assert bundle.back_on_shelf == []
    # A healthy bundle IS cached for the next ten minutes.
    assert cache.get(D._NS, "new-user") is bundle


def test_refresh_bypasses_the_server_cache(monkeypatch):
    calls = []

    async def hot(**_k):
        calls.append(1)
        return [{"bgg_id": 1001, "rank": 1, "name": "x", "year_published": None, "thumbnail_url": None}]

    monkeypatch.setattr(D, "fetch_hot_games", hot)
    sb = _sb()
    first = _run(D.build_bundle(sb, "u1"))
    again = _run(D.build_bundle(sb, "u1"))
    assert again is first and len(calls) == 1
    fresh = _run(D.build_bundle(sb, "u1", refresh=True))
    assert fresh is not first and len(calls) == 2
