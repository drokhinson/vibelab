"""The description backfill must batch its BGG calls, and must be resumable.

The catalog seeds from BGG's top ~1000 games, so on a cold run every row needs
a description. One BGG call per game at ~1.5s each is 25 minutes — it would die
on the platform request timeout with the catalog half-filled. So the endpoint
issues one /thing call per 20 games and caps each pass at `limit`, reporting
`remaining` so the admin panel can drive it to completion.

Both properties are invisible in the response body of a single happy-path call,
which is exactly why they're pinned here.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routes.boardgame_buddy import game_routes as G  # noqa: E402
from routes.boardgame_buddy import router as bgb_router  # noqa: E402
from routes.boardgame_buddy.dependencies import CurrentUser, get_current_admin  # noqa: E402


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

    def update(self, payload):
        self._payload = payload
        return self

    def execute(self):
        if self._payload is not None:
            self.log.append((self._eq[1], self._payload))
            return type("R", (), {"data": [{}]})()
        return type("R", (), {"data": self.rows})()


class _SB:
    def __init__(self, rows, log):
        self.rows, self.log = rows, log

    def table(self, name):
        return _Query(name, self.log, self.rows)


def _thing_xml(ids):
    items = "".join(
        f"<item id='{i}'><description>Blurb for {i}.&amp;#10;&amp;#10;More.</description></item>"
        for i in ids
    )
    return f"<items>{items}</items>"


@pytest.fixture
def client(monkeypatch):
    """50 description-less games, a fake BGG, and an admin identity."""
    rows = [{"id": f"g{i}", "bgg_id": 1000 + i} for i in range(50)]
    writes = []
    calls = []

    monkeypatch.setattr(G, "get_supabase", lambda: _SB(rows, writes))
    monkeypatch.setattr(G, "_invalidate_game_caches", lambda *a, **k: None)

    async def fake_fetch_bgg(path, params, **kwargs):
        calls.append(params["id"])
        return _thing_xml([int(x) for x in str(params["id"]).split(",")])

    monkeypatch.setattr(G, "fetch_bgg", fake_fetch_bgg)

    app = FastAPI()
    app.include_router(bgb_router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="admin-1", display_name="Admin", username="admin", is_admin=True
    )
    c = TestClient(app)
    c.writes, c.calls = writes, calls
    return c


BASE = "/api/v1/boardgame_buddy/games/admin/backfill-descriptions"


def test_bgg_is_called_once_per_twenty_games_not_once_per_game(client):
    r = client.post(BASE)
    assert r.status_code == 200
    # 50 games -> 3 chunks (20/20/10), NOT 50 calls. This is the whole point.
    assert len(client.calls) == 3
    assert [len(c.split(",")) for c in client.calls] == [20, 20, 10]


def test_every_game_gets_its_own_description_written(client):
    client.post(BASE)
    assert len(client.writes) == 50
    # Writes are keyed by game id and carry the parsed, unescaped text.
    game_id, payload = client.writes[0]
    assert game_id == "g0"
    assert payload["description"] == "Blurb for 1000.\n\nMore."


def test_limit_bounds_the_pass_and_remaining_drives_the_next_one(client):
    r = client.post(f"{BASE}?limit=20")
    body = r.json()
    assert body["updated"] == 20
    assert body["failed"] == 0
    # 50 missing, 20 done -> the panel must come back for 30 more.
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
    # The run continued past the bad chunk instead of aborting at 20.
    assert len(calls) == 3
    assert body["updated"] == 30
    assert body["failed"] == 20


def test_a_game_bgg_has_no_blurb_for_is_left_null(client, monkeypatch):
    async def blank(path, params, **kwargs):
        ids = [int(x) for x in str(params["id"]).split(",")]
        items = "".join(f"<item id='{i}'><description></description></item>" for i in ids)
        return f"<items>{items}</items>"

    monkeypatch.setattr(G, "fetch_bgg", blank)
    body = client.post(BASE).json()
    # Nothing written, and the games stay in the panel rather than silently
    # vanishing into a stored empty string.
    assert client.writes == []
    assert body["updated"] == 0
    assert body["remaining"] == 50


def test_backfill_requires_admin():
    app = FastAPI()
    app.include_router(bgb_router)
    assert TestClient(app).post(BASE).status_code in (401, 403)


# ── Admin review counts ──────────────────────────────────────────────────────
# The Settings gear's dot is painted on every boot for every admin, so this
# endpoint must stay ONE round trip returning counts — not three, and not lists
# the client counts itself.


class _CountQuery:
    def __init__(self, name, counts, log):
        self.name, self.counts, self.log = name, counts, log
        self._filters = []

    def select(self, *_a, **kw):
        self.log.append(("select", self.name, kw.get("count")))
        return self

    def eq(self, col, val):
        self._filters.append(f"{col}={val}")
        return self

    def is_(self, col, val):
        self._filters.append(f"{col} is {val}")
        return self

    def or_(self, expr):
        self._filters.append(f"or({expr})")
        return self

    def limit(self, *_a):
        return self

    def execute(self):
        key = (self.name, ",".join(sorted(self._filters)))
        return type("R", (), {"data": [], "count": self.counts.get(key, 0)})()


@pytest.fixture
def counts_client(monkeypatch):
    log = []
    counts = {
        ("boardgamebuddy_chapter_reports", "status=open"): 2,
        ("boardgamebuddy_games", "or(image_url.is.null,thumbnail_url.is.null)"): 5,
        ("boardgamebuddy_games", "description is null"): 40,
    }

    class _SB:
        def table(self, name):
            return _CountQuery(name, counts, log)

    from routes.boardgame_buddy import admin_routes as A

    monkeypatch.setattr(A, "get_supabase", lambda: _SB())
    app = FastAPI()
    app.include_router(bgb_router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="admin-1", display_name="Admin", username="admin", is_admin=True
    )
    c = TestClient(app)
    c.log = log
    return c


COUNTS_URL = "/api/v1/boardgame_buddy/admin/review-counts"


def test_review_counts_reports_each_queue(counts_client):
    body = counts_client.get(COUNTS_URL).json()
    assert body["chapter_reports"] == 2
    assert body["missing_images"] == 5
    assert body["missing_descriptions"] == 40


def test_review_counts_total_is_derived_not_sent(counts_client):
    # Computed server-side so the gear's dot and the per-row badges can never
    # disagree about whether there is anything waiting.
    assert counts_client.get(COUNTS_URL).json()["total"] == 47


def test_review_counts_uses_exact_count_not_row_fetches(counts_client):
    counts_client.get(COUNTS_URL)
    selects = [row for row in counts_client.log if row[0] == "select"]
    assert len(selects) == 3
    # Every one asks PostgREST for the count header rather than the rows.
    assert all(row[2] == "exact" for row in selects), selects


def test_review_counts_requires_admin():
    app = FastAPI()
    app.include_router(bgb_router)
    assert TestClient(app).get(COUNTS_URL).status_code in (401, 403)
