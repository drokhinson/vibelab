"""A seat keeps the side it played on, across the write and back out again.

Migration 048 gives ``boardgamebuddy_play_players`` a ``team`` column. Before
it, the tag typed on the Play screen settled which seats shared a win flag and
was then dropped at save, so a team night persisted as N seats and no sides.

Three things are pinned here, and the middle one is why this file exists:

  * ``""`` is NOT a team. PlaySession seeds every seat with ``team: ""`` and
    writes ``""`` back when a tag is cleared, so an empty string is the common
    case on the wire — not an edge one. Stored as-is, every untagged seat in
    the app would carry the same tag and group into one anonymous side.
  * ``PUT /plays/{id}`` is a FULL REPLACEMENT: it deletes every seat and
    re-inserts from the payload. If ``_write_play_players`` did not carry the
    field, editing a play's notes would silently erase who played with whom —
    a fact nothing else in the app can reconstruct.
  * ``_fetch_players`` must tolerate a row with no ``team`` key at all. Only
    three roster RPCs were re-emitted; the reduced projections in
    ``bgb_profile_bundle`` and ``bgb_game_detail_bundle`` were deliberately
    left alone and must still validate.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

from routes import play_routes as P  # noqa: E402
from routes.constants import MAX_PLAY_TEAM_CHARS  # noqa: E402
from routes.models import PlayerEntry, PlayPlayerResponse  # noqa: E402


# ── PlayerEntry: what reaches the row ────────────────────────────────────────

@pytest.mark.parametrize("sent, stored", [
    ("Red", "Red"),
    ("  Red  ", "Red"),      # trimmed, so " Red" and "Red" are one side
    ("", None),              # the cleared tag — the common case
    ("   ", None),
    (None, None),
])
def test_team_normalizes_blank_to_none(sent, stored):
    assert PlayerEntry(name="Ana", team=sent).team == stored


def test_team_is_absent_by_default():
    assert PlayerEntry(name="Ana").team is None


def test_team_longer_than_the_cap_is_rejected():
    PlayerEntry(name="Ana", team="x" * MAX_PLAY_TEAM_CHARS)   # the boundary is fine
    with pytest.raises(Exception):
        PlayerEntry(name="Ana", team="x" * (MAX_PLAY_TEAM_CHARS + 1))


def test_response_tolerates_a_roster_row_without_the_key():
    """The RPCs that were not re-emitted return rows with no `team`."""
    assert PlayPlayerResponse(name="Ana", is_winner=False).team is None


# ── The write path ───────────────────────────────────────────────────────────

class _Insert:
    def __init__(self, sink):
        self.sink = sink

    def insert(self, rows):
        self.sink.extend(rows)
        return self

    def execute(self):
        return self


class _WriteSb:
    def __init__(self):
        self.rows = []

    def table(self, _name):
        return _Insert(self.rows)


def test_write_carries_the_team_onto_every_row():
    sb = _WriteSb()
    out = P._write_play_players(sb, "play-1", [
        PlayerEntry(name="Ana", user_id="u-a", team="Red"),
        PlayerEntry(name="Bo", user_id="u-b", team="red"),   # same side, any case
        PlayerEntry(name="Cy", team=""),                     # no side
    ])
    assert [r["team"] for r in sb.rows] == ["Red", "red", None]
    # ...and the echoed response agrees with what was written, so the client
    # does not have to refetch to learn what landed.
    assert [pl.team for pl in out] == ["Red", "red", None]


def test_an_edit_round_trip_does_not_erase_the_sides():
    """PUT /plays/{id} deletes and re-inserts; the sides have to survive it."""
    fetched = [
        PlayPlayerResponse(user_id="u-a", name="Ana", is_winner=True, team="Red"),
        PlayPlayerResponse(user_id="u-b", name="Bo", is_winner=False, team="Blue"),
    ]
    # What the edit popup sends back for an untouched roster.
    resent = [PlayerEntry(name=pl.name, user_id=pl.user_id,
                          is_winner=pl.is_winner, team=pl.team) for pl in fetched]
    sb = _WriteSb()
    P._write_play_players(sb, "play-1", resent)
    assert [r["team"] for r in sb.rows] == ["Red", "Blue"]


# ── The read path ────────────────────────────────────────────────────────────

class _Select:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_a, **_k):
        return self

    def in_(self, *_a, **_k):
        return self

    def execute(self):
        return self

    @property
    def data(self):
        return self.rows


class _ReadSb:
    """play_players first, then the profile lookup (empty — these are ghosts)."""

    def __init__(self, player_rows):
        self.player_rows = player_rows

    def table(self, name):
        if name == "boardgamebuddy_play_players":
            return _Select(self.player_rows)
        return _Select([])


def test_fetch_reads_the_team_back():
    by_play = P._fetch_players(_ReadSb([
        {"play_id": "p1", "player_user_id": None, "player_display_name": "Ana",
         "is_winner": True, "score": 10, "round_scores": None, "team": "Red"},
        {"play_id": "p1", "player_user_id": None, "player_display_name": "Bo",
         "is_winner": False, "score": 5, "round_scores": None, "team": None},
    ]), ["p1"])
    assert {pl.name: pl.team for pl in by_play["p1"]} == {"Ana": "Red", "Bo": None}


def test_fetch_tolerates_a_row_predating_the_column():
    by_play = P._fetch_players(_ReadSb([
        {"play_id": "p1", "player_user_id": None, "player_display_name": "Ana",
         "is_winner": True, "score": 10, "round_scores": None},
    ]), ["p1"])
    assert by_play["p1"][0].team is None
