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
    `score` is the same place read as a rating out of 10, which the client
    shows once a game falls out of its category's top 3 (see
    rank_service._score).
    """

    game_id: str
    category: str
    category_label: str
    tier: RankTier
    position: int
    score: float
    # The ranked game itself, so a client holding the ranking can build the
    # "which do you prefer?" list without asking for it (Rank.localContext).
    # Optional: absent from a row cached before it was added.
    game: GameSummary | None = None


class RankPlaced(RankEntry):
    """PUT /ranks/games/{id}: the game's new entry, plus the viewer's whole
    ranking after the write — every other game in the category may have moved
    — so the client can replace its cached copy rather than refetch it."""

    ranks: list[RankEntry]


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
