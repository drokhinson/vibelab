"""format_reason is the one writer of the line under every Discover pick.

A pick is labelled by WHY it is there — never by its score — and the label is
composed server-side so the client cannot drift from it. Each reason kind has
one phrasing, the mechanics phrasing changes shape at one, two and three-plus,
and a kind whose data is missing falls through to the next rather than
rendering an empty line.

Pure function, so no Supabase fake and no network.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.constants import DiscoverReasonKind as K  # noqa: E402
from routes.services.discovery_service import format_reason  # noqa: E402


def test_because_you_play_names_the_seed_game():
    assert format_reason(K.BECAUSE_YOU_PLAY, reason_game_name="Wingspan") == "Because you play Wingspan"


def test_shared_mechanics_phrasing_by_count():
    assert format_reason(K.SHARED_MECHANICS, shared_mechanics=["Drafting"]) == \
        "Shares Drafting with your shelf"
    assert format_reason(K.SHARED_MECHANICS, shared_mechanics=["Drafting", "Set Collection"]) == \
        "Shares Drafting and Set Collection with your shelf"
    assert format_reason(K.SHARED_MECHANICS, shared_mechanics=["A", "B", "C"]) == \
        "Shares 3 mechanics with your shelf"


def test_shared_categories_uses_the_strongest_category():
    assert format_reason(K.SHARED_CATEGORIES, shared_categories=["Animals", "Economic"]) == \
        "More Animals like you play"


def test_table_fit_and_rating_are_fixed_lines():
    assert format_reason(K.FITS_YOUR_TABLE) == "Fits your usual table"
    assert format_reason(K.HIGHLY_RATED) == "Highly rated on BoardGameGeek"


def test_missing_data_falls_through_never_blank():
    # Labelled by the seed game but the name did not survive hydration: the
    # shared mechanics still explain it.
    assert format_reason(K.BECAUSE_YOU_PLAY, shared_mechanics=["Drafting"]) == \
        "Shares Drafting with your shelf"
    # Nothing personal survived at all: the rating line, not "".
    assert format_reason(K.SHARED_MECHANICS) == "Highly rated on BoardGameGeek"
    assert format_reason(K.SHARED_CATEGORIES, shared_categories=[""]) == "Highly rated on BoardGameGeek"
