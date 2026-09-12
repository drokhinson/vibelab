"""/collection/grid is one RPC, and the RPC is told everything it needs.

The grid used to read a user's whole shelf on every page turn and filter, sort
and slice it in Python. Migration 024 moved all four into
`bgb_collection_page`, which leaves the handler with nothing to get wrong
except the call itself — so that is what this pins:

  1. ONE round trip. Two (or three, on the played shelf) is what the change
     removed, and an added read would not fail anything else.
  2. Every query parameter reaches the RPC under the parameter name the
     function declares. A dropped argument silently falls back to the
     function's DEFAULT — a lost `p_search` returns the unfiltered shelf, and a
     lost `viewer` makes the wishlist gate compare against NULL. Neither one
     errors; both are wrong answers.
  3. An empty response is a 502, not an empty shelf. The function cannot
     return one, so an empty `data` means the RPC is missing or failed, and a
     shelf that renders as "no games" is the worst way to say so.
  4. The read stays off the event loop. The Supabase client is synchronous and
     this service runs ONE uvicorn worker, so a blocking read left on the loop
     stalls every other request in flight.

The filtering, sorting and paging themselves are the function's, and are
verified against real data — there is no Postgres here to run them against.
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio

import pytest
from fastapi import HTTPException

from routes.boardgame_buddy import collection_routes as R
from routes.boardgame_buddy.constants import CollectionSort, CollectionStatus, PlayMode
from routes.boardgame_buddy.dependencies import CurrentUser


ME = "user-me"
THEM = "user-them"

USER = CurrentUser(user_id=ME, display_name="Me", username="me")


def _game_json(gid="game-1", **over):
    row = {
        "id": gid, "bgg_id": 13, "name": "Catan", "year_published": 1995,
        "min_players": 3, "max_players": 4, "playing_time": 60,
        "thumbnail_url": None, "image_url": None, "theme_color": None,
        "is_expansion": False, "base_game_bgg_id": None, "expansion_color": None,
        "rulebook_url": None, "play_mode": "competitive", "expansion_count": 2,
    }
    row.update(over)
    return row


def _item_json(**over):
    row = {
        "id": "coll-1", "game_id": "game-1", "status": "owned",
        "added_at": "2024-03-01T00:00:00+00:00", "last_played_at": "2024-05-02",
        "play_count": 7, "game": _game_json(),
    }
    row.update(over)
    return row


# ── Fakes ────────────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, data):
        self.data = data


class _Rpc:
    def __init__(self, payload, delay=0.0):
        self._payload, self._delay = payload, delay

    def execute(self):
        # A real Supabase read blocks the calling thread. That is the whole
        # point of the fake — a sleep here is what an await would never be.
        if self._delay:
            time.sleep(self._delay)
        return _Result(self._payload)


class _Supabase:
    """Records every call; serves one canned payload."""

    def __init__(self, payload, delay=0.0):
        self._payload, self._delay = payload, delay
        self.rpc_calls = []
        self.table_calls = []

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return _Rpc(self._payload, self._delay)

    def table(self, name):
        self.table_calls.append(name)
        raise AssertionError(f"unexpected table read: {name}")


@pytest.fixture
def sb(monkeypatch):
    """Install a fake Supabase and hand the test a setter for its payload."""
    holder = {}

    def install(payload, delay=0.0):
        holder["sb"] = _Supabase(payload, delay)
        monkeypatch.setattr(R, "get_supabase", lambda: holder["sb"])
        return holder["sb"]

    return install


def _grid(**over):
    """Call the handler with the FastAPI defaults, overridden per test."""
    kwargs = {
        "page": 1, "per_page": 12,
        "status": CollectionStatus.OWNED,
        "search": None, "players": None,
        "playtime_min": None, "playtime_max": None,
        "play_mode": None, "exclude_expansions": True,
        "sort": CollectionSort.LAST_PLAYED,
        "prioritize_exact_players": False,
        "user_id": None, "user": USER,
    }
    kwargs.update(over)
    return asyncio.run(R.collection_grid(**kwargs))


# ── Tests ────────────────────────────────────────────────────────────────────

def test_one_rpc_and_no_other_reads(sb):
    fake = sb({"items": [_item_json()], "total": 1, "parted_total": 0})

    _grid()

    assert [name for name, _ in fake.rpc_calls] == ["bgb_collection_page"]
    assert fake.table_calls == []


def test_every_filter_reaches_the_function(sb):
    fake = sb({"items": [], "total": 0, "parted_total": 0})

    _grid(
        page=3, per_page=24,
        status=CollectionStatus.WISHLIST,
        search="cat", players=5,
        playtime_min=30, playtime_max=90,
        play_mode=PlayMode.COOP,
        exclude_expansions=False,
        sort=CollectionSort.ALPHABETICAL,
        prioritize_exact_players=True,
        user_id=THEM,
    )

    _, params = fake.rpc_calls[0]
    assert params == {
        # Both ids: the wishlist gate in the function compares them, so a
        # handler that passed only `target` would serve anyone's wishlist.
        "viewer": ME,
        "target": THEM,
        "p_status": "wishlist",
        "p_search": "cat",
        "p_players": 5,
        "p_playtime_min": 30,
        "p_playtime_max": 90,
        # Enums travel as their raw string values, not as "PlayMode.COOP".
        "p_play_mode": "coop",
        "p_exclude_expansions": False,
        "p_sort": "alphabetical",
        "p_prioritize_exact_players": True,
        "p_page": 3,
        "p_per_page": 24,
    }


def test_target_defaults_to_the_viewer(sb):
    fake = sb({"items": [], "total": 0, "parted_total": 0})

    _grid(user_id=None)

    _, params = fake.rpc_calls[0]
    assert params["viewer"] == ME and params["target"] == ME


def test_payload_maps_onto_the_response(sb):
    sb({
        "items": [_item_json(), _item_json(id="coll-2", game_id="game-2",
                                          status="prev_owned",
                                          game=_game_json("game-2", name="Azul"))],
        "total": 41,
        "parted_total": 6,
    })

    page = _grid(page=2, per_page=12)

    assert (page.total, page.parted_total) == (41, 6)
    assert (page.page, page.per_page) == (2, 12)
    assert [it.game.name for it in page.items] == ["Catan", "Azul"]
    # expansion_count comes back on the game now — it was a third round trip.
    assert page.items[0].game.expansion_count == 2
    assert page.items[0].play_count == 7
    assert page.items[1].status == CollectionStatus.PREV_OWNED


def test_played_shelf_keeps_its_synthetic_ids(sb):
    # The client keys tiles on both of these, and there is no collection row
    # for the function to take them from.
    sb({
        "items": [_item_json(id="played-game-9", game_id="game-9",
                             status="played",
                             added_at="2024-05-02T00:00:00+00:00",
                             game=_game_json("game-9"))],
        "total": 1,
        "parted_total": 0,
    })

    page = _grid(status=CollectionStatus.PLAYED)

    assert page.items[0].id == "played-game-9"
    assert page.items[0].added_at.isoformat() == "2024-05-02T00:00:00+00:00"


def test_an_empty_response_is_a_502(sb):
    sb(None)

    with pytest.raises(HTTPException) as exc:
        _grid()

    assert exc.value.status_code == 502


def test_the_loop_keeps_running_during_a_page_turn(sb):
    sb({"items": [], "total": 0, "parted_total": 0}, delay=0.25)

    async def main():
        ticks = 0

        async def tick():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        ticker = asyncio.create_task(tick())
        await R.collection_grid(
            page=1, per_page=12, status=CollectionStatus.OWNED,
            search=None, players=None, playtime_min=None, playtime_max=None,
            play_mode=None, exclude_expansions=True,
            sort=CollectionSort.LAST_PLAYED, prioritize_exact_players=False,
            user_id=None, user=USER,
        )
        ticker.cancel()
        return ticks

    # ~25 ticks if the read is off the loop; 0 or 1 if it is blocking it.
    assert asyncio.run(main()) > 5
