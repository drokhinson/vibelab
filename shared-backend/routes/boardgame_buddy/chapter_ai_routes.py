"""AI drafting endpoints for reference-guide chapters.

Two POSTs, one per body shape a chapter can have:

  * `/chapters/generate`      — a markdown chapter (title + content)
  * `/chapters/generate-grid` — a scoring grid (rows)

Both are the create wizard's optional head-start step, both are synchronous
because the author is standing in the wizard waiting, and both SAVE NOTHING:
the reply is loaded into the editor for review and the author presses Save
themselves. That is what makes a small model the right call here — a draft the
author is about to edit is cheap to be wrong about, and the alternative is a
blank form and a rulebook.

Split out of chapter_routes.py, which was already three times the ~300-line
guideline in CLAUDE.md before a second drafter went into it. The seam is the
one the services already use: chapter_ai.py / chapter_grid_ai.py hold the
prompts and the coercion, this file holds the two lookups they need and the
GeminiError → 502 mapping.

Every handler runs its Supabase round trips through `asyncio.to_thread`; the
`_<handler>_sync` helper directly above a route is that blocking half.
"""

import asyncio
import logging
from typing import Any

from fastapi import Depends, HTTPException, Path
from supabase import Client

from db import get_supabase
from gemini import GeminiError

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    ChapterGenerateRequest,
    ChapterGenerateResponse,
    ChapterGridGenerateRequest,
    ChapterGridGenerateResponse,
)
from .services import chapter_ai, chapter_grid, chapter_grid_ai

logger = logging.getLogger(__name__)

# Both drafters map a failed model call to this. The underlying reason (missing
# key, safety block, model drift) goes to the api_logs row; the author just
# needs to know the draft didn't land and the step still works without it.
_DRAFT_FAILED = "Couldn't draft that right now — try again in a moment."


def _game_row_sync(sb: Client, game_id: str) -> dict[str, Any]:
    """The game's name and year — all either prompt needs about it.

    The BGG `description` is deliberately not selected; see the note in
    chapter_ai._build_prompt for why it left the prompt.
    """
    game = (
        sb.table("boardgamebuddy_games")
        .select("id, name, year_published")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")
    return game.data[0]


def _chapter_type_label(sb: Client, chapter_type: str) -> str:
    """Validate the chapter type and return its human label in one round-trip.

    The AI prompt wants "Tips & Tricks", not the `tips` slug.
    """
    row = (
        sb.table("boardgamebuddy_chapter_types")
        .select("id, label")
        .eq("id", chapter_type)
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=400, detail="Unknown chapter type")
    return row.data[0].get("label") or chapter_type


def _generate_chapter_before_sync(
    sb: Client, game_id: str, chapter_type: str
) -> tuple[dict[str, Any], str]:
    """The game row and the chapter type's label — the two lookups the prompt needs."""
    return _game_row_sync(sb, game_id), _chapter_type_label(sb, chapter_type)


@router.post(
    "/games/{game_id}/chapters/generate",
    response_model=ChapterGenerateResponse,
    status_code=200,
    summary="Draft a chapter with AI",
)
async def generate_chapter(
    body: ChapterGenerateRequest,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ChapterGenerateResponse:
    """Draft a chapter of the given type (optionally steered by a focus prompt) — returned for the user to review, not saved."""
    # A scoring grid's body is rows in the typed `grid` column, not markdown, so
    # there is nothing for THIS drafter to write and nowhere to put it if there
    # were. The grid wizard's head-start step posts to generate-grid below; this
    # is for everything else that can reach a public endpoint.
    if body.chapter_type == chapter_grid.SCORING_GRID_CHAPTER_TYPE:
        raise HTTPException(
            status_code=400,
            detail=(
                "Scoring grid templates are drafted as rows — "
                "POST to chapters/generate-grid instead."
            ),
        )

    sb = get_supabase()
    row, label = await asyncio.to_thread(
        _generate_chapter_before_sync, sb, game_id, body.chapter_type
    )

    try:
        title, content = await chapter_ai.generate_chapter(
            game_name=row.get("name") or "",
            game_year=row.get("year_published"),
            chapter_type_id=body.chapter_type,
            chapter_type_label=label,
            focus=body.prompt,
        )
    except GeminiError as exc:
        logger.warning("chapter generation failed for game %s: %s", game_id, exc)
        raise HTTPException(status_code=502, detail=_DRAFT_FAILED) from exc

    return ChapterGenerateResponse(
        chapter_type=body.chapter_type,
        title=title,
        content=content,
    )


@router.post(
    "/games/{game_id}/chapters/generate-grid",
    response_model=ChapterGridGenerateResponse,
    status_code=200,
    summary="Draft a scoring grid with AI",
)
async def generate_scoring_grid(
    body: ChapterGridGenerateRequest,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ChapterGridGenerateResponse:
    """Rough out a scoring grid's rows for this game (optionally steered) — returned for the author to edit, not saved."""
    # No chapter_type on the body and none checked: a grid is one type by
    # definition (chapter_grid.SCORING_GRID_CHAPTER_TYPE), so there is no type
    # lookup here and, unlike the chapter drafter above, no 400 for an unknown
    # one. One game lookup, one model call.
    sb = get_supabase()
    row = await asyncio.to_thread(_game_row_sync, sb, game_id)

    try:
        grid = await chapter_grid_ai.generate_grid(
            game_name=row.get("name") or "",
            game_year=row.get("year_published"),
            focus=body.prompt,
        )
    except GeminiError as exc:
        logger.warning("grid generation failed for game %s: %s", game_id, exc)
        raise HTTPException(status_code=502, detail=_DRAFT_FAILED) from exc

    return ChapterGridGenerateResponse(grid=grid)
