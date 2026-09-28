"""The played mark (migration 057): "played it, somewhere I didn't log it".

One mark on any game, stored as played_before_at on the game's collection row
whatever its status; a game on no shelf holds it on a status 'played' row. The
SQL half (which games land on the Played shelf, the status map's marks,
search) is exercised against Postgres by db/tests/057_played_mark.sql. Pinned
here is what the API decides:

  * setting the mark stamps any row, keeping an existing stamp, and creates a
    'played' row for a game on no shelf (404 for an unknown game);
  * clearing it deletes a 'played' row and only un-stamps any other;
  * 'played' is not a shelf status: POST/PATCH refuse it;
  * a shelf change never names played_before_at, so the mark survives it;
  * removing a marked game from its shelf keeps the row as 'played';
  * the status map carries every mark;
  * search's fallback path does not count a 'played' row as a collection hit.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from routes import collection_routes as R  # noqa: E402
from routes.dependencies import CurrentUser  # noqa: E402
from routes.services import search_service as SS  # noqa: E402

ME = "00000000-0000-0000-0000-00000000000a"
GAME = "11111111-0000-0000-0000-000000000001"
USER = CurrentUser(user_id=ME, display_name="Me", username="me", is_admin=False)
STAMP = "2026-01-01T00:00:00+00:00"


class _Q:
    def __init__(self, sb, table):
        self.sb, self.table, self.filters, self.not_eq = sb, table, {}, {}
        self.op, self.payload = "select", None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self.filters[col] = val
        return self

    def neq(self, col, val):
        self.not_eq[col] = val
        return self

    def ilike(self, *_a):
        return self

    def limit(self, _n):
        return self

    def upsert(self, row, on_conflict=None):
        self.op, self.payload = "upsert", row
        return self

    def insert(self, row):
        self.op, self.payload = "insert", row
        return self

    def update(self, row):
        self.op, self.payload = "update", row
        return self

    def delete(self):
        self.op = "delete"
        return self

    def _match(self, r):
        return (all(r.get(k) == v for k, v in self.filters.items())
                and all(r.get(k) != v for k, v in self.not_eq.items()))

    def execute(self):
        rows = self.sb.rows
        if self.table == "boardgamebuddy_games":
            data = [{"id": GAME, "name": "Azul"}] if self.sb.game_exists else []
            return type("R", (), {"data": data})()
        if self.op == "upsert":
            hit = [r for r in rows if r["game_id"] == self.payload["game_id"]]
            if hit:
                hit[0].update(self.payload)
            else:
                rows.append(dict(self.payload))
            self.sb.writes.append(("upsert", self.payload))
        elif self.op == "insert":
            rows.append(dict(self.payload))
            self.sb.writes.append(("insert", self.payload))
        elif self.op == "update":
            for r in rows:
                if self._match(r):
                    r.update(self.payload)
            self.sb.writes.append(("update", self.payload))
        elif self.op == "delete":
            self.sb.rows[:] = [r for r in rows if not self._match(r)]
            self.sb.writes.append(("delete", None))
        else:
            return type("R", (), {"data": [r for r in rows if self._match(r)]})()
        return type("R", (), {"data": []})()


class _SB:
    def __init__(self, rows=(), game_exists=True):
        self.rows = [dict(r) for r in rows]
        self.writes, self.rpc_payload = [], {}
        self.game_exists = game_exists

    def table(self, name):
        return _Q(self, name)

    def rpc(self, _name, _params):
        payload = self.rpc_payload
        return type("P", (), {"execute": lambda _s: type("R", (), {"data": payload})()})()


def _row(status, stamp=None):
    return {"user_id": ME, "game_id": GAME, "status": status, "played_before_at": stamp}


@pytest.fixture(autouse=True)
def denorm(monkeypatch):
    monkeypatch.setattr(R, "collection_denormalized_from_game", lambda g: {"game_name": g["name"]})


# ── Setting the mark ─────────────────────────────────────────────────────────

def test_a_game_on_no_shelf_gets_a_played_row():
    sb = _SB()
    R._set_played_mark(sb, ME, GAME, True)
    (row,) = sb.rows
    assert row["status"] == "played"
    assert row["played_before_at"]
    assert row["game_name"] == "Azul"


def test_an_unknown_game_is_a_404():
    sb = _SB(game_exists=False)
    with pytest.raises(HTTPException) as e:
        R._set_played_mark(sb, ME, GAME, True)
    assert e.value.status_code == 404
    assert sb.rows == []


@pytest.mark.parametrize("status", ["owned", "prev_owned", "wishlist"])
def test_any_shelf_status_takes_the_mark_and_keeps_its_status(status):
    sb = _SB([_row(status)])
    R._set_played_mark(sb, ME, GAME, True)
    (row,) = sb.rows
    assert row["status"] == status
    assert row["played_before_at"]


def test_an_existing_stamp_is_kept():
    sb = _SB([_row("owned", STAMP)])
    R._set_played_mark(sb, ME, GAME, True)
    assert sb.rows[0]["played_before_at"] == STAMP
    assert sb.writes == []


# ── Clearing the mark ────────────────────────────────────────────────────────

def test_clearing_a_played_row_deletes_it():
    sb = _SB([_row("played", STAMP)])
    R._set_played_mark(sb, ME, GAME, False)
    assert sb.rows == []


@pytest.mark.parametrize("status", ["owned", "prev_owned", "wishlist"])
def test_clearing_a_shelf_row_only_unstamps_it(status):
    sb = _SB([_row(status, STAMP)])
    R._set_played_mark(sb, ME, GAME, False)
    (row,) = sb.rows
    assert row["status"] == status
    assert row["played_before_at"] is None


def test_clearing_with_no_row_is_a_no_op():
    sb = _SB()
    R._set_played_mark(sb, ME, GAME, False)
    assert sb.rows == [] and sb.writes == []


# ── Shelf status and the mark are independent ────────────────────────────────

def test_played_is_not_a_shelf_status():
    sb = _SB()
    with pytest.raises(HTTPException) as e:
        R._upsert_collection(sb, ME, GAME, "played")
    assert e.value.status_code == 400
    assert sb.rows == []


@pytest.mark.parametrize("status", ["owned", "prev_owned", "wishlist"])
def test_a_shelf_change_keeps_the_mark(status):
    """A marked game that is then bought, wishlisted or sold stays marked:
    the upsert never names played_before_at."""
    sb = _SB([_row("played", STAMP)])
    R._upsert_collection(sb, ME, GAME, status)
    (row,) = sb.rows
    assert row["status"] == status
    assert row["played_before_at"] == STAMP


def test_removing_a_marked_game_keeps_it_as_played():
    sb = _SB([_row("owned", STAMP)])
    R._remove_from_shelf(sb, ME, GAME)
    (row,) = sb.rows
    assert row["status"] == "played"
    assert row["played_before_at"] == STAMP


def test_removing_an_unmarked_game_deletes_the_row():
    sb = _SB([_row("wishlist")])
    R._remove_from_shelf(sb, ME, GAME)
    assert sb.rows == []


def test_removing_a_mark_only_row_leaves_it_alone():
    """Remove is the shelf's; clearing a mark is the switch's."""
    sb = _SB([_row("played", STAMP)])
    R._remove_from_shelf(sb, ME, GAME)
    assert sb.rows == [_row("played", STAMP)]


# ── Reads ────────────────────────────────────────────────────────────────────

def test_status_map_carries_the_marks(monkeypatch):
    sb = _SB()
    sb.rpc_payload = {
        "status_map": {GAME: "owned", "g2": "played"},
        "expansion_counts": {},
        "played_marks": [GAME],
    }
    monkeypatch.setattr(R, "get_supabase", lambda: sb)
    res = asyncio.run(R.collection_status_map(user=USER))
    assert res.played_marks == [GAME]
    assert res.status_map == {GAME: "owned", "g2": "played"}


def test_status_map_without_marks_is_an_empty_list(monkeypatch):
    sb = _SB()
    sb.rpc_payload = {"status_map": {}, "expansion_counts": {}}
    monkeypatch.setattr(R, "get_supabase", lambda: sb)
    assert asyncio.run(R.collection_status_map(user=USER)).played_marks == []


def test_search_fallback_is_not_fooled_by_a_played_row(monkeypatch):
    """A mark-only game is a catalog hit, as one with only logged plays is."""
    rows = [
        {"user_id": ME, "status": "played", "game_id": "g1",
         "boardgamebuddy_games": {"id": "g1", "name": "Azul"}},
        {"user_id": ME, "status": "owned", "game_id": "g2",
         "boardgamebuddy_games": {"id": "g2", "name": "Azul Duel"}},
    ]
    sb = _SB(rows)
    monkeypatch.setattr(SS, "game_summary_from_row", lambda g: type("G", (), {"id": g["id"], "name": g["name"]})())
    class _Hit:
        def __init__(self, **kw):
            self.__dict__.update(kw)
    monkeypatch.setattr(SS, "UnifiedSearchHit", _Hit)
    hits = SS._collection_hits(sb, ME, "azul", 10, include_expansions=True)
    assert [h.collection_status for h in hits] == ["owned"]
