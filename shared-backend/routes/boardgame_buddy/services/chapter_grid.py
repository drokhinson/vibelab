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

# The chapter type a scoring grid must be filed under. It is a LAYOUT of the
# existing type rather than a type of its own: the guide scroll groups by
# chapter_type with one header per type, so a 7th type would split a user's
# scoring material into two sections both labelled "scoring".
SCORING_GRID_CHAPTER_TYPE = "scoring"


def validate_layout_pairing(
    layout: ChapterLayout | str | None,
    chapter_type: str | None,
) -> None:
    """Reject a scoring grid filed under any chapter type but `scoring`.

    Pydantic already ties `layout` to the presence of `grid` (ChapterCreate
    ._grid_matches_layout) and the DB ties it again (bgb_chapters_grid_shape).
    Neither can see the chapter TYPE, which is the third thing that has to
    agree — nothing else stops the two drifting.
    """
    if layout is None or chapter_type is None:
        return
    if str(layout) != ChapterLayout.SCORING_GRID:
        return
    if chapter_type != SCORING_GRID_CHAPTER_TYPE:
        raise HTTPException(
            status_code=400,
            detail=f"A scoring grid must be a '{SCORING_GRID_CHAPTER_TYPE}' chapter",
        )


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
