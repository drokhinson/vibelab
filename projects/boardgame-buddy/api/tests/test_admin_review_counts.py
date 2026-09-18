"""The admin review counts — the gear's dot and the per-row badges.

Lodged in test_description_backfill.py until migration 045 deleted that file's
subject. They were only ever there by accident of chronology; the counts are
their own endpoint with their own failure mode, which is over-reporting.

THREE COUNTS, NOT FIVE. The description, stats and publisher queues became one
metadata queue, and collapsing them fixed an over-count as well as three round
trips: a game missing both its blurb and its year used to be counted twice, so
the dot claimed more work than existed.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routes import router as bgb_router  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402


class _CountQuery:
    def __init__(self, name, counts, log):
        self.name, self.counts, self.log = name, counts, log
        self._filters = []

    def select(self, *_a, **kw):
        self.log.append(("select", self.name, kw.get("count")))
        return self

    def eq(self, col, val):
        self._filters.append(f"{col}={val}")
        return self

    def is_(self, col, val):
        self._filters.append(f"{col} is {val}")
        return self

    def or_(self, expr):
        self._filters.append(f"or({expr})")
        return self

    @property
    def not_(self):
        # PostgREST's negation prefix: `.not_.is_(col, "null")` reads as
        # "col IS NOT NULL". Recorded with the prefix so the two spellings
        # cannot collide in the counts map below.
        outer = self

        class _Not:
            def is_(self_, col, val):
                outer._filters.append(f"not {col} is {val}")
                return outer

        return _Not()

    def limit(self, *_a):
        return self

    def execute(self):
        key = (self.name, ",".join(sorted(self._filters)))
        return type("R", (), {"data": [], "count": self.counts.get(key, 0)})()


@pytest.fixture
def counts_client(monkeypatch):
    log = []
    counts = {
        ("boardgamebuddy_chapter_reports", "status=open"): 2,
        ("boardgamebuddy_games", "or(image_url.is.null,thumbnail_url.is.null)"): 5,
        ("boardgamebuddy_games",
         "not bgg_id is null,or(description.is.null,bgg_stats_synced_at.is.null,"
         "publishers.is.null,year_published.is.null)"): 40,
    }

    class _SB:
        def table(self, name):
            return _CountQuery(name, counts, log)

    from routes import admin_routes as A

    monkeypatch.setattr(A, "get_supabase", lambda: _SB())
    app = FastAPI()
    app.include_router(bgb_router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="admin-1", display_name="Admin", username="admin", is_admin=True
    )
    c = TestClient(app)
    c.log = log
    return c


COUNTS_URL = "/api/v1/boardgame_buddy/admin/review-counts"


def test_review_counts_reports_each_queue(counts_client):
    body = counts_client.get(COUNTS_URL).json()
    assert body["chapter_reports"] == 2
    assert body["missing_images"] == 5
    assert body["missing_metadata"] == 40


def test_review_counts_total_is_derived_not_sent(counts_client):
    # Computed server-side so the gear's dot and the per-row badges can never
    # disagree about whether there is anything waiting.
    assert counts_client.get(COUNTS_URL).json()["total"] == 47


def test_review_counts_uses_exact_count_not_row_fetches(counts_client):
    counts_client.get(COUNTS_URL)
    selects = [row for row in counts_client.log if row[0] == "select"]
    assert len(selects) == 3
    # Every one asks PostgREST for the count header rather than the rows.
    assert all(row[2] == "exact" for row in selects), selects


def test_review_counts_requires_admin():
    app = FastAPI()
    app.include_router(bgb_router)
    assert TestClient(app).get(COUNTS_URL).status_code in (401, 403)


def test_a_game_short_of_two_things_is_counted_once(counts_client):
    """The payoff of the collapse. Three overlapping queues counted a game
    missing both its blurb and its year twice, and the gear's dot summed them."""
    body = counts_client.get(COUNTS_URL).json()
    assert body["missing_metadata"] == 40, (
        "one row per incomplete game, however many fields it is short of"
    )
