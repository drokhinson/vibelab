"""The importer's BoardGameGeek preview: what it reads, filters and shows.

BoardGameGeek plays used to be written by POST /bgg/sync, straight into
boardgamebuddy_plays. They come through the play importer now, which means one
endpoint has to answer "which of my BGG plays are not in BgB yet?" without
writing anything — and get four things right that the old write path either
did differently or never had to think about:

1. THE PARSER CARRIES THREE MORE FIELDS. The game's BGG name (so the Games step
   can name a game the catalog lacks), each seat's BGG username (so the syncing
   account can be seated without a name match), and `quantity`.

2. QUANTITY IS ECHOED, NEVER EXPANDED. N rows sharing one bgg_play_id would be
   rejected by the partial UNIQUE — the import would land one and report N.

3. "ALREADY HERE" IS ASKED OF bgg_play_id, WHICH EVERY WRITER SHARES. A play
   the retired sync wrote carries no client_key, so nothing derived from the
   importer's own draft ids could recognise it.

4. AN UNREADABLE HISTORY IS NOT AN EMPTY ONE. A warm-up exhaustion must report
   read_failed rather than "nothing new", and must never be cached.

All pure: no network, no database.

Run:  python -m pytest tests/test_bgg_pending_plays.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio
from datetime import datetime, timezone

import pytest

import cache
from routes import constants as K
from routes.bgg_client import BggWarmUpError
from routes.bgg_plays_read import existing_bgg_play_ids, parse_plays
from routes.services import bgg_plays_cache
from routes.services import bgg_plays_service as S


# ── Fakes ────────────────────────────────────────────────────────────────────

class _Q:
    """Just enough of the PostgREST builder for the two reads this makes."""
    def __init__(self, table, store):
        self.table, self.store, self.ids = table, store, None
        self.writes = store.setdefault("_writes", [])

    def select(self, *_a, **_k): return self
    def eq(self, *_a, **_k): return self

    def in_(self, _col, ids):
        self.ids = list(ids)
        return self

    def insert(self, rows):
        self.writes.append((self.table, rows))
        return self

    def upsert(self, rows, **_k):
        self.writes.append((self.table, rows))
        return self

    def execute(self):
        rows = self.store.get(self.table, [])
        if self.ids is not None:
            rows = [r for r in rows if r.get("bgg_play_id") in self.ids
                    or r.get("bgg_id") in self.ids]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, store): self.store = store
    def table(self, name): return _Q(name, self.store)


def _plays_xml(*plays: str, total: int | None = None) -> str:
    n = len(plays) if total is None else total
    return f'<?xml version="1.0"?><plays total="{n}">{"".join(plays)}</plays>'


def _play(pid, objectid, date="2026-01-02", *, name="Catan", quantity=None,
          players="", comments=None):
    q = f' quantity="{quantity}"' if quantity is not None else ""
    body = f'<item name="{name}" objectid="{objectid}"/>'
    if comments is not None:
        body += f"<comments>{comments}</comments>"
    if players:
        body += f"<players>{players}</players>"
    return f'<play id="{pid}" date="{date}"{q}>{body}</play>'


def _seat(name, *, username=None, win=False):
    u = f' username="{username}"' if username else ""
    return f'<player name="{name}"{u} win="{"1" if win else "0"}"/>'


@pytest.fixture(autouse=True)
def _clear_cache():
    """The read cache is module state, so one test's stored read would serve
    the next one and make the "is it really re-filtered?" tests pass for the
    wrong reason."""
    bgg_plays_cache.invalidate("u1")
    yield
    bgg_plays_cache.invalidate("u1")


# ── 1 · The parser ───────────────────────────────────────────────────────────

def test_parses_the_three_fields_the_preview_added():
    rows, total = parse_plays(
        _plays_xml(_play(11, 13, name="Catan", quantity=3,
                         comments="league night",
                         players=_seat("Sean", username="seanb", win=True)
                                 + _seat("Mick"))),
        username="me",
    )
    assert total == 1
    (row,) = rows
    assert row["bgg_game_name"] == "Catan"
    assert row["quantity"] == 3
    assert row["notes"] == "league night"
    assert row["players"] == [
        {"name": "Sean", "username": "seanb", "is_winner": True},
        {"name": "Mick", "username": None, "is_winner": False},
    ]


def test_quantity_defaults_to_one_and_never_goes_below_it():
    rows, _ = parse_plays(
        _plays_xml(_play(11, 13), _play(12, 13, quantity=0), _play(13, 13, quantity="x")),
        username="me",
    )
    assert [r["quantity"] for r in rows] == [1, 1, 1]


def test_quantity_is_never_expanded_into_extra_rows():
    """N rows sharing one bgg_play_id would be rejected by the partial UNIQUE,
    so the import would land one play and claim N."""
    rows, _ = parse_plays(_plays_xml(_play(11, 13, quantity=7)), username="me")
    assert len(rows) == 1
    assert rows[0]["bgg_play_id"] == 11


def test_still_drops_the_plays_the_old_parser_dropped():
    body = _plays_xml(
        '<play id="1" date=""><item name="A" objectid="13"/></play>',   # no date
        '<play id="2" date="2026-01-02"></play>',                        # no item
        '<play id="3" date="2026-01-02"><item name="A" objectid="0"/></play>',
        '<play id="0" date="2026-01-02"><item name="A" objectid="13"/></play>',
        _play(9, 13),
        total=5,
    )
    rows, _ = parse_plays(body, username="me")
    assert [r["bgg_play_id"] for r in rows] == [9]


def test_a_seat_with_only_a_handle_is_kept_and_named_by_it():
    """BGG records some seats as a bare account. Dropping those would import a
    play with fewer people at the table than actually played it."""
    rows, _ = parse_plays(
        _plays_xml(_play(11, 13, players=_seat("", username="ghosty") + _seat("  "))),
        username="me",
    )
    assert rows[0]["players"] == [
        {"name": "ghosty", "username": "ghosty", "is_winner": False},
    ]


# ── 2 · "Already here" ───────────────────────────────────────────────────────

def test_existing_ids_sees_a_play_the_retired_sync_wrote():
    """That row carries a bgg_play_id and NO client_key, which is exactly why
    the filter keys on this column and not on the importer's own ids."""
    sb = _SB({"boardgamebuddy_plays": [
        {"bgg_play_id": 111222, "client_key": None},
        {"bgg_play_id": 333, "client_key": "some-uuid"},
    ]})
    assert existing_bgg_play_ids(sb, "u1", [111222, 333, 999]) == {111222, 333}


def test_existing_ids_is_empty_without_a_read_when_nothing_is_asked():
    sb = _SB({})
    assert existing_bgg_play_ids(sb, "u1", []) == set()
    assert existing_bgg_play_ids(sb, "u1", [None, None]) == set()


# ── 3 · The preview ──────────────────────────────────────────────────────────

def _preview(sb, *, plays, monkeypatch, reuse=None):
    if reuse is not None:
        bgg_plays_cache.store("u1", fetched_at=reuse, plays=plays)
    else:
        async def _fetch(_uid, _username):
            return plays
        monkeypatch.setattr(S, "fetch_all_plays", _fetch)
    monkeypatch.setattr(S, "_summaries_for", lambda _sb, ids: {})
    return asyncio.run(S.pending_plays(sb, "u1", "me"))


def _raw(pid, bgg_id=13, date="2026-01-02"):
    return {
        "bgg_play_id": pid, "bgg_id": bgg_id, "bgg_game_name": "Catan",
        "played_at": date, "notes": None, "quantity": 1,
        "players": [{"name": "Sean", "username": None, "is_winner": True}],
    }


def test_the_preview_excludes_plays_already_in_bgb(monkeypatch):
    sb = _SB({"boardgamebuddy_plays": [{"bgg_play_id": 2}]})
    res = _preview(sb, plays=[_raw(1), _raw(2), _raw(3)], monkeypatch=monkeypatch)
    assert res.total_new == 2
    assert sorted(p.bgg_play_id for p in res.plays) == [1, 3]
    assert res.read_failed is False


def test_the_preview_writes_nothing(monkeypatch):
    store = {"boardgamebuddy_plays": []}
    sb = _SB(store)
    _preview(sb, plays=[_raw(1), _raw(2)], monkeypatch=monkeypatch)
    assert store.get("_writes", []) == []


def test_a_cached_read_is_still_filtered_live(monkeypatch):
    """The cached thing is the BGG bytes, never the filter over them — or the
    second preview would offer back the plays the first one just imported."""
    fetched = datetime.now(timezone.utc)
    plays = [_raw(1), _raw(2)]

    first = _preview(_SB({"boardgamebuddy_plays": []}),
                     plays=plays, monkeypatch=monkeypatch, reuse=fetched)
    assert first.total_new == 2
    assert first.reused_read is True

    # Play 1 has since been imported. Same cache entry, different answer.
    second = _preview(_SB({"boardgamebuddy_plays": [{"bgg_play_id": 1}]}),
                      plays=plays, monkeypatch=monkeypatch, reuse=fetched)
    assert second.total_new == 1
    assert [p.bgg_play_id for p in second.plays] == [2]


def test_a_cached_read_survives_being_read(monkeypatch):
    """Peek, not pop: backing out of the wizard and coming back must not cost
    another paginated walk."""
    fetched = datetime.now(timezone.utc)
    _preview(_SB({"boardgamebuddy_plays": []}),
             plays=[_raw(1)], monkeypatch=monkeypatch, reuse=fetched)
    assert bgg_plays_cache.peek("u1") is not None


def test_a_warm_up_failure_is_not_zero_new_plays(monkeypatch):
    async def _boom(_uid, _username):
        raise BggWarmUpError()
    monkeypatch.setattr(S, "fetch_all_plays", _boom)
    monkeypatch.setattr(S, "_summaries_for", lambda _sb, ids: {})

    res = asyncio.run(S.pending_plays(_SB({}), "u1", "me"))
    assert res.read_failed is True
    assert res.total_new == 0 and res.plays == []
    # And it must not poison the cache for the importer that follows.
    assert bgg_plays_cache.peek("u1") is None


def test_the_window_is_newest_first_and_capped(monkeypatch):
    n = K.MAX_BGG_PENDING_PLAYS + 5
    plays = [_raw(i, date=f"2020-01-{(i % 28) + 1:02d}") for i in range(1, n + 1)]
    res = _preview(_SB({"boardgamebuddy_plays": []}), plays=plays, monkeypatch=monkeypatch)

    assert res.total_new == n
    assert len(res.plays) == K.MAX_BGG_PENDING_PLAYS
    assert res.truncated is True
    dates = [p.played_at.isoformat() for p in res.plays]
    assert dates == sorted(dates, reverse=True)


def test_a_repeated_play_id_across_pages_is_one_row(monkeypatch):
    res = _preview(_SB({"boardgamebuddy_plays": []}),
                   plays=[_raw(1), _raw(1)], monkeypatch=monkeypatch)
    assert res.total_new == 1


def test_player_names_keep_first_seen_order_and_casing(monkeypatch):
    plays = [_raw(1), _raw(2)]
    plays[0]["players"] = [{"name": "Mick", "username": None, "is_winner": False}]
    plays[1]["players"] = [
        {"name": "mick", "username": None, "is_winner": False},
        {"name": "Sean", "username": None, "is_winner": True},
    ]
    res = _preview(_SB({"boardgamebuddy_plays": []}), plays=plays, monkeypatch=monkeypatch)
    assert res.players == ["Mick", "Sean"]
