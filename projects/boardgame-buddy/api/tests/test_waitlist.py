"""The waitlist answers a write failure differently from a bad address.

`ok=false` used to mean both, and the landing view words it as "that address
doesn't look right" — so an outage told visitors who typed a perfectly good
address that they had made a typo. They blame themselves and leave, which is
the one failure on this endpoint with a lasting cost.

The split is pinned here rather than left to the comment because the two paths
look alike from inside the function (both are "the insert did not happen") and
collapsing them back would be a natural-looking simplification.

The duplicate case is pinned for the opposite reason: it MUST stay
indistinguishable from a fresh save, or the endpoint becomes a way to test
whether a given person signed up.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

import cache
import routes.waitlist_routes as wl
from main import app

PATH = "/api/v1/boardgame_buddy/waitlist"


class _Insert:
    def __init__(self, raise_exc):
        self._raise = raise_exc

    def execute(self):
        if self._raise:
            raise self._raise
        return object()


class _Table:
    def __init__(self, raise_exc):
        self._raise = raise_exc
        self.rows = []

    def insert(self, row):
        self.rows.append(row)
        return _Insert(self._raise)


class _Client:
    def __init__(self, raise_exc=None):
        self.table_obj = _Table(raise_exc)

    def table(self, name):
        assert name == "boardgamebuddy_waitlist"
        return self.table_obj


@pytest.fixture
def client(monkeypatch):
    # The throttle is a process-global keyed on IP, and TestClient reports the
    # same IP every time — so without this every test after the first would be
    # short-circuited into ok=true and pass vacuously.
    cache.clear(wl._THROTTLE_NS)
    return TestClient(app)


def _patch(monkeypatch, raise_exc=None):
    c = _Client(raise_exc)
    monkeypatch.setattr(wl, "get_supabase", lambda: c)
    return c


def test_fresh_signup_is_ok(client, monkeypatch):
    c = _patch(monkeypatch)
    res = client.post(PATH, json={"email": "a@example.com", "source": "landing"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert c.table_obj.rows == [{"email": "a@example.com", "source": "landing"}]


def test_duplicate_is_indistinguishable_from_a_fresh_save(client, monkeypatch):
    """Same status, same body. Anything else is an enumeration oracle."""
    dup = APIError({"code": wl._UNIQUE_VIOLATION, "message": "duplicate key"})
    _patch(monkeypatch, dup)
    res = client.post(PATH, json={"email": "a@example.com"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}


@pytest.mark.parametrize(
    "email",
    ["", "   ", "nope", "no@domain", "a@b.c", "two@@at.com", "sp ace@example.com",
     "a@" + "x" * 300 + ".com"],
)
def test_unusable_address_is_ok_false_not_an_error(client, monkeypatch, email):
    """A bad address is the ONE case that answers ok=false, and it never
    reaches the database."""
    c = _patch(monkeypatch)
    res = client.post(PATH, json={"email": email})
    assert res.status_code in (200, 422)  # 422 when the field exceeds max_length
    if res.status_code == 200:
        assert res.json() == {"ok": False}
    assert c.table_obj.rows == []


def test_missing_table_is_503_not_ok_false(client, monkeypatch):
    """The state before migration 035 runs. This is the regression: a 200
    ok=false here makes the landing view blame the visitor's typing."""
    missing = APIError({"code": "42P01", "message": 'relation ... does not exist'})
    _patch(monkeypatch, missing)
    res = client.post(PATH, json={"email": "a@example.com"})
    assert res.status_code == 503
    assert res.json()["detail"]


def test_unexpected_exception_is_503_not_ok_false(client, monkeypatch):
    _patch(monkeypatch, RuntimeError("connection reset"))
    res = client.post(PATH, json={"email": "a@example.com"})
    assert res.status_code == 503


def test_throttle_answers_ok_without_a_second_write(client, monkeypatch):
    c = _patch(monkeypatch)
    assert client.post(PATH, json={"email": "a@example.com"}).json() == {"ok": True}
    assert client.post(PATH, json={"email": "b@example.com"}).json() == {"ok": True}
    assert len(c.table_obj.rows) == 1
