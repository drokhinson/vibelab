"""/bootstrap carries the viewer's ranking (ranks + rank_queue), and a failing
rank read boots without it rather than failing the whole payload."""

import asyncio
import os

os.environ.setdefault("SUPABASE_URL", "http://test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

from routes import bootstrap_routes as B  # noqa: E402
from routes.constants import RankTier  # noqa: E402
from routes.dependencies import CurrentUser  # noqa: E402
from routes.rank_models import RankEntry  # noqa: E402

ME = "00000000-0000-0000-0000-00000000000a"
USER = CurrentUser(user_id=ME, display_name="Me", username="me", is_admin=False)


class _Dump:
    def __init__(self, data=None, **attrs):
        self._data = data if data is not None else {}
        for k, v in attrs.items():
            setattr(self, k, v)

    def model_dump(self, mode=None):
        return self._data


class _Rpc:
    def execute(self):
        return type("R", (), {"data": {"bootstrap_version": 2}})()


class _SB:
    def rpc(self, *_a, **_k):
        return _Rpc()


@pytest.fixture
def stubbed(monkeypatch):
    monkeypatch.setattr(B, "get_supabase", lambda: _SB())

    async def feed(*_a, **_k):
        return _Dump({"items": []}, next_cursor=None)

    async def notifs(*_a, **_k):
        return _Dump({"items": []}, unread=0, pending=0)

    monkeypatch.setattr(B.feed_service, "build_feed_page", feed)
    monkeypatch.setattr(B.notification_service, "list_notifications", notifs)
    monkeypatch.setattr(B.game_service, "recently_played", lambda *a, **k: [])
    monkeypatch.setattr(B.played_with_service, "fetch_play_partners", lambda *a, **k: _Dump({}))
    monkeypatch.setattr(B.release_notice_service, "unseen", lambda *a, **k: [])
    return monkeypatch


def _entry():
    return RankEntry(game_id="g", category="family", category_label="Family",
                     tier=RankTier.LOVE, position=1, score=10.0)


def test_bootstrap_carries_ranks_and_the_queue(stubbed):
    stubbed.setattr(B.rank_service, "list_ranks", lambda sb, uid: [_entry()])
    stubbed.setattr(B.rank_service, "queue", lambda sb, uid: [])
    payload = asyncio.run(B.get_bootstrap(user=USER))
    assert payload["ranks"] == [_entry().model_dump(mode="json")]
    assert payload["rank_queue"] == []
    assert payload["bootstrap_version"] == 2


def test_a_failing_rank_read_boots_without_it(stubbed):
    def boom(*_a):
        raise RuntimeError("db down")

    stubbed.setattr(B.rank_service, "list_ranks", boom)
    stubbed.setattr(B.rank_service, "queue", lambda sb, uid: [])
    payload = asyncio.run(B.get_bootstrap(user=USER))
    assert payload["ranks"] is None
    assert payload["rank_queue"] == []
