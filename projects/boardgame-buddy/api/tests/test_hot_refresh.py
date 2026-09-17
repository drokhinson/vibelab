"""The trending refresh writes one run, prunes, and imports within a cap.

What is pinned: one insert carrying one captured_at for the whole list; the
retention delete; at most HOT_IMPORT_PER_RUN imports per run, spaced by the
BGG throttle, with the rest reported as skipped rather than silently dropped;
a failing import is logged and skipped, never fatal; an empty hot list is a
503 that writes nothing (an empty run would make the delta RPC compare against
nothing and read a healthy day as "no movement"); and the read path prefers
the snapshot RPC, only going to BGG live when no run exists.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import cache  # noqa: E402
from routes import game_routes as G  # noqa: E402
from routes.services import discovery_service as D  # noqa: E402


class _Query:
    def __init__(self, name, log, catalog):
        self.name, self.log, self.catalog = name, log, catalog
        self._op = "select"
        self._payload = None
        self._in = None
        self._lt = None

    def select(self, *_a, **_k):
        return self

    def insert(self, rows):
        self._op, self._payload = "insert", rows
        return self

    def delete(self):
        self._op = "delete"
        return self

    def lt(self, col, val):
        self._lt = (col, val)
        return self

    def in_(self, col, vals):
        self._in = (col, set(vals))
        return self

    def eq(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a):
        return self

    def execute(self):
        if self._op == "insert":
            self.log.append(("insert", self.name, self._payload))
            return type("R", (), {"data": self._payload})()
        if self._op == "delete":
            self.log.append(("delete", self.name, self._lt))
            return type("R", (), {"data": [{}, {}]})()   # two stale rows pruned
        rows = self.catalog.get(self.name, [])
        if self._in:
            col, vals = self._in
            rows = [r for r in rows if r.get(col) in vals]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, catalog, rpc=None):
        self.catalog, self.log, self.rpc_answers = catalog, [], (rpc or {})

    def table(self, name):
        return _Query(name, self.log, self.catalog)

    def rpc(self, name, params):
        rows = self.rpc_answers.get(name, [])
        return type("Q", (), {"execute": lambda _s: type("R", (), {"data": rows})()})()


def _hot(n, start=1):
    return [{"bgg_id": 1000 + i, "rank": i, "name": f"Hot {i}", "year_published": 2026, "thumbnail_url": None}
            for i in range(start, start + n)]


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    cache.clear(D._NS)
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(D.asyncio, "sleep", fake_sleep)
    yield sleeps
    cache.clear(D._NS)


def _run(coro):
    return asyncio.run(coro)


def test_one_run_written_old_runs_pruned_imports_capped(monkeypatch, _quiet):
    # 60 hot games, the catalog has the first 45 → 15 missing, cap is 10.
    catalog = {"boardgamebuddy_games": [{"bgg_id": 1000 + i} for i in range(1, 46)]}
    sb = _SB(catalog)
    imported = []

    async def hot(**kw):
        assert kw.get("use_cache") is False   # never the hour-old copy
        return _hot(60)

    async def fake_import(_sb, bgg_id):
        imported.append(bgg_id)
        return {"id": f"g{bgg_id}"}

    monkeypatch.setattr(D, "fetch_hot_games", hot)
    monkeypatch.setattr(G, "import_game_from_bgg", fake_import)
    result = _run(D.refresh_hot_snapshot(sb))

    inserts = [e for e in sb.log if e[0] == "insert"]
    assert len(inserts) == 1 and len(inserts[0][2]) == 60
    assert len({r["captured_at"] for r in inserts[0][2]}) == 1      # one run id
    assert [e for e in sb.log if e[0] == "delete"]                   # retention ran
    assert result.items == 60 and result.pruned == 2
    assert imported == [1000 + i for i in range(46, 56)]              # the first ten missing
    assert result.imported == 10
    assert result.skipped == [1000 + i for i in range(56, 61)]        # the other five, for tomorrow
    assert len(_quiet) == 9                                           # nine gaps for ten imports
    assert all(s == D.BGG_THROTTLE_SECONDS for s in _quiet)


def test_a_failing_import_is_skipped_not_fatal(monkeypatch):
    sb = _SB({"boardgamebuddy_games": []})

    async def hot(**_k):
        return _hot(3)

    async def flaky(_sb, bgg_id):
        if bgg_id == 1002:
            raise RuntimeError("BGG 502")
        return {"id": "x"}

    monkeypatch.setattr(D, "fetch_hot_games", hot)
    monkeypatch.setattr(G, "import_game_from_bgg", flaky)
    result = _run(D.refresh_hot_snapshot(sb))
    assert result.imported == 2 and result.failed == [1002] and result.skipped == []


def test_empty_hot_list_is_503_and_writes_nothing(monkeypatch):
    sb = _SB({"boardgamebuddy_games": []})

    async def down(**_k):
        return []

    monkeypatch.setattr(D, "fetch_hot_games", down)
    with pytest.raises(HTTPException) as exc:
        _run(D.refresh_hot_snapshot(sb))
    assert exc.value.status_code == 503
    assert sb.log == []


def test_refresh_drops_the_viewer_bundle_cache(monkeypatch):
    cache.set(D._NS, "u1", "stale-bundle", ttl_seconds=600)
    sb = _SB({"boardgamebuddy_games": [{"bgg_id": 1001}]})

    async def hot(**_k):
        return _hot(1)

    monkeypatch.setattr(D, "fetch_hot_games", hot)
    _run(D.refresh_hot_snapshot(sb))
    assert cache.get(D._NS, "u1") is None


def test_trending_reads_the_snapshot_first_and_bgg_only_when_empty(monkeypatch):
    live_calls = []

    async def hot(**_k):
        live_calls.append(1)
        return _hot(2)

    monkeypatch.setattr(D, "fetch_hot_games", hot)
    catalog = {"boardgamebuddy_games": [{
        "id": "g1", "bgg_id": 1001, "name": "Hot 1", "is_expansion": False, "play_mode": "competitive",
    }]}
    snap = [{"bgg_id": 1001, "rank": 1, "name": "Hot 1", "year_published": 2026, "thumbnail_url": None,
             "prev_rank": 4, "rank_delta": 3, "is_new": False, "captured_at": "2026-09-17T06:23:00Z"},
            {"bgg_id": 1002, "rank": 2, "name": "Hot 2", "year_published": 2026, "thumbnail_url": None,
             "prev_rank": None, "rank_delta": None, "is_new": True, "captured_at": "2026-09-17T06:23:00Z"}]

    entries, failed = _run(D.fetch_trending(_SB(catalog, {"bgb_bgg_hot_latest": snap})))
    assert failed is False and live_calls == []
    assert [(e.bgg_id, e.rank_delta, e.is_new, e.game is not None) for e in entries] == [
        (1001, 3, False, True), (1002, None, True, False),
    ]

    # No run yet: live, with no deltas.
    entries, failed = _run(D.fetch_trending(_SB(catalog)))
    assert failed is False and live_calls == [1]
    assert all(e.rank_delta is None and e.is_new is False for e in entries)


# ── The route: an admin session or the service key ──────────────────────────
# The daily cron has no user, only the key already used to promote admins.

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routes import dependencies as DEP  # noqa: E402
from routes import discovery_routes  # noqa: E402
from routes import router as bgb_router  # noqa: E402
from routes.models import HotRefreshResult  # noqa: E402

URL = "/api/v1/boardgame_buddy/discover/admin/refresh-trending"


@pytest.fixture
def route_client(monkeypatch):
    monkeypatch.setattr(DEP, "ADMIN_API_KEY", "svc-key")

    async def fake_refresh(_sb):
        from datetime import datetime, timezone
        return HotRefreshResult(captured_at=datetime.now(timezone.utc), items=50, imported=3)

    monkeypatch.setattr(discovery_routes.discovery_service, "refresh_hot_snapshot", fake_refresh)
    monkeypatch.setattr(discovery_routes, "get_supabase", lambda: object())
    app = FastAPI()
    app.include_router(bgb_router)
    return TestClient(app)


def test_service_key_bearer_runs_the_refresh(route_client):
    r = route_client.post(URL, headers={"Authorization": "Bearer svc-key"})
    assert r.status_code == 200
    assert r.json()["items"] == 50 and r.json()["imported"] == 3


def test_wrong_key_and_no_auth_are_refused(route_client):
    assert route_client.post(URL, headers={"Authorization": "Bearer nope"}).status_code in (401, 403)
    assert route_client.post(URL).status_code in (401, 403)
