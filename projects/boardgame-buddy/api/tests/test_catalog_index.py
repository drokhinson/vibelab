"""GET /search/index — the catalog, whole, compact, built once per TTL.

What is pinned:

  1. The read runs OFF the event loop (same ticker as test_search_offloop.py):
     this is a full-table read, so it is the one place inlining it would hurt
     most.
  2. Covers on the configured R2 origin come back as their KEY under
     `thumb_base`; a cover on any other origin stays absolute. Both must
     survive the client's `startsWith("http")` reassembly.
  3. A second call inside the TTL does not touch the database, and
     invalidate_catalog_index() makes the next one rebuild.
  4. Past INDEX_HARD_CAP the response is a prefix and says `truncated`.
  5. Expansions are asked away in the query (the fake records the filter).
"""

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import cache
import object_store
from routes.services import search_service as S


def _row(gid, name, thumb=None, **over):
    row = {
        "id": gid, "name": name, "year_published": 2017, "min_players": 2,
        "max_players": 4, "playing_time": 45, "thumbnail_url": thumb,
    }
    row.update(over)
    return row


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, sb, rows, delay):
        self._sb, self._rows, self._delay = sb, rows, delay
        self.filters = []
        self._limit = None

    def select(self, *_a, **_kw): return self
    def order(self, *_a, **_kw): return self
    def eq(self, col, val): self.filters.append((col, val)); return self
    def limit(self, n): self._limit = n; return self

    def execute(self):
        if self._delay:
            time.sleep(self._delay)
        self._sb.reads += 1
        self._sb.last_filters = list(self.filters)
        rows = self._rows[: self._limit] if self._limit else self._rows
        return _Result(rows)


class _SB:
    def __init__(self, rows, delay=0.0):
        self._rows, self._delay = rows, delay
        self.reads = 0
        self.last_filters = []

    def table(self, _name):
        return _Table(self, self._rows, self._delay)


def _fresh():
    """Each test starts with no built index in the per-process cache."""
    cache.clear(S._CACHE_INDEX)


def _index(sb):
    return asyncio.run(S.catalog_index(sb))


def test_the_read_stays_off_the_loop():
    _fresh()
    sb = _SB([_row("g1", "Catan")], delay=0.2)
    ticks = 0

    async def ticker(stop):
        nonlocal ticks
        while not stop.is_set():
            await asyncio.sleep(0.01)
            ticks += 1

    async def scenario():
        stop = asyncio.Event()
        beat = asyncio.create_task(ticker(stop))
        res = await S.catalog_index(sb)
        stop.set()
        await beat
        return res

    res = asyncio.run(scenario())
    assert res.count == 1
    assert ticks >= 5, f"event loop was blocked building the index (ticks={ticks})"


def test_covers_shorten_to_their_key_under_the_r2_base(monkeypatch):
    _fresh()
    monkeypatch.setattr(object_store, "public_base", lambda kind: "https://img.example.test")
    sb = _SB([
        _row("g1", "Catan", thumb="https://img.example.test/13_thumb.jpg"),
        _row("g2", "Azul", thumb="https://cf.geekdo-images.com/abc/thumb.jpg"),
        _row("g3", "Root", thumb=None),
    ])
    res = _index(sb)
    by = {g.id: g for g in res.games}
    assert res.thumb_base == "https://img.example.test"
    assert by["g1"].th == "13_thumb.jpg"
    assert by["g2"].th == "https://cf.geekdo-images.com/abc/thumb.jpg"
    assert by["g3"].th is None
    # The rest of the row is the paint set and nothing more.
    assert (by["g1"].y, by["g1"].mn, by["g1"].mx, by["g1"].t) == (2017, 2, 4, 45)


def test_no_base_configured_leaves_every_cover_absolute(monkeypatch):
    _fresh()
    monkeypatch.setattr(object_store, "public_base", lambda kind: "")
    sb = _SB([_row("g1", "Catan", thumb="https://x.test/13_thumb.jpg")])
    res = _index(sb)
    assert res.thumb_base == ""
    assert res.games[0].th == "https://x.test/13_thumb.jpg"


def test_the_index_is_built_once_per_ttl_and_invalidation_rebuilds_it():
    _fresh()
    sb = _SB([_row("g1", "Catan")])
    _index(sb)
    _index(sb)
    assert sb.reads == 1
    S.invalidate_catalog_index()
    _index(sb)
    assert sb.reads == 2


def test_past_the_cap_the_response_is_a_flagged_prefix(monkeypatch):
    _fresh()
    monkeypatch.setattr(S, "INDEX_HARD_CAP", 3)
    sb = _SB([_row(f"g{i}", f"Game {i}") for i in range(5)])
    res = _index(sb)
    assert res.truncated is True
    assert res.count == 3
    assert [g.id for g in res.games] == ["g0", "g1", "g2"]


def test_under_the_cap_is_not_truncated(monkeypatch):
    _fresh()
    monkeypatch.setattr(S, "INDEX_HARD_CAP", 3)
    sb = _SB([_row(f"g{i}", f"Game {i}") for i in range(3)])
    res = _index(sb)
    assert res.truncated is False
    assert res.count == 3


def test_expansions_are_excluded_in_the_query():
    _fresh()
    sb = _SB([_row("g1", "Catan")])
    _index(sb)
    assert ("is_expansion", False) in sb.last_filters


def test_rows_missing_a_name_are_dropped():
    _fresh()
    sb = _SB([_row("g1", "Catan"), _row("g2", ""), {"id": None, "name": "x"}])
    res = _index(sb)
    assert [g.id for g in res.games] == ["g1"]
    assert res.count == 1
