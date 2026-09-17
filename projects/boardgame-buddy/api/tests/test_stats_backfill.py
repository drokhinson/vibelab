"""The BGG stats backfill must batch, throttle, resume, and never re-ask.

Sibling of test_description_backfill.py, with two properties of its own.
A stats=1 record is several times the size of a stats=0 one and the BGG client
has no rate-limit guard, so the chunks must be SPACED as well as sequential —
a cold 50-chunk run at full speed is how the app gets 429'd for everyone. And
a game BGG carries no statistics for must still be stamped as synced, or it
sits in the queue and is re-requested on every pass forever.
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


def _thing_xml(ids, *, skip=()):
    items = "".join(
        f"<item id='{i}'><statistics><ratings><bayesaverage value='7.{i % 10}'/>"
        f"<ranks><rank type='subtype' name='boardgame' value='{i}'/></ranks>"
        f"<averageweight value='2.5'/><owned value='100'/></ratings></statistics></item>"
        for i in ids if i not in skip
    )
    return f"<items>{items}</items>"


@pytest.fixture
def client(monkeypatch):
    """50 unsynced games, a fake BGG, a recorded sleep, and an admin identity."""
    rows = [{"id": f"g{i}", "bgg_id": 1000 + i} for i in range(50)]
    writes, calls, sleeps = [], [], []

    monkeypatch.setattr(G, "get_supabase", lambda: _SB(rows, writes))
    monkeypatch.setattr(G, "_invalidate_game_caches", lambda *a, **k: None)

    async def fake_fetch_bgg(path, params, **kwargs):
        assert params["stats"] == 1
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


BASE = "/api/v1/boardgame_buddy/games/admin/backfill-stats"


def test_batches_of_twenty_and_a_throttle_between_them(client):
    r = client.post(BASE)
    assert r.status_code == 200
    assert [len(c.split(",")) for c in client.calls] == [20, 20, 10]
    # Two gaps for three chunks: the first goes straight out.
    assert len(client.sleeps) == 2
    assert all(s == G.BGG_THROTTLE_SECONDS for s in client.sleeps)


def test_every_game_is_stamped_with_its_stats(client):
    body = client.post(BASE).json()
    assert body["updated"] == 50 and body["failed"] == 0 and body["remaining"] == 0
    game_id, payload = client.writes[0]
    assert game_id == "g0"
    assert payload["bgg_rating"] == 7.0
    assert payload["bgg_rank"] == 1000
    assert payload["bgg_weight"] == 2.5
    assert payload["bgg_owned_count"] == 100
    assert payload["bgg_stats_synced_at"]


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


def test_a_game_bgg_omits_is_still_stamped_so_it_leaves_the_queue(client, monkeypatch):
    async def partial(path, params, **kwargs):
        ids = [int(x) for x in str(params["id"]).split(",")]
        return _thing_xml(ids, skip={1000})

    monkeypatch.setattr(G, "fetch_bgg", partial)
    body = client.post(f"{BASE}?limit=20").json()
    assert body["updated"] == 20
    stamped = dict(client.writes)["g0"]
    # Nothing to store, but the marker is set: this row will not be asked
    # for again on the next pass.
    assert stamped["bgg_rating"] is None and stamped["bgg_rank"] is None
    assert stamped["bgg_stats_synced_at"]


def test_backfill_requires_admin():
    app = FastAPI()
    app.include_router(bgb_router)
    assert TestClient(app).post(BASE).status_code in (401, 403)
