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
    # ── Trail sports ───────────────────────────────────────────────────────────
    "trail-running": [
        _WANT,
        {"value": "5k_trail",   "label": "5K Trail"},
        {"value": "half_trail", "label": "Half Marathon Distance"},
        {"value": "marathon",   "label": "Marathon"},
        {"value": "ultra",      "label": "Ultra"},
    ],
    "hiking": [
        _WANT,
        {"value": "day_hikes",   "label": "Day Hikes"},
        {"value": "overnight",   "label": "Overnight"},
        {"value": "multi_day",   "label": "Multi-Day"},
        {"value": "peak_bagging","label": "Peak Bagging"},
    ],
    "swimming": [
        _WANT,
        {"value": "recreational", "label": "Recreational"},
        {"value": "lap_swimmer",  "label": "Lap Swimmer"},
        {"value": "competitive",  "label": "Competitive"},
        {"value": "open_water",   "label": "Open Water"},
    ],
    "yoga": [
        _WANT,
        {"value": "beginner",    "label": "Beginner"},
        {"value": "practitioner","label": "Practitioner"},
        {"value": "advanced",    "label": "Advanced / Teacher"},
    ],
    # ── Outdoors ───────────────────────────────────────────────────────────────
    "camping": [
        _WANT,
        {"value": "car_camper",  "label": "Car Camper"},
        {"value": "backpacker",  "label": "Backpacker"},
        {"value": "wilderness",  "label": "Wilderness / Off-grid"},
    ],
    "photography": [
        _WANT,
        {"value": "phone_shooter", "label": "Phone / Point-and-Shoot"},
        {"value": "dslr_hobbyist", "label": "DSLR Hobbyist"},
        {"value": "semi_pro",      "label": "Semi-Pro"},
        {"value": "professional",  "label": "Professional"},
    ],
    "bird-watching": [
        _WANT,
        {"value": "backyard_birder", "label": "Backyard Birder"},
        {"value": "local_lister",    "label": "Local Lister"},
        {"value": "serious_birder",  "label": "Serious Birder"},
    ],
    "fishing": [
        _WANT,
        {"value": "casual",     "label": "Casual"},
        {"value": "freshwater", "label": "Freshwater Angler"},
        {"value": "fly_fisher", "label": "Saltwater / Fly Fisher"},
    ],
    "gardening": [
        _WANT,
        {"value": "container",    "label": "Container / Patio"},
        {"value": "veggie_garden","label": "Veggie Garden"},
        {"value": "landscape",    "label": "Landscape / Permaculture"},
    ],
    # ── Crafting & Making ──────────────────────────────────────────────────────
    "pottery": [
        _WANT,
        {"value": "hand_building", "label": "Hand Building"},
        {"value": "wheel_throwing","label": "Wheel Throwing"},
        {"value": "glazing_firing","label": "Glazing & Firing"},
    ],
    "knitting": [
        _WANT,
        {"value": "scarves",    "label": "Scarves & Simple"},
        {"value": "patterns",   "label": "Intermediate Patterns"},
        {"value": "colorwork",  "label": "Complex Colorwork"},
    ],
    "woodworking": [
        _WANT,
        {"value": "weekend_diy",   "label": "Weekend DIY"},
        {"value": "furniture",     "label": "Furniture Making"},
        {"value": "fine_woodwork", "label": "Fine Woodworking"},
    ],
    "painting": [
        _WANT,
        {"value": "exploring",  "label": "Exploring Mediums"},
        {"value": "developing", "label": "Developing Style"},
        {"value": "exhibiting", "label": "Exhibiting / Selling"},
    ],
    "leathercraft": [
        _WANT,
        {"value": "basic_stitching", "label": "Basic Stitching"},
        {"value": "bags_accessories","label": "Bags & Accessories"},
        {"value": "custom_craft",    "label": "Custom Craft"},
    ],
    # ── Cooking & Baking ───────────────────────────────────────────────────────
    "thai-cooking": [
        _WANT,
        {"value": "home_cook",       "label": "Home Cook"},
        {"value": "dinner_party",    "label": "Dinner Party Host"},
        {"value": "recipe_developer","label": "Recipe Developer"},
    ],
    "italian-cooking": [
        _WANT,
        {"value": "home_cook",       "label": "Home Cook"},
        {"value": "dinner_party",    "label": "Dinner Party Host"},
        {"value": "recipe_developer","label": "Recipe Developer"},
    ],
    "baking": [
        _WANT,
        {"value": "simple_treats",  "label": "Simple Treats"},
        {"value": "layer_cakes",    "label": "Layer Cakes & Breads"},
        {"value": "patisserie",     "label": "Patisserie / Artisan"},
    ],
    "bbq-grilling": [
        _WANT,
        {"value": "backyard",   "label": "Backyard Griller"},
        {"value": "low_slow",   "label": "Low & Slow BBQ"},
        {"value": "pitmaster",  "label": "Pitmaster"},
    ],
    "japanese-cooking": [
        _WANT,
        {"value": "home_cook",       "label": "Home Cook"},
        {"value": "dinner_party",    "label": "Dinner Party Host"},
        {"value": "recipe_developer","label": "Recipe Developer"},
    ],
    # ── Music ──────────────────────────────────────────────────────────────────
    "guitar": [
        _WANT,
        {"value": "learning_basics", "label": "Learning Basics"},
        {"value": "playing_songs",   "label": "Playing Songs"},
        {"value": "gigging",         "label": "Gigging / Performing"},
    ],
    "piano": [
        _WANT,
        {"value": "learning_basics", "label": "Learning Basics"},
        {"value": "playing_songs",   "label": "Playing Songs"},
        {"value": "performing",      "label": "Performing"},
    ],
    "drums": [
        _WANT,
        {"value": "learning_basics", "label": "Learning Basics"},
        {"value": "playing_songs",   "label": "Playing Songs"},
        {"value": "gigging",         "label": "Gigging / Performing"},
    ],
    "singing": [
        _WANT,
        {"value": "shower_singer", "label": "Shower Singer"},
        {"value": "open_mic",      "label": "Open Mic"},
        {"value": "performing",    "label": "Performing"},
    ],
    # ── Tech ───────────────────────────────────────────────────────────────────
    "3d-printing": [
        _WANT,
        {"value": "printing_models",  "label": "Printing Models"},
        {"value": "customizing",      "label": "Customizing / Remixing"},
        {"value": "designing",        "label": "Designing from Scratch"},
    ],
    # ── Books & Reading ────────────────────────────────────────────────────────
    "fiction": [
        _WANT,
        {"value": "casual_reader",    "label": "Casual Reader"},
        {"value": "regular_reader",   "label": "Regular Reader"},
        {"value": "voracious_reader", "label": "Voracious Reader"},
    ],
    "non-fiction": [
        _WANT,
        {"value": "casual_reader",    "label": "Casual Reader"},
        {"value": "regular_reader",   "label": "Regular Reader"},
        {"value": "voracious_reader", "label": "Voracious Reader"},
    ],
    "sci-fi-fantasy": [
        _WANT,
        {"value": "casual_reader",    "label": "Casual Reader"},
        {"value": "regular_reader",   "label": "Regular Reader"},
        {"value": "voracious_reader", "label": "Voracious Reader"},
    ],
    # ── Movies & TV ────────────────────────────────────────────────────────────
    "film-buff": [
        _WANT,
        {"value": "casual_viewer",  "label": "Casual Viewer"},
        {"value": "regular_watcher","label": "Regular Watcher"},
        {"value": "cinephile",      "label": "Cinephile / Critic"},
    ],
    "documentaries": [
        _WANT,
        {"value": "casual_viewer",  "label": "Casual Viewer"},
        {"value": "regular_watcher","label": "Regular Watcher"},
        {"value": "enthusiast",     "label": "Enthusiast / Researcher"},
    ],
    "anime": [
        _WANT,
        {"value": "casual_viewer", "label": "Casual Viewer"},
        {"value": "regular_watcher","label": "Regular Watcher"},
        {"value": "otaku",         "label": "Otaku"},
    ],
}


def get_levels_for_hobby(slug: str) -> list[dict]:
    """Return the skill-level list appropriate for the given hobby slug."""
    return HOBBY_LEVEL_PRESETS.get(slug, DEFAULT_LEVELS)


# Keep for backwards compatibility — existing code that imports PROFICIENCY_LEVELS
# will still get the flat list of value strings.
PROFICIENCY_LEVELS = [lvl["value"] for lvl in DEFAULT_LEVELS]
