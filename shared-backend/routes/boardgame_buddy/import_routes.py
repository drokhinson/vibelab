"""Play importer endpoints (Settings → Import plays).

Two calls, deliberately separate. `parse` reads a note into draft plays and
writes nothing; `import` writes one reviewed chunk. Everything between them
— mapping names onto accounts, matching game names to the catalog, filling in
dates — happens in the wizard, so nothing the model guessed reaches the
database without the user having seen it.

The note can arrive as pasted text, as photographs of the page, or as both.
Photographs are inline base64 on the parse request and are never persisted:
they are read once and dropped with the request. A play photo earns a row in
the storage bucket because the play keeps it forever; a picture of somebody's
notebook is scaffolding for one call, and keeping it would mean deciding later
who deletes it and when.
"""

import base64
import binascii
import logging

from fastapi import Depends, HTTPException, Path

from db import get_supabase
from gemini import GeminiError

from . import router
from .constants import MAX_IMPORT_IMAGE_BYTES, MAX_IMPORT_IMAGES_TOTAL_BYTES
from .dependencies import CurrentUser, get_current_user
from .models import (
    PlayImportDeleteResponse,
    PlayImportImage,
    PlayImportListResponse,
    PlayImportParseRequest,
    PlayImportParseResponse,
    PlayImportRequest,
    PlayImportResponse,
)
from .services import play_import_ai, play_import_service

logger = logging.getLogger(__name__)


def _decoded_images(images: list[PlayImportImage]) -> list[tuple[str, str]]:
    """Validate the photographs and hand back (mime_type, base64) pairs.

    The bytes are decoded to be MEASURED, then thrown away and the original
    base64 forwarded — re-encoding would just spend CPU reproducing the string
    we were given. A malformed or oversized image is a 400 rather than a 502:
    it is the request that is wrong, not the model, and the client can say so
    without telling the user to try again.
    """
    out: list[tuple[str, str]] = []
    total = 0
    for i, image in enumerate(images):
        try:
            raw = base64.b64decode(image.data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail=f"Photo {i + 1} couldn't be read."
            ) from exc
        if not raw:
            raise HTTPException(status_code=400, detail=f"Photo {i + 1} is empty.")
        if len(raw) > MAX_IMPORT_IMAGE_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Photo {i + 1} is too large — {MAX_IMPORT_IMAGE_BYTES // (1024 * 1024)} MB is the limit.",
            )
        total += len(raw)
        if total > MAX_IMPORT_IMAGES_TOTAL_BYTES:
            raise HTTPException(
                status_code=400,
                detail="Those photos are too large together — try fewer, or smaller ones.",
            )
        out.append((image.mime_type, image.data))
    return out


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
    images = _decoded_images(body.images)
    if not body.text.strip() and not images:
        # Neither field carries a note. Said here rather than as min_length on
        # `text`, so someone who photographed their note instead of typing it
        # doesn't get an error pointing at the box they deliberately left empty.
        raise HTTPException(
            status_code=400,
            detail="Paste your notes or add a photo of them first.",
        )
    try:
        plays, warnings = await play_import_ai.parse_plays(
            text=body.text,
            hint=body.hint,
            images=images,
        )
    except GeminiError as exc:
        # The real reason (missing key, safety block, model drift, an
        # unreadable note) is on the api_logs row; the user needs to know
        # whether to try again or edit what they pasted.
        logger.warning(
            "play import parse failed for user %s (%d photos): %s",
            user.user_id, len(images), exc,
        )
        raise HTTPException(
            status_code=502,
            detail=(
                "Couldn't read those photos — try again, or check they're in focus and the whole page is in frame."
                if images
                else "Couldn't read that note — try again, or add a note about how it's organised."
            ),
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
