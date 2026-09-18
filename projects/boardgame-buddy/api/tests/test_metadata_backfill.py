"""One BGG read fills every field, and the queue it drains actually terminates.

Replaces test_description_backfill.py, test_stats_backfill.py and
test_publisher_backfill.py. Those pinned three endpoints that asked
BoardGameGeek the SAME question — one /thing?stats=1 response carries the
blurb, the four stats, the publisher links and the year — so the catalog was
walked three times to read one document.

Everything they pinned that is still true is carried forward: 20-id chunking, a
throttle between chunks, the limit/remaining pass contract, one bad chunk
counted not fatal, admin-only, and the whole run-ledger narration group.

What is NEW is the part the merge forced a decision on. The three endpoints
disagreed about a game BoardGameGeek has nothing for: stats stamped it,
publishers wrote `[]`, and descriptions deliberately left it NULL "so it keeps
showing in the panel" — which meant that queue never drained and re-requested
the same games on every pass, forever. The resolution is that THE QUEUE IS NOT
THE LIST:

  * the row is stamped and leaves the queue, so a run can finish;
  * the row stays in the list, because the list reads the field predicate;

and those two halves are pinned against each other below, because getting one
without the other is exactly how this was broken before.
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
from routes import game_routes as G  # noqa: E402
from routes import router as bgb_router  # noqa: E402
from routes.constants import AdminRunLevel, AdminRunTool  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402
from routes.services import admin_run_progress as A  # noqa: E402

BASE = "/api/v1/boardgame_buddy/games/admin/backfill-metadata"
LIST = "/api/v1/boardgame_buddy/games/admin/missing-metadata"


class _Query:
    """Minimal PostgREST builder recording writes into `log`.

    `is_`/`not_`/`or_` RECORD their arguments rather than no-opping, because
    the queue predicate is now a thing worth asserting — a migration that adds
    a column the endpoint does not filter on is silent otherwise.
    """

    def __init__(self, name, log, rows, filters):
        self.name, self.log, self.rows, self.filters = name, log, rows, filters
        self._payload = None

    def select(self, *_a, **_k):
        return self

    def is_(self, col, val):
        self.filters.append(f"is:{col}={val}")
        return self

    def or_(self, expr):
        self.filters.append(f"or:{expr}")
        return self

    @property
    def not_(self):
        self.filters.append("not")
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
    def __init__(self, rows, log, filters):
        self.rows, self.log, self.filters = rows, log, filters

    def table(self, name):
        return _Query(name, self.log, self.rows, self.filters)


def _thing_xml(ids, *, unknown=(), no_desc=(), no_year=(), uncredited=()):
    """One /thing?stats=1 response carrying all four field groups.

    The four switches are the four ways BGG can answer thinly, and each one is
    a different outcome in `_meta_cols`.
    """
    items = []
    for i in ids:
        if i in unknown:
            continue                      # BGG knows no such id
        parts = [
            "<statistics><ratings>"
            f"<bayesaverage value='7.{i % 10}'/>"
            f"<ranks><rank type='subtype' name='boardgame' value='{i}'/></ranks>"
            "<averageweight value='2.5'/><owned value='100'/>"
            "</ratings></statistics>",
            f"<name type='primary' value='Game {i}'/>",
        ]
        if i not in no_year:
            parts.append(f"<yearpublished value='{2000 + (i % 20)}'/>")
        if i not in no_desc:
            parts.append(f"<description>Blurb for {i}</description>")
        if i not in uncredited:
            parts.append(f"<link type='boardgamepublisher' value='Publisher {i}'/>")
        items.append(f"<item id='{i}'>{''.join(parts)}</item>")
    return f"<items>{''.join(items)}</items>"


def _row(i, *, desc=None, stats=None, pubs=None, year=None, meta=None):
    """A catalog row. Every field defaults to absent, i.e. queued."""
    return {
        "id": f"g{i}", "bgg_id": 1000 + i, "name": f"Game {i}",
        "description": desc, "bgg_stats_synced_at": stats,
        "publishers": pubs, "year_published": year, "bgg_meta_synced_at": meta,
    }


@pytest.fixture
def client(monkeypatch):
    """50 unsynced games, a fake BGG, a recorded sleep, and an admin identity."""
    cache.clear(A._NS)
    state = {"rows": [_row(i) for i in range(50)], "writes": [], "calls": [],
             "sleeps": [], "filters": [], "fans": []}

    monkeypatch.setattr(G, "get_supabase",
                        lambda: _SB(state["rows"], state["writes"], state["filters"]))
    monkeypatch.setattr(G, "_invalidate_game_caches", lambda *a, **k: None)
    monkeypatch.setattr(G, "_sync_denormalized_game_fields",
                        lambda _sb, gid: state["fans"].append(gid))

    async def fake_fetch_bgg(path, params, **kwargs):
        # stats=1 is the whole point of the merge: a stats=0 call could not
        # carry the ratings, and three calls is what this replaced.
        assert params["stats"] == 1, "the merged sweep must ask for stats"
        state["calls"].append(params["id"])
        return _thing_xml([int(x) for x in str(params["id"]).split(",")], **state.get("xml", {}))

    async def fake_sleep(seconds):
        state["sleeps"].append(seconds)

    monkeypatch.setattr(G, "fetch_bgg", fake_fetch_bgg)
    monkeypatch.setattr(G.asyncio, "sleep", fake_sleep)

    app = FastAPI()
    app.include_router(bgb_router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="admin-1", display_name="Admin", username="admin", is_admin=True
    )
    c = TestClient(app)
    c.state = state
    yield c
    cache.clear(A._NS)


def _payload_for(client, game_id):
    return next(p for gid, p in client.state["writes"] if gid == game_id)


# ── One call, four fields ────────────────────────────────────────────────────

def test_one_bgg_call_per_batch_carries_every_field(client):
    """The whole justification for the merge: three sweeps became one."""
    r = client.post(BASE)
    assert r.status_code == 200
    assert [len(c.split(",")) for c in client.state["calls"]] == [20, 20, 10], (
        "one call per 20 games — and ONE sweep, not three"
    )
    payload = _payload_for(client, "g0")
    assert payload["description"] == "Blurb for 1000"
    assert payload["bgg_rating"] == 7.0 and payload["bgg_rank"] == 1000
    assert payload["bgg_weight"] == 2.5 and payload["bgg_owned_count"] == 100
    assert payload["publishers"] == ["Publisher 1000"]
    assert payload["year_published"] == 2000
    assert payload["bgg_stats_synced_at"] and payload["bgg_meta_synced_at"]


def test_batches_are_spaced_by_the_bgg_throttle(client):
    """Taken from the stats and publisher sweeps, not the description one: that
    ran unthrottled and only got away with it because stats=0 payloads are
    small. Every payload is a stats=1 one now."""
    client.post(BASE)
    assert len(client.state["sleeps"]) == 2, "two gaps for three chunks"
    assert all(s == G.BGG_THROTTLE_SECONDS for s in client.state["sleeps"])


def test_limit_bounds_the_pass_and_remaining_drives_the_next(client):
    body = client.post(BASE, params={"limit": 20}).json()
    assert body["updated"] == 20 and body["remaining"] == 30
    assert len(client.state["calls"]) == 1


def test_a_failing_chunk_is_counted_not_fatal(client, monkeypatch):
    async def boom(_path, params, **_kw):
        if str(params["id"]).startswith("1020"):
            raise RuntimeError("BGG 502")
        return _thing_xml([int(x) for x in str(params["id"]).split(",")])

    monkeypatch.setattr(G, "fetch_bgg", boom)
    body = client.post(BASE).json()
    assert body["updated"] == 30 and body["failed"] == 20


def test_backfill_requires_admin():
    app = FastAPI()
    app.include_router(bgb_router)
    assert TestClient(app).post(BASE).status_code in (401, 403)


# ── The queue terminates; the list does not ──────────────────────────────────

def test_a_game_bgg_has_no_description_for_is_stamped_and_leaves_the_queue(client):
    """The direct reversal of the deleted description test.

    That one asserted the row was left NULL so it "keeps showing in the panel".
    It does still show — see the next test — but it is stamped, so the run can
    finish instead of re-requesting it on every pass forever.
    """
    client.state["rows"] = [_row(0)]
    client.state["xml"] = {"no_desc": (1000,)}
    body = client.post(BASE).json()

    payload = _payload_for(client, "g0")
    assert "description" not in payload, "no blurb is not a reason to write NULL"
    assert payload["bgg_meta_synced_at"], "but it IS stamped"
    assert body["remaining"] == 0, "so the drain stops"


def test_that_same_game_is_still_listed_in_the_panel(client):
    """The other half, and the reason the two predicates differ at all."""
    client.state["rows"] = [_row(0, stats="2026-01-01", pubs=[], year=1999,
                                 meta="2026-01-01")]
    rows = client.get(LIST).json()
    assert [r["id"] for r in rows] == ["g0"]
    assert rows[0]["missing"] == ["description"]
    assert rows[0]["checked_at"], "and it says it has been asked, so it isn't stuck"


def test_a_complete_game_is_in_neither_the_queue_nor_the_list(client):
    client.state["rows"] = [_row(0, desc="x", stats="2026-01-01", pubs=["P"],
                                 year=1999, meta="2026-01-01")]
    assert client.get(LIST).json() == []
    assert client.post(BASE).json()["remaining"] == 0
    assert client.state["calls"] == []


def test_an_id_bgg_does_not_know_is_stamped_but_not_written_empty(client):
    """`publishers: []` was the OLD backfill clearing its own NULL-is-the-queue
    marker. NULL no longer means "never asked", so writing it would be a lie
    about BGG having answered."""
    client.state["rows"] = [_row(0)]
    client.state["xml"] = {"unknown": (1000,)}
    client.post(BASE)
    payload = _payload_for(client, "g0")
    assert payload["bgg_meta_synced_at"]
    assert "publishers" not in payload and "description" not in payload


def test_an_existing_description_is_never_nulled(client):
    """A blurb an admin already has must survive a sweep BGG answers thinly."""
    client.state["rows"] = [_row(0, desc="Written by hand")]
    client.state["xml"] = {"no_desc": (1000,)}
    client.post(BASE)
    assert "description" not in _payload_for(client, "g0")


# ── The year ─────────────────────────────────────────────────────────────────

def test_a_missing_year_is_filled_and_fanned_out(client):
    """The reported bug. The fan-out is this sweep's alone: year_published is in
    COLLECTION_DENORM_GAME_FIELDS and the other three fields are not."""
    client.state["rows"] = [_row(0)]
    client.post(BASE)
    assert _payload_for(client, "g0")["year_published"] == 2000
    assert client.state["fans"] == ["g0"], "collections cache the year"


def test_a_year_we_already_have_is_not_rewritten_or_fanned_out(client):
    """BGG disagreeing with a year an admin holds is not a backfill's to
    arbitrate — and an unconditional fan-out is two extra bulk UPDATEs a row."""
    client.state["rows"] = [_row(0, year=1987)]
    client.post(BASE)
    assert "year_published" not in _payload_for(client, "g0")
    assert client.state["fans"] == []


def test_a_game_bgg_has_no_year_for_still_leaves_the_queue(client):
    client.state["rows"] = [_row(0)]
    client.state["xml"] = {"no_year": (1000,)}
    body = client.post(BASE).json()
    assert "year_published" not in _payload_for(client, "g0")
    assert _payload_for(client, "g0")["bgg_meta_synced_at"]
    assert body["remaining"] == 0


def test_bgg_crediting_nobody_is_an_answer_not_a_gap(client):
    client.state["rows"] = [_row(0)]
    client.state["xml"] = {"uncredited": (1000,)}
    client.post(BASE)
    assert _payload_for(client, "g0")["publishers"] == []


# ── The queue predicate ──────────────────────────────────────────────────────

def test_the_queue_is_the_new_column_and_not_the_retired_ones(client):
    """The one test that catches a migration/endpoint mismatch."""
    client.post(BASE)
    joined = " ".join(client.state["filters"])
    assert "bgg_meta_synced_at.is.null" in joined
    assert "is:bgg_id=null" in joined, "rows with no bgg_id can never be asked"
    for retired in ("is:description=null", "is:bgg_stats_synced_at=null", "is:publishers=null"):
        assert retired not in joined, f"{retired} was a retired queue"


def test_a_stale_incomplete_row_is_asked_about_again(client):
    """Without this the stamp is permanent and a blurb BGG adds next year never
    lands. Bounded by AGE, so a pile of un-fillable rows can never fill a pass
    and stall the drain the way a count-based re-check would."""
    client.state["rows"] = [_row(0, stats="2019-01-01", pubs=[], year=1999,
                                 meta="2019-01-01")]
    assert client.post(BASE).json()["updated"] == 1


def test_a_stale_but_complete_row_is_left_alone(client):
    client.state["rows"] = [_row(0, desc="x", stats="2019-01-01", pubs=["P"],
                                 year=1999, meta="2019-01-01")]
    assert client.post(BASE).json()["updated"] == 0
    assert client.state["calls"] == []


# ── The run log ──────────────────────────────────────────────────────────────

def test_a_pass_narrates_scan_fetch_and_caches(client):
    client.post(BASE)
    snap = A.read(AdminRunTool.BGG_METADATA)
    assert snap["state"] == "done" and snap["started_by"] == "Admin"
    assert [s["key"] for s in snap["steps"]] == ["scan", "fetch", "caches"]
    assert {s["state"] for s in snap["steps"]} == {"done"}
    assert next(s["detail"] for s in snap["steps"] if s["key"] == "scan") == (
        "50 games are missing BGG data"
    )
    fetch = next(s for s in snap["steps"] if s["key"] == "fetch")
    assert (fetch["done"], fetch["total"]) == (3, 3), "one tick per batch"
    assert snap["totals"] == {"updated": 50, "failed": 0, "remaining": 0}


def test_a_scan_that_takes_only_part_of_the_queue_says_so(client):
    client.post(BASE, params={"limit": 20})
    snap = A.read(AdminRunTool.BGG_METADATA)
    assert next(s["detail"] for s in snap["steps"] if s["key"] == "scan") == (
        "50 games are missing BGG data — taking 20 this pass"
    )
    assert snap["totals"]["remaining"] == 30


def test_a_drain_reads_as_one_log_across_its_passes(client):
    first = client.post(BASE, params={"limit": 20}).json()
    assert first["remaining"] == 30
    run_id = A.read(AdminRunTool.BGG_METADATA)["run_id"]

    client.post(BASE, params={"limit": 20, "pass_no": 1})
    snap = A.read(AdminRunTool.BGG_METADATA)
    assert snap["run_id"] == run_id and snap["pass_no"] == 1
    assert sorted({e["pass_no"] for e in snap["events"]}) == [0, 1]
    assert snap["totals"]["updated"] == 40


def test_a_failed_batch_names_the_games_in_it(client, monkeypatch):
    async def boom(_path, params, **_kw):
        if str(params["id"]).startswith("1020"):
            raise RuntimeError("BGG 502")
        return _thing_xml([int(x) for x in str(params["id"]).split(",")])

    monkeypatch.setattr(G, "fetch_bgg", boom)
    client.post(BASE)
    snap = A.read(AdminRunTool.BGG_METADATA)
    errors = [e["message"] for e in snap["events"] if e["level"] == AdminRunLevel.ERROR.value]
    assert errors == ["Batch 2 failed (Game 20, Game 21, Game 22 and 17 more) — BGG 502"]
    assert snap["state"] == "done", "one bad batch does not fail the pass"


def test_the_no_description_batch_warns_rather_than_going_quiet(client):
    """This line IS the replacement for the old NULL-forever visibility, so it
    has to say both halves: stamped, and still listed."""
    client.state["rows"] = [_row(i) for i in range(5)]
    client.state["xml"] = {"no_desc": tuple(1000 + i for i in range(3))}
    client.post(BASE)
    warns = [e["message"] for e in A.read(AdminRunTool.BGG_METADATA)["events"]
             if e["level"] == AdminRunLevel.WARN.value]
    assert len(warns) == 1
    assert "3 of this batch have no description on BoardGameGeek" in warns[0]
    assert "they stay listed" in warns[0]


def test_filled_years_are_named_in_the_log(client):
    """"3 years filled" is not something an admin can go and check."""
    client.state["rows"] = [_row(0), _row(1, year=1999)]
    client.post(BASE)
    infos = [e["message"] for e in A.read(AdminRunTool.BGG_METADATA)["events"]
             if e["level"] == AdminRunLevel.INFO.value]
    assert any(m == "Filled the missing year for Game 0" for m in infos)


def test_an_empty_queue_skips_the_fetch_rather_than_showing_an_empty_counter(client):
    client.state["rows"] = []
    client.post(BASE)
    snap = A.read(AdminRunTool.BGG_METADATA)
    fetch = next(s for s in snap["steps"] if s["key"] == "fetch")
    assert fetch["state"] == "skipped" and fetch["detail"] == "Nothing left to ask about"
    assert next(s["detail"] for s in snap["steps"] if s["key"] == "scan") == (
        "Nothing is missing BGG data"
    )
