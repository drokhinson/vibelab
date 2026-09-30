"""Play invites on the API side.

The rules themselves (who is invited, what counts) live in SQL and are pinned
by db/tests/play_invites.sql. This file pins what the API adds around them:

  * The bell's first page carries every unanswered invite and the pending
    count, and a failure of either read leaves the bell loading.
  * Later pages carry no invites, so paging never repeats them.
  * The roster reads an invited seat as its account, marked pending.
  * Accepting names the plays to the RPC; a play with no invite is a 404.
  * A lobby seat says whether it was accepted, and defaults to not.
"""

import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from routes import play_routes  # noqa: E402
from routes.models import SessionParticipantResponse  # noqa: E402
from routes.services import notification_service  # noqa: E402


class _Res:
    def __init__(self, data):
        self.data = data

    def execute(self):
        return self


class _Sb:
    """Answers each RPC from a map; a callable value is called with the args."""

    def __init__(self, rpcs=None, table_rows=None):
        self.rpcs = rpcs or {}
        self.calls = []
        self.table_rows = table_rows or {}

    def rpc(self, name, args):
        self.calls.append((name, args))
        value = self.rpcs.get(name)
        if isinstance(value, Exception):
            raise value
        return _Res(value(args) if callable(value) else value)

    def table(self, name):
        return _Table(self.table_rows.get(name, []))


class _Table:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_a):
        return self

    def in_(self, *_a):
        return self

    def eq(self, *_a):
        return self

    def execute(self):
        return _Res(self.rows)


def _entry(kind, key):
    return {
        "entry_key": key,
        "kind": kind,
        "occurred_at": datetime(2026, 9, 27, tzinfo=timezone.utc).isoformat(),
        "is_unread": True,
        "actor_id": "dana",
        "actor_display_name": "Dana",
        "play_group": "act",
        "play_id": "play-1",
        "play_ids": ["play-1"],
        "group_count": 1,
        "game_count": 1,
    }


def _bell(**rpcs):
    base = {
        "bgb_notifications": [],
        "bgb_notifications_unread": 0,
        "bgb_play_invites": [_entry("play_invite", "inv:a")],
        "bgb_notifications_pending": 2,
    }
    base.update(rpcs)
    return _Sb(base)


def test_the_first_page_carries_the_invites_and_the_pending_count():
    res = asyncio.run(notification_service.list_notifications(_bell(), "sam"))
    assert [i.kind for i in res.invites] == ["play_invite"]
    assert res.pending == 2


def test_a_later_page_carries_no_invites():
    sb = _bell()
    res = asyncio.run(notification_service.list_notifications(
        sb, "sam", before=datetime(2026, 9, 1, tzinfo=timezone.utc), before_key="k"
    ))
    assert res.invites == []
    assert "bgb_play_invites" not in [c[0] for c in sb.calls]


def test_a_failing_invite_read_still_loads_the_bell():
    sb = _bell(bgb_play_invites=RuntimeError("no such function"),
               bgb_notifications_pending=RuntimeError("no such function"))
    res = asyncio.run(notification_service.list_notifications(sb, "sam"))
    assert res.invites == [] and res.pending == 0


def test_an_invited_seat_reads_as_its_account_marked_pending():
    sb = _Sb(table_rows={
        "boardgamebuddy_play_players": [
            {"play_id": "play-1", "player_user_id": "dana", "pending_user_id": None,
             "player_display_name": "Dana", "is_winner": True, "score": 10},
            {"play_id": "play-1", "player_user_id": None, "pending_user_id": "sam",
             "player_display_name": "Sam", "is_winner": False, "score": 8},
        ],
        "boardgamebuddy_profiles": [
            {"id": "dana", "display_name": "Dana"},
            {"id": "sam", "display_name": "Sam R"},
        ],
    })
    players = play_routes._fetch_players(sb, ["play-1"])["play-1"]
    by_id = {p.user_id: p for p in players}
    assert by_id["sam"].pending and by_id["sam"].name == "Sam R"
    assert not by_id["dana"].pending


def test_accept_passes_the_plays_through():
    sb = _Sb({"bgb_accept_play_invites": lambda args: len(args["p_play_ids"])})
    assert notification_service.accept_invites(sb, "sam", ["a", "b"]) == 2
    assert sb.calls == [("bgb_accept_play_invites", {"p_viewer": "sam", "p_play_ids": ["a", "b"]})]


def test_accepting_a_play_with_no_invite_is_a_404(monkeypatch):
    monkeypatch.setattr(play_routes, "get_supabase", lambda: _Sb({"bgb_accept_play_invites": 0}))

    class _User:
        user_id = "sam"

    class _Tasks:
        def add_task(self, *_a, **_k):
            raise AssertionError("nothing was accepted, so nothing can unlock")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(play_routes.accept_play(_Tasks(), "play-1", _User()))
    assert exc.value.status_code == 404


def test_a_lobby_seat_is_not_accepted_unless_it_says_so():
    row = {"id": "p", "display_name": "Sam", "joined_at": "2026-09-27T18:00:00+00:00"}
    assert SessionParticipantResponse(**row).accepted is False
    assert SessionParticipantResponse(**row, accepted=True).accepted is True


def test_the_review_list_is_only_the_plays_still_waiting_newest_first():
    sb = _Sb(table_rows={
        "boardgamebuddy_play_players": [{"play_id": "a"}, {"play_id": "b"}],
        "boardgamebuddy_plays": [
            {"id": "a", "game_name": "Azul", "played_at": "2024-07-06"},
            {"id": "b", "game_name": "Wingspan", "played_at": "2024-08-12"},
        ],
    })
    rows = notification_service.invite_items(sb, "sam", ["a", "b", "c"])
    assert [r["game_name"] for r in rows] == ["Wingspan", "Azul"]
