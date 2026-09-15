"""Scoring-grid chapter helpers (migration 018).

A scoring grid is a `layout='scoring_grid'` chapter whose rows live in the typed
`grid` JSONB column. `content` is NOT where the rows are stored — it carries a
generated plain-text mirror of them instead, which is what keeps three existing
behaviours working without a branch in each:

  * the chapter pool ILIKE-searches `content` (chapter_routes.browse_chapter_pool),
    so a JSON document there would make "blue", "rows" and "label" match every
    grid ever written;
  * the moderation queue slices `content[:240]` into its preview
    (chapter_routes.list_chapter_reports), so an admin triaging a report would
    read raw JSON;
  * three client surfaces feed `content` to renderMarkdown, so anything that has
    not learned about grids yet still renders something sensible.

The mirror is regenerated on every save and never hand-edited: `grid` is the
source of truth and `content` is derived from it.

This module exists at all so chapter_routes.py (already 728 lines against a ~300
guideline) does not grow further.
"""

from fastapi import HTTPException

from ..constants import ChapterLayout, ScoringGridMode
from ..models import ScoringGrid

# The chapter type a scoring grid must be filed under, seeded by migration 021
# at display_order 5 so it sorts above every other type in both the authoring
# picker and the guide scroll. The type and the layout are 1:1 and each holds
# half the truth — the type says the chapter is a scoring grid, the layout says
# its body is stored in `grid` rather than `content` — which is what the
# cross-check below exists to keep from drifting.
SCORING_GRID_CHAPTER_TYPE = "scoring_grid"


def validate_layout_pairing(
    layout: ChapterLayout | str | None,
    chapter_type: str | None,
) -> None:
    """Require layout and chapter type to agree, in BOTH directions.

    `layout == 'scoring_grid'` if and only if `chapter_type == 'scoring_grid'`.
    Rejecting only the first direction would leave the other half authorable:
    a 'scoring_grid' chapter with a text body renders as an empty section under
    a heading promising a table, because every renderer branches on the layout.

    Pydantic already ties `layout` to the presence of `grid` (ChapterCreate
    ._grid_matches_layout) and the DB ties it again (bgb_chapters_grid_shape).
    Neither can see the chapter TYPE, which is the third thing that has to
    agree — nothing else stops the two drifting.
    """
    if layout is None or chapter_type is None:
        return
    is_grid_layout = str(layout) == ChapterLayout.SCORING_GRID
    is_grid_type = chapter_type == SCORING_GRID_CHAPTER_TYPE
    if is_grid_layout == is_grid_type:
        return
    if is_grid_layout:
        detail = f"A scoring grid must be a '{SCORING_GRID_CHAPTER_TYPE}' chapter"
    else:
        detail = f"A '{SCORING_GRID_CHAPTER_TYPE}' chapter must have a scoring grid"
    raise HTTPException(status_code=400, detail=detail)


def resolve_mode(
    mode: ScoringGridMode | None,
    is_expansion: bool,
) -> ScoringGridMode | None:
    """The rule itself, over a bare mode value.

    Split out of resolve_grid_mode below so the AI drafter can ask the same
    question BEFORE there is a grid to ask it of: it needs to know which shape
    to draft — an expansion's extra rows, or a whole reprinted sheet — and the
    default for an expansion that named nothing has to be the same default the
    write path will store, or the rows would be drafted for one mode and saved
    under the other. See chapter_ai_routes.generate_scoring_grid.
    """
    if not is_expansion:
        return None
    return mode or ScoringGridMode.ADD_ON


def resolve_grid_mode(
    grid: ScoringGrid | None,
    is_expansion: bool,
) -> ScoringGridMode | None:
    """Decide the mode a grid is STORED with, from the game it is written for.

    Two modes exist and only an expansion can be in either (see
    constants.ScoringGridMode): an add-on's rows join the base game's grid, a
    replacement's stand in for it. A base game's own grid has nothing to meet,
    so its mode is NULL — not 'add_on', which would read as "these rows join
    something" and make every base grid look like half a scorepad.

    The client cannot decide this on its own. The editor knows which game it is
    saving to, but not authoritatively whether that game is an expansion; the
    write path has just SELECTed the row to derive the title, so it does, and
    resolving here is what stops a mode landing on a base grid because a stale
    client thought otherwise.

    An expansion grid that names no mode gets ADD_ON. That is the commoner
    shape by a wide margin, and it is the safe one to be wrong about: an add-on
    that should have replaced leaves the base game's rows on the table above
    its own, which a scorer can see and ignore, where the reverse silently
    hides rows they were expecting to fill in.
    """
    if grid is None:
        return None
    return resolve_mode(grid.mode, is_expansion)


def apply_grid_mode(grid: ScoringGrid, is_expansion: bool) -> dict:
    """The `grid` JSONB to store: the document, with its mode resolved.

    One helper rather than two lines at each of the two write paths, because
    the two lines have to agree — a create that stored the client's mode
    verbatim and an update that resolved it would let an edit silently change a
    grid's mode without anyone touching the control.
    """
    doc = grid.model_dump(mode="json")
    mode = resolve_grid_mode(grid, is_expansion)
    doc["mode"] = str(mode) if mode is not None else None
    return doc


def grid_title(game_name: str | None) -> str:
    """The title a scoring-grid chapter gets, DERIVED from the game it is for.

    A grid has no name of its own and never asks for one. Naming it would be
    asking the author to distinguish their grid from other people's, and that is
    not the axis anyone picks along: a grid belongs to one game, a player keeps
    at most one per game, and the pool already sorts by popularity and prints
    the author under every row — which is what a reader actually chooses on. The
    field only ever collected twenty synonyms for "Everdell score sheet".

    So the title joins `content` as something generated from the rows' context
    rather than typed beside them. It still has to EXIST — the column is NOT
    NULL, the pool ILIKE-searches it, the moderation queue heads a report with
    it and the play snapshot carries it onto the scoring card — so it is the
    game's name plus the physical thing it stands in for — "Everdell score
    sheet" — which reads correctly in all four places and, unlike a bare game
    name, still reads correctly out of context.

    Regenerated on every write, so renaming a game re-titles its grids the next
    time one is edited rather than leaving a title that names a game nobody can
    find any more.
    """
    name = (game_name or "").strip()
    return f"{name} score sheet" if name else "Score sheet"


def grid_to_content(grid: ScoringGrid) -> str:
    """Render a grid's rows as the markdown bullet list stored in `content`.

    One bullet per row, the optional note in parentheses after it. Deliberately
    plain: it is read by a search LIKE, an admin preview and renderMarkdown, and
    all three want prose.
    """
    lines = []
    for row in grid.rows:
        note = f" ({row.note})" if row.note else ""
        lines.append(f"- {row.label}{note}")
    return "\n".join(lines)
