"""POST /bgg/sync writes a collection and counts plays. It writes no plays.

That sentence is the whole change, and it is the kind that rots silently: the
sync would still look healthy with the play writes back in, and the only
symptom would be plays appearing in somebody's log that they were never shown.
So these tests watch the WRITES rather than the summary — every table the sync
touches is recorded, and a `boardgamebuddy_plays` insert fails the test.

The rest is the arithmetic that moved with it:

  * `plays_new` counts against bgg_play_id, so a play the retired write path
    landed is not offered back to the importer.
  * A warm-up exhaustion reports `plays_read_failed`, never `plays_new = 0` —
    a done screen that hides the importer hand-off because it could not read
    the history is worse than one that says so.
  * `unique_games_to_import` is collection-only now. A game that exists purely
    to carry a play is the importer's to fetch on demand, and counting it here
    would promise a worker queue nobody is filling.
  * A successful read is parked for the importer; a failed one never is.

All pure: no network, no database.

Run:  python -m pytest tests/test_bgg_sync_collection_only.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio

import pytest

from routes import bgg_link_routes as R
from routes.bgg_client import BggWarmUpError
from routes.services import bgg_plays_cache


# ── Fakes ────────────────────────────────────────────────────────────────────

class _Q:
    def __init__(self, table, store):
        self.table, self.store, self.ids = table, store, None

    def select(self, *_a, **_k): return self
    def eq(self, *_a, **_k): return self
    def update(self, rows):
        self.store["_writes"].append((self.table, "update", rows))
        return self

    def insert(self, rows):
        self.store["_writes"].append((self.table, "insert", rows))
        return self

    def upsert(self, rows, **_k):
        self.store["_writes"].append((self.table, "upsert", rows))
        return self

    def in_(self, _col, ids):
        self.ids = list(ids)
        return self

    def execute(self):
        rows = self.store.get(self.table, [])
        if self.ids is not None:
            rows = [r for r in rows
                    if r.get("bgg_play_id") in self.ids or r.get("bgg_id") in self.ids]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, store):
        self.store = store
        store.setdefault("_writes", [])

    def table(self, name): return _Q(name, self.store)


def _raw_play(pid, bgg_id=13):
    return {
        "bgg_play_id": pid, "bgg_id": bgg_id, "bgg_game_name": "Catan",
        "played_at": "2026-01-02", "notes": None, "quantity": 1,
        "players": [{"name": "Sean", "username": None, "is_winner": True}],
    }


def _run(store, *, collection, plays, monkeypatch, plays_raise=False):
    sb = _SB(store)
    monkeypatch.setattr(R, "get_supabase", lambda: sb)

    async def _collection(_uid, _username):
        return collection, False
    monkeypatch.setattr(R, "_fetch_collection_batched", _collection)

    async def _plays(_uid, _username):
        if plays_raise:
            raise BggWarmUpError()
        return plays
    monkeypatch.setattr(R, "fetch_all_plays", _plays)

    summary = asyncio.run(R._run_sync("u1", "me"))
    return summary, store["_writes"]


@pytest.fixture(autouse=True)
def _clear_cache():
    bgg_plays_cache.invalidate("u1")
    yield
    bgg_plays_cache.invalidate("u1")


# ── The writes ───────────────────────────────────────────────────────────────

def test_the_sync_writes_no_plays_and_no_play_players():
    store = {"boardgamebuddy_games": [{"id": "g-13", "bgg_id": 13, "name": "Catan"}]}

    with pytest.MonkeyPatch.context() as mp:
        _summary, writes = _run(
            store,
            collection=[(13, "owned", None)],
            plays=[_raw_play(1), _raw_play(2)],
            monkeypatch=mp,
        )

    touched = {t for t, _op, _rows in writes}
    assert "boardgamebuddy_plays" not in touched
    assert "boardgamebuddy_play_players" not in touched
    # It still does its actual job.
    assert "boardgamebuddy_collections" in touched


def test_the_sync_queues_no_kind_play_pending_rows():
    """Plays for a game the catalog lacks used to become pending imports. The
    importer's Games step fetches those on demand now."""
    store = {"boardgamebuddy_games": []}   # nothing resolves

    with pytest.MonkeyPatch.context() as mp:
        summary, writes = _run(
            store,
            collection=[(13, "owned", None)],
            plays=[_raw_play(1, bgg_id=99)],
            monkeypatch=mp,
        )

    queued = [rows for table, _op, rows in writes
              if table == "boardgamebuddy_bgg_pending_imports"]
    kinds = {r["kind"] for batch in queued for r in batch}
    assert kinds == {"collection"}
    # And the play-only game is not promised to the worker either.
    assert summary.unique_games_to_import == 1


# ── The counting ─────────────────────────────────────────────────────────────

def test_plays_new_excludes_what_is_already_here():
    store = {
        "boardgamebuddy_games": [{"id": "g-13", "bgg_id": 13, "name": "Catan"}],
        # No client_key — this is what the retired write path left behind.
        "boardgamebuddy_plays": [{"bgg_play_id": 2, "client_key": None}],
    }

    with pytest.MonkeyPatch.context() as mp:
        summary, _writes = _run(
            store,
            collection=[],
            plays=[_raw_play(1), _raw_play(2), _raw_play(3)],
            monkeypatch=mp,
        )

    assert summary.plays_total == 3
    assert summary.plays_new == 2
    assert summary.plays_read_failed is False


def test_an_unreadable_history_is_not_nothing_new():
    store = {"boardgamebuddy_games": []}

    with pytest.MonkeyPatch.context() as mp:
        summary, _writes = _run(
            store, collection=[], plays=[], monkeypatch=mp, plays_raise=True,
        )

    assert summary.plays_read_failed is True
    assert summary.plays_new == 0 and summary.plays_total == 0


# ── The hand-off to the importer ─────────────────────────────────────────────

def test_a_successful_read_is_parked_for_the_importer():
    store = {"boardgamebuddy_games": []}

    with pytest.MonkeyPatch.context() as mp:
        _run(store, collection=[], plays=[_raw_play(1)], monkeypatch=mp)

    cached = bgg_plays_cache.peek("u1")
    assert cached is not None
    assert [p["bgg_play_id"] for p in cached.plays] == [1]


def test_a_failed_read_is_never_parked():
    """An importer told "nothing new" off a read that never happened is worse
    than one that spends the requests itself."""
    store = {"boardgamebuddy_games": []}

    with pytest.MonkeyPatch.context() as mp:
        _run(store, collection=[], plays=[], monkeypatch=mp, plays_raise=True)

    assert bgg_plays_cache.peek("u1") is None
