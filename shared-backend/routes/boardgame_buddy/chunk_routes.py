"""Guide chunk endpoints — reusable guide pieces plus per-user selections."""

from typing import Any, Optional

from fastapi import Depends, HTTPException, Path, Response

from db import get_supabase

from . import router
from .models import (
    ChunkCreate,
    ChunkResponse,
    ChunkTypeResponse,
    ChunkUpdate,
    ChunkVisibilityUpdate,
    ExpansionInline,
    GuideSelectionUpdate,
    MessageResponse,
    MyGuideChunkResponse,
    MyGuideResponse,
)
from .dependencies import CurrentUser, get_current_user


def _chunk_row_to_response(
    row: dict[str, Any],
    expansion_map: Optional[dict[str, ExpansionInline]] = None,
) -> ChunkResponse:
    """Flatten a Supabase row with joined chunk_type and profile into ChunkResponse.

    `expansion_map` keys on `game_id`. When the chunk's `game_id` is found
    there, the chunk was contributed by an enabled expansion and the
    matching ExpansionInline (name + dot color) is attached to the response.
    """
    chunk_type = row.get("chunk_type")
    type_obj = row.get("boardgamebuddy_chunk_types")
    profile_obj = row.get("boardgamebuddy_profiles")

    chunk_type_label = None
    chunk_type_icon = None
    chunk_type_order = 0
    if isinstance(type_obj, dict):
        chunk_type_label = type_obj.get("label")
        chunk_type_icon = type_obj.get("icon")
        chunk_type_order = int(type_obj.get("display_order") or 0)

    created_by_name = None
    if isinstance(profile_obj, dict):
        created_by_name = profile_obj.get("display_name")

    expansion = expansion_map.get(row["game_id"]) if expansion_map else None

    return ChunkResponse(
        id=row["id"],
        game_id=row["game_id"],
        chunk_type=chunk_type,
        chunk_type_label=chunk_type_label,
        chunk_type_icon=chunk_type_icon,
        chunk_type_order=chunk_type_order,
        title=row["title"],
        layout=row.get("layout", "text"),
        content=row["content"],
        is_default=bool(row.get("is_default")),
        created_by=row.get("created_by"),
        created_by_name=created_by_name,
        updated_at=row["updated_at"],
        expansion=expansion,
    )


_CHUNK_SELECT = (
    "id, game_id, chunk_type, title, layout, content, is_default,"
    " created_by, updated_at,"
    " boardgamebuddy_chunk_types(label, icon, display_order),"
    " boardgamebuddy_profiles(display_name)"
)


def _sort_chunk_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort by chunk_type.display_order, then title."""
    return sorted(rows, key=lambda r: (
        int(((r.get("boardgamebuddy_chunk_types") or {}).get("display_order")) or 0),
        r.get("title") or "",
    ))


def _enabled_expansions_for(
    base_bgg_id: Optional[int],
    user_id: str,
) -> tuple[list[str], dict[str, ExpansionInline]]:
    """Return (enabled_game_ids, expansion_map keyed by game_id) for a user+base.

    Empty when the base game has no expansions or the user has none enabled.
    """
    if not base_bgg_id:
        return [], {}
    sb = get_supabase()
    expansions = (
        sb.table("boardgamebuddy_games")
        .select("id, name, expansion_color")
        .eq("is_expansion", True)
        .eq("base_game_bgg_id", base_bgg_id)
        .execute()
    )
    rows = expansions.data or []
    if not rows:
        return [], {}
    exp_ids = [r["id"] for r in rows]
    enabled = (
        sb.table("boardgamebuddy_user_expansions")
        .select("expansion_game_id")
        .eq("user_id", user_id)
        .in_("expansion_game_id", exp_ids)
        .execute()
    )
    enabled_ids = {r["expansion_game_id"] for r in (enabled.data or [])}
    enabled_list = [r["id"] for r in rows if r["id"] in enabled_ids]
    expansion_map = {
        r["id"]: ExpansionInline(
            expansion_game_id=r["id"],
            name=r["name"],
            color=r.get("expansion_color"),
        )
        for r in rows
        if r["id"] in enabled_ids
    }
    return enabled_list, expansion_map


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
    summary="List default chunks for a game",
)
async def list_chunks(
    game_id: str = Path(..., description="Game UUID"),
) -> list[ChunkResponse]:
    """Return the default (curated) chunks for a game.

    Used by anonymous viewers and as the seed view for signed-in users with no
    customizations. Non-default community chunks only become reachable after a
    user opts into customizing their guide.
    """
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_guide_chunks")
        .select(_CHUNK_SELECT)
        .eq("game_id", game_id)
        .eq("is_default", True)
        .execute()
    )
    rows = _sort_chunk_rows(result.data or [])
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

    game = (
        sb.table("boardgamebuddy_games")
        .select("id")
        .eq("id", game_id)
        .execute()
    )
    if not game.data:
        raise HTTPException(status_code=404, detail="Game not found")

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
    """Edit an existing chunk. Creator or admin may edit."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("id, created_by")
        .eq("id", chunk_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chunk not found")
    if existing.data[0]["created_by"] != user.user_id and not user.is_admin:
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
    """Delete a chunk. Creator or admin may delete. Cascades to selections."""
    sb = get_supabase()

    existing = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("id, created_by")
        .eq("id", chunk_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Chunk not found")
    if existing.data[0]["created_by"] != user.user_id and not user.is_admin:
        raise HTTPException(status_code=403, detail="You can only delete chunks you created")

    sb.table("boardgamebuddy_guide_chunks").delete().eq("id", chunk_id).execute()
    return MessageResponse(message="Chunk deleted")


@router.get(
    "/games/{game_id}/my-guide",
    response_model=MyGuideResponse,
    status_code=200,
    summary="Get my assembled guide for a game",
)
async def get_my_guide(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MyGuideResponse:
    """Return the user's guide view for a game.

    Two view modes, distinguished by `has_customizations`:
    - **No selections:** returns only `is_default=true` chunks; the user is in
      the default view and the frontend hides the panel + restore button.
    - **Has selections:** returns *all* chunks with per-user `is_hidden` and
      `user_display_order` overlays so the frontend can split visible vs. the
      Hidden / available chunks panel.

    Default chunks of any expansion the user has toggled on are merged into
    the response; each merged chunk is tagged with its source expansion's
    color so the UI can render the dot.
    """
    sb = get_supabase()

    base_row = (
        sb.table("boardgamebuddy_games")
        .select("bgg_id")
        .eq("id", game_id)
        .execute()
    )
    if not base_row.data:
        raise HTTPException(status_code=404, detail="Game not found")
    base_bgg_id = base_row.data[0].get("bgg_id")

    enabled_ids, expansion_map = _enabled_expansions_for(base_bgg_id, user.user_id)

    selections_res = (
        sb.table("boardgamebuddy_guide_selections")
        .select("chunk_id, display_order, is_hidden")
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .execute()
    )
    selections = selections_res.data or []
    has_customizations = bool(selections)

    target_game_ids = [game_id, *enabled_ids]
    chunks_query = (
        sb.table("boardgamebuddy_guide_chunks")
        .select(_CHUNK_SELECT)
        .in_("game_id", target_game_ids)
    )
    if not has_customizations:
        chunks_query = chunks_query.eq("is_default", True)
    chunks_res = chunks_query.execute()
    chunk_rows = _sort_chunk_rows(chunks_res.data or [])

    selections_by_chunk = {r["chunk_id"]: r for r in selections}

    chunks: list[MyGuideChunkResponse] = []
    for row in chunk_rows:
        base = _chunk_row_to_response(row, expansion_map)
        sel = selections_by_chunk.get(row["id"])
        chunks.append(MyGuideChunkResponse(
            **base.model_dump(),
            is_hidden=bool(sel["is_hidden"]) if sel else False,
            user_display_order=sel["display_order"] if sel else None,
        ))
    return MyGuideResponse(has_customizations=has_customizations, chunks=chunks)


@router.delete(
    "/games/{game_id}/my-guide",
    status_code=204,
    summary="Restore my guide to defaults",
)
async def reset_my_guide(
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """Wipe the user's hide/reorder selections for a game.

    Reverts the guide to the curated default view. Idempotent — safe to call
    even when no selection rows exist.
    """
    sb = get_supabase()
    (
        sb.table("boardgamebuddy_guide_selections")
        .delete()
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .execute()
    )
    return Response(status_code=204)


@router.put(
    "/games/{game_id}/my-guide",
    response_model=MessageResponse,
    status_code=200,
    summary="Replace my visible chunk order",
)
async def set_my_guide(
    body: GuideSelectionUpdate,
    game_id: str = Path(..., description="Game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Replace the user's visible-chunk ordering for the game.

    Only non-hidden selection rows are rewritten — hidden rows are preserved
    so the "Hidden chunks" panel stays intact across reorders.
    """
    sb = get_supabase()

    if body.chunk_ids:
        # Accept chunks belonging to the base game OR any expansion the user
        # has toggled on — those are the chunks the frontend can legitimately
        # show, hide, or reorder in the merged guide.
        base_row = (
            sb.table("boardgamebuddy_games")
            .select("bgg_id")
            .eq("id", game_id)
            .execute()
        )
        base_bgg_id = base_row.data[0].get("bgg_id") if base_row.data else None
        enabled_ids, _ = _enabled_expansions_for(base_bgg_id, user.user_id)
        allowed_game_ids = [game_id, *enabled_ids]
        valid = (
            sb.table("boardgamebuddy_guide_chunks")
            .select("id")
            .in_("game_id", allowed_game_ids)
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

    # Clear only the user's non-hidden rows for this game; leave is_hidden=true rows alone.
    (
        sb.table("boardgamebuddy_guide_selections")
        .delete()
        .eq("user_id", user.user_id)
        .eq("game_id", game_id)
        .eq("is_hidden", False)
        .execute()
    )

    if body.chunk_ids:
        rows = [
            {
                "user_id": user.user_id,
                "game_id": game_id,
                "chunk_id": chunk_id,
                "display_order": idx,
                "is_hidden": False,
            }
            for idx, chunk_id in enumerate(body.chunk_ids)
        ]
        sb.table("boardgamebuddy_guide_selections").insert(rows).execute()

    return MessageResponse(message="Guide updated")


@router.post(
    "/chunks/{chunk_id}/visibility",
    response_model=MessageResponse,
    status_code=200,
    summary="Hide or unhide a chunk for the current user",
)
async def set_chunk_visibility(
    body: ChunkVisibilityUpdate,
    chunk_id: str = Path(..., description="Chunk UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Per-user hide/unhide. Upserts a selection row with is_hidden set."""
    sb = get_supabase()

    chunk = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("id, game_id")
        .eq("id", chunk_id)
        .execute()
    )
    if not chunk.data:
        raise HTTPException(status_code=404, detail="Chunk not found")
    game_id = chunk.data[0]["game_id"]

    existing = (
        sb.table("boardgamebuddy_guide_selections")
        .select("id, display_order, is_hidden")
        .eq("user_id", user.user_id)
        .eq("chunk_id", chunk_id)
        .execute()
    )

    if existing.data:
        row_id = existing.data[0]["id"]
        updates: dict[str, Any] = {"is_hidden": body.is_hidden}
        # When unhiding, park the chunk at the end of the visible list.
        if not body.is_hidden:
            tail = (
                sb.table("boardgamebuddy_guide_selections")
                .select("display_order")
                .eq("user_id", user.user_id)
                .eq("game_id", game_id)
                .eq("is_hidden", False)
                .order("display_order", desc=True)
                .limit(1)
                .execute()
            )
            next_order = (tail.data[0]["display_order"] + 1) if tail.data else 0
            updates["display_order"] = next_order
        (
            sb.table("boardgamebuddy_guide_selections")
            .update(updates)
            .eq("id", row_id)
            .execute()
        )
    else:
        # No existing selection row — create one.
        display_order = 0
        if not body.is_hidden:
            tail = (
                sb.table("boardgamebuddy_guide_selections")
                .select("display_order")
                .eq("user_id", user.user_id)
                .eq("game_id", game_id)
                .eq("is_hidden", False)
                .order("display_order", desc=True)
                .limit(1)
                .execute()
            )
            display_order = (tail.data[0]["display_order"] + 1) if tail.data else 0
        (
            sb.table("boardgamebuddy_guide_selections")
            .insert({
                "user_id": user.user_id,
                "game_id": game_id,
                "chunk_id": chunk_id,
                "display_order": display_order,
                "is_hidden": body.is_hidden,
            })
            .execute()
        )

    return MessageResponse(message="Hidden" if body.is_hidden else "Visible")
