"""Play importer endpoints (Settings → Import plays).

Two calls, deliberately separate. `parse` reads a pasted note into draft plays
and writes nothing; `import` writes one reviewed chunk. Everything between them
— mapping names onto accounts, matching game names to the catalog, filling in
dates — happens in the wizard, so nothing the model guessed reaches the
database without the user having seen it.
"""

import logging

from fastapi import Depends, HTTPException, Path

from db import get_supabase
from gemini import GeminiError

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    PlayImportDeleteResponse,
    PlayImportListResponse,
    PlayImportParseRequest,
    PlayImportParseResponse,
    PlayImportRequest,
    PlayImportResponse,
)
from .services import play_import_ai, play_import_service

logger = logging.getLogger(__name__)


@router.post(
    "/plays/import/parse",
    response_model=PlayImportParseResponse,
    status_code=200,
    summary="Parse a pasted note into draft plays",
)
async def parse_import(
    body: PlayImportParseRequest,
    user: CurrentUser = Depends(get_current_user),
) -> PlayImportParseResponse:
    """Read a note into draft plays, players and catalog game matches — nothing is saved."""
    try:
        plays, warnings = await play_import_ai.parse_plays(
            text=body.text,
            hint=body.hint,
        )
    except GeminiError as exc:
        # The real reason (missing key, safety block, model drift, an
        # unreadable note) is on the api_logs row; the user needs to know
        # whether to try again or edit what they pasted.
        logger.warning("play import parse failed for user %s: %s", user.user_id, exc)
        raise HTTPException(
            status_code=502,
            detail="Couldn't read that note — try again, or add a note about how it's organised.",
        ) from exc

    sb = get_supabase()
    game_names = play_import_service.distinct_game_names(plays)
    return PlayImportParseResponse(
        plays=plays,
        players=play_import_service.distinct_player_names(plays),
        games=play_import_service.match_games(sb, user.user_id, game_names),
        total_plays=sum(p.count for p in plays),
        warnings=warnings,
    )


@router.post(
    "/plays/import",
    response_model=PlayImportResponse,
    status_code=201,
    summary="Import a chunk of reviewed plays",
)
async def import_plays(
    body: PlayImportRequest,
    user: CurrentUser = Depends(get_current_user),
) -> PlayImportResponse:
    """Write one chunk of reviewed plays; each play's client_key makes a retry safe."""
    return play_import_service.import_plays(get_supabase(), user.user_id, body.plays)


@router.get(
    "/plays/imports",
    response_model=PlayImportListResponse,
    status_code=200,
    summary="List past imports",
)
async def list_imports(
    user: CurrentUser = Depends(get_current_user),
) -> PlayImportListResponse:
    """Every import this user has run, newest first — what Settings lists to undo one."""
    return play_import_service.list_imports(get_supabase(), user.user_id)


@router.delete(
    "/plays/import-group/{group_id}",
    response_model=PlayImportDeleteResponse,
    status_code=200,
    summary="Delete one run of identical imported plays",
)
async def delete_import_group(
    group_id: str = Path(..., description="Import group UUID (one run)"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayImportDeleteResponse:
    """Remove every play in one imported run; players and expansions cascade."""
    deleted = play_import_service.delete_import_group(
        get_supabase(), user.user_id, group_id
    )
    return PlayImportDeleteResponse(deleted=deleted)


@router.delete(
    "/plays/import-batch/{batch_id}",
    response_model=PlayImportDeleteResponse,
    status_code=200,
    summary="Delete everything one import wrote",
)
async def delete_import_batch(
    batch_id: str = Path(..., description="Import batch UUID (one whole import)"),
    user: CurrentUser = Depends(get_current_user),
) -> PlayImportDeleteResponse:
    """Undo a whole import — every play that paste created, and nothing else.

    Deliberately returns 200 with deleted=0 rather than 404 for an id that is
    not this user's: the RPC is owner-scoped, and distinguishing "not yours"
    from "not there" would tell a caller that somebody else's batch exists.
    """
    deleted = play_import_service.delete_import_batch(
        get_supabase(), user.user_id, batch_id
    )
    return PlayImportDeleteResponse(deleted=deleted)
