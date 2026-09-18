"""The admin Usage spoke: the R2 walk, the two caches, and the gate.

What is pinned here is the part that is easy to get quietly wrong:

  - `usage()` sums across PAGES. A single-page fake would pass against a
    version that reads only the first 1000 keys, which is the whole bug the
    paginator exists to avoid.
  - An unconfigured bucket is DATA, not an exception, and an unlistable one is
    scoped to itself — the two buckets have separate permissions, so one
    refusing must not take the other's number down with it.
  - The page ceiling reports a floor rather than a silent partial sum.
  - Both caches serve the second call without a second read, and `refresh`
    bypasses them. Without this the R2 walk would run on every repaint.
  - Both endpoints are admin-gated, walked from the router so a third one
    cannot forget.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cache  # noqa: E402
import object_store  # noqa: E402
import routes  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402
from routes.services import usage_service as U  # noqa: E402

BASE = "/api/v1/boardgame_buddy/admin/usage"

R2_ENV = {
    "R2_ACCOUNT_ID": "acct123",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
    "R2_PLAYS_BUCKET": "bgb-plays",
    "R2_GAMES_BUCKET": "bgb-games",
    "R2_PLAYS_PUBLIC_BASE": "https://img.bgbuddy.app",
    "R2_GAMES_PUBLIC_BASE": "https://covers.bgbuddy.app",
}


@pytest.fixture
def configured(monkeypatch):
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    object_store.reload()
    yield
    object_store.reload()


@pytest.fixture
def unconfigured(monkeypatch):
    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)
    object_store.reload()
    yield
    object_store.reload()


class _FakePaginator:
    def __init__(self, pages_by_bucket, error=None):
        self._pages = pages_by_bucket
        self._error = error

    def paginate(self, Bucket):  # noqa: N803 — boto3's own casing
        if self._error:
            raise self._error
        for page in self._pages.get(Bucket, []):
            yield page


class _FakeS3:
    def __init__(self, pages_by_bucket, error=None):
        self._paginator = _FakePaginator(pages_by_bucket, error)

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return self._paginator


def _pages(*sizes_per_page):
    """One page per argument, each a list of object sizes."""
    return [
        {"Contents": [{"Key": f"k{i}-{j}", "Size": s} for j, s in enumerate(sizes)]}
        for i, sizes in enumerate(sizes_per_page)
    ]


# ── object_store.usage() ─────────────────────────────────────────────────────

def test_usage_sums_across_pages(configured, monkeypatch):
    """Two pages per bucket, so a first-page-only read cannot pass."""
    monkeypatch.setattr(object_store, "_s3", lambda: _FakeS3({
        "bgb-plays": _pages([100, 200], [300]),
        "bgb-games": _pages([7], [8, 9]),
    }))
    out = object_store.usage()
    assert out["plays"] == {
        "configured": True, "objects": 3, "bytes": 600,
        "truncated": False, "error": None,
    }
    assert out["games"]["objects"] == 3
    assert out["games"]["bytes"] == 24


def test_usage_unconfigured_is_data_not_an_exception(unconfigured):
    out = object_store.usage()
    for kind in ("plays", "games"):
        assert out[kind]["configured"] is False
        assert out[kind]["objects"] == 0
        assert out[kind]["bytes"] == 0
        assert out[kind]["error"] is None


def test_usage_truncates_at_the_page_ceiling(configured, monkeypatch):
    """Past the ceiling the number is a FLOOR and says so, rather than being a
    silent partial sum the screen would render as the whole truth."""
    monkeypatch.setattr(object_store, "_USAGE_MAX_PAGES", 2)
    monkeypatch.setattr(object_store, "_s3", lambda: _FakeS3({
        "bgb-plays": _pages([1], [1], [1], [1]),
        "bgb-games": [],
    }))
    out = object_store.usage()
    assert out["plays"]["truncated"] is True
    assert out["plays"]["objects"] == 2, "walk did not stop at the ceiling"
    assert out["games"]["truncated"] is False


def test_a_listing_failure_is_scoped_to_its_own_bucket(configured, monkeypatch):
    """Separate buckets, separate permissions. A token that cannot list cover
    art can still list play photos, and raising would hide the good number."""
    class _OneBucketFails:
        def get_paginator(self, name):
            return self

        def paginate(self, Bucket):  # noqa: N803
            if Bucket == "bgb-games":
                raise RuntimeError("AccessDenied")
            yield from _pages([42])

    monkeypatch.setattr(object_store, "_s3", lambda: _OneBucketFails())
    out = object_store.usage()
    assert out["plays"]["bytes"] == 42
    assert out["plays"]["error"] is None
    assert "AccessDenied" in out["games"]["error"]
    # The bucket it was signing for is named, because AccessDenied is also what
    # a missing R2_JURISDICTION produces — see put()'s error text.
    assert "bgb-games" in out["games"]["error"]
    assert out["games"]["objects"] == 0


# ── the caches ───────────────────────────────────────────────────────────────

class _FakeSupabase:
    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    def rpc(self, name, params=None):
        assert name == "bgb_admin_usage_stats"
        self.calls += 1
        return self

    def execute(self):
        return type("R", (), {"data": self.payload})()


@pytest.fixture(autouse=True)
def _clean_cache():
    U.invalidate()
    yield
    U.invalidate()


def test_usage_payload_is_cached_then_bypassed_by_refresh():
    sb = _FakeSupabase({"users": {"total": 3}})
    assert U.fetch_usage(sb)["users"]["total"] == 3
    U.fetch_usage(sb)
    assert sb.calls == 1, "second read should have come from cache"
    U.fetch_usage(sb, refresh=True)
    assert sb.calls == 2, "refresh should have bypassed the cache"


def test_bucket_walk_is_cached_then_bypassed_by_refresh(monkeypatch):
    calls = {"n": 0}

    def _fake_usage():
        calls["n"] += 1
        return {"plays": {"configured": True, "objects": 1, "bytes": 5,
                          "truncated": False, "error": None}}

    monkeypatch.setattr(object_store, "usage", _fake_usage)
    assert U.fetch_bucket_usage()["buckets"]["plays"]["bytes"] == 5
    U.fetch_bucket_usage()
    assert calls["n"] == 1, "the R2 walk ran twice — it must be cached"
    U.fetch_bucket_usage(refresh=True)
    assert calls["n"] == 2


# ── the endpoints ────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="u1", display_name="Dana", username="dana", is_admin=True
    )
    yield TestClient(app)


def test_usage_endpoint_passes_the_rpc_payload_through(client, monkeypatch):
    payload = {"users": {"total": 7}, "screens": [], "generated_at": "2026-01-01T00:00:00Z"}
    monkeypatch.setattr(U, "fetch_usage", lambda sb, refresh=False: payload)
    assert client.get(BASE).json() == payload


def test_buckets_endpoint_reports_an_unconfigured_bucket_as_a_200(client, monkeypatch):
    """Local dev and a pre-cutover deploy both look like this. It must not 502:
    the screen renders a "not configured" state off this shape."""
    monkeypatch.setattr(U, "fetch_bucket_usage", lambda refresh=False: {
        "buckets": {"plays": {"configured": False, "objects": 0, "bytes": 0,
                              "truncated": False, "error": None}}
    })
    r = client.get(f"{BASE}/buckets")
    assert r.status_code == 200
    assert r.json()["buckets"]["plays"]["configured"] is False


def test_both_reads_are_admin_gated():
    """Walked from the router so a third usage endpoint cannot forget."""
    usage_routes = [
        r for r in routes.router.routes
        if getattr(r, "path", "").endswith("/admin/usage")
        or getattr(r, "path", "").endswith("/admin/usage/buckets")
    ]
    assert len(usage_routes) == 2, "route list changed — check the gate still holds"
    for route in usage_routes:
        calls = [d.call for d in route.dependant.dependencies]
        assert get_current_admin in calls, f"{route.path} is not admin-gated"
