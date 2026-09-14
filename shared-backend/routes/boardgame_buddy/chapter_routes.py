"""Reference-guide chapter endpoints.

Each user builds their own reference guide for each game by adding
chapters one at a time. Two ways to add: create a new chapter (type +
title + markdown), or browse the pool of existing chapters for that
game and add the ones they want. No curated defaults, no review queue
— moderation is reactive via per-chapter reports.

The wizard's optional AI head start — the markdown drafter and the scoring-grid
one both — lives next door in `chapter_ai_routes.py`, so the two prompts and
their 502 mapping are not interleaved with the CRUD.

Every handler runs its Supabase round trips through `asyncio.to_thread`; the
`_<handler>_sync` helper directly above a route is that blocking half.
"""

import asyncio
import logging
from typing import Any, Optional

from fastapi import Depends, Header, HTTPException, Path, Query, Response
from supabase import Client

from db import get_supabase

from . import router
from .dependencies import (
    CurrentUser,
    get_current_admin,
    get_current_user,
    maybe_supabase_user,
)
from .constants import ChapterLayout
from .models import (
    AddChapterRequest,
    ChapterCreate,
    ChapterPoolCountResponse,
    ChapterPoolItem,
    ChapterReportCreate,
    ChapterReportResponse,
    ChapterResponse,
    ChapterTypeResponse,
    ChapterUpdate,
    MessageResponse,
    MyGuideChapterResponse,
)
from .services import chapter_grid
from .services._helpers import parse_csv_param

logger = logging.getLogger(__name__)


_CHAPTER_SELECT = (
    "id, game_id, chapter_type, title, layout, content, grid,"
    " created_by, updated_at, created_at,"
    " boardgamebuddy_chapter_types(label, icon, display_order),"
    " boardgamebuddy_profiles(display_name)"
)


def _build_source_map(sb, game_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch (name, expansion_color, bgg_id) for a list of game ids in one trip.

    The chapter response uses this to populate source_game_name / source_color
    so the FE can render colored dots tying each chapter to its expansion (or
    leave the dot blank for base-game chapters).

    `bgg_id` rides along for migration 032: when several add-on expansions
    contribute rows to one scorepad, their blocks are ordered by BGG id
    ascending — a stable, publication-ordered key every client agrees on, where
    the order the guide happens to return them in is not.
    """
    if not game_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_games")
        .select("id, name, expansion_color, is_expansion, bgg_id")
        .in_("id", game_ids)
        .execute()
    ).data or []
    return {
        r["id"]: {
            "name": r.get("name") or "",
            # Base games get None — the FE skips the colored dot.
            "color": r.get("expansion_color") if r.get("is_expansion") else None,
            "bgg_id": r.get("bgg_id"),
        }
        for r in rows
    }


def _chapter_row_to_response(
    row: dict[str, Any],
    source_map: Optional[dict[str, dict[str, Any]]] = None,
) -> ChapterResponse:
    """Flatten a Supabase row with joined chapter_type + profile.

    When `source_map` is supplied, also populate source_game_id /
    source_game_name / source_color so a multi-game merged response can be
    rendered with the right colored dot per chapter.
    """
    type_obj = row.get("boardgamebuddy_chapter_types")
    profile_obj = row.get("boardgamebuddy_profiles")

    label = None
    icon = None
    display_order = 0
    if isinstance(type_obj, dict):
        label = type_obj.get("label")
        icon = type_obj.get("icon")
        display_order = int(type_obj.get("display_order") or 0)

    created_by_name = None
    if isinstance(profile_obj, dict):
        created_by_name = profile_obj.get("display_name")

    source_game_id = None
    source_game_name = None
    source_color = None
    source_bgg_id = None
    if source_map is not None:
        entry = source_map.get(row["game_id"])
        source_game_id = row["game_id"]
        if entry:
            source_game_name = entry.get("name")
            source_color = entry.get("color")
            source_bgg_id = entry.get("bgg_id")

    return ChapterResponse(
        id=row["id"],
        game_id=row["game_id"],
        chapter_type=row["chapter_type"],
        chapter_type_label=label,
        chapter_type_icon=icon,
        chapter_type_order=display_order,
        title=row["title"],
        layout=row.get("layout", "text"),
        content=row["content"],
        # Stale client caches and rows written before 018 can carry a layout
        # with no grid; every reader treats that as plain text rather than
        # throwing, so `grid` is read defensively here too.
        grid=row.get("grid"),
        created_by=row.get("created_by"),
        created_by_name=created_by_name,
        updated_at=row["updated_at"],
        source_game_id=source_game_id,
        source_game_name=source_game_name,
        source_color=source_color,
        source_bgg_id=source_bgg_id,
    )


def _validate_chapter_type(sb, chapter_type: str) -> None:
    """Raise 400 if the supplied chapter_type is not in the lookup table."""
    row = (
        sb.table("boardgamebuddy_chapter_types")
        .select("id")
        .eq("id", chapter_type)
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=400, detail="Unknown chapter type")


@router.get(
    "/chapter-types",
    response_model=list[ChapterTypeResponse],
    status_code=200,
    summary="List chapter types",
)
async def list_chapter_types() -> list[ChapterTypeResponse]:
    """Return the six fixed chapter-type lookup rows."""
    sb = get_supabase()
    result = await asyncio.to_thread(
        sb.table("boardgamebuddy_chapter_types")
        .select("id, label, icon, display_order")
        .order("display_order")
        .execute
    )
    return [ChapterTypeResponse(**r) for r in (result.data or [])]


def _browse_chapter_pool_sync(
    sb: Client,
    game_id: str,
    viewer_id: Optional[str],
    *,
    q: Optional[str],
    chapter_type: Optional[str],
    layout: Optional[ChapterLayout],
    expansion_ids: Optional[str],
) -> list[ChapterPoolItem]:
    exp_ids = parse_csv_param(expansion_ids)
    all_game_ids = [game_id, *exp_ids]

    pool_q = sb.table("boardgamebuddy_guide_chapters").select(_CHAPTER_SELECT)
    pool_q = pool_q.in_("game_id", all_game_ids) if exp_ids else pool_q.eq("game_id", game_id)
    if chapter_type:
        pool_q = pool_q.eq("chapter_type", chapter_type)
    if layout:
        pool_q = pool_q.eq("layout", str(layout))
    if q:
        # PostgREST's `or` filter combines two ILIKE matches into one query.
        needle = f"%{q}%"
        pool_q = pool_q.or_(f"title.ilike.{needle},content.ilike.{needle}")
    pool_rows = pool_q.limit(1000).execute().data or []

    if not pool_rows:
        return []

    chapter_ids = [r["id"] for r in pool_rows]
    source_map = _build_source_map(sb, all_game_ids) if exp_ids else {}

    # Popularity: count user_chapters rows per chapter in one round trip.
    # Bounded at 1000 adopter rows until the tally moves to an RPC GROUP BY.
    popularity: dict[str, int] = {cid: 0 for cid in chapter_ids}
    pop_rows = (
        sb.table("boardgamebuddy_user_chapters")
        .select("chapter_id")
        .in_("chapter_id", chapter_ids)
        .limit(1000)
        .execute()
    ).data or []
    for r in pop_rows:
        popularity[r["chapter_id"]] = popularity.get(r["chapter_id"], 0) + 1

    in_my_guide: set[str] = set()
    if viewer_id is not None:
        mine = (
            sb.table("boardgamebuddy_user_chapters")
            .select("chapter_id")
            .eq("user_id", viewer_id)
            .in_("chapter_id", chapter_ids)
            .execute()
        ).data or []
        in_my_guide = {r["chapter_id"] for r in mine}

    # Two-pass stable sort: secondary key (created_at desc) first, then
    # primary (popularity desc). Python's sort is stable, so popularity
    # ties resolve by created_at desc.
    pool_rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    pool_rows.sort(key=lambda r: popularity.get(r["id"], 0), reverse=True)

    return [
        ChapterPoolItem(
            **_chapter_row_to_response(row, source_map if exp_ids else None).model_dump(),
            popularity=popularity.get(row["id"], 0),
            in_my_guide=row["id"] in in_my_guide,
        )
        for row in pool_rows
    ]


@router.get(
    "/games/{game_id}/chapter-pool",
    response_model=list[ChapterPoolItem],
    status_code=200,
    summary="Browse the pool of existing chapters for a game",
)
async def browse_chapter_pool(
    game_id: str = Path(..., description="Game UUID"),
    q: Optional[str] = Query(None, description="Keyword search across title + content"),
    chapter_type: Optional[str] = Query(None, description="Optional chapter-type filter"),
    layout: Optional[ChapterLayout] = Query(
        None,
        description=(
            "Optional body-layout filter. `scoring_grid` is how the reference"
            " guide asks 'does this game have scoring templates?' — each row"
            " already carries in_my_guide, so the client needs no other"
            " endpoint to answer '…that I haven't added'."
        ),
    ),
    expansion_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated expansion game UUIDs to also include in the pool."
            " When set, the pool merges chapters from the base game plus these"
            " expansions, each row tagged with source_game_id/source_color."
        ),
    ),
    authorization: Optional[str] = Header(None),
) -> list[ChapterPoolItem]:
    """Browse every chapter that exists for this game (optionally + expansions).

    Sorted by `popularity DESC, created_at DESC`. Each row includes
    a `popularity` count (how many users have it in their guide) and
    `in_my_guide` (whether the caller already has it).
    """
    sb = get_supabase()
    su_user = await maybe_supabase_user(authorization)
    return await asyncio.to_thread(
        _browse_chapter_pool_sync,
        sb,
        game_id,
        su_user.sub if su_user is not None else None,
        q=q,
        chapter_type=chapter_type,
        layout=layout,
        expansion_ids=expansion_ids,
    )


def _chapter_pool_count_sync(
    sb: Client, game_id: str, expansion_ids: Optional[str]
) -> int:
    exp_ids = parse_csv_param(expansion_ids)
    all_game_ids = [game_id, *exp_ids]
    # head=True asks Postgrest for the tally and none of the rows — the whole
    # reason this is not just `len()` of the pool, whose rows each carry a full
    # markdown body.
    count_q = sb.table("boardgamebuddy_guide_chapters").select(
        "id", count="exact", head=True
    )
    count_q = (
        count_q.in_("game_id", all_game_ids) if exp_ids else count_q.eq("game_id", game_id)
    )
    return count_q.execute().count or 0


@router.get(
    "/games/{game_id}/chapter-pool/count",
    response_model=ChapterPoolCountResponse,
    status_code=200,
    summary="How many chapters exist for a game",
)
async def count_chapter_pool(
    game_id: str = Path(..., description="Game UUID"),
    expansion_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated expansion game UUIDs to also count, matching the"
            " scope `GET /games/{game_id}/chapter-pool` would return for the"
            " same parameters."
        ),
    ),
) -> ChapterPoolCountResponse:
    """Count every chapter written for this game (optionally + expansions).

    The same number `GET /games/{game_id}/chapter-pool` would return the length
    of, without the chapter bodies. No auth: the pool size is the same for
    everybody, and the caller's own guide is counted client-side from
    `my-chapters`.
    """
    sb = get_supabase()
    total = await asyncio.to_thread(
        _chapter_pool_count_sync, sb, game_id, expansion_ids
    )
    return ChapterPoolCountResponse(total=total)


def _create_chapter_sync(
    sb: Client, game_id: str, body: ChapterCreate, user_id: str
) -> MyGuideChapterResponse:
    game = (
        sb.table("boardgamebuddy_games")
        # is_expansion decides a scoring grid's MODE (migration 032) — an
        # expansion's rows either join the base game's grid or stand in for it,
        # and a base game's own grid is in neither mode. Selected here beside
        # the name the title is derived from, so the mode costs no extra
        # round-trip.
        .select("id, name, is_expansion")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    _validate_chapter_type(sb, body.chapter_type)
    chapter_grid.validate_layout_pairing(body.layout, body.chapter_type)

    # For a scoring grid the rows ARE the chapter: both `content` and `title`
    # are generated rather than anything the author typed — see
    # services/chapter_grid.py for why neither is a field on the form.
    is_grid = body.layout is ChapterLayout.SCORING_GRID and body.grid is not None
    content = (
        chapter_grid.grid_to_content(body.grid)
        if is_grid
        else body.content
    )
    title = (
        chapter_grid.grid_title(game.data[0].get("name"))
        if is_grid
        else body.title
    )

    insert = (
        sb.table("boardgamebuddy_guide_chapters")
        .insert({
            "game_id": game_id,
            "chapter_type": body.chapter_type,
            "title": title,
            "content": content,
            "layout": str(body.layout),
            "grid": (
                chapter_grid.apply_grid_mode(
                    body.grid, bool(game.data[0].get("is_expansion"))
                )
                if body.grid
                else None
            ),
            "created_by": user_id,
        })
        .execute()
    )
    if not insert.data:
        raise HTTPException(status_code=500, detail="Chapter insert returned no row")
    new_id = insert.data[0]["id"]

    # Auto-add to creator's guide.
    sel = (
        sb.table("boardgamebuddy_user_chapters")
        .insert({
            "user_id": user_id,
            "game_id": game_id,
            "chapter_id": new_id,
        })
        .execute()
    )
    added_at = sel.data[0]["created_at"] if sel.data else None

    fetched = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .eq("id", new_id)
        .execute()
    )
    base = _chapter_row_to_response(fetched.data[0])
    return MyGuideChapterResponse(
        **base.model_dump(),
        added_at=added_at or base.updated_at,
    )


@router.post(
    "/games/{game_id}/chapters",
    response_model=MyGuideChapterResponse,
    status_code=201,
    summary="Create a chapter and add it to my guide",
)
async def create_chapter(
    body: ChapterCreate,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MyGuideChapterResponse:
    """Create a new chapter attached to a game and immediately add it to the creator's guide."""
    sb = get_supabase()
    return await asyncio.to_thread(_create_chapter_sync, sb, game_id, body, user.user_id)


def _update_chapter_sync(
    sb: Client, chapter_id: str, body: ChapterUpdate, user_id: str
) -> ChapterResponse:
    existing = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id, game_id, created_by, layout, chapter_type")
        .eq("id", chapter_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    row = existing.data[0]
    if row["created_by"] != user_id:
        raise HTTPException(status_code=403, detail="You can only edit chapters you created")

    # Check the pairing the edit would LEAVE BEHIND, not just the fields it
    # carries. A PATCH that only moves chapter_type to 'tips' names no layout at
    # all, so validating the body alone would happily strand a scoring grid
    # under a type the guide scroll files elsewhere.
    layout = body.layout if body.layout is not None else row.get("layout")
    chapter_grid.validate_layout_pairing(
        layout,
        body.chapter_type if body.chapter_type is not None else row.get("chapter_type"),
    )

    updates: dict[str, Any] = {"updated_at": "now()"}
    if body.chapter_type is not None:
        _validate_chapter_type(sb, body.chapter_type)
        updates["chapter_type"] = body.chapter_type
    if body.title is not None:
        updates["title"] = body.title
    if body.content is not None:
        updates["content"] = body.content
    if body.layout is not None:
        updates["layout"] = str(body.layout)
    # A grid's title is derived, so it is rewritten on every edit whatever the
    # body said — which is also how a grid authored before the title field was
    # retired, or one whose game has since been renamed, picks up the current
    # form. Costs one lookup, and only on a grid edit.
    is_expansion = False
    if str(layout) == str(ChapterLayout.SCORING_GRID):
        game = (
            sb.table("boardgamebuddy_games")
            # is_expansion rides along for the mode below, same one lookup.
            .select("name, is_expansion")
            .eq("id", row["game_id"])
            .execute()
        )
        updates["title"] = chapter_grid.grid_title(
            game.data[0].get("name") if game.data else None
        )
        is_expansion = bool(game.data[0].get("is_expansion")) if game.data else False
    # A None grid means "not supplied", so this endpoint cannot CLEAR one. That
    # is deliberate: a chapter never changes layout in practice, and the editor
    # sends layout and grid together or neither.
    if body.grid is not None:
        updates["grid"] = chapter_grid.apply_grid_mode(body.grid, is_expansion)
        # Keep the derived mirror in step with the rows it mirrors, whether or
        # not the caller also sent `content`.
        updates["content"] = chapter_grid.grid_to_content(body.grid)

    sb.table("boardgamebuddy_guide_chapters").update(updates).eq("id", chapter_id).execute()

    fetched = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .eq("id", chapter_id)
        .execute()
    )
    if not fetched.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    return _chapter_row_to_response(fetched.data[0])


@router.patch(
    "/chapters/{chapter_id}",
    response_model=ChapterResponse,
    status_code=200,
    summary="Edit a chapter",
)
async def update_chapter(
    body: ChapterUpdate,
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ChapterResponse:
    """Edit an existing chapter. Creator-only (admins can edit by deleting + recreating)."""
    sb = get_supabase()
    return await asyncio.to_thread(_update_chapter_sync, sb, chapter_id, body, user.user_id)


def _delete_chapter_sync(sb: Client, chapter_id: str, user: CurrentUser) -> MessageResponse:
    existing = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id, created_by")
        .eq("id", chapter_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    if existing.data[0]["created_by"] != user.user_id and not user.is_admin:
        raise HTTPException(status_code=403, detail="You can only delete chapters you created")

    sb.table("boardgamebuddy_guide_chapters").delete().eq("id", chapter_id).execute()
    return MessageResponse(message="Chapter deleted")


@router.delete(
    "/chapters/{chapter_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a chapter from the pool",
)
async def delete_chapter(
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a chapter from the pool. Creator or admin only. Cascades to user_chapters + reports."""
    sb = get_supabase()
    return await asyncio.to_thread(_delete_chapter_sync, sb, chapter_id, user)


def _report_chapter_sync(
    sb: Client, chapter_id: str, body: ChapterReportCreate, user_id: str
) -> MessageResponse:
    chapter = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id")
        .eq("id", chapter_id)
        .execute()
    )
    if not chapter.data:
        raise HTTPException(status_code=404, detail="Chapter not found")

    existing = (
        sb.table("boardgamebuddy_chapter_reports")
        .select("id, status")
        .eq("chapter_id", chapter_id)
        .eq("reporter_id", user_id)
        .execute()
    )
    if existing.data:
        return MessageResponse(message="Already reported — thanks for flagging")

    sb.table("boardgamebuddy_chapter_reports").insert({
        "chapter_id": chapter_id,
        "reporter_id": user_id,
        "reason": body.reason,
    }).execute()
    return MessageResponse(message="Reported — an admin will review shortly")


@router.post(
    "/chapters/{chapter_id}/report",
    response_model=MessageResponse,
    status_code=201,
    summary="Report a chapter for admin review",
)
async def report_chapter(
    body: ChapterReportCreate,
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Flag a chapter for admin moderation. Idempotent per (chapter, reporter)."""
    sb = get_supabase()
    return await asyncio.to_thread(_report_chapter_sync, sb, chapter_id, body, user.user_id)


def _get_my_chapters_sync(
    sb: Client, game_id: str, expansion_ids: Optional[str], user_id: str
) -> list[MyGuideChapterResponse]:
    exp_ids = parse_csv_param(expansion_ids)
    all_game_ids = [game_id, *exp_ids]

    sel_q = (
        sb.table("boardgamebuddy_user_chapters")
        .select("chapter_id, game_id, created_at")
        .eq("user_id", user_id)
        .order("created_at")
    )
    sel_q = sel_q.in_("game_id", all_game_ids) if exp_ids else sel_q.eq("game_id", game_id)
    sel_rows = sel_q.execute().data or []

    if not sel_rows:
        return []

    chapter_ids = [r["chapter_id"] for r in sel_rows]
    added_at_map = {r["chapter_id"]: r["created_at"] for r in sel_rows}

    chapters = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .in_("id", chapter_ids)
        .execute()
    ).data or []

    source_map = _build_source_map(sb, all_game_ids) if exp_ids else {}

    # Preserve insertion order (added_at ascending).
    by_id = {r["id"]: r for r in chapters}
    ordered_rows = [by_id[cid] for cid in chapter_ids if cid in by_id]

    out: list[MyGuideChapterResponse] = []
    for row in ordered_rows:
        base = _chapter_row_to_response(row, source_map if exp_ids else None)
        out.append(MyGuideChapterResponse(
            **base.model_dump(),
            added_at=added_at_map[row["id"]],
        ))
    return out


@router.get(
    "/games/{game_id}/my-chapters",
    response_model=list[MyGuideChapterResponse],
    status_code=200,
    summary="My reference guide for a game",
)
async def get_my_chapters(
    game_id: str = Path(..., description="Game UUID"),
    expansion_ids: Optional[str] = Query(
        None,
        description=(
            "Comma-separated expansion game UUIDs to also include. When set,"
            " the response merges the caller's chapters across the base game"
            " and these expansions, each tagged with source_game_id/source_color."
        ),
    ),
    user: CurrentUser = Depends(get_current_user),
) -> list[MyGuideChapterResponse]:
    """Return the chapters the caller has added to their guide for this game
    (and optionally for the listed expansions, merged into one response)."""
    sb = get_supabase()
    return await asyncio.to_thread(
        _get_my_chapters_sync, sb, game_id, expansion_ids, user.user_id
    )


def _add_chapter_to_my_guide_sync(
    sb: Client, game_id: str, body: AddChapterRequest, user_id: str
) -> MyGuideChapterResponse:
    chapter = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .eq("id", body.chapter_id)
        .eq("game_id", game_id)
        .execute()
    )
    if not chapter.data:
        raise HTTPException(status_code=404, detail="Chapter not found for this game")

    existing = (
        sb.table("boardgamebuddy_user_chapters")
        .select("created_at")
        .eq("user_id", user_id)
        .eq("chapter_id", body.chapter_id)
        .execute()
    )
    if existing.data:
        added_at = existing.data[0]["created_at"]
    else:
        ins = (
            sb.table("boardgamebuddy_user_chapters")
            .insert({
                "user_id": user_id,
                "game_id": game_id,
                "chapter_id": body.chapter_id,
            })
            .execute()
        )
        added_at = ins.data[0]["created_at"] if ins.data else None

    base = _chapter_row_to_response(chapter.data[0])
    return MyGuideChapterResponse(
        **base.model_dump(),
        added_at=added_at or base.updated_at,
    )


@router.post(
    "/games/{game_id}/my-chapters",
    response_model=MyGuideChapterResponse,
    status_code=201,
    summary="Add an existing chapter to my guide",
)
async def add_chapter_to_my_guide(
    body: AddChapterRequest,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MyGuideChapterResponse:
    """Add a chapter from the pool to the caller's guide. Idempotent."""
    sb = get_supabase()
    return await asyncio.to_thread(
        _add_chapter_to_my_guide_sync, sb, game_id, body, user.user_id
    )


@router.delete(
    "/games/{game_id}/my-chapters/{chapter_id}",
    status_code=204,
    summary="Remove a chapter from my guide",
)
async def remove_chapter_from_my_guide(
    game_id: str = Path(..., description="Game UUID"),
    chapter_id: str = Path(..., description="Chapter UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """Drop a chapter from the caller's guide. Does NOT delete the chapter itself. Idempotent."""
    sb = get_supabase()
    await asyncio.to_thread(
        sb.table("boardgamebuddy_user_chapters")
        .delete()
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .eq("chapter_id", chapter_id)
        .execute
    )
    return Response(status_code=204)


# ── Admin moderation ──────────────────────────────────────────────────────────

@router.get(
    "/admin/chapter-reports",
    response_model=list[ChapterReportResponse],
    status_code=200,
    summary="List chapter reports (admin)",
)
async def list_chapter_reports(
    status: str = Query("open", description="Filter: open | resolved"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> list[ChapterReportResponse]:
    """Admin-only: list chapter reports for moderation."""
    if status not in ("open", "resolved"):
        raise HTTPException(status_code=400, detail="status must be 'open' or 'resolved'")
    sb = get_supabase()

    rows_q = (
        sb.table("boardgamebuddy_chapter_reports")
        .select(
            "id, chapter_id, reporter_id, reason, status, created_at, resolved_at,"
            " boardgamebuddy_guide_chapters(title, content, chapter_type, game_id,"
            " boardgamebuddy_chapter_types(label),"
            " boardgamebuddy_games(name)),"
            # boardgamebuddy_chapter_reports has TWO FKs into profiles
            # (reporter_id + resolved_by). PostgREST can't pick a default
            # relationship, so disambiguate via !reporter_id and alias the
            # joined object as `reporter` for a stable JSON key.
            " reporter:boardgamebuddy_profiles!reporter_id(display_name)"
        )
        .eq("status", status)
        .order("created_at", desc=False)
    )
    rows = (await asyncio.to_thread(rows_q.execute)).data or []

    out: list[ChapterReportResponse] = []
    for r in rows:
        chapter = r.get("boardgamebuddy_guide_chapters") or {}
        type_obj = chapter.get("boardgamebuddy_chapter_types") or {}
        game_obj = chapter.get("boardgamebuddy_games") or {}
        reporter = r.get("reporter") or {}
        # Safe for a scoring-grid chapter too, and only because `content` holds
        # a generated plain-text mirror of its rows (services/chapter_grid.py).
        # Do not "fix" this to read `grid` — the whole point of the mirror is
        # that this line, and the pool's ILIKE search, need no branch.
        content = chapter.get("content") or ""
        preview = content[:240] + ("…" if len(content) > 240 else "")
        out.append(ChapterReportResponse(
            id=r["id"],
            chapter_id=r["chapter_id"],
            chapter_title=chapter.get("title") or "(deleted)",
            chapter_content_preview=preview,
            chapter_type=chapter.get("chapter_type") or "",
            chapter_type_label=type_obj.get("label"),
            game_id=chapter.get("game_id") or "",
            game_name=game_obj.get("name") or "(unknown game)",
            reporter_id=r["reporter_id"],
            reporter_name=reporter.get("display_name"),
            reason=r.get("reason"),
            status=r["status"],
            created_at=r["created_at"],
            resolved_at=r.get("resolved_at"),
        ))
    return out


def _resolve_chapter_report_sync(sb: Client, report_id: str, admin_id: str) -> MessageResponse:
    existing = (
        sb.table("boardgamebuddy_chapter_reports")
        .select("id, status")
        .eq("id", report_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Report not found")
    if existing.data[0]["status"] != "open":
        raise HTTPException(status_code=400, detail="Report is already resolved")

    sb.table("boardgamebuddy_chapter_reports").update({
        "status": "resolved",
        "resolved_by": admin_id,
        "resolved_at": "now()",
    }).eq("id", report_id).execute()
    return MessageResponse(message="Report resolved")


@router.post(
    "/admin/chapter-reports/{report_id}/resolve",
    response_model=MessageResponse,
    status_code=200,
    summary="Resolve a chapter report without deleting the chapter (admin)",
)
async def resolve_chapter_report(
    report_id: str = Path(..., description="Report UUID"),
    admin: CurrentUser = Depends(get_current_admin),
) -> MessageResponse:
    """Admin-only: mark a report as resolved with no further action."""
    sb = get_supabase()
    return await asyncio.to_thread(
        _resolve_chapter_report_sync, sb, report_id, admin.user_id
    )
