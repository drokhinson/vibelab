"""The game page's admin "Refresh from BoardGameGeek" re-reads what only the
import used to write — tags, the play_mode they imply, player counts — which is
what the old starter catalog got wrong (every row 002_seed.sql used to insert was 'competitive',
Pandemic included). One /thing call, admin-only."""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import routes  # noqa: E402
from routes import game_routes as G  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402

ADMIN = CurrentUser(user_id="00000000-0000-0000-0000-00000000000a", display_name="A",
                    username="a", is_admin=True)

PANDEMIC_XML = """<?xml version="1.0" encoding="utf-8"?>
<items><item type="boardgame" id="30549">
  <name type="primary" value="Pandemic"/>
  <yearpublished value="2008"/>
  <minplayers value="2"/><maxplayers value="4"/><playingtime value="45"/>
  <link type="boardgamecategory" id="2145" value="Medical"/>
  <link type="boardgamemechanic" id="2023" value="Cooperative Game"/>
  <link type="boardgamemechanic" id="2040" value="Hand Management"/>
</item></items>"""


class _Q:
    def __init__(self, sb, table):
        self.sb, self.table, self._update = sb, table, None

    def select(self, *_a, **_k):
        return self

    def update(self, cols):
        self._update = cols
        return self

    def eq(self, *_a):
        return self

    def execute(self):
        if self._update is not None:
            self.sb.updates.append((self.table, self._update))
            if self.table == "boardgamebuddy_games":
                self.sb.row.update(self._update)
            return type("R", (), {"data": []})()
        return type("R", (), {"data": [dict(self.sb.row)] if self.sb.row else []})()


class _SB:
    def __init__(self, row):
        self.row = row
        self.updates = []

    def table(self, name):
        return _Q(self, name)


@pytest.fixture
def stub(monkeypatch):
    calls = []

    async def fake_fetch(path, params, **_k):
        calls.append((path, params))
        return PANDEMIC_XML

    async def fake_images(*_a, **_k):
        calls.append(("images",))

    monkeypatch.setattr(G, "fetch_bgg", fake_fetch)
    monkeypatch.setattr(G, "_hydrate_images_from_bgg", fake_images)
    monkeypatch.setattr(G, "_sync_denormalized_game_fields", lambda *a, **k: calls.append(("denorm",)))
    monkeypatch.setattr(G, "_invalidate_game_caches", lambda: None)
    return calls


def _seed_row(**over):
    row = {"id": "g1", "bgg_id": 30549, "name": "Pandemic", "year_published": 2008,
           "min_players": 2, "max_players": 4, "playing_time": 45, "image_url": "https://x/p.jpg",
           "play_mode": "competitive", "categories": ["Medical", "Cooperative", "Family"],
           "mechanics": ["Hand Management"], "is_expansion": False,
           "created_at": "2026-01-01T00:00:00Z"}
    row.update(over)
    return row


def test_refresh_rewrites_tags_and_derives_coop(stub, monkeypatch):
    sb = _SB(_seed_row())
    monkeypatch.setattr(G, "get_supabase", lambda: sb)
    game = asyncio.run(G.refresh_single_game_from_bgg(game_id="g1", _admin=ADMIN))
    written = next(cols for table, cols in sb.updates if table == "boardgamebuddy_games")
    assert written["play_mode"] == "coop"
    assert written["mechanics"] == ["Cooperative Game", "Hand Management"]
    assert written["categories"] == ["Medical"]
    assert (written["min_players"], written["max_players"], written["playing_time"]) == (2, 4, 45)
    assert game.play_mode == "coop"
    # One BGG read; art already present, so no image fetch; denorm fan-out ran.
    assert [c for c in stub if c[0] == "/thing"] == [("/thing", {"id": 30549, "stats": 1})]
    assert ("images",) not in stub and ("denorm",) in stub


def test_refresh_fetches_art_when_the_row_has_none(stub, monkeypatch):
    sb = _SB(_seed_row(image_url=None))
    monkeypatch.setattr(G, "get_supabase", lambda: sb)
    asyncio.run(G.refresh_single_game_from_bgg(game_id="g1", _admin=ADMIN))
    assert ("images",) in stub


def test_a_game_without_a_bgg_id_is_a_400(stub, monkeypatch):
    monkeypatch.setattr(G, "get_supabase", lambda: _SB(_seed_row(bgg_id=None)))
    with pytest.raises(HTTPException) as e:
        asyncio.run(G.refresh_single_game_from_bgg(game_id="g1", _admin=ADMIN))
    assert e.value.status_code == 400


def test_the_route_is_admin_gated():
    route = next(r for r in routes.router.routes
                 if getattr(r, "path", "").endswith("/games/admin/{game_id}/refresh-bgg"))
    assert get_current_admin in [d.call for d in route.dependant.dependencies]
