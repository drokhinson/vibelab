"""Every play_players row a bulk insert sends carries `linked_at`.

PUT /plays/{id} full-replaces the nested lists: it deletes every play_players
row and re-inserts them. `_read_linked_at` exists so a returning seat keeps the
timestamp it was first seated at, or a typo fix in the notes would notify all
five players that they had just been added to a play they have been in for two
years.

That carry-over is per seat, which used to mean the key was PRESENT on the rows
that had one and ABSENT on the rows that didn't — a ghost, or a player just
added. PostgREST writes a bulk insert as one statement over the union of the
keys it was handed, so the absent ones were sent an explicit NULL instead of
falling through to the column default, and `linked_at` is `DEFAULT now() NOT
NULL` (migration 008):

    null value in column "linked_at" of relation "boardgamebuddy_play_players"
    violates not-null constraint
    Failing row contains (…, f, null, null, Sean D, [null, null, null], null).

i.e. a 500 on every edit of a play that seats a ghost, once the host's own seat
had a timestamp to carry. It is a class of bug no single-row test can see and
the type checker cannot see at all — the rows are plain dicts, and each one is
individually valid. What makes it visible is asserting on the KEY SETS of the
batch, which is what this file does.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.play_routes import _write_play_players


class _Seat:
    """The shape _write_play_players reads off a PlayPlayer / PlayerEntry."""

    def __init__(self, name, user_id=None, is_winner=False, score=None, round_scores=None):
        self.name = name
        self.user_id = user_id
        self.is_winner = is_winner
        self.score = score
        self.round_scores = round_scores


class _FakeSb:
    """Captures the one insert() the writer makes."""

    def __init__(self):
        self.rows = None

    def table(self, _name):
        return self

    def insert(self, rows):
        self.rows = rows
        return self

    def execute(self):
        return self


HOST = "11111111-1111-1111-1111-111111111111"
BUDDY = "22222222-2222-2222-2222-222222222222"
SEATED_AT = "2024-01-01T00:00:00+00:00"


def _write(players, carried=None):
    sb = _FakeSb()
    out = _write_play_players(sb, "play-1", players, linked_at_by_user=carried)
    return sb.rows, out


def test_every_row_in_a_mixed_batch_carries_linked_at():
    """The field case: a carried-over host seat beside a ghost with none."""
    rows, _ = _write(
        [_Seat("Me", user_id=HOST), _Seat("Sean D")],
        carried={HOST: SEATED_AT},
    )
    assert len(rows) == 2
    assert all("linked_at" in r for r in rows)
    assert all(r["linked_at"] is not None for r in rows)
    # One statement, one column list: differing key sets are the bug itself.
    assert len({frozenset(r) - {"player_user_id"} for r in rows}) == 1


def test_a_returning_seat_keeps_its_timestamp_and_a_new_one_is_stamped_now():
    rows, _ = _write(
        [_Seat("Me", user_id=HOST), _Seat("Buddy", user_id=BUDDY), _Seat("Sean D")],
        carried={HOST: SEATED_AT},
    )
    by_name = {r["player_display_name"]: r for r in rows}
    assert by_name["Me"]["linked_at"] == SEATED_AT
    assert by_name["Buddy"]["linked_at"] != SEATED_AT
    assert by_name["Sean D"]["linked_at"] != SEATED_AT
    # Seats written together happened together.
    assert by_name["Buddy"]["linked_at"] == by_name["Sean D"]["linked_at"]


def test_a_ghost_has_no_player_user_id_key():
    """The other conditional key, which is fine: nullable, and NULL is correct."""
    rows, _ = _write([_Seat("Sean D")])
    assert "player_user_id" not in rows[0]
    assert rows[0]["player_display_name"] == "Sean D"


def test_the_create_path_with_no_carry_over_still_stamps_every_row():
    rows, out = _write([_Seat("Me", user_id=HOST, is_winner=True, score=42), _Seat("Sean D")])
    assert all(r["linked_at"] for r in rows)
    assert [r["is_winner"] for r in rows] == [True, False]
    assert [o.name for o in out] == ["Me", "Sean D"]


def test_an_empty_roster_writes_nothing():
    sb = _FakeSb()
    assert _write_play_players(sb, "play-1", []) == []
    assert sb.rows is None
