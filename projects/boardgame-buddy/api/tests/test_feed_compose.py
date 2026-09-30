"""The Feed shows a Suggested Buddies card only at FEED_MIN_BUDDY_SUGGESTIONS
or more suggestions."""

import os

os.environ.setdefault("SUPABASE_URL", "http://test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402

from routes.models import FeedSuggestedBuddy, SuggestedBuddiesResponse  # noqa: E402
from routes.services import feed_service as F  # noqa: E402


def _sug(n: int) -> SuggestedBuddiesResponse:
    return SuggestedBuddiesResponse(
        suggestions=[
            FeedSuggestedBuddy(user_id=f"u{i}", display_name=f"U{i}", mutual_count=1)
            for i in range(n)
        ]
    )


def _kinds(n: int) -> list[str]:
    page = F._compose_page([], None, None, _sug(n))
    return [c.kind for c in page.cards]


@pytest.mark.parametrize("n", [0, 1, F.FEED_MIN_BUDDY_SUGGESTIONS - 1])
def test_too_few_suggestions_is_no_card(n):
    assert _kinds(n) == []


@pytest.mark.parametrize("n", [F.FEED_MIN_BUDDY_SUGGESTIONS, 5])
def test_enough_suggestions_is_a_card(n):
    assert _kinds(n) == ["suggested_buddies"]
