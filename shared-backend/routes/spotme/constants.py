"""Shared constants for SpotMe API."""

import os

JWT_SECRET = os.environ.get("SPOTME_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"

# Generic fallback levels used for hobbies without a specific preset
DEFAULT_LEVELS = [
    {"value": "want_to_learn", "label": "Want to Learn"},
    {"value": "beginner",      "label": "Beginner"},
    {"value": "intermediate",  "label": "Intermediate"},
    {"value": "advanced",      "label": "Advanced"},
    {"value": "expert",        "label": "Expert"},
]

# Hobby-specific level presets keyed by hobby slug.
# All presets begin with "want_to_learn" so users can express interest before committing.
_WANT = {"value": "want_to_learn", "label": "Want to Learn"}

HOBBY_LEVEL_PRESETS: dict[str, list[dict]] = {
    # ── Winter sports ──────────────────────────────────────────────────────────
    "skiing": [
        _WANT,
        {"value": "green_circle",  "label": "Green Circle"},
        {"value": "blue_square",   "label": "Blue Square"},
        {"value": "black_diamond", "label": "Black Diamond"},
        {"value": "double_black",  "label": "Double Black Diamond"},
    ],
    "snowboarding": [
        _WANT,
        {"value": "green_circle",  "label": "Green Circle"},
        {"value": "blue_square",   "label": "Blue Square"},
        {"value": "black_diamond", "label": "Black Diamond"},
        {"value": "double_black",  "label": "Double Black Diamond"},
    ],
    # ── Rock climbing ──────────────────────────────────────────────────────────
    "rock-climbing": [
        _WANT,
        {"value": "top_rope",   "label": "Top Rope"},
        {"value": "sport_510",  "label": "Sport 5.10"},
        {"value": "sport_512",  "label": "Sport 5.12+"},
        {"value": "trad",       "label": "Trad / Multi-pitch"},
    ],
    # ── Mountain biking ────────────────────────────────────────────────────────
    "mountain-biking": [
        _WANT,
        {"value": "flow_trails",   "label": "Flow Trails"},
        {"value": "technical_xc",  "label": "Technical XC"},
        {"value": "enduro",        "label": "Enduro"},
        {"value": "dh",            "label": "DH / Park"},
    ],
    # ── Water sports ───────────────────────────────────────────────────────────
    "surfing": [
        _WANT,
        {"value": "white_water",  "label": "White Water"},
        {"value": "green_waves",  "label": "Green Waves"},
        {"value": "overhead",     "label": "Overhead+"},
        {"value": "big_wave",     "label": "Big Wave"},
    ],
    "kayaking": [
        _WANT,
        {"value": "flatwater",  "label": "Flatwater"},
        {"value": "class_ii",   "label": "Class II-III"},
        {"value": "class_iv",   "label": "Class IV+"},
        {"value": "expedition", "label": "Expedition"},
    ],
    # ── Board & video games ────────────────────────────────────────────────────
    "board-games": [
        _WANT,
        {"value": "casual",   "label": "Casual (Party Games)"},
        {"value": "gamer",    "label": "Gamer (40-90 min strategy)"},
        {"value": "hardcore", "label": "Hardcore (no time limit)"},
    ],
    "video-games": [
        _WANT,
        {"value": "casual",      "label": "Casual"},
        {"value": "regular",     "label": "Regular"},
        {"value": "competitive", "label": "Competitive"},
        {"value": "pro",         "label": "Pro / Esports"},
    ],
}


def get_levels_for_hobby(slug: str) -> list[dict]:
    """Return the skill-level list appropriate for the given hobby slug."""
    return HOBBY_LEVEL_PRESETS.get(slug, DEFAULT_LEVELS)


# Keep for backwards compatibility — existing code that imports PROFICIENCY_LEVELS
# will still get the flat list of value strings.
PROFICIENCY_LEVELS = [lvl["value"] for lvl in DEFAULT_LEVELS]
