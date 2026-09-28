"""Which list a game is ranked in — decided by BoardGameGeek, not the player.

The player is told "Ranking against your Family games" and never picks. The
answer is BGG's own family ranks (bgg_family, migration 056) where the game has
one, and otherwise a fallback read off the categories and weight the catalog
already holds, so a game the metadata backfill has not reached yet still gets a
sensible list rather than a blank.
"""

from typing import Any

# Order is the order the categories are listed in, most common first.
CATEGORY_LABELS: dict[str, str] = {
    "strategy": "Strategy",
    "family": "Family",
    "party": "Party",
    "thematic": "Thematic",
    "war": "War",
    "abstract": "Abstract",
    "children": "Children's",
    "customizable": "Customizable",
}

# BGG's <rank type="family" name="…"> values → our category.
BGG_FAMILY_TO_CATEGORY: dict[str, str] = {
    "strategygames": "strategy",
    "familygames": "family",
    "partygames": "party",
    "thematic": "thematic",
    "wargames": "war",
    "abstracts": "abstract",
    "childrensgames": "children",
    "cgs": "customizable",
}

# BGG category tags that say plainly which list a game belongs in. Checked in
# this order; the first hit wins.
_CATEGORY_TAGS: list[tuple[str, str]] = [
    ("Party Game", "party"),
    ("Children's Game", "children"),
    ("Wargame", "war"),
    ("Abstract Strategy", "abstract"),
    ("Collectible Components", "customizable"),
]

# Without a family or a telling tag, weight splits the rest. 2.5 is roughly
# where BGG's own Family and Strategy lists stop overlapping.
_STRATEGY_WEIGHT = 2.5


def rank_category(game: dict[str, Any]) -> str:
    """The category key a catalog row is ranked in."""
    family = BGG_FAMILY_TO_CATEGORY.get(game.get("bgg_family") or "")
    if family:
        return family
    tags = set(game.get("categories") or [])
    for tag, category in _CATEGORY_TAGS:
        if tag in tags:
            return category
    weight = game.get("bgg_weight")
    try:
        if weight is not None and float(weight) >= _STRATEGY_WEIGHT:
            return "strategy"
    except (TypeError, ValueError):
        pass
    return "family"


def category_label(category: str) -> str:
    """"Family" for "family"; a stored key we no longer know is title-cased."""
    return CATEGORY_LABELS.get(category, category.replace("_", " ").title())
