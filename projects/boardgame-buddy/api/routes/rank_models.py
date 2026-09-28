"""Pydantic models for game ranking (migration 056).

Their own module rather than more of models.py, which is past ten times the
~300-line ceiling; GameSummary is imported from there so a ranked game is the
same object every other payload carries.
"""

from pydantic import BaseModel, Field

from .constants import RankTier
from .models import GameSummary


class RankEntry(BaseModel):
    """Where one game sits in the viewer's ranking.

    `position` is the player-facing number, 1-based across the whole
    category with the tiers stacked love → good → not: "#3 Family".
    """

    game_id: str
    category: str
    category_label: str
    tier: RankTier
    position: int


class RanksResponse(BaseModel):
    """Every game the viewer has ranked. Small — tens of rows — so the client
    holds it whole and reads the game page pill and the top-5 chips off it."""

    ranks: list[RankEntry]


class RankedGame(BaseModel):
    """One row of a category's ranking, for the comparison questions."""

    game: GameSummary
    tier: RankTier
    position: int


class RankContext(BaseModel):
    """What the ranking sheet needs for one game.

    `ranked` is the category's ranking WITHOUT this game, in order, because
    that is the list the questions binary-search it into. `rank` is where it
    sits now, or None when it has not been ranked.
    """

    game: GameSummary
    category: str
    category_label: str
    rank: RankEntry | None = None
    ranked: list[RankedGame]


class RankWrite(BaseModel):
    """Place a game: its tier, and its 0-based index within that tier among
    the OTHER games in it (the list RankContext.ranked shows for that tier).
    The server clamps the index, so a list that changed since cannot open a
    hole."""

    tier: RankTier
    index: int = Field(..., ge=0, le=10_000)


class RankQueueItem(BaseModel):
    game: GameSummary
    category: str
    category_label: str


class RankQueueResponse(BaseModel):
    """Owned or played games the viewer has not ranked yet, A to Z."""

    items: list[RankQueueItem]


class RankRemoveResponse(BaseModel):
    removed: bool
