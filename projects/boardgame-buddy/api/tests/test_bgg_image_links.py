"""BGG's own image URLs are recorded, and search thumbnails are asked for once.

Two things are pinned here:

  * the image-links backfill: 20 ids per BGG call, every asked-about row
    stamped (even with no art, even unknown to BGG) so the drain terminates,
    and the queue predicate is `bgg_images_synced_at IS NULL`;
  * search thumbnails: catalog and thumb cache answer without BGG, the rest go
    out as ONE /thing call, and BGG's answer — "none" included — is cached so
    the same id is never asked twice. A BGG failure caches nothing.
"""

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cache  # noqa: E402
from routes import game_routes as G  # noqa: E402
from routes import image_link_routes as L  # noqa: E402
from routes import router as bgb_router  # noqa: E402
from routes.constants import AdminRunTool  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402
from routes.services import admin_run_progress as A  # noqa: E402
from routes.services import bgg_thumbnails as T  # noqa: E402

BACKFILL = "/api/v1/boardgame_buddy/games/admin/backfill-image-links"
IMG = "https://cf.geekdo-images.com/{}_image.jpg"
THUMB = "https://cf.geekdo-images.com/{}_thumb.jpg"


# ── A PostgREST stand-in ─────────────────────────────────────────────────────

class _Query:
    def __init__(self, db, name):
        self.db, self.name = db, name
        self._payload = None
        self._upsert = None
        self._in = None
        self._range = None

    def select(self, *_a, **_k):
        return self

    def is_(self, col, val):
        self.db["filters"].append(f"is:{col}={val}")
        return self

    @property
    def not_(self):
        self.db["filters"].append("not")
        return self

    def in_(self, col, vals):
        self._in = (col, list(vals))
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

    def upsert(self, rows, **_k):
        self._upsert = rows
        return self

    def insert(self, row):
        self._upsert = [row]
        return self

    def execute(self):
        table = self.db["tables"].setdefault(self.name, [])
        if self._payload is not None:
            self.db["writes"].append((self._eq[1], self._payload))
            return type("R", (), {"data": [{}]})()
        if self._upsert is not None:
            self.db["upserts"].extend(self._upsert)
            return type("R", (), {"data": self._upsert})()
        rows = table
        if self._in:
            col, vals = self._in
            rows = [r for r in rows if r.get(col) in vals]
        if self._range:
            lo, hi = self._range
            rows = rows[lo:hi + 1]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        return _Query(self.db, name)


def _db(**tables):
    return {"tables": dict(tables), "writes": [], "upserts": [], "filters": []}


def _thing_xml(ids, *, unknown=(), no_art=()):
    items = []
    for i in ids:
        if i in unknown:
            continue
        art = "" if i in no_art else (
            f"<image>{IMG.format(i)}</image><thumbnail>{THUMB.format(i)}</thumbnail>"
        )
        items.append(f"<item id='{i}' type='boardgame'>{art}</item>")
    return f"<items>{''.join(items)}</items>"


# ── The backfill ─────────────────────────────────────────────────────────────

@pytest.fixture
def backfill(monkeypatch):
    cache.clear(A._NS)
    state = {"calls": [], "sleeps": 0, "unknown": set(), "no_art": set(), "boom": False}
    db = _db()
    monkeypatch.setattr(L, "get_supabase", lambda: _SB(db))

    async def fake_fetch(_path, params, **_kw):
        ids = [int(x) for x in str(params["id"]).split(",")]
        state["calls"].append(ids)
        if state["boom"]:
            raise RuntimeError("BoardGameGeek said no")
        return _thing_xml(ids, unknown=state["unknown"], no_art=state["no_art"])

    async def fake_sleep(_s):
        state["sleeps"] += 1

    monkeypatch.setattr(L, "fetch_bgg", fake_fetch)
    monkeypatch.setattr(L.asyncio, "sleep", fake_sleep)

    app = FastAPI()
    app.include_router(bgb_router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="u1", display_name="Dana", username="dana", is_admin=True
    )
    yield state, db, TestClient(app)
    cache.clear(A._NS)


def _games(n):
    return [{"id": f"g{i}", "bgg_id": 100 + i, "name": f"Game {i}"} for i in range(n)]


def test_twenty_ids_per_bgg_call_and_a_throttle_between(backfill):
    state, db, client = backfill
    db["tables"]["boardgamebuddy_games"] = _games(45)
    body = client.post(BACKFILL).json()
    assert body == {"updated": 45, "failed": 0, "remaining": 0}
    assert [len(c) for c in state["calls"]] == [20, 20, 5]
    assert state["sleeps"] == 2, "between chunks, not before the first"


def test_the_queue_is_never_recorded_rows_with_a_bgg_id(backfill):
    _state, db, client = backfill
    db["tables"]["boardgamebuddy_games"] = _games(1)
    client.post(BACKFILL)
    assert "is:bgg_images_synced_at=null" in db["filters"]
    assert "is:bgg_id=null" in db["filters"] and "not" in db["filters"]


def test_it_writes_bggs_urls_and_the_stamp_and_nothing_else(backfill):
    _state, db, client = backfill
    db["tables"]["boardgamebuddy_games"] = _games(1)
    client.post(BACKFILL)
    [(gid, payload)] = db["writes"]
    assert gid == "g0"
    assert payload["bgg_image_url"] == IMG.format(100)
    assert payload["bgg_thumbnail_url"] == THUMB.format(100)
    assert payload["bgg_images_synced_at"]
    assert "image_url" not in payload and "thumbnail_url" not in payload, (
        "recording BGG's links must not touch the art the app renders"
    )


def test_no_art_and_unknown_ids_are_stamped_so_the_drain_ends(backfill):
    state, db, client = backfill
    db["tables"]["boardgamebuddy_games"] = _games(3)
    state["no_art"] = {100}
    state["unknown"] = {101}
    body = client.post(BACKFILL).json()
    assert body == {"updated": 3, "failed": 0, "remaining": 0}
    by_id = dict(db["writes"])
    assert by_id["g0"]["bgg_image_url"] is None and by_id["g0"]["bgg_images_synced_at"]
    assert by_id["g1"]["bgg_thumbnail_url"] is None and by_id["g1"]["bgg_images_synced_at"]
    warns = [e["message"] for e in A.read(AdminRunTool.BGG_IMAGE_LINKS)["events"]
             if e["level"] == "warn"]
    assert any("no art" in w for w in warns)
    assert any("not on BoardGameGeek" in w for w in warns)


def test_limit_bounds_the_pass_and_a_failed_chunk_stays_owed(backfill):
    state, db, client = backfill
    db["tables"]["boardgamebuddy_games"] = _games(30)
    body = client.post(BACKFILL, params={"limit": 25}).json()
    assert body["updated"] == 25 and body["remaining"] == 5
    db["writes"].clear()
    state["boom"] = True
    body = client.post(BACKFILL, params={"limit": 25, "pass_no": 1}).json()
    assert body["updated"] == 0 and body["failed"] == 25
    assert db["writes"] == []


# ── Import records them for free ─────────────────────────────────────────────

def test_import_keeps_bggs_urls_next_to_the_rehosted_ones(monkeypatch):
    calls = []

    async def fake_fetch(_path, params, **_kw):
        calls.append(params)
        return (
            "<items><item id='9' type='boardgame'><name type='primary' value='Nine'/>"
            f"<image>{IMG.format(9)}</image><thumbnail>{THUMB.format(9)}</thumbnail>"
            "</item></items>"
        )

    async def fake_upload(_sb, _bgg_id, _url, kind):
        return f"https://cdn.example.com/9_{kind}.jpg"

    monkeypatch.setattr(G, "fetch_bgg", fake_fetch)
    monkeypatch.setattr(G, "_upload_to_storage", fake_upload)
    monkeypatch.setattr(G, "_invalidate_game_caches", lambda: None)
    db = _db()
    _run(G.import_game_from_bgg(_SB(db), 9))

    assert len(calls) == 1, "the URLs ride the /thing call the import already makes"
    [row] = db["upserts"]
    assert row["image_url"] == "https://cdn.example.com/9_image.jpg"
    assert row["thumbnail_url"] == "https://cdn.example.com/9_thumb.jpg"
    assert row["bgg_image_url"] == IMG.format(9)
    assert row["bgg_thumbnail_url"] == THUMB.format(9)
    assert row["bgg_images_synced_at"]


# ── Search thumbnails ────────────────────────────────────────────────────────

@pytest.fixture
def thumbs(monkeypatch):
    state = {"calls": [], "boom": False}

    async def fake_fetch(_path, params, **_kw):
        ids = [int(x) for x in str(params["id"]).split(",")]
        state["calls"].append(ids)
        if state["boom"]:
            raise RuntimeError("down")
        return _thing_xml(ids, no_art={3})

    monkeypatch.setattr(T, "fetch_bgg", fake_fetch)
    return state


def _run(coro):
    return asyncio.run(coro)


def test_catalog_and_cache_answer_without_asking_bgg(thumbs):
    fresh = datetime.now(timezone.utc).isoformat()
    db = _db(
        boardgamebuddy_games=[{"bgg_id": 1, "thumbnail_url": "https://cdn.example.com/1.jpg"}],
        boardgamebuddy_bgg_thumb_cache=[
            {"bgg_id": 2, "thumbnail_url": THUMB.format(2), "fetched_at": fresh},
            {"bgg_id": 3, "thumbnail_url": None, "fetched_at": fresh},
        ],
    )
    got = _run(T.bgg_thumbnails(_SB(db), [1, 2, 3]))
    assert got == {1: "https://cdn.example.com/1.jpg", 2: THUMB.format(2), 3: None}
    assert thumbs["calls"] == [], "a cached 'BGG has none' is an answer too"


def test_the_rest_is_one_bgg_call_written_through_to_the_cache(thumbs):
    db = _db()
    got = _run(T.bgg_thumbnails(_SB(db), [2, 3, 4]))
    assert thumbs["calls"] == [[2, 3, 4]]
    assert got == {2: THUMB.format(2), 3: None, 4: THUMB.format(4)}
    assert {u["bgg_id"]: u["thumbnail_url"] for u in db["upserts"]} == got


def test_a_stale_cache_row_is_asked_again(thumbs):
    old = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat()
    db = _db(boardgamebuddy_bgg_thumb_cache=[
        {"bgg_id": 5, "thumbnail_url": None, "fetched_at": old},
    ])
    _run(T.bgg_thumbnails(_SB(db), [5]))
    assert thumbs["calls"] == [[5]]


def test_a_bgg_failure_answers_none_and_caches_nothing(thumbs):
    thumbs["boom"] = True
    db = _db()
    got = _run(T.bgg_thumbnails(_SB(db), [7, 8]))
    assert got == {7: None, 8: None}
    assert db["upserts"] == [], "a failure cached as 'none' would hide the art for 90 days"


def test_at_most_twenty_ids_reach_bgg(thumbs):
    _run(T.bgg_thumbnails(_SB(_db()), list(range(100, 150))))
    assert len(thumbs["calls"]) == 1 and len(thumbs["calls"][0]) == T.MAX_IDS
