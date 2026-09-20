"""The sides reach a spectator while the game is still being played.

Migration 048 gave a SAVED seat its ``team`` and said plainly what it was
leaving open: the lobby participant table had no such column, the tags lived on
the host's local draft, and so "a spectator's live mirror shows untinted
columns until the play is saved". Migration 050 closes that — and what this
file pins is the two halves of the wire that make it true.

  * ``SessionParticipantResponse.team`` must DEFAULT to None. The bundle RPC is
    deployed separately from this service, and every participant row written
    before the migration has no key at all; a required field would 500 the poll
    both ends of a live session are sitting on.
  * ``SessionTeamsBody`` normalizes ``""`` to None, exactly as
    ``PlayerEntry.team`` does. This is the common case, not an edge one — the
    client seeds every seat with ``team:""`` and writes ``""`` back when a tag
    is cleared, so without it every untagged seat would carry one shared
    anonymous tag and group into a side nobody is on.
  * The write is a FULL REPLACEMENT that reaches the RPC as a plain map. A seat
    the host clears has to arrive as a tag the RPC will null out, not vanish
    from the payload and keep its old colour on every spectator's grid.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

from routes.constants import MAX_PLAY_TEAM_CHARS  # noqa: E402
from routes.models import (  # noqa: E402
    SessionParticipantResponse,
    SessionResponse,
    SessionTeamsBody,
)
from routes.services import session_service  # noqa: E402


# ── What the bundle hands back ───────────────────────────────────────────────

def _participant(**over):
    row = {
        "id": "p-1",
        "display_name": "Ana",
        "joined_at": "2026-09-20T18:00:00+00:00",
    }
    row.update(over)
    return row


def test_a_participant_predating_the_column_still_validates():
    """The RPC deploys separately; the 2s poll must not 500 in between."""
    assert SessionParticipantResponse(**_participant()).team is None


def test_a_participant_carries_its_side():
    assert SessionParticipantResponse(**_participant(team="Red")).team == "Red"


def test_a_null_team_is_no_side():
    assert SessionParticipantResponse(**_participant(team=None)).team is None


# ── What the host sends ──────────────────────────────────────────────────────

@pytest.mark.parametrize("sent, stored", [
    ("Red", "Red"),
    ("  Red  ", "Red"),     # trimmed, so " Red" and "Red" are one side
    ("", None),             # the cleared tag — the common case
    ("   ", None),
    (None, None),
])
def test_tags_normalize_like_a_saved_seat(sent, stored):
    body = SessionTeamsBody(teams={"p-1": sent})
    assert body.teams == {"p-1": stored}


def test_an_empty_map_is_a_legitimate_write():
    """It is what clearing the last tag sends, and what leaving team mode sends."""
    assert SessionTeamsBody(teams={}).teams == {}
    assert SessionTeamsBody().teams == {}


def test_a_tag_longer_than_the_cap_is_rejected():
    SessionTeamsBody(teams={"p-1": "x" * MAX_PLAY_TEAM_CHARS})
    with pytest.raises(Exception):
        SessionTeamsBody(teams={"p-1": "x" * (MAX_PLAY_TEAM_CHARS + 1)})


def test_every_seat_is_kept_including_the_untagged_ones():
    """Full replacement: an omitted seat is a CLEARED seat, so the client sends
    all of them and the blanks have to survive normalization as explicit
    Nones rather than being dropped from the map."""
    body = SessionTeamsBody(teams={"p-1": "Red", "p-2": "", "p-3": "Blue"})
    assert body.teams == {"p-1": "Red", "p-2": None, "p-3": "Blue"}


# ── What reaches the RPC ─────────────────────────────────────────────────────

class _Rpc:
    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    def rpc(self, name, args):
        self.calls.append((name, args))
        return self

    def execute(self):
        return self

    @property
    def data(self):
        return self.reply


_BUNDLE = {
    "id": "s-1",
    "code": "ABCDE",
    "status": "open",
    "phase": "play",
    "host_user_id": "u-host",
    "participants": [
        {"id": "p-1", "display_name": "Ana",
         "joined_at": "2026-09-20T18:00:00+00:00", "team": "Red"},
        {"id": "p-2", "display_name": "Bo",
         "joined_at": "2026-09-20T18:00:01+00:00", "team": None},
    ],
    "created_at": "2026-09-20T18:00:00+00:00",
    "expires_at": "2026-09-20T20:00:00+00:00",
}


def test_the_map_reaches_the_rpc_whole():
    sb = _Rpc(_BUNDLE)
    out = session_service.set_session_teams(
        sb, viewer_id="u-host", code="ABCDE", play_mode="team",
        teams={"p-1": "Red", "p-2": None},
    )
    name, args = sb.calls[0]
    assert name == "bgb_set_session_teams"
    assert args == {
        "p_host": "u-host",
        "p_code": "ABCDE",
        "p_mode": "team",
        "p_teams": {"p-1": "Red", "p-2": None},
    }
    # ...and the bundle comes back with the sides on it, so the host's own
    # screen never has to refetch to learn what landed.
    assert [p.team for p in out.participants] == ["Red", None]


def test_the_mode_travels_with_the_sides():
    """One write, because a mirror holding the tags but not the mode would draw
    a grid the host's own screen is not drawing — the merge is gated on it."""
    sb = _Rpc(dict(_BUNDLE, play_mode="team"))
    out = session_service.set_session_teams(
        sb, viewer_id="u-host", code="ABCDE", play_mode="team", teams={}
    )
    assert sb.calls[0][1]["p_mode"] == "team"
    assert out.play_mode.value == "team"


def test_an_unsaid_mode_reaches_the_rpc_as_null():
    """None means "leave it alone", so a client that only knows how to publish
    tags cannot un-say a mode the host already set."""
    sb = _Rpc(_BUNDLE)
    session_service.set_session_teams(
        sb, viewer_id="u-host", code="ABCDE", play_mode=None, teams={"p-1": "Red"}
    )
    assert sb.calls[0][1]["p_mode"] is None


def test_a_session_predating_the_column_has_no_mode():
    """The bundle RPC deploys separately; both ends read absent as competitive."""
    assert SessionResponse.model_validate(_BUNDLE).play_mode is None


def test_a_non_host_is_told_so_in_this_endpoint_s_words():
    sb = _Rpc({"error": "host_only"})
    with pytest.raises(Exception) as e:
        session_service.set_session_teams(
            sb, viewer_id="u-someone", code="ABCDE", play_mode="team",
            teams={"p-1": "Red"},
        )
    assert "host" in str(e.value).lower()


def test_a_dead_lobby_is_not_reported_as_a_team_problem():
    """Same gate, same vocabulary as every other host write."""
    sb = _Rpc({"error": "not_found"})
    with pytest.raises(Exception):
        session_service.set_session_teams(
            sb, viewer_id="u-host", code="ZZZZZ", play_mode=None, teams={}
        )
