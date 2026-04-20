"""Guide chunk endpoints — reusable guide pieces plus per-user selections."""

from typing import Any

from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .models import (
    ChunkCreate,
    ChunkResponse,
    ChunkTypeResponse,
    ChunkUpdate,
    GuideSelectionUpdate,
    MessageResponse,
)
from .dependencies import CurrentUser, get_current_user


def _chunk_row_to_response(row: dict[str, Any]) -> ChunkResponse:
    """Flatten a Supabase row with joined chunk_type and profile into ChunkResponse."""
    chunk_type = row.get("chunk_type")
    # Supabase FK expansion returns a nested dict when using PostgREST embedding.
    type_obj = row.get("boardgamebuddy_chunk_types")
    profile_obj = row.get("boardgamebuddy_profiles")

    chunk_type_label = None
    chunk_type_icon = None
    if isinstance(type_obj, dict):
        chunk_type_label = type_obj.get("label")
        chunk_type_icon = type_obj.get("icon")

    created_by_name = None
    if isinstance(profile_obj, dict):
        created_by_name = profile_obj.get("display_name")

    return ChunkResponse(
        id=row["id"],
        game_id=row["game_id"],
        chunk_type=chunk_type,
        chunk_type_label=chunk_type_label,
        chunk_type_icon=chunk_type_icon,
        title=row["title"],
        layout=row.get("layout", "text"),
        content=row["content"],
        created_by=row.get("created_by"),
        created_by_name=created_by_name,
        updated_at=row["updated_at"],
    )


_CHUNK_SELECT = (
    "id, game_id, chunk_type, title, layout, content, created_by, updated_at,"
    " boardgamebuddy_chunk_types(label, icon),"
    " boardgamebuddy_profiles(display_name)"
)


@router.get(
    "/chunk-types",
    response_model=list[ChunkTypeResponse],
    status_code=200,
    summary="List chunk types",
)
async def list_chunk_types() -> list[ChunkTypeResponse]:
    """Return the available chunk type lookup rows."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_chunk_types")
        .select("id, label, icon, display_order")
        .order("display_order")
        .execute()
    )
    return [ChunkTypeResponse(**r) for r in (result.data or [])]


@router.get(
    "/games/{game_id}/chunks",
    response_model=list[ChunkResponse],
    status_code=200,
    summary="List chunks for a game",
)
async def list_chunks(
    game_id: str = Path(..., description="Game UUID"),
) -> list[ChunkResponse]:
    """Return every chunk contributed for a game, ordered by type then title."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_guide_chunks")
        .select(_CHUNK_SELECT)
        .eq("game_id", game_id)
        .execute()
    )
    rows = result.data or []
    rows.sort(key=lambda r: (
        ((r.get("boardgamebuddy_chunk_types") or {}).get("label") or r.get("chunk_type") or ""),
        r.get("title") or "",
    ))
    return [_chunk_row_to_response(r) for r in rows]


@router.post(
    "/games/{game_id}/chunks",
    response_model=ChunkResponse,
    status_code=201,
    summary="Create a chunk",
)
async def create_chunk(
    body: ChunkCreate,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ChunkResponse:
    """Create a new guide chunk attached to a game."""
    sb = get_supabase()

    # Verify game exists.
    game = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

    # Verify chunk_type is valid.
    chunk_type = (
        sb.table("boardgamebuddy_chunk_types")
        .select("id")
        .eq("id", body.chunk_type)
        .execute()
    )
    if not chunk_type.data:
        raise HTTPException(status_code=400, detail="Unknown chunk type")

    insert = (
        sb.table("boardgamebuddy_guide_chunks")
        .insert({
            "game_id": game_id,
            "chunk_type": body.chunk_type,
            "title": body.title,
            "content": body.content,
            "layout": body.layout,
            "created_by": user.user_id,
        })
        .execute()
    )
    new_id = insert.data[0]["id"]

    fetched = (
        sb.table("boardgamebuddy_guide_chunks")
        .select(_CHUNK_SELECT)
        .eq("id", new_id)
        .execute()
    )
    return _chunk_row_to_response(fetched.data[0])


@router.patch(
    "/chunks/{chunk_id}",
    response_model=ChunkResponse,
    status_code=200,
    summary="Edit a chunk",
)
async def update_chunk(
    body: ChunkUpdate,
    chunk_id: str = Path(..., description="Chunk UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ChunkResponse:
    """Edit an existing chunk. Only the creator may edit."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("id, created_by")
        .eq("id", chunk_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chunk not found")
    if existing.data[0]["created_by"] != user.user_id:
        raise HTTPException(status_code=403, detail="You can only edit chunks you created")

    updates: dict[str, Any] = {"updated_at": "now()"}
    if body.chunk_type is not None:
        ct = (
            sb.table("boardgamebuddy_chunk_types")
            .select("id")
            .eq("id", body.chunk_type)
            .execute()
        )
        if not ct.data:
            raise HTTPException(status_code=400, detail="Unknown chunk type")
        updates["chunk_type"] = body.chunk_type
    if body.title is not None:
        updates["title"] = body.title
    if body.content is not None:
        updates["content"] = body.content
    if body.layout is not None:
        updates["layout"] = body.layout

    sb.table("boardgamebuddy_guide_chunks").update(updates).eq("id", chunk_id).execute()

    fetched = (
        sb.table("boardgamebuddy_guide_chunks")
        .select(_CHUNK_SELECT)
        .eq("id", chunk_id)
        .execute()
    )
    return _chunk_row_to_response(fetched.data[0])


@router.delete(
    "/chunks/{chunk_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a chunk",
)
async def delete_chunk(
    chunk_id: str = Path(..., description="Chunk UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a chunk. Only the creator may delete. Cascades to selections."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("id, created_by")
        .eq("id", chunk_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chunk not found")
    if existing.data[0]["created_by"] != user.user_id:
        raise HTTPException(status_code=403, detail="You can only delete chunks you created")

    sb.table("boardgamebuddy_guide_chunks").delete().eq("id", chunk_id).execute()
    return MessageResponse(message="Chunk deleted")


@router.get(
    "/games/{game_id}/my-guide",
    response_model=list[ChunkResponse],
    status_code=200,
    summary="Get my assembled guide for a game",
)
async def get_my_guide(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> list[ChunkResponse]:
    """Return the current user's selected chunks for the game, in order."""
    sb = get_supabase()
    selections = (
        sb.table("boardgamebuddy_guide_selections")
        .select("chunk_id, display_order")
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .order("display_order")
        .execute()
    )
    rows = selections.data or []
    if not rows:
        return []

    chunk_ids = [r["chunk_id"] for r in rows]
    chunks = (
        sb.table("boardgamebuddy_guide_chunks")
        .select(_CHUNK_SELECT)
        .in_("id", chunk_ids)
        .execute()
    )
    by_id = {c["id"]: c for c in (chunks.data or [])}
    ordered = [by_id[cid] for cid in chunk_ids if cid in by_id]
    return [_chunk_row_to_response(r) for r in ordered]


@router.put(
    "/games/{game_id}/my-guide",
    response_model=MessageResponse,
    status_code=200,
    summary="Replace my guide selection",
)
async def set_my_guide(
    body: GuideSelectionUpdate,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Replace this user's chunk selection for the game with the given ordered list."""
    sb = get_supabase()

    if body.chunk_ids:
        valid = (
            sb.table("boardgamebuddy_guide_chunks")
            .select("id")
            .eq("game_id", game_id)
            .in_("id", body.chunk_ids)
            .execute()
        )
        valid_ids = {r["id"] for r in (valid.data or [])}
        invalid = [cid for cid in body.chunk_ids if cid not in valid_ids]
        if invalid:
            raise HTTPException(
                status_code=400,
                detail=f"Chunks not found for this game: {invalid}",
            )

    # Atomic replace: clear existing, insert new ordered rows.
    (
        sb.table("boardgamebuddy_guide_selections")
        .delete()
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .execute()
    )

    if body.chunk_ids:
        rows = [
            {
                "user_id": user.user_id,
                "game_id": game_id,
                "chunk_id": chunk_id,
                "display_order": idx,
            }
            for idx, chunk_id in enumerate(body.chunk_ids)
        ]
        sb.table("boardgamebuddy_guide_selections").insert(rows).execute()

    return MessageResponse(message="Guide updated")
