"""Reading the admin run logs.

The five admin catalog jobs narrate themselves into an in-process ledger
(services/admin_run_progress.py) while they work. This module is the read side
— the writes live with the work, in game_routes and discovery_service, because
a ledger written anywhere but beside the thing it describes goes stale the
first time that thing changes.

TWO READS, NOT ONE, and the split is about cost rather than tidiness. The run
page polls ONE tool every second and wants the journal; the Settings admin card
polls EVERY tool and wants five words per tool. Serving the card from the
per-tool endpoint would mean five requests a second each carrying up to two
hundred event rows, to paint a pill that says "Running · 4 of 10".

There is no write endpoint here. A run is started by the endpoint that does the
work — POST /discover/admin/refresh-trending and the four backfills — because
"start a run" and "do the thing" are the same act, and an /admin/runs/start
that did not itself run anything would be a second source of truth about
whether a run exists.
"""

from fastapi import Depends, Path

from . import router
from .dependencies import CurrentUser, get_current_admin
from .constants import AdminRunTool
from .models import AdminRunProgressResponse, AdminRunSummary
from .services import admin_run_progress


@router.get(
    "/admin/runs",
    response_model=list[AdminRunSummary],
    status_code=200,
    summary="Live or recent state of every admin run, without the logs (admin)",
)
async def list_admin_runs(
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[AdminRunSummary]:
    """Admin-only: one row per tool that has run in the last ten minutes.

    A tool with no record is ABSENT rather than an idle row. The difference
    matters to the caller: absent means "nothing recent", which is the pill's
    idle state, and inventing a row for it would make every tool look like it
    had run and finished with nothing to show.

    Reads an in-process dict; no I/O, so the Settings card can poll it.
    """
    return [AdminRunSummary(**row) for row in admin_run_progress.read_all()]


@router.get(
    "/admin/runs/{tool}",
    response_model=AdminRunProgressResponse,
    status_code=200,
    summary="One admin run's checklist and log (admin)",
)
async def get_admin_run(
    tool: AdminRunTool = Path(..., description="Which admin job's run to read"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> AdminRunProgressResponse:
    """Admin-only: what this tool is doing now, or what it last did.

    No record is `state = unknown`, and for an admin run that reads as "nothing
    has run in the last ten minutes" — the page's idle state — NOT as "still
    working". The BGG check's identical field means the opposite, because there
    the ledger and the request that writes it live and die together. See
    RunState's docstring.

    The tool is validated by the enum, so an unknown slug is a 422 rather than
    an empty log that looks like a finished run.
    """
    snapshot = admin_run_progress.read(tool)
    if not snapshot:
        return AdminRunProgressResponse(tool=tool)
    return AdminRunProgressResponse(**snapshot)
