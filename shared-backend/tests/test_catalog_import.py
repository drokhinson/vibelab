"""kind='catalog' must import the GAME and nothing else.

POST /bgg/check queues these so a game on the user's BGG shelf that BgB has
never seen can be listed by name in the comparison. If the worker also wrote a
collection row, that game would stop reading as "only on BGG" and the push would
silently stop offering to clear it — the mirror would quietly reverse. There is
no branch in the worker enforcing this; it falls out of the bulk path filtering
on kind, which is exactly the kind of implicit behaviour worth pinning down.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio

import pytest

from routes.boardgame_buddy import bgg_link_routes as L


class _Table:
    def __init__(self, name, log, rows):
        self.name, self.log, self.rows = name, log, rows
        self._pending = True
    def select(self, *_a, **_k): return self
    def eq(self, col, val):
        if (col, val) == ("status", "done"):
            self._pending = False
        return self
    def in_(self, *_a, **_k): return self
    def order(self, *_a, **_k): return self
    def limit(self, *_a, **_k): return self
    def update(self, payload):
        self.log.append((self.name, "update", payload))
        return self
    def upsert(self, payload, **_k):
        self.log.append((self.name, "upsert", payload))
        return self
    def insert(self, payload, **_k):
        self.log.append((self.name, "insert", payload))
        return self
    def delete(self):
        self.log.append((self.name, "delete", None))
        return self
    def execute(self):
        return type("R", (), {"data": self.rows.pop(0) if self.rows else []})()


class _SB:
    def __init__(self, log, queues):
        self.log, self.queues = log, queues
    def table(self, name):
        return _Table(name, self.log, self.queues.setdefault(name, []))


@pytest.fixture
def worker(monkeypatch):
    log = []
    # One pending catalog row, then an empty page so the loop terminates.
    queues = {
        "boardgamebuddy_bgg_pending_imports": [
            [{"id": "r1", "bgg_id": 266192, "kind": "catalog", "payload": {}, "attempts": 0}],
            [],
        ],
        "boardgamebuddy_collections": [[]],
    }
    sb = _SB(log, queues)
    monkeypatch.setattr(L, "get_supabase", lambda: sb)

    async def fake_import(_sb, bgg_id):
        log.append(("bgg", "import_game_from_bgg", bgg_id))
        return {"id": "game-uuid", "bgg_id": bgg_id, "name": "Wingspan"}
    monkeypatch.setattr(L, "import_game_from_bgg", fake_import)

    async def no_sleep(_s): return None
    monkeypatch.setattr(L.asyncio, "sleep", no_sleep)

    asyncio.run(L._process_pending_imports("u1"))
    return log


def test_the_game_itself_is_imported(worker):
    assert ("bgg", "import_game_from_bgg", 266192) in worker


def test_no_collection_row_is_written(worker):
    """The whole point. A shelf row here would reverse the mirror."""
    touched = {name for name, _op, _p in worker}
    assert "boardgamebuddy_collections" not in touched


def test_no_play_row_is_written(worker):
    touched = {name for name, _op, _p in worker}
    assert "boardgamebuddy_plays" not in touched
    assert "boardgamebuddy_play_players" not in touched


def test_the_queue_row_is_marked_done(worker):
    updates = [p for n, op, p in worker
               if n == "boardgamebuddy_bgg_pending_imports" and op == "update"]
    assert any(u.get("status") == "done" for u in updates), updates


def test_it_is_not_marked_errored(worker):
    updates = [p for n, op, p in worker
               if n == "boardgamebuddy_bgg_pending_imports" and op == "update"]
    assert not any(u.get("status") == "error" for u in updates), updates


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
