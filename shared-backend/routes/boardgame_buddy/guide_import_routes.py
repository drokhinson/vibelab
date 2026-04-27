"""Guide bundle import: admin direct, user-submit with review queue, and review endpoints."""

import logging
from typing import Optional

from fastapi import Depends, Header, HTTPException, Path, Query  # Query used by /guides/import

from auth import require_admin
from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user

from . import router
from .game_routes import (
    _GAME_SUMMARY_FIELDS,
    _hydrate_images_from_bgg,
    _next_expansion_color,
    import_bgg_game,
)
from .models import (
    GameSummary,
    GuideBundle,
    GuideImportResponse,
    PendingGuideDecisionBody,
    PendingGuideDetail,
    PendingGuideSubmitResponse,
    PendingGuideSummary,
)

logger = logging.getLogger(__name__)


async def _apply_bundle(bundle: GuideBundle, force: bool, created_by: Optional[str] = None) -> GuideImportResponse:
    """Insert a validated GuideBundle's chunks into the DB. Shared by admin direct + approval paths."""
    sb = get_supabase()

    valid_type_rows = (
        sb.table("boardgamebuddy_chunk_types")
        .select("id")
        .execute()
    )
    valid_types = {r["id"] for r in (valid_type_rows.data or [])}
    unknown = sorted({c.chunk_type for c in bundle.chunks if c.chunk_type not in valid_types})
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown chunk_type(s): {unknown}. Valid: {sorted(valid_types)}",
        )

    imported_game = False
    direct_inserted = False  # bundle had full metadata → no BGG call yet
    existing_game = (
        sb.table("boardgamebuddy_games")
        .select("id, is_expansion, base_game_bgg_id, expansion_color")
        .eq("bgg_id", bundle.game.bgg_id)
        .execute()
    )
    g = bundle.game
    if existing_game.data:
        game_id = existing_game.data[0]["id"]
        # Backfill expansion linkage if the bundle now claims expansion status
        # but the existing row predates this feature (or was imported as a
        # base game by mistake). Trust the bundle.
        if g.is_expansion:
            existing_row = existing_game.data[0]
            updates: dict[str, object] = {}
            if not existing_row.get("is_expansion"):
                updates["is_expansion"] = True
            if g.base_game_bgg_id and existing_row.get("base_game_bgg_id") != g.base_game_bgg_id:
                updates["base_game_bgg_id"] = g.base_game_bgg_id
            if not existing_row.get("expansion_color"):
                updates["expansion_color"] = _next_expansion_color(sb, g.base_game_bgg_id)
            if updates:
                sb.table("boardgamebuddy_games").update(updates).eq("id", game_id).execute()
    else:
        # If the bundle carries the core BGG metadata, insert directly and skip
        # the BGG XML API call (saves daily quota). image_url / thumbnail_url
        # are left NULL — best-effort image hydration runs after insert below.
        if g.min_players is not None and g.max_players is not None and g.playing_time is not None:
            new_row: dict[str, object] = {
                "bgg_id": g.bgg_id,
                "name": g.name,
                "min_players": g.min_players,
                "max_players": g.max_players,
                "playing_time": g.playing_time,
                "is_expansion": g.is_expansion,
                "base_game_bgg_id": g.base_game_bgg_id,
            }
            if g.is_expansion:
                new_row["expansion_color"] = _next_expansion_color(sb, g.base_game_bgg_id)
            insert = sb.table("boardgamebuddy_games").insert(new_row).execute()
            game_id = insert.data[0]["id"]
            direct_inserted = True
        else:
            summary = await import_bgg_game(g.bgg_id)
            game_id = summary.id
        imported_game = True

    if force:
        (
            sb.table("boardgamebuddy_guide_chunks")
            .delete()
            .eq("game_id", game_id)
            .eq("is_default", True)
            .execute()
        )

    existing_rows = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("chunk_type, title")
        .eq("game_id", game_id)
        .execute()
    )
    existing_keys = {(r["chunk_type"], r["title"]) for r in (existing_rows.data or [])}

    # Admin direct imports (created_by=None) are seed chunks and become the
    # curated defaults. Approved community submissions land as non-default
    # contributions until the admin opts in via the per-chunk is_default flag.
    bulk_default = created_by is None
    to_insert = []
    skipped_reasons: list[str] = []
    for chunk in bundle.chunks:
        key = (chunk.chunk_type, chunk.title)
        if key in existing_keys:
            skipped_reasons.append(f"duplicate: {chunk.chunk_type} / {chunk.title!r}")
            continue
        effective_default = chunk.is_default if chunk.is_default is not None else bulk_default
        to_insert.append({
            "game_id": game_id,
            "chunk_type": chunk.chunk_type,
            "title": chunk.title,
            "content": chunk.content,
            "layout": chunk.layout,
            "is_default": effective_default,
            "created_by": created_by,
        })
        existing_keys.add(key)

    if to_insert:
        sb.table("boardgamebuddy_guide_chunks").insert(to_insert).execute()

    image_fetch_warning: Optional[str] = None
    if direct_inserted:
        try:
            await _hydrate_images_from_bgg(sb, game_id, g.bgg_id)
        except Exception as exc:
            logger.warning("post-insert image hydration failed bgg_id=%s: %s", g.bgg_id, exc)
            image_fetch_warning = (
                "Game added, but BGG image fetch failed. "
                "It will appear in the Missing images list — refresh from there."
            )

    return GuideImportResponse(
        game_id=game_id,
        imported_game=imported_game,
        chunks_inserted=len(to_insert),
        chunks_skipped=len(skipped_reasons),
        skipped_reasons=skipped_reasons,
        image_fetch_warning=image_fetch_warning,
    )


def _require_profile_admin(sb, user_id: str) -> None:
    """Block unless the profile row has is_admin=true."""
    profile = (
        sb.table("boardgamebuddy_profiles")
        .select("is_admin")
        .eq("id", user_id)
        .execute()
    )
    if not profile.data or not profile.data[0].get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin privileges required")


@router.post(
    "/guides/import",
    response_model=GuideImportResponse,
    status_code=200,
    summary="Bulk import a generated guide bundle (admin API key)",
)
async def import_guide(
    bundle: GuideBundle,
    force: bool = Query(False, description="Replace existing default chunks (is_default=true) before inserting"),
    authorization: Optional[str] = Header(None),
) -> GuideImportResponse:
    """Import a JSON guide bundle. Authenticated via shared ADMIN_API_KEY."""
    require_admin(authorization)
    return await _apply_bundle(bundle, force)


@router.post(
    "/guides/submit",
    response_model=PendingGuideSubmitResponse,
    status_code=200,
    summary="Submit a guide bundle for review (all users, including admins)",
)
async def submit_guide(
    bundle: GuideBundle,
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> PendingGuideSubmitResponse:
    """Queue a guide bundle for admin review. All users — including admins — go through review."""
    sb = get_supabase()
    inserted = (
        sb.table("boardgamebuddy_pending_guides")
        .insert({
            "uploader_id": su_user.sub,
            "game_name": bundle.game.name,
            "bgg_id": bundle.game.bgg_id,
            "chunk_count": len(bundle.chunks),
            "bundle": bundle.model_dump(mode="json"),
            "status": "pending",
        })
        .execute()
    )
    pending_id = inserted.data[0]["id"] if inserted.data else None
    return PendingGuideSubmitResponse(
        id=pending_id,
        status="submitted",
        message="Submitted for review. An admin will approve or reject it shortly.",
    )


@router.get(
    "/guides/pending",
    response_model=list[PendingGuideSummary],
    status_code=200,
    summary="List pending user-submitted guide bundles (admin only)",
)
async def list_pending_guides(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> list[PendingGuideSummary]:
    """Admin-only: list all pending guide submissions with uploader display names."""
    sb = get_supabase()
    _require_profile_admin(sb, su_user.sub)

    rows = (
        sb.table("boardgamebuddy_pending_guides")
        .select("id, uploader_id, game_name, bgg_id, chunk_count, status, created_at")
        .eq("status", "pending")
        .order("created_at", desc=False)
        .execute()
    )
    records = rows.data or []
    uploader_ids = list({r["uploader_id"] for r in records})
    name_map: dict[str, str] = {}
    if uploader_ids:
        names = (
            sb.table("boardgamebuddy_profiles")
            .select("id, display_name")
            .in_("id", uploader_ids)
            .execute()
        )
        name_map = {r["id"]: r["display_name"] for r in (names.data or [])}

    return [
        PendingGuideSummary(
            uploader_name=name_map.get(r["uploader_id"]),
            **r,
        )
        for r in records
    ]


@router.get(
    "/guides/pending/{pending_id}",
    response_model=PendingGuideDetail,
    status_code=200,
    summary="Get a pending guide submission's full bundle (admin only)",
)
async def get_pending_guide(
    pending_id: str = Path(..., description="Pending guide submission UUID"),
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> PendingGuideDetail:
    """Admin-only: fetch a single pending submission including its full bundle for review."""
    sb = get_supabase()
    _require_profile_admin(sb, su_user.sub)

    result = (
        sb.table("boardgamebuddy_pending_guides")
        .select("*")
        .eq("id", pending_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Pending submission not found")
    row = result.data[0]
    uploader_name = None
    names = (
        sb.table("boardgamebuddy_profiles")
        .select("display_name")
        .eq("id", row["uploader_id"])
        .execute()
    )
    if names.data:
        uploader_name = names.data[0]["display_name"]

    game_exists = False
    existing_game: Optional[GameSummary] = None
    bundle_bgg_id = (row.get("bundle") or {}).get("game", {}).get("bgg_id")
    if bundle_bgg_id:
        catalog = (
            sb.table("boardgamebuddy_games")
            .select(_GAME_SUMMARY_FIELDS)
            .eq("bgg_id", bundle_bgg_id)
            .execute()
        )
        if catalog.data:
            game_exists = True
            existing_game = GameSummary(**catalog.data[0])

    return PendingGuideDetail(
        uploader_name=uploader_name,
        game_exists=game_exists,
        existing_game=existing_game,
        **row,
    )


@router.post(
    "/guides/pending/{pending_id}/approve",
    response_model=GuideImportResponse,
    status_code=200,
    summary="Approve and import a pending guide submission (admin only)",
)
async def approve_pending_guide(
    body: PendingGuideDecisionBody,
    pending_id: str = Path(..., description="Pending guide submission UUID"),
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> GuideImportResponse:
    """Admin-only: import the submitted bundle and mark the pending row approved."""
    sb = get_supabase()
    _require_profile_admin(sb, su_user.sub)

    result = (
        sb.table("boardgamebuddy_pending_guides")
        .select("*")
        .eq("id", pending_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Pending submission not found")
    row = result.data[0]
    if row["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Already {row['status']}")

    bundle_data = body.override_bundle.model_dump(mode="json") if body.override_bundle else row["bundle"]
    bundle = GuideBundle(**bundle_data)
    import_result = await _apply_bundle(bundle, body.force, created_by=row["uploader_id"])

    sb.table("boardgamebuddy_pending_guides").update({
        "status": "approved",
        "review_notes": body.notes,
        "reviewed_by": su_user.sub,
        "reviewed_at": "now()",
    }).eq("id", pending_id).execute()

    return import_result


@router.post(
    "/guides/pending/{pending_id}/reject",
    response_model=PendingGuideSummary,
    status_code=200,
    summary="Reject a pending guide submission (admin only)",
)
async def reject_pending_guide(
    body: PendingGuideDecisionBody,
    pending_id: str = Path(..., description="Pending guide submission UUID"),
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> PendingGuideSummary:
    """Admin-only: mark a pending submission as rejected, leaving an audit row."""
    sb = get_supabase()
    _require_profile_admin(sb, su_user.sub)

    result = (
        sb.table("boardgamebuddy_pending_guides")
        .select("*")
        .eq("id", pending_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Pending submission not found")
    row = result.data[0]
    if row["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Already {row['status']}")

    updated = (
        sb.table("boardgamebuddy_pending_guides")
        .update({
            "status": "rejected",
            "review_notes": body.notes,
            "reviewed_by": su_user.sub,
            "reviewed_at": "now()",
        })
        .eq("id", pending_id)
        .execute()
    )
    final = updated.data[0] if updated.data else row
    return PendingGuideSummary(
        id=final["id"],
        uploader_id=final["uploader_id"],
        game_name=final["game_name"],
        bgg_id=final.get("bgg_id"),
        chunk_count=final["chunk_count"],
        status=final["status"],
        created_at=final["created_at"],
    )
