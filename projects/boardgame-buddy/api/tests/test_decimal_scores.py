"""Scores may be decimals: two places, and whole numbers stay ints.

A score of 12.5 is stored and echoed as 12.5; a score of 12 is 12, never 12.0,
on every model a play or a live round is read or written through. The round
sum is rounded to two places so a breakdown like 0.1 + 0.2 stores 0.3 rather
than float noise.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from routes.models import (  # noqa: E402
    ParsedPlayer,
    PlayerEntry,
    PlayPlayerResponse,
    SessionScoreRow,
    tidy_score,
)
from routes.services.play_import_ai import _coerce_score  # noqa: E402


def test_tidy_score_keeps_whole_numbers_as_ints():
    assert tidy_score(12.0) == 12 and isinstance(tidy_score(12.0), int)
    assert tidy_score(7) == 7
    assert tidy_score(None) is None


def test_tidy_score_rounds_to_two_places():
    assert tidy_score(12.3456) == 12.35
    assert tidy_score(0.1 + 0.2) == 0.3


def test_player_entry_accepts_decimal_rounds_and_sums_them():
    p = PlayerEntry.model_validate(
        {"name": "Dmitri", "round_scores": [10, 2.5, None, 0.1, 0.2]}
    )
    assert p.round_scores == [10, 2.5, None, 0.1, 0.2]
    assert p.score == 12.8


def test_player_entry_whole_sum_is_an_int():
    p = PlayerEntry.model_validate({"name": "Cleo", "round_scores": [1.5, 1.5]})
    assert p.score == 3 and isinstance(p.score, int)
    assert p.model_dump()["score"] == 3


def test_read_models_echo_decimals_and_ints_unchanged():
    row = PlayPlayerResponse.model_validate(
        {"name": "Max", "is_winner": False, "score": 9.0, "round_scores": [4.5, 4.5]}
    )
    assert row.score == 9 and isinstance(row.score, int)
    assert row.round_scores == [4.5, 4.5]
    live = SessionScoreRow(participant_id="p", round_index=0, score=2.5)
    assert live.score == 2.5
    assert ParsedPlayer(name="Max", score=7.25).score == 7.25


def test_photo_import_reads_decimal_scores():
    assert _coerce_score("12.5") == 12.5
    assert _coerce_score(12.0) == 12
    assert _coerce_score("nan") is None
    assert _coerce_score("twelve") is None
