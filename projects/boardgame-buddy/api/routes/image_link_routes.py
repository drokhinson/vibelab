"""Admin: record BoardGameGeek's own image URLs for games imported before 054.

Import, the image refresh and the single-game hydrate all write
bgg_image_url / bgg_thumbnail_url from the /thing response they already read
(game_routes.bgg_image_fields), so this queue only ever holds older games and
empties for good once drained.

Cheap on BGG's quota: one /thing?stats=0 per 20 games, and no image downloads —
it records the URLs, it does not re-host anything. Its own module because
game_routes is already far past the size the repo asks for.
"""

import asyncio
import logging
import xml.etree.ElementTree as ET

from fastapi import Depends, HTTPException, Path, Query

from db import get_supabase

from . import router
from .bgg_client import fetch_bgg, parse_bgg_xml, thing_item_image_urls
from .bgg_collection_read import BGG_THROTTLE_SECONDS
from .constants import AdminBackfillPhase, AdminRunLevel, AdminRunTool
from .dependencies import CurrentUser, get_current_admin
from .game_routes import (
    _ADMIN_LIST_LIMIT,
    _BGG_CHUNK_SIZE,
    _PASS_NO,
    _batch_detail,
    _name_list,
    _name_of,
    _saved_line,
    _scan_detail,
    bgg_image_fields,
)
from .models import BackfillPassResponse, GameSummary
from .services import admin_run_progress
from .services._helpers import chunked, game_select_clause, page_all

logger = logging.getLogger(__name__)


@router.get(
    "/games/admin/missing-image-links",
    response_model=list[GameSummary],
    status_code=200,
    summary="List games whose BGG image URLs have never been recorded (admin)",
)
async def list_games_missing_image_links(
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[GameSummary]:
    """Admin-only: the backfill's queue, a page of it. Unlike the other two
    panels the list IS the queue — a stamped row has nothing left to do."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .not_.is_("bgg_id", "null")
        .is_("bgg_images_synced_at", "null")
        .order("name")
        .limit(_ADMIN_LIST_LIMIT)
        .execute()
    )
    return [GameSummary(**g) for g in (result.data or [])]


@router.post(
    "/games/admin/{game_id}/image-links",
    response_model=GameSummary,
    status_code=200,
    summary="Record BGG's image URLs for one game (admin)",
)
async def record_single_game_image_links(
    game_id: str = Path(..., description="Game UUID"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> GameSummary:
    """Admin-only: one /thing?stats=0, no downloads, no re-host."""
    sb = get_supabase()
    existing = (
        sb.table("boardgamebuddy_games").select("id, bgg_id").eq("id", game_id).execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Game not found")
    bgg_id = existing.data[0]["bgg_id"]
    if not bgg_id:
        raise HTTPException(status_code=400, detail="Game has no bgg_id; cannot look it up on BGG")

    body = await fetch_bgg("/thing", {"id": bgg_id, "stats": 0}, timeout=10.0)
    item = parse_bgg_xml(body, context=f"image links bgg_id={bgg_id}").find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="Game not found on BGG")
    sb.table("boardgamebuddy_games").update(
        bgg_image_fields(*thing_item_image_urls(item))
    ).eq("id", game_id).execute()

    refreshed = (
        sb.table("boardgamebuddy_games").select(game_select_clause()).eq("id", game_id).execute()
    )
    if not refreshed.data:
        raise HTTPException(status_code=500, detail="Failed to update game row")
    return GameSummary(**refreshed.data[0])


@router.post(
    "/games/admin/backfill-image-links",
    response_model=BackfillPassResponse,
    status_code=200,
    summary="Record BGG's own image URLs for older games, 20 per BGG call (admin)",
)
async def backfill_image_links(
    limit: int = Query(200, ge=1, le=1000, description="Max games to record in this call"),
    pass_no: int = _PASS_NO,
    _admin: CurrentUser = Depends(get_current_admin),
) -> BackfillPassResponse:
    """Admin-only: fill bgg_image_url / bgg_thumbnail_url where never recorded.

    The queue is `bgg_images_synced_at IS NULL`. Every game asked about is
    stamped — even with no art, even when BGG no longer knows the id — so the
    drain terminates; both cases are named in the run log.
    """
    sb = get_supabase()
    P = AdminBackfillPhase
    with admin_run_progress.run_pass(
        AdminRunTool.BGG_IMAGE_LINKS, started_by=_admin.display_name, pass_no=pass_no
    ) as prog:
        prog.begin(P.SCAN)
        rows = await asyncio.to_thread(
            page_all,
            lambda: sb.table("boardgamebuddy_games")
            .select("id, bgg_id, name")
            .not_.is_("bgg_id", "null")
            .is_("bgg_images_synced_at", "null"),
            "id", label="backfill image links",
        )
        total_missing = len(rows)
        batch = rows[:limit]
        prog.tick(P.SCAN, 0, detail=_scan_detail(total_missing, len(batch), "BGG image links"))

        by_bgg_id = {int(r["bgg_id"]): r for r in batch}
        chunks = list(chunked(batch, _BGG_CHUNK_SIZE))

        updated = 0
        failed = 0
        if not chunks:
            prog.skip(P.FETCH, detail="Nothing left to record")
        else:
            prog.begin(P.FETCH, total=len(chunks))
        for i, chunk in enumerate(chunks):
            prog.tick(P.FETCH, i, detail=_batch_detail(i, len(chunks), updated))
            if i:
                await asyncio.sleep(BGG_THROTTLE_SECONDS)
            ids = ",".join(str(r["bgg_id"]) for r in chunk)
            try:
                body = await fetch_bgg(
                    "/thing", {"id": ids, "stats": 0}, timeout=20.0, use_cache=False
                )
                root = parse_bgg_xml(body, context=f"backfill image links ({len(chunk)} ids)")
            except Exception as exc:
                logger.warning("Image-link backfill chunk failed (%d ids)", len(chunk), exc_info=True)
                failed += len(chunk)
                prog.event(
                    P.FETCH,
                    f"Batch {i + 1} failed ({_name_list(chunk)}) — {exc}",
                    level=AdminRunLevel.ERROR,
                )
                continue

            by_item: dict[int, ET.Element] = {}
            for item in root.findall("item"):
                try:
                    by_item[int(item.get("id", "0"))] = item
                except (TypeError, ValueError):
                    continue

            wrote = 0
            unknown: list[dict] = []
            no_art: list[dict] = []
            for r in chunk:
                item = by_item.get(int(r["bgg_id"]))
                # Stamped either way, like the metadata sweep: a queue that
                # keeps an id BGG no longer knows never drains. The row keeps
                # its re-hosted art; only the BGG links stay empty.
                if item is None:
                    unknown.append(r)
                    raw_img = raw_thumb = None
                else:
                    raw_img, raw_thumb = thing_item_image_urls(item)
                    if not raw_img and not raw_thumb:
                        no_art.append(r)
                try:
                    sb.table("boardgamebuddy_games").update(
                        bgg_image_fields(raw_img, raw_thumb)
                    ).eq("id", by_bgg_id[int(r["bgg_id"])]["id"]).execute()
                    updated += 1
                    wrote += 1
                except Exception as exc:
                    logger.warning("Image-link write failed for game %s", r["id"], exc_info=True)
                    failed += 1
                    prog.event(
                        P.FETCH,
                        f"{_name_of(r)} — could not save: {exc}",
                        level=AdminRunLevel.ERROR,
                    )
            prog.event(P.FETCH, _saved_line(i, len(chunks), wrote, len(chunk)))
            if no_art:
                prog.event(
                    P.FETCH,
                    f"{len(no_art)} of this batch have no art on BoardGameGeek — "
                    f"stamped anyway, so the run can finish ({_name_list(no_art)})",
                    level=AdminRunLevel.WARN,
                )
            if unknown:
                prog.event(
                    P.FETCH,
                    f"{len(unknown)} of this batch are not on BoardGameGeek under that id "
                    f"({_name_list(unknown)})",
                    level=AdminRunLevel.WARN,
                )
        if chunks:
            prog.tick(P.FETCH, len(chunks), detail=f"{updated} saved")

        remaining = max(0, total_missing - updated)
        # Nothing the app renders reads these columns yet, so there is no
        # cache to clear — said rather than silently skipped.
        prog.skip(P.CACHES, detail="Nothing the app shows changed, caches left alone")
        prog.add_totals(updated=updated, failed=failed, remaining=remaining)

        return BackfillPassResponse(updated=updated, failed=failed, remaining=remaining)
