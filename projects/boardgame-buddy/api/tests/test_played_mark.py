"""The "played it, never logged it here" mark (migration 057).

A collection row with status 'played' and played_before_at stamped. Pinned
here is what the API decides on its own; the shelf and status-map SQL is
exercised against Postgres by db/tests/057_played_mark.sql.

  * adding 'played' stamps played_before_at, and nothing else does;
  * 'played' is only for a game not otherwise in the collection — it would
    otherwise overwrite owned, prev-owned or wishlist (409);
  * re-marking a marked game is allowed (it is the same row);
  * the status map carries the marks, so the client can tell a mark from a
    game that only has plays.
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

ME = "00000000-0000-0000-0000-00000000000a"
GAME = "11111111-0000-0000-0000-000000000001"
USER = CurrentUser(user_id=ME, display_name="Me", username="me", is_admin=False)


class _Q:
    def __init__(self, sb, table):
        self.sb, self.table, self.filters, self.op, self.payload = sb, table, {}, "select", None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self.filters[col] = val
        return self

    def limit(self, _n):
        return self

    def upsert(self, row, on_conflict=None):
        self.op, self.payload = "upsert", row
        return self

    def execute(self):
        if self.op == "upsert":
            self.sb.upserts.append(self.payload)
            return type("R", (), {"data": [self.payload]})()
        if self.table == "boardgamebuddy_games":
            return type("R", (), {"data": [{"id": GAME, "name": "Azul"}]})()
        rows = [r for r in self.sb.rows
                if all(r.get(k) == v for k, v in self.filters.items())]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, rows=()):
        self.rows, self.upserts, self.rpc_payload = list(rows), [], {}

    def table(self, name):
        return _Q(self, name)

    def rpc(self, _name, _params):
        payload = self.rpc_payload
        return type("P", (), {"execute": lambda _s: type("R", (), {"data": payload})()})()


@pytest.fixture
def denorm(monkeypatch):
    monkeypatch.setattr(R, "collection_denormalized_from_game", lambda g: {"game_name": g["name"]})


def test_marking_stamps_played_before_at(denorm):
    sb = _SB()
    R._upsert_collection(sb, ME, GAME, "played")
    (row,) = sb.upserts
    assert row["status"] == "played"
    assert row["played_before_at"]


@pytest.mark.parametrize("status", ["owned", "prev_owned", "wishlist"])
def test_marking_never_overwrites_a_shelf_status(denorm, status):
    sb = _SB([{"user_id": ME, "game_id": GAME, "status": status}])
    with pytest.raises(HTTPException) as e:
        R._upsert_collection(sb, ME, GAME, "played")
    assert e.value.status_code == 409
    assert sb.upserts == []


def test_re_marking_a_marked_game_is_allowed(denorm):
    sb = _SB([{"user_id": ME, "game_id": GAME, "status": "played"}])
    R._upsert_collection(sb, ME, GAME, "played")
    assert sb.upserts[0]["status"] == "played"


@pytest.mark.parametrize("status", ["owned", "prev_owned", "wishlist"])
def test_other_statuses_leave_the_mark_alone(denorm, status):
    """An upsert without played_before_at leaves the column as it is, which is
    how a marked game that is then bought keeps its mark as the owned game's."""
    sb = _SB([{"user_id": ME, "game_id": GAME, "status": "played"}])
    R._upsert_collection(sb, ME, GAME, status)
    assert "played_before_at" not in sb.upserts[0]


def test_status_map_carries_the_marks(monkeypatch):
    sb = _SB()
    sb.rpc_payload = {
        "status_map": {GAME: "played", "g2": "played"},
        "expansion_counts": {},
        "played_marks": [GAME],
    }
    monkeypatch.setattr(R, "get_supabase", lambda: sb)
    res = asyncio.run(R.collection_status_map(user=USER))
    assert res.played_marks == [GAME]
    assert res.status_map == {GAME: "played", "g2": "played"}


def test_status_map_without_marks_is_an_empty_list(monkeypatch):
    sb = _SB()
    sb.rpc_payload = {"status_map": {}, "expansion_counts": {}}
    monkeypatch.setattr(R, "get_supabase", lambda: sb)
    assert asyncio.run(R.collection_status_map(user=USER)).played_marks == []
