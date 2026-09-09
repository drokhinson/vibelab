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

from ..constants import ChapterLayout
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
