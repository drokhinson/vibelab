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

import cache  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routes import game_routes as G  # noqa: E402
from routes import router as bgb_router  # noqa: E402
from routes.constants import AdminRunLevel, AdminRunTool  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402
from routes.services import admin_run_progress as A  # noqa: E402


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
    # `name` rides along because the run log names what it is working on — a
    # line reading "g13 failed" is one an admin has to go and decode.
    rows = [{"id": f"g{i}", "bgg_id": 1000 + i, "name": f"Game {i}"} for i in range(50)]
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


# ── The run log ──────────────────────────────────────────────────────────────
# A cold catalog is up to twenty-five of these calls, and the panel used to
# show "N done, M left" inside a button between them. These pin that the ledger
# turns those calls into one readable log.

@pytest.fixture(autouse=True)
def _clean_run_log():
    cache.clear(A._NS)
    yield
    cache.clear(A._NS)


def test_a_pass_narrates_scan_fetch_and_caches(client):
    client.post(BASE)
    snap = A.read(AdminRunTool.BGG_STATS)
    assert snap["state"] == "done"
    assert snap["started_by"] == "Admin"
    assert [s["key"] for s in snap["steps"]] == ["scan", "fetch", "caches"]
    assert {s["state"] for s in snap["steps"]} == {"done"}
    assert next(s["detail"] for s in snap["steps"] if s["key"] == "scan") == (
        "50 games are missing BGG stats"
    )
    fetch = next(s for s in snap["steps"] if s["key"] == "fetch")
    assert (fetch["done"], fetch["total"]) == (3, 3), "one tick per batch"
    assert [e["message"] for e in snap["events"]] == [
        "Batch 1 of 3 — 20 of 20 saved",
        "Batch 2 of 3 — 20 of 20 saved",
        "Batch 3 of 3 — 10 of 10 saved",
    ]
    assert snap["totals"] == {"updated": 50, "failed": 0, "remaining": 0}


def test_a_scan_that_takes_only_part_of_the_queue_says_so(client):
    client.post(BASE, params={"limit": 20})
    snap = A.read(AdminRunTool.BGG_STATS)
    assert next(s["detail"] for s in snap["steps"] if s["key"] == "scan") == (
        "50 games are missing BGG stats — taking 20 this pass"
    )
    assert snap["totals"]["remaining"] == 30


def test_a_drain_reads_as_one_log_across_its_passes(client, monkeypatch):
    """The whole point of the pass counter: twenty-five requests, one run."""
    first = client.post(BASE, params={"limit": 20}).json()
    assert first["remaining"] == 30
    run_id = A.read(AdminRunTool.BGG_STATS)["run_id"]

    client.post(BASE, params={"limit": 20, "pass_no": 1})
    snap = A.read(AdminRunTool.BGG_STATS)

    assert snap["run_id"] == run_id, "still the same run"
    assert snap["pass_no"] == 1
    assert sorted({e["pass_no"] for e in snap["events"]}) == [0, 1]
    assert snap["totals"]["updated"] == 40, "totals accumulate across passes"
    # The checklist restarted for the new pass; the log below it did not.
    assert {s["state"] for s in snap["steps"]} == {"done"}


def test_a_failed_batch_names_the_games_in_it(client, monkeypatch):
    async def boom(_path, params, **_kw):
        if str(params["id"]).startswith("1020"):
            raise RuntimeError("BGG 502")
        return _thing_xml([int(x) for x in str(params["id"]).split(",")])

    monkeypatch.setattr(G, "fetch_bgg", boom)
    body = client.post(BASE).json()
    assert body["updated"] == 30 and body["failed"] == 20

    snap = A.read(AdminRunTool.BGG_STATS)
    errors = [e["message"] for e in snap["events"] if e["level"] == AdminRunLevel.ERROR.value]
    assert errors == [
        "Batch 2 failed (Game 20, Game 21, Game 22 and 17 more) — BGG 502"
    ]
    assert snap["state"] == "done", "one bad batch does not fail the pass"


def test_games_bgg_has_no_stats_for_get_a_warning_not_silence(client, monkeypatch):
    """They are stamped and leave the queue, so the count moves while the
    catalog gains nothing — which looks like a bug unless the log says."""
    async def partial(_path, params, **_kw):
        ids = [int(x) for x in str(params["id"]).split(",")]
        return _thing_xml(ids, skip=ids[:5])

    monkeypatch.setattr(G, "fetch_bgg", partial)
    client.post(BASE, params={"limit": 20})

    snap = A.read(AdminRunTool.BGG_STATS)
    warns = [e["message"] for e in snap["events"] if e["level"] == AdminRunLevel.WARN.value]
    assert warns == [
        "5 of this batch have no stats on BoardGameGeek — stamped so they leave the queue"
    ]


def test_an_empty_queue_skips_the_fetch_rather_than_showing_an_empty_counter(client, monkeypatch):
    monkeypatch.setattr(G, "get_supabase", lambda: _SB([], []))
    client.post(BASE)
    snap = A.read(AdminRunTool.BGG_STATS)
    fetch = next(s for s in snap["steps"] if s["key"] == "fetch")
    assert fetch["state"] == "skipped" and fetch["detail"] == "Nothing left to fetch"
    assert next(s["detail"] for s in snap["steps"] if s["key"] == "scan") == (
        "Nothing is missing BGG stats"
    )
