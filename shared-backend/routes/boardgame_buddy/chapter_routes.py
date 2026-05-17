"""Reference-guide chapter endpoints.

Each user builds their own reference guide for each game by adding
chapters one at a time. Two ways to add: create a new chapter (type +
title + markdown), or browse the pool of existing chapters for that
game and add the ones they want. No curated defaults, no review queue
— moderation is reactive via per-chapter reports.
"""

from typing import Any, Optional

from fastapi import Depends, Header, HTTPException, Path, Query, Response

from db import get_supabase

from . import router
from .dependencies import (
    CurrentUser,
    get_current_admin,
    get_current_user,
    maybe_supabase_user,
)
from .models import (
    AddChapterRequest,
    ChapterCreate,
    ChapterPoolItem,
    ChapterReportCreate,
    ChapterReportResponse,
    ChapterResponse,
    ChapterTypeResponse,
    ChapterUpdate,
    MessageResponse,
    MyGuideChapterResponse,
)


_CHAPTER_SELECT = (
    "id, game_id, chapter_type, title, layout, content,"
    " created_by, updated_at, created_at,"
    " boardgamebuddy_chapter_types(label, icon, display_order),"
    " boardgamebuddy_profiles(display_name)"
)


def _parse_expansion_ids(raw: Optional[str]) -> list[str]:
    """Parse comma-separated ?expansion_ids=a,b,c into a list (empty if blank)."""
    if not raw:
        return []
    return [s for s in (p.strip() for p in raw.split(",")) if s]


def _build_source_map(sb, game_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch (name, expansion_color) for a list of game ids in one round-trip.

    The chapter response uses this to populate source_game_name / source_color
    so the FE can render colored dots tying each chapter to its expansion (or
    leave the dot blank for base-game chapters).
    """
    if not game_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_games")
        .select("id, name, expansion_color, is_expansion")
        .in_("id", game_ids)
        .execute()
    ).data or []
    return {
        r["id"]: {
            "name": r.get("name") or "",
            # Base games get None — the FE skips the colored dot.
            "color": r.get("expansion_color") if r.get("is_expansion") else None,
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
    if source_map is not None:
        entry = source_map.get(row["game_id"])
        source_game_id = row["game_id"]
        if entry:
            source_game_name = entry.get("name")
            source_color = entry.get("color")

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
        created_by=row.get("created_by"),
        created_by_name=created_by_name,
        updated_at=row["updated_at"],
        source_game_id=source_game_id,
        source_game_name=source_game_name,
        source_color=source_color,
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
    result = (
        sb.table("boardgamebuddy_chapter_types")
        .select("id, label, icon, display_order")
        .order("display_order")
        .execute()
    )
    return [ChapterTypeResponse(**r) for r in (result.data or [])]


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

    exp_ids = _parse_expansion_ids(expansion_ids)
    all_game_ids = [game_id, *exp_ids]

    pool_q = sb.table("boardgamebuddy_guide_chapters").select(_CHAPTER_SELECT)
    pool_q = pool_q.in_("game_id", all_game_ids) if exp_ids else pool_q.eq("game_id", game_id)
    if chapter_type:
        pool_q = pool_q.eq("chapter_type", chapter_type)
    if q:
        # PostgREST's `or` filter combines two ILIKE matches into one query.
        needle = f"%{q}%"
        pool_q = pool_q.or_(f"title.ilike.{needle},content.ilike.{needle}")
    pool_rows = pool_q.execute().data or []

    if not pool_rows:
        return []

    chapter_ids = [r["id"] for r in pool_rows]
    source_map = _build_source_map(sb, all_game_ids) if exp_ids else {}

    # Popularity: count user_chapters rows per chapter in one round trip.
    popularity: dict[str, int] = {cid: 0 for cid in chapter_ids}
    pop_rows = (
        sb.table("boardgamebuddy_user_chapters")
        .select("chapter_id")
        .in_("chapter_id", chapter_ids)
        .execute()
    ).data or []
    for r in pop_rows:
        popularity[r["chapter_id"]] = popularity.get(r["chapter_id"], 0) + 1

    in_my_guide: set[str] = set()
    if su_user is not None:
        mine = (
            sb.table("boardgamebuddy_user_chapters")
            .select("chapter_id")
            .eq("user_id", su_user.sub)
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

    game = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    _validate_chapter_type(sb, body.chapter_type)

    insert = (
        sb.table("boardgamebuddy_guide_chapters")
        .insert({
            "game_id": game_id,
            "chapter_type": body.chapter_type,
            "title": body.title,
            "content": body.content,
            "layout": body.layout,
            "created_by": user.user_id,
        })
        .execute()
    )
    new_id = insert.data[0]["id"]

    # Auto-add to creator's guide.
    sel = (
        sb.table("boardgamebuddy_user_chapters")
        .insert({
            "user_id": user.user_id,
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

    existing = (
        sb.table("boardgamebuddy_guide_chapters")
        .select("id, created_by")
        .eq("id", chapter_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chapter not found")
    if existing.data[0]["created_by"] != user.user_id:
        raise HTTPException(status_code=403, detail="You can only edit chapters you created")

    updates: dict[str, Any] = {"updated_at": "now()"}
    if body.chapter_type is not None:
        _validate_chapter_type(sb, body.chapter_type)
        updates["chapter_type"] = body.chapter_type
    if body.title is not None:
        updates["title"] = body.title
    if body.content is not None:
        updates["content"] = body.content
    if body.layout is not None:
        updates["layout"] = body.layout

    sb.table("boardgamebuddy_guide_chapters").update(updates).eq("id", chapter_id).execute()

    fetched = (
        sb.table("boardgamebuddy_guide_chapters")
        .select(_CHAPTER_SELECT)
        .eq("id", chapter_id)
        .execute()
    )
    return _chapter_row_to_response(fetched.data[0])


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
        .eq("reporter_id", user.user_id)
        .execute()
    )
    if existing.data:
        return MessageResponse(message="Already reported — thanks for flagging")

    sb.table("boardgamebuddy_chapter_reports").insert({
        "chapter_id": chapter_id,
        "reporter_id": user.user_id,
        "reason": body.reason,
    }).execute()
    return MessageResponse(message="Reported — an admin will review shortly")


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

    exp_ids = _parse_expansion_ids(expansion_ids)
    all_game_ids = [game_id, *exp_ids]

    sel_q = (
        sb.table("boardgamebuddy_user_chapters")
        .select("chapter_id, game_id, created_at")
        .eq("user_id", user.user_id)
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
        .eq("user_id", user.user_id)
        .eq("chapter_id", body.chapter_id)
        .execute()
    )
    if existing.data:
        added_at = existing.data[0]["created_at"]
    else:
        ins = (
            sb.table("boardgamebuddy_user_chapters")
            .insert({
                "user_id": user.user_id,
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
    (
        sb.table("boardgamebuddy_user_chapters")
        .delete()
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .eq("chapter_id", chapter_id)
        .execute()
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

    rows = (
        sb.table("boardgamebuddy_chapter_reports")
        .select(
            "id, chapter_id, reporter_id, reason, status, created_at, resolved_at,"
            " boardgamebuddy_guide_chapters(title, content, chapter_type, game_id,"
            " boardgamebuddy_chapter_types(label),"
            " boardgamebuddy_games(name)),"
            " boardgamebuddy_profiles(display_name)"
        )
        .eq("status", status)
        .order("created_at", desc=False)
        .execute()
    ).data or []

    out: list[ChapterReportResponse] = []
    for r in rows:
        chapter = r.get("boardgamebuddy_guide_chapters") or {}
        type_obj = chapter.get("boardgamebuddy_chapter_types") or {}
        game_obj = chapter.get("boardgamebuddy_games") or {}
        reporter = r.get("boardgamebuddy_profiles") or {}
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
        "resolved_by": admin.user_id,
        "resolved_at": "now()",
    }).eq("id", report_id).execute()
    return MessageResponse(message="Report resolved")
