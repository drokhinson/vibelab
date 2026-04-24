"""Bulk import endpoint for agent-generated guide bundles."""

from typing import Optional

from fastapi import Header, HTTPException, Query

from auth import require_admin
from db import get_supabase

from . import router
from .game_routes import import_bgg_game
from .models import GuideBundle, GuideImportResponse


@router.post(
    "/guides/import",
    response_model=GuideImportResponse,
    status_code=200,
    summary="Bulk import a generated guide bundle",
)
async def import_guide(
    bundle: GuideBundle,
    force: bool = Query(False, description="Replace existing seed chunks (created_by IS NULL) before inserting"),
    authorization: Optional[str] = Header(None),
) -> GuideImportResponse:
    """Import a JSON guide bundle produced by the agentic generator. Admin auth required."""
    require_admin(authorization)
    sb = get_supabase()

    # Validate chunk types against the lookup table (single round-trip).
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

    # Look up the game by bgg_id; import from BGG if missing.
    imported_game = False
    existing_game = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("bgg_id", bundle.game.bgg_id)
        .execute()
    )
    if existing_game.data:
        game_id = existing_game.data[0]["id"]
    else:
        summary = await import_bgg_game(bundle.game.bgg_id)
        game_id = summary.id
        imported_game = True

    # Optional: wipe existing seed chunks for this game (preserving user contributions).
    if force:
        (
            sb.table("boardgamebuddy_guide_chunks")
            .delete()
            .eq("game_id", game_id)
            .is_("created_by", "null")
            .execute()
        )

    # Fetch existing (chunk_type, title) pairs once to dedupe without N+1.
    existing_rows = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("chunk_type, title")
        .eq("game_id", game_id)
        .execute()
    )
    existing_keys = {(r["chunk_type"], r["title"]) for r in (existing_rows.data or [])}

    to_insert = []
    skipped_reasons: list[str] = []
    for chunk in bundle.chunks:
        key = (chunk.chunk_type, chunk.title)
        if key in existing_keys:
            skipped_reasons.append(f"duplicate: {chunk.chunk_type} / {chunk.title!r}")
            continue
        to_insert.append({
            "game_id": game_id,
            "chunk_type": chunk.chunk_type,
            "title": chunk.title,
            "content": chunk.content,
            "layout": chunk.layout,
            "created_by": None,
        })
        existing_keys.add(key)  # guard against dupes within this bundle too

    if to_insert:
        sb.table("boardgamebuddy_guide_chunks").insert(to_insert).execute()

    return GuideImportResponse(
        game_id=game_id,
        imported_game=imported_game,
        chunks_inserted=len(to_insert),
        chunks_skipped=len(skipped_reasons),
        skipped_reasons=skipped_reasons,
    )
