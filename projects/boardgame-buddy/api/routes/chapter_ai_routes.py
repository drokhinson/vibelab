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
    """The game's name and year — and, for the grid drafter, what it is TO.

    `is_expansion` and `base_game_bgg_id` are what the grid prompt reads: an
    expansion's grid is either the rows that box adds to somebody else's sheet
    or a sheet that stands in for it, and neither can be drafted by a prompt
    that thinks it is looking at a base game. The chapter drafter ignores both;
    three narrow columns in a lookup it was making anyway is cheaper than a
    second helper.

    The BGG `description` is deliberately not selected; see the note in
    chapter_ai._build_prompt for why it left the prompt.
    """
    game = (
        sb.table("boardgamebuddy_games")
        .select("id, name, year_published, is_expansion, base_game_bgg_id")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")
    return game.data[0]


def _base_game_name_sync(sb: Client, base_game_bgg_id: int | None) -> str | None:
    """The name of the game an expansion is played with, or None.

    One extra round trip, taken only on the expansion path and only to put a
    NAME in the prompt — "do not repeat Everdell's rows" is a rule a model can
    follow, "do not repeat the base game's rows" is one it can talk itself out
    of. Failing to find it is not an error: `base_game_bgg_id` is a soft
    reference by design (an expansion can be imported before its base game), so
    the prompt falls back to "the base game" and drafts a slightly vaguer sheet
    rather than 404ing a wizard step that is optional anyway.
    """
    if not base_game_bgg_id:
        return None
    row = (
        sb.table("boardgamebuddy_games")
        .select("name")
        .eq("bgg_id", base_game_bgg_id)
        .eq("is_expansion", False)
        .limit(1)
        .execute()
    )
    return (row.data[0].get("name") or None) if row.data else None


def _generate_grid_before_sync(
    sb: Client, game_id: str
) -> tuple[dict[str, Any], str | None]:
    """The game row, plus its base game's name when the game is an expansion."""
    row = _game_row_sync(sb, game_id)
    base_name = (
        _base_game_name_sync(sb, row.get("base_game_bgg_id"))
        if row.get("is_expansion")
        else None
    )
    return row, base_name


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
    # one.
    sb = get_supabase()
    row, base_name = await asyncio.to_thread(_generate_grid_before_sync, sb, game_id)

    # Resolved by the SAME rule the write path uses, against the row we just
    # read rather than against what the client believes: a mode on a base game's
    # grid is dropped, and an expansion that named none drafts as an add-on —
    # which is exactly what a save would store, so the rows cannot be drafted
    # for one shape and filed under the other (migration 032).
    mode = chapter_grid.resolve_mode(body.mode, bool(row.get("is_expansion")))

    try:
        grid = await chapter_grid_ai.generate_grid(
            game_name=row.get("name") or "",
            game_year=row.get("year_published"),
            mode=mode,
            base_game_name=base_name,
            focus=body.prompt,
        )
    except GeminiError as exc:
        logger.warning("grid generation failed for game %s: %s", game_id, exc)
        raise HTTPException(status_code=502, detail=_DRAFT_FAILED) from exc

    return ChapterGridGenerateResponse(grid=grid)
