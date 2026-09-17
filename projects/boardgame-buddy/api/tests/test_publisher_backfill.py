"""The publisher backfill must batch, throttle, resume, and never re-ask.

Sibling of test_stats_backfill.py, with one property of its own worth pinning:
the queue marker is `publishers IS NULL`, so a game BGG credits to nobody has
to be written as '{}' rather than skipped. Skipping it would leave the column
NULL, put the row straight back in the queue, and mean the admin panel never
empties however many times it is run.

It asks BGG with stats=0: publisher credits are plain <link> rows and the
statistics block is several times the payload for nothing.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routes import game_routes as G  # noqa: E402
from routes import router as bgb_router  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402


class _Query:
    """Minimal PostgREST builder recording writes into `log`."""

    def __init__(self, name, log, rows):
        self.name, self.log, self.rows = name, log, rows
        self._payload = None

    def select(self, *_a, **_k):
        return self

    def is_(self, *_a, **_k):
        return self

    @property
    def not_(self):
        return self

    def eq(self, col, val):
        self._eq = (col, val)
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, lo, hi):
        self._range = (lo, hi)
        return self

    def update(self, payload):
        self._payload = payload
        return self

    def execute(self):
        if self._payload is not None:
            self.log.append((self._eq[1], self._payload))
            return type("R", (), {"data": [{}]})()
        rows = self.rows
        if getattr(self, "_range", None):
            lo, hi = self._range
            rows = rows[lo:hi + 1]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, rows, log):
        self.rows, self.log = rows, log

    def table(self, name):
        return _Query(name, self.log, self.rows)


def _thing_xml(ids, *, skip=(), uncredited=()):
    items = ""
    for i in ids:
        if i in skip:
            continue
        links = (
            ""
            if i in uncredited
            else f"<link type='boardgamedesigner' id='1' value='A Designer'/>"
                 f"<link type='boardgamepublisher' id='2' value='Publisher {i}'/>"
        )
        items += f"<item id='{i}'>{links}</item>"
    return f"<items>{items}</items>"


@pytest.fixture
def client(monkeypatch):
    """50 unsynced games, a fake BGG, a recorded sleep, and an admin identity."""
    rows = [{"id": f"g{i}", "bgg_id": 1000 + i} for i in range(50)]
    writes, calls, sleeps = [], [], []

    monkeypatch.setattr(G, "get_supabase", lambda: _SB(rows, writes))
    monkeypatch.setattr(G, "_invalidate_game_caches", lambda *a, **k: None)

    async def fake_fetch_bgg(path, params, **kwargs):
        assert params["stats"] == 0
        calls.append(params["id"])
        return _thing_xml([int(x) for x in str(params["id"]).split(",")])

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(G, "fetch_bgg", fake_fetch_bgg)
    monkeypatch.setattr(G.asyncio, "sleep", fake_sleep)

    app = FastAPI()
    app.include_router(bgb_router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="admin-1", display_name="Admin", username="admin", is_admin=True
    )
    c = TestClient(app)
    c.writes, c.calls, c.sleeps = writes, calls, sleeps
    return c


BASE = "/api/v1/boardgame_buddy/games/admin/backfill-publishers"


def test_batches_of_twenty_and_a_throttle_between_them(client):
    r = client.post(BASE)
    assert r.status_code == 200
    assert [len(c.split(",")) for c in client.calls] == [20, 20, 10]
    # Two gaps for three chunks: the first goes straight out.
    assert len(client.sleeps) == 2
    assert all(s == G.BGG_THROTTLE_SECONDS for s in client.sleeps)


def test_every_game_is_written_with_its_publishers(client):
    body = client.post(BASE).json()
    assert body["updated"] == 50 and body["failed"] == 0 and body["remaining"] == 0
    game_id, payload = client.writes[0]
    assert game_id == "g0"
    assert payload == {"publishers": ["Publisher 1000"]}


def test_limit_bounds_the_pass_and_remaining_drives_the_next(client):
    body = client.post(f"{BASE}?limit=20").json()
    assert body["updated"] == 20
    assert body["remaining"] == 30
    assert len(client.calls) == 1


def test_a_failing_chunk_is_counted_not_fatal(client, monkeypatch):
    calls = []

    async def flaky(path, params, **kwargs):
        calls.append(params["id"])
        if len(calls) == 2:
            raise RuntimeError("BGG 429")
        return _thing_xml([int(x) for x in str(params["id"]).split(",")])

    monkeypatch.setattr(G, "fetch_bgg", flaky)
    body = client.post(BASE).json()
    assert len(calls) == 3
    assert body["updated"] == 30
    assert body["failed"] == 20


def test_a_game_bgg_omits_is_written_empty_so_it_leaves_the_queue(client, monkeypatch):
    async def partial(path, params, **kwargs):
        ids = [int(x) for x in str(params["id"]).split(",")]
        return _thing_xml(ids, skip={1000})

    monkeypatch.setattr(G, "fetch_bgg", partial)
    body = client.post(f"{BASE}?limit=20").json()
    assert body["updated"] == 20
    # '{}' rather than left NULL: the queue is `publishers IS NULL`, so
    # skipping the write would re-request this row on every pass forever.
    assert dict(client.writes)["g0"] == {"publishers": []}


def test_a_game_bgg_credits_to_nobody_also_leaves_the_queue(client, monkeypatch):
    async def uncredited(path, params, **kwargs):
        ids = [int(x) for x in str(params["id"]).split(",")]
        return _thing_xml(ids, uncredited={1000})

    monkeypatch.setattr(G, "fetch_bgg", uncredited)
    client.post(f"{BASE}?limit=20")
    assert dict(client.writes)["g0"] == {"publishers": []}


def test_backfill_requires_admin():
    app = FastAPI()
    app.include_router(bgb_router)
    assert TestClient(app).post(BASE).status_code in (401, 403)
