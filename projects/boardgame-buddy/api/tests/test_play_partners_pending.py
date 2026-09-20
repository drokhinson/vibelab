"""The player picker's bundle carries unanswered buddy requests.

Migration 049 adds a fourth list to `bgb_play_partners`: `pending`, one row per
live buddy request the viewer is a party to, either direction. It exists
because the other three cannot hold that person. `accounts` is accepted edges
only; `ghosts` is free text from past plays; and `recent` — which HAS carried
pending flags since 047/061 — is built from shared plays, so it only ever
describes someone the viewer has already logged a game with. The person you
added across the table ninety seconds ago is in none of them, which is exactly
when you need to seat them.

Two properties, and the second is the one that will actually bite:

  * the list is parsed and typed, direction included, so the client can say
    whose move it is rather than guessing from the edge;
  * a payload WITHOUT the key still works. The API and the SQL deploy
    separately — Railway on a push, the migration by hand — so there is a
    window where a new service reads an old function, and a KeyError there
    would take out the Gather picker seed and /bootstrap with it.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.services import played_with_service

VIEWER = "11111111-1111-1111-1111-111111111111"


class _SB:
    """One canned answer for the one RPC this service calls."""

    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        payload = self.payload
        return type("Q", (), {"execute": lambda _s: type("R", (), {"data": payload})()})()


def _edge(name, direction, edge_id="e-1", user_id="u-1"):
    return {
        "id": edge_id,
        "other_user_id": user_id,
        "other_display_name": name,
        "other_username": name.lower(),
        "other_avatar": None,
        "direction": direction,
        "created_at": "2026-09-20T10:00:00+00:00",
    }


def test_pending_edges_are_parsed_both_directions():
    sb = _SB({
        "accounts": [],
        "pending": [
            _edge("Priya", "outgoing", "e-1", "u-priya"),
            _edge("Dev", "incoming", "e-2", "u-dev"),
        ],
        "ghosts": [],
        "recent": [],
    })
    out = played_with_service.fetch_play_partners(sb, VIEWER)

    assert sb.calls == [("bgb_play_partners", {"p_viewer": VIEWER})]
    assert [p.direction for p in out.pending] == ["outgoing", "incoming"]
    assert [p.other_display_name for p in out.pending] == ["Priya", "Dev"]
    # The edge id rides along: the same row is what a surface offering Accept
    # or Cancel would act on, and looking it up again is a round trip for an
    # id the RPC already had in hand.
    assert [p.id for p in out.pending] == ["e-1", "e-2"]


def test_pending_defaults_to_empty_before_the_migration_lands():
    """An older bgb_play_partners returns three keys. That is one missing
    section, not a 500 on the app's first-paint seed."""
    sb = _SB({"accounts": [], "ghosts": [], "recent": []})
    out = played_with_service.fetch_play_partners(sb, VIEWER)
    assert out.pending == []
    assert out.model_dump(mode="json")["pending"] == []


def test_pending_survives_a_null_key():
    """jsonb_build_object with a NULL value sends null, not an absent key."""
    sb = _SB({"accounts": [], "pending": None, "ghosts": None, "recent": None})
    out = played_with_service.fetch_play_partners(sb, VIEWER)
    assert out.pending == [] and out.ghosts == [] and out.recent == []
