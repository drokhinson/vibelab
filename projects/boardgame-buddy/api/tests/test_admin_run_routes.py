"""The two read endpoints behind the admin run log.

What is pinned: both are admin-gated; an unknown tool slug is a 422 rather
than an empty log that reads as a finished run; a tool with no record answers
`unknown` while still naming the tool it is about; the summary list carries no
journal; and the per-tool read carries the whole thing.
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
import routes  # noqa: E402
from routes.constants import AdminRunTool, AdminTrendingPhase  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402
from routes.services import admin_run_progress as A  # noqa: E402

BASE = "/api/v1/boardgame_buddy/admin/runs"


@pytest.fixture
def client():
    cache.clear(A._NS)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="u1", display_name="Dana", username="dana", is_admin=True
    )
    yield TestClient(app)
    cache.clear(A._NS)


def test_no_record_is_unknown_and_still_names_its_tool(client):
    """For an admin run, unknown means NOTHING HAS RUN RECENTLY — the page's
    idle state. The BGG check's identical field means "still working"; the two
    must not be conflated, so the tool has to come back either way."""
    r = client.get(f"{BASE}/trending")
    assert r.status_code == 200
    assert r.json()["state"] == "unknown"
    assert r.json()["tool"] == "trending"
    assert r.json()["events"] == []


def test_an_unknown_tool_is_rejected_not_answered_empty(client):
    assert client.get(f"{BASE}/not-a-tool").status_code == 422


def test_a_live_run_comes_back_with_its_checklist_and_log(client):
    led = A.open(AdminRunTool.TRENDING, started_by="Dana")
    led.begin(AdminTrendingPhase.IMPORT, total=10)
    led.tick(AdminTrendingPhase.IMPORT, 4, detail="Ark Nova")
    led.event(AdminTrendingPhase.IMPORT, "Imported Ark Nova (BGG 342942)")
    led.add_totals(updated=4, failed=1, remaining=6)

    body = client.get(f"{BASE}/trending").json()
    assert body["state"] == "running"
    assert body["started_by"] == "Dana"
    assert body["totals"] == {"updated": 4, "failed": 1, "remaining": 6}
    step = next(s for s in body["steps"] if s["key"] == "import")
    assert (step["state"], step["done"], step["total"], step["detail"]) == (
        "active", 4, 10, "Ark Nova",
    )
    assert [e["message"] for e in body["events"]] == ["Imported Ark Nova (BGG 342942)"]


def test_the_summary_list_carries_no_journal(client):
    led = A.open(AdminRunTool.BGG_STATS)
    led.event(AdminTrendingPhase.IMPORT, "a line nobody needs on the Settings card")
    rows = client.get(BASE).json()
    assert len(rows) == 1
    assert "events" not in rows[0]
    assert rows[0]["tool"] == "bgg-stats"


def test_the_summary_list_omits_tools_that_have_not_run(client):
    A.open(AdminRunTool.BGG_IMAGES)
    assert [r["tool"] for r in client.get(BASE).json()] == ["bgg-images"]


def test_both_reads_are_admin_gated():
    """Walked from the router so a third read endpoint cannot forget."""
    run_routes = [
        r for r in routes.router.routes
        if getattr(r, "path", "").endswith("/admin/runs")
        or "/admin/runs/{tool}" in getattr(r, "path", "")
    ]
    assert len(run_routes) == 2, "route list changed — check the gate still holds"
    for route in run_routes:
        calls = [d.call for d in route.dependant.dependencies]
        assert get_current_admin in calls, f"{route.path} is not admin-gated"
