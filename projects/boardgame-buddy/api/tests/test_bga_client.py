"""Session reuse, refresh, and the throttle that keeps the account alive.

`bga_client` owns IDENTITY: which cookies to send, when to mint new ones, and
how often it is allowed to ask BGA anything at all. The transport is stubbed
here — what is under test is the decisions, not httpx.

The throttle gets its own test because it is the one thing in this feature that
protects the USER rather than the code. BGG rate-limits; BGA bans. A change
that makes the sweep faster by loosening this is a change that gets somebody's
account suspended, and it should have to delete a test to do it.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from routes import bga_client


def _row(**over):
    """A profile row as `_load_profile_session` would return one."""
    base = {
        "bga_username": "me_bga",
        "bga_player_id": "77",
        "bga_password_enc": "enc",
        "bga_session_cookies": {"PHPSESSID": "live"},
        "bga_session_expires_at": (
            datetime.now(timezone.utc) + timedelta(days=7)
        ).isoformat(),
    }
    base.update(over)
    return base


# ── Freshness ────────────────────────────────────────────────────────────────


def test_a_live_session_is_fresh():
    assert bga_client._session_is_fresh(_row()) is True


def test_a_session_with_no_cookies_is_not_fresh():
    assert bga_client._session_is_fresh(_row(bga_session_cookies={})) is False
    assert bga_client._session_is_fresh(_row(bga_session_cookies=None)) is False


def test_an_expired_session_is_not_fresh():
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    assert bga_client._session_is_fresh(_row(bga_session_expires_at=past)) is False


def test_a_session_inside_the_leeway_is_refreshed_early():
    """Refreshing at the expiry costs a re-login AND a retried request.

    Four minutes is inside the five-minute leeway, so this must read as stale
    even though the cookie has not technically died yet.
    """
    soon = (datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat()
    assert bga_client._session_is_fresh(_row(bga_session_expires_at=soon)) is False


def test_a_naive_timestamp_is_read_as_utc():
    """Supabase can hand back a stamp with no offset; reading it as local time
    would make a live session look expired in one timezone and not another."""
    naive = (datetime.now(timezone.utc) + timedelta(days=3)).replace(tzinfo=None).isoformat()
    assert bga_client._session_is_fresh(_row(bga_session_expires_at=naive)) is True


def test_an_unparseable_timestamp_is_not_fresh():
    """Fail towards a re-login, never towards sending cookies we cannot date."""
    assert bga_client._session_is_fresh(_row(bga_session_expires_at="soon-ish")) is False
    assert bga_client._session_is_fresh(_row(bga_session_expires_at=None)) is False


def test_cookies_are_read_defensively():
    assert bga_client._session_cookies(_row()) == {"PHPSESSID": "live"}
    assert bga_client._session_cookies(_row(bga_session_cookies="nonsense")) == {}
    # An empty value is not a cookie.
    assert bga_client._session_cookies(_row(bga_session_cookies={"a": ""})) == {}


# ── Load errors are actionable, not 500s ─────────────────────────────────────


class _FakeTable:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        class R:
            data = self._rows
        return R()


class _FakeSb:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _FakeTable(self._rows)


def test_no_link_is_a_400_not_a_500():
    with pytest.raises(HTTPException) as exc:
        bga_client._load_profile_session(_FakeSb([{"bga_username": None}]), "u-1")
    assert exc.value.status_code == 400


def test_a_username_with_no_password_is_a_409():
    """RELINK_REQUIRED.

    The user can fix this and the account step renders exactly this state, so
    it must not surface as a server error they can do nothing about.
    """
    with pytest.raises(HTTPException) as exc:
        bga_client._load_profile_session(
            _FakeSb([{"bga_username": "me_bga", "bga_password_enc": None}]), "u-1"
        )
    assert exc.value.status_code == 409
    assert "re-link" in exc.value.detail.lower()


def test_a_missing_profile_is_a_400():
    with pytest.raises(HTTPException) as exc:
        bga_client._load_profile_session(_FakeSb([]), "u-1")
    assert exc.value.status_code == 400


# ── The throttle ─────────────────────────────────────────────────────────────


def test_throttle_defaults_to_two_seconds(monkeypatch):
    """Stricter than BGG's 1.5s, on purpose: BGG rate-limits, BGA bans."""
    monkeypatch.delenv("BGA_THROTTLE_SECONDS", raising=False)
    assert bga_client.throttle_seconds() == 2.0


def test_throttle_is_env_tunable_and_survives_nonsense(monkeypatch):
    monkeypatch.setenv("BGA_THROTTLE_SECONDS", "0.05")
    assert bga_client.throttle_seconds() == 0.05
    monkeypatch.setenv("BGA_THROTTLE_SECONDS", "not-a-number")
    assert bga_client.throttle_seconds() == 2.0


def test_consecutive_calls_are_spaced_by_the_throttle(monkeypatch):
    """`_wait_turn` holds until the gap has elapsed."""
    monkeypatch.setenv("BGA_THROTTLE_SECONDS", "0.05")
    bga_client._last_call_at = 0.0

    async def run():
        started = time.monotonic()
        await bga_client._wait_turn()
        await bga_client._wait_turn()
        await bga_client._wait_turn()
        return time.monotonic() - started

    elapsed = asyncio.run(run())
    # Three turns means two gaps. Compared with slack, because a loaded CI box
    # only ever makes this slower.
    assert elapsed >= 0.09


def test_the_gate_serialises_concurrent_callers(monkeypatch):
    """One BGA request at a time per worker.

    `bgg_collection_read` throttles WITHIN a sweep, which lets two users' sweeps
    interleave at full speed. That is not enough here — the limit BGA enforces
    is per account and per client, not per sweep — so the lock is module-level
    and covers the whole process.
    """
    monkeypatch.setenv("BGA_THROTTLE_SECONDS", "0.02")
    bga_client._last_call_at = 0.0
    overlaps = 0
    inside = 0

    async def one():
        nonlocal overlaps, inside
        async with bga_client._gate:
            inside += 1
            if inside > 1:
                overlaps += 1
            await bga_client._wait_turn()
            await asyncio.sleep(0.01)
            inside -= 1

    async def run():
        await asyncio.gather(*(one() for _ in range(4)))

    asyncio.run(run())
    assert overlaps == 0
