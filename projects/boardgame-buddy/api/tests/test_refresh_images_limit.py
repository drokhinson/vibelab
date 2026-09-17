"""The image re-host is bounded, and says how much is left.

This endpoint used to page the WHOLE catalog in one request — one BGG call plus
two downloads and two uploads per needy game, spaced by the BGG throttle. On a
cold thousand-game catalog that is well past half an hour, so it died on the
platform's request timeout with the work half done; and because it reported no
`remaining`, the admin panel's drain loop (which breaks on a falsy one) ran it
exactly once and offered no way to continue.

What is pinned: the queue is the games that NEED work (missing OR still
BGG-hosted), `limit` bounds one pass, `remaining` counts that queue rather than
the catalog, a row needing nothing costs neither a BGG call nor a throttle
sleep, and one bad game does not sink the pass.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cache  # noqa: E402
import routes  # noqa: E402
from routes import game_routes as G  # noqa: E402
from routes.constants import AdminRunTool  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402
from routes.services import admin_run_progress as A  # noqa: E402

URL = "/api/v1/boardgame_buddy/games/refresh-images"

R2 = "https://cdn.example.com/g.jpg"
BGG = "https://cf.geekdo-images.com/g.jpg"


_DEFAULT = object()


def _row(n, image=None, thumb=None, bgg_id=_DEFAULT):
    # A sentinel, not None: `bgg_id=None` is a real case here (a game BGG has
    # never heard of), so it cannot double as "caller didn't say".
    return {
        "id": f"id-{n}",
        "bgg_id": 1000 + n if bgg_id is _DEFAULT else bgg_id,
        "name": f"Game {n}",
        "image_url": image,
        "thumbnail_url": thumb,
    }


class _Query:
    def __init__(self, rows, writes):
        self.rows, self.writes = rows, writes
        self._payload = None
        self._range = None

    def select(self, *_a, **_k):
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
            self.writes.append((self._eq[1], self._payload))
            return type("R", (), {"data": [{}]})()
        rows = self.rows
        if self._range:
            lo, hi = self._range
            rows = rows[lo:hi + 1]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, rows, writes):
        self.rows, self.writes = rows, writes

    def table(self, _name):
        return _Query(self.rows, self.writes)


@pytest.fixture
def harness(monkeypatch):
    cache.clear(A._NS)
    state = {"rows": [], "writes": [], "fetched": [], "sleeps": 0, "boom": set()}

    monkeypatch.setattr(G, "get_supabase", lambda: _SB(state["rows"], state["writes"]))

    async def fake_fetch_bgg(_path, params, **_kw):
        bgg_id = int(params["id"])
        state["fetched"].append(bgg_id)
        if bgg_id in state["boom"]:
            raise RuntimeError("BoardGameGeek said no")
        return (
            f"<items><item id='{bgg_id}'><image>{BGG}</image>"
            f"<thumbnail>{BGG}</thumbnail></item></items>"
        )

    async def fake_sleep(_s):
        state["sleeps"] += 1

    async def fake_upload(_sb, _bgg_id, _url, _kind):
        return R2

    monkeypatch.setattr(G, "fetch_bgg", fake_fetch_bgg)
    monkeypatch.setattr(G.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(G, "_upload_to_storage", fake_upload)
    monkeypatch.setattr(G, "_sync_denormalized_game_fields", lambda *_a: None)
    monkeypatch.setattr(G, "_invalidate_game_caches", lambda: None)

    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="u1", display_name="Dana", username="dana", is_admin=True
    )
    yield state, TestClient(app)
    cache.clear(A._NS)


# ── The queue ────────────────────────────────────────────────────────────────

def test_a_row_already_hosted_by_us_is_not_in_the_queue(harness):
    state, client = harness
    state["rows"] = [_row(1, image=R2, thumb=R2)]
    body = client.post(URL).json()
    assert body == {"updated": 0, "failed": 0, "remaining": 0}
    assert state["fetched"] == [], "no BGG call for a row needing nothing"
    assert state["sleeps"] == 0, "and no throttle sleep either"


@pytest.mark.parametrize("image, thumb", [
    (None, R2),      # no box art
    (R2, None),      # no thumbnail
    (BGG, R2),       # still hotlinking BGG
    (R2, BGG),
])
def test_missing_or_bgg_hosted_counts_as_needing_work(harness, image, thumb):
    state, client = harness
    state["rows"] = [_row(1, image=image, thumb=thumb)]
    assert client.post(URL).json()["updated"] == 1


def test_a_row_with_no_bgg_id_is_skipped_rather_than_retried_forever(harness):
    state, client = harness
    state["rows"] = [_row(1, bgg_id=None)]
    body = client.post(URL).json()
    assert body["updated"] == 0 and body["remaining"] == 0
    assert state["fetched"] == []


# ── Bounding and draining ────────────────────────────────────────────────────

def test_limit_bounds_the_pass_and_remaining_counts_the_queue(harness):
    state, client = harness
    state["rows"] = [_row(n) for n in range(10)] + [_row(99, image=R2, thumb=R2)]
    body = client.post(URL, params={"limit": 4}).json()
    assert body["updated"] == 4
    # Ten needy games, four done: six left. NOT eleven-minus-four — the row
    # that needed nothing was never in the queue.
    assert body["remaining"] == 6
    assert len(state["fetched"]) == 4


def test_a_drain_ends_when_remaining_reaches_zero(harness):
    """The panel's loop breaks on a falsy `remaining`; the last pass has to
    produce one or the drain never stops."""
    state, client = harness
    state["rows"] = [_row(n) for n in range(5)]
    seen = []
    for pass_no in range(5):
        body = client.post(URL, params={"limit": 2, "pass_no": pass_no}).json()
        seen.append(body["remaining"])
        # The rows the real endpoint would have updated leave the queue.
        for gid, _payload in state["writes"]:
            for row in state["rows"]:
                if row["id"] == gid:
                    row["image_url"] = row["thumbnail_url"] = R2
        state["writes"].clear()
        if not body["remaining"]:
            break
    assert seen == [3, 1, 0]


# ── Failure ──────────────────────────────────────────────────────────────────

def test_one_bad_game_is_counted_and_the_pass_continues(harness):
    state, client = harness
    state["rows"] = [_row(n) for n in range(3)]
    state["boom"] = {1001}
    body = client.post(URL).json()
    assert body["updated"] == 2 and body["failed"] == 1
    assert body["remaining"] == 1, "the one that failed is still owed"


def test_the_run_log_names_the_game_that_failed(harness):
    state, client = harness
    state["rows"] = [_row(n) for n in range(3)]
    state["boom"] = {1001}
    client.post(URL)

    snap = A.read(AdminRunTool.BGG_IMAGES)
    assert snap["state"] == "done"
    assert snap["totals"] == {"updated": 2, "failed": 1, "remaining": 1}
    errors = [e["message"] for e in snap["events"] if e["level"] == "error"]
    assert errors == ["Game 1 — BoardGameGeek said no"], (
        "a log line reading 'id-1 failed' is one an admin has to go and decode"
    )
    assert "Re-hosted Game 0" in [e["message"] for e in snap["events"]]
    scan = next(s for s in snap["steps"] if s["key"] == "scan")
    assert scan["detail"] == "3 games are missing an image we host"
