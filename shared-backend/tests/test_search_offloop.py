"""The unified search runs off the event loop.

One thing is worth pinning here, and it is not the ranking: that a `/search`
call does not hold the event loop while Supabase answers. The Supabase client
is synchronous, and this service runs ONE uvicorn worker, so a blocking read
left on the loop stalls every other request in flight — during Gather that is
the host's 2s lobby poll plus one 2s poll per joiner, all of which queue behind
each keystroke. `test_the_loop_keeps_running_during_a_search` is the assertion
that would have failed before `_catalog_hits` moved to `asyncio.to_thread`, and
would fail again if someone inlined it back onto the loop.

The rest pins the RPC → two-query fallback, which is the branch the same change
restructured: it used to sit in `unified_search`'s own try/except and now lives
inside the threaded function.

The fake below is just enough PostgREST/RPC to serve those reads.
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio

from routes.boardgame_buddy.services import search_service as S


VIEWER = "user-me"


def _game(name, gid, **over):
    row = {
        "id": gid, "bgg_id": None, "name": name, "year_published": 1995,
        "min_players": 2, "max_players": 4, "playing_time": 60,
        "thumbnail_url": None, "image_url": None, "theme_color": None,
        "is_expansion": False, "base_game_bgg_id": None, "expansion_color": None,
        "rulebook_url": None, "play_mode": "competitive",
    }
    row.update(over)
    return row


# ── Fakes ────────────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, data):
        self.data = data


class _RpcCall:
    def __init__(self, rows, delay, fail):
        self._rows, self._delay, self._fail = rows, delay, fail

    def execute(self):
        # A real Supabase read blocks the calling thread. That is the whole
        # point of the fake — a sleep here is what an await would never be.
        if self._delay:
            time.sleep(self._delay)
        if self._fail:
            raise RuntimeError("function boardgamebuddy_search_games does not exist")
        return _Result(self._rows)


class _Table:
    """Enough of the PostgREST builder for the two-query fallback."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_kw): return self
    def eq(self, *_a, **_kw): return self
    def ilike(self, *_a, **_kw): return self
    def order(self, *_a, **_kw): return self
    def limit(self, *_a, **_kw): return self
    def execute(self): return _Result(self._rows)


class _SB:
    def __init__(self, rpc_rows=None, *, delay=0.0, rpc_fails=False, table_rows=None):
        self._rpc_rows = rpc_rows or []
        self._delay = delay
        self._rpc_fails = rpc_fails
        self._table_rows = table_rows or []
        self.rpc_calls = 0

    def rpc(self, _name, _params):
        self.rpc_calls += 1
        return _RpcCall(self._rpc_rows, self._delay, self._rpc_fails)

    def table(self, _name):
        return _Table(self._table_rows)


def _search(sb, q="catan", **kw):
    return asyncio.run(S.unified_search(sb, VIEWER, q, **kw))


# ── The event loop ───────────────────────────────────────────────────────────

def test_the_loop_keeps_running_during_a_search():
    """A search must not stall other requests while Supabase answers.

    The fake read blocks its thread for 200ms. A ticker coroutine runs
    alongside on a 10ms beat; if the search were executed on the loop the
    ticker would be frozen for the whole read and land ~1 tick. Off the loop it
    keeps its beat, so the assertion is that it ticked many times — a floor
    well under the theoretical 20 so a slow CI box cannot make this flaky.
    """
    sb = _SB([_game("Catan", "g1")], delay=0.2)
    ticks = 0

    async def ticker(stop):
        nonlocal ticks
        while not stop.is_set():
            await asyncio.sleep(0.01)
            ticks += 1

    async def scenario():
        stop = asyncio.Event()
        beat = asyncio.create_task(ticker(stop))
        res = await S.unified_search(sb, VIEWER, "catan")
        stop.set()
        await beat
        return res

    res = asyncio.run(scenario())
    assert len(res.results) == 1
    assert ticks >= 5, f"event loop was blocked during the search (ticks={ticks})"


def test_a_blocking_search_does_not_serialize_with_its_peers():
    """Two concurrent searches overlap rather than queueing.

    Same reasoning one level up: 3 searches × 200ms each finish in well under
    the 600ms they would take back-to-back on a single thread.
    """
    sb = _SB([_game("Catan", "g1")], delay=0.2)

    async def scenario():
        started = time.monotonic()
        await asyncio.gather(*(
            S.unified_search(sb, VIEWER, q) for q in ("catan", "carcassonne", "azul")
        ))
        return time.monotonic() - started

    elapsed = asyncio.run(scenario())
    assert elapsed < 0.5, f"searches serialized ({elapsed:.2f}s for 3 × 0.2s)"


# ── The fallback the same change restructured ────────────────────────────────

def test_rpc_rows_split_into_collection_and_db_hits():
    sb = _SB([
        dict(_game("Catan", "g1"), in_collection=True, collection_status="owned"),
        dict(_game("Catan Junior", "g2"), in_collection=False, collection_status=None),
    ])
    res = _search(sb)
    assert [h.source for h in res.results] == ["collection", "db"]
    assert res.results[0].collection_status == "owned"


def test_a_missing_rpc_falls_back_to_the_two_query_path():
    """Migration 041 not applied yet — search still answers, from PostgREST."""
    sb = _SB(rpc_fails=True, table_rows=[_game("Catan", "g1")])
    res = _search(sb)
    assert sb.rpc_calls == 1
    assert [h.game.name for h in res.results] == ["Catan"]


def test_the_fallback_also_stays_off_the_loop():
    """The slow path is TWO blocking round trips, so it matters more, not less.

    Wrapping only the RPC would have put this branch back on the loop at
    exactly the moment the service is already degraded.
    """
    sb = _SB(rpc_fails=True, delay=0.2, table_rows=[_game("Catan", "g1")])
    ticks = 0

    async def ticker(stop):
        nonlocal ticks
        while not stop.is_set():
            await asyncio.sleep(0.01)
            ticks += 1

    async def scenario():
        stop = asyncio.Event()
        beat = asyncio.create_task(ticker(stop))
        res = await S.unified_search(sb, VIEWER, "catan")
        stop.set()
        await beat
        return res

    res = asyncio.run(scenario())
    assert len(res.results) == 1
    assert ticks >= 5, f"event loop was blocked during the fallback (ticks={ticks})"


def test_an_empty_query_never_reaches_the_database():
    sb = _SB([_game("Catan", "g1")])
    res = _search(sb, q="   ")
    assert res.results == []
    assert sb.rpc_calls == 0
