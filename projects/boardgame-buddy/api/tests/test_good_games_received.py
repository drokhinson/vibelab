"""The Profile hub's Good games counter: reaction_service.received_count, and
the `good_games_received` key /profile/bundle and /bootstrap carry it in."""

import asyncio
import os

os.environ.setdefault("SUPABASE_URL", "http://test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

from routes import bootstrap_routes as B  # noqa: E402
from routes import profile_routes as P  # noqa: E402
from routes.dependencies import CurrentUser  # noqa: E402
from routes.services import reaction_service  # noqa: E402

ME = "00000000-0000-0000-0000-00000000000a"
THEM = "00000000-0000-0000-0000-00000000000b"
USER = CurrentUser(user_id=ME, display_name="Me", username="me", is_admin=False)


class _SB:
    """Answers each RPC from a name -> data map; a name mapped to an
    exception raises it from execute()."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def rpc(self, name, params=None):
        self.calls.append((name, params))
        answer = self.answers.get(name)

        class _Call:
            def execute(_self):
                if isinstance(answer, Exception):
                    raise answer
                return type("R", (), {"data": answer})()

        return _Call()


# ── reaction_service.received_count ─────────────────────────────────────────

def test_received_count_returns_the_rpc_integer():
    sb = _SB({"bgb_good_games_received": 7})
    assert reaction_service.received_count(sb, ME) == 7
    assert sb.calls == [("bgb_good_games_received", {"p_user": ME})]


def test_received_count_is_none_when_the_read_fails():
    sb = _SB({"bgb_good_games_received": RuntimeError("42883")})
    assert reaction_service.received_count(sb, ME) is None


def test_received_count_is_none_on_a_non_integer_answer():
    assert reaction_service.received_count(_SB({"bgb_good_games_received": None}), ME) is None


# ── GET /profile/bundle ─────────────────────────────────────────────────────

def _bundle(sb, target=None):
    return asyncio.run(P.get_profile_bundle(
        target_user_id=target, col_per_page=12, plays_per_page=10, viewer=USER,
    ))


def test_self_bundle_carries_good_games(monkeypatch):
    sb = _SB({"bgb_profile_bundle": {"stats": {}}, "bgb_good_games_received": 3})
    monkeypatch.setattr(P, "get_supabase", lambda: sb)
    out = _bundle(sb)
    assert out["good_games_received"] == 3
    assert out["stats"] == {}


def test_self_bundle_survives_a_failed_count(monkeypatch):
    sb = _SB({
        "bgb_profile_bundle": {"stats": {}},
        "bgb_good_games_received": RuntimeError("boom"),
    })
    monkeypatch.setattr(P, "get_supabase", lambda: sb)
    out = _bundle(sb)
    assert out["good_games_received"] is None
    assert out["stats"] == {}


def test_other_bundle_does_not_read_the_count(monkeypatch):
    sb = _SB({"bgb_profile_bundle": {"stats": {}}})
    monkeypatch.setattr(P, "get_supabase", lambda: sb)
    out = _bundle(sb, target=THEM)
    assert "good_games_received" not in out
    assert [c[0] for c in sb.calls] == ["bgb_profile_bundle"]


# ── GET /bootstrap ──────────────────────────────────────────────────────────

class _Dump:
    def __init__(self, data=None, **attrs):
        self._data = data if data is not None else {}
        for k, v in attrs.items():
            setattr(self, k, v)

    def model_dump(self, mode=None):
        return self._data


@pytest.fixture
def boot(monkeypatch):
    async def feed(*_a, **_k):
        return _Dump({"items": []}, next_cursor=None)

    async def notifs(*_a, **_k):
        return _Dump({"items": []}, unread=0)

    monkeypatch.setattr(B.feed_service, "build_feed_page", feed)
    monkeypatch.setattr(B.notification_service, "list_notifications", notifs)
    monkeypatch.setattr(B.game_service, "recently_played", lambda *a, **k: [])
    monkeypatch.setattr(B.played_with_service, "fetch_play_partners", lambda *a, **k: _Dump({}))
    monkeypatch.setattr(B.release_notice_service, "unseen", lambda *a, **k: [])
    monkeypatch.setattr(B.rank_service, "list_ranks", lambda *a, **k: [])
    monkeypatch.setattr(B.rank_service, "queue", lambda *a, **k: [])
    return monkeypatch


def test_bootstrap_seeds_good_games_into_the_profile_bundle(boot):
    sb = _SB({
        "bgb_bootstrap": {"profile_bundle": {"stats": {}}},
        "bgb_good_games_received": 5,
    })
    boot.setattr(B, "get_supabase", lambda: sb)
    out = asyncio.run(B.get_bootstrap(user=USER))
    assert out["profile_bundle"]["good_games_received"] == 5
