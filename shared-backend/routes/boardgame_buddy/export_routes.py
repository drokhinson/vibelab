"""Take-your-data-with-you: the account export behind Settings → Data management.

Two routes. `/export/manifest` is what paints the checkbox sheet — every
dataset with a live row count, so a user can see there is nothing under
"Achievements" without downloading a zip to find out. `/export` builds the
archive for whatever they ticked.

Self-only, always: there is no `user_id` parameter on either route and there
must never be one. Profiles are public in this app and several read endpoints
take a target user, but a bulk dump of somebody's plays, notes, purchase prices
and private BGG comments is not the thing profiles being public was a decision
about.
"""

import asyncio
from typing import Annotated

from fastapi import Depends, HTTPException, Query, Response

from db import get_supabase

from . import router
from .constants import ExportDataset
from .dependencies import CurrentUser, get_current_user
from .models import ExportManifestResponse
from .services import export_service


@router.get(
    "/export/manifest",
    response_model=ExportManifestResponse,
    status_code=200,
    summary="What the current user can export, and how much of each there is",
)
async def get_export_manifest(
    user: CurrentUser = Depends(get_current_user),
) -> ExportManifestResponse:
    """List every exportable dataset with its live row count."""
    datasets = await asyncio.to_thread(
        export_service.manifest, get_supabase(), user.user_id
    )
    return ExportManifestResponse(datasets=datasets)


@router.get(
    "/export",
    status_code=200,
    summary="Download the current user's data as a zip of CSVs",
    response_class=Response,
    # No `response_model`: the body is a zip, not a model. This is the one
    # place in the app where the house rule in .claude/rules/backend-python.md
    # cannot apply — the schema below is what Swagger has to go on instead.
    responses={200: {"content": {"application/zip": {}},
                     "description": "A zip archive of CSV files."}},
)
async def download_export(
    dataset: Annotated[
        list[ExportDataset],
        Query(description="Which datasets to include. Repeat the parameter to "
                          "pick several: ?dataset=collection&dataset=plays"),
    ],
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """Build and return a zip of CSVs for the datasets the caller ticked."""
    # Deduplicated but not re-ordered here — export_service builds in its own
    # registry order so the same ticks always produce the same archive.
    wanted = list(dict.fromkeys(dataset))
    if not wanted:
        raise HTTPException(status_code=400, detail="Pick at least one dataset to export")

    # One thread for the whole build, not one per read: the Supabase client is
    # synchronous and this is dozens of round trips, so hopping back to the
    # event loop between them would only spread the blocking out.
    payload, filename = await asyncio.to_thread(
        export_service.build_export,
        get_supabase(),
        user.user_id,
        wanted,
        display_name=user.display_name,
        username=user.username,
    )
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # The archive is built for this one download and never stored, so
            # nothing between here and the phone should keep a copy of it.
            "Cache-Control": "no-store",
            # The browser can only read the filename off the response if the
            # header is exposed to script — this is a cross-origin fetch
            # (Vercel front end, Railway API), and without this the download
            # lands as "download" with no extension.
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )
