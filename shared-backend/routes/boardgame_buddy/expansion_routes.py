"""Expansion linking + per-user toggle endpoints.

Expansions are first-class games (`is_expansion=true`, `base_game_bgg_id=N`)
imported via the BGG flow or a guide bundle. This module exposes:

- listing the expansions linked to a base game (with the caller's enable state),
- toggling one on/off per-user,
- an admin override for the auto-assigned dot color.
"""

from typing import Optional

from fastapi import Depends, Header, HTTPException, Path

from db import get_supabase

from . import router
from .dependencies import (
    CurrentUser,
    get_current_admin,
    get_current_user,
    maybe_supabase_user,
)
from .models import (
    ExpansionColorUpdate,
    ExpansionListItem,
    ExpansionToggleRequest,
    GameSummary,
    MessageResponse,
)


@router.get(
    "/games/{base_id}/expansions",
    response_model=list[ExpansionListItem],
    status_code=200,
    summary="List expansions linked to a base game",
)
async def list_expansions(
    base_id: str = Path(..., description="Base game UUID"),
    authorization: Optional[str] = Header(None),
) -> list[ExpansionListItem]:
    """List every expansion whose `base_game_bgg_id` equals this base game's bgg_id.

    For authenticated callers, `is_enabled` reflects the caller's own toggle
    state. Anon callers always see `is_enabled=false`.
    """
    sb = get_supabase()
    su_user = await maybe_supabase_user(authorization)
    base = (
        sb.table("boardgamebuddy_games")
        .select("bgg_id")
        .eq("id", base_id)
        .execute()
    )
    if not base.data:
        raise HTTPException(status_code=404, detail="Game not found")
    base_bgg_id = base.data[0].get("bgg_id")
    if not base_bgg_id:
        return []

    expansions = (
        sb.table("boardgamebuddy_games")
        .select("id, bgg_id, name, thumbnail_url, expansion_color, rulebook_url")
        .eq("is_expansion", True)
        .eq("base_game_bgg_id", base_bgg_id)
        .order("name")
        .execute()
    )
    rows = expansions.data or []
    if not rows:
        return []

    exp_ids = [r["id"] for r in rows]

    enabled_ids: set[str] = set()
    if su_user is not None:
        enabled = (
            sb.table("boardgamebuddy_user_expansions")
            .select("expansion_game_id")
            .eq("user_id", su_user.sub)
            .in_("expansion_game_id", exp_ids)
            .execute()
        )
        enabled_ids = {r["expansion_game_id"] for r in (enabled.data or [])}

    # One round-trip to count default chunks per expansion.
    chunk_counts: dict[str, int] = {eid: 0 for eid in exp_ids}
    chunks = (
        sb.table("boardgamebuddy_guide_chunks")
        .select("game_id")
        .in_("game_id", exp_ids)
        .eq("is_default", True)
        .execute()
    )
    for c in chunks.data or []:
        chunk_counts[c["game_id"]] = chunk_counts.get(c["game_id"], 0) + 1

    return [
        ExpansionListItem(
            expansion_game_id=r["id"],
            bgg_id=r.get("bgg_id"),
            name=r["name"],
            thumbnail_url=r.get("thumbnail_url"),
            color=r.get("expansion_color"),
            is_enabled=r["id"] in enabled_ids,
            chunk_count=chunk_counts.get(r["id"], 0),
            rulebook_url=r.get("rulebook_url"),
        )
        for r in rows
    ]


@router.post(
    "/games/{base_id}/expansions/{expansion_id}/toggle",
    response_model=MessageResponse,
    status_code=200,
    summary="Enable or disable an expansion for the current user",
)
async def toggle_expansion(
    body: ExpansionToggleRequest,
    base_id: str = Path(..., description="Base game UUID"),
    expansion_id: str = Path(..., description="Expansion game UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Per-user enable/disable. Insert or delete one row in boardgamebuddy_user_expansions."""
    sb = get_supabase()

    # Confirm the expansion exists and is genuinely linked to this base.
    base = (
        sb.table("boardgamebuddy_games")
        .select("bgg_id")
        .eq("id", base_id)
        .execute()
    )
    if not base.data:
        raise HTTPException(status_code=404, detail="Base game not found")
    base_bgg_id = base.data[0].get("bgg_id")

    expansion = (
        sb.table("boardgamebuddy_games")
        .select("id, is_expansion, base_game_bgg_id")
        .eq("id", expansion_id)
        .execute()
    )
    if not expansion.data:
        raise HTTPException(status_code=404, detail="Expansion not found")
    row = expansion.data[0]
    if not row.get("is_expansion") or row.get("base_game_bgg_id") != base_bgg_id:
        raise HTTPException(
            status_code=400,
            detail="That game is not an expansion of this base game.",
        )

    if body.is_enabled:
        # Upsert pattern: insert and ignore conflict via primary-key collision.
        # Supabase-py doesn't expose ON CONFLICT for plain insert, so check first.
        existing = (
            sb.table("boardgamebuddy_user_expansions")
            .select("user_id")
            .eq("user_id", user.user_id)
            .eq("expansion_game_id", expansion_id)
            .execute()
        )
        if not existing.data:
            sb.table("boardgamebuddy_user_expansions").insert({
                "user_id": user.user_id,
                "expansion_game_id": expansion_id,
            }).execute()
        return MessageResponse(message="Expansion enabled")

    sb.table("boardgamebuddy_user_expansions").delete().eq(
        "user_id", user.user_id
    ).eq("expansion_game_id", expansion_id).execute()
    return MessageResponse(message="Expansion disabled")


@router.patch(
    "/games/admin/{game_id}/expansion-color",
    response_model=GameSummary,
    status_code=200,
    summary="Override an expansion's dot color (admin)",
)
async def update_expansion_color(
    body: ExpansionColorUpdate,
    game_id: str = Path(..., description="Expansion game UUID"),
    _admin: CurrentUser = Depends(get_current_admin),
) -> GameSummary:
    """Admin-only: replace the auto-assigned `expansion_color` for a game."""
    sb = get_supabase()
    existing = (
        sb.table("boardgamebuddy_games")
        .select("id, is_expansion")
        .eq("id", game_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Game not found")
    if not existing.data[0].get("is_expansion"):
        raise HTTPException(status_code=400, detail="Game is not an expansion")

    updated = (
        sb.table("boardgamebuddy_games")
        .update({"expansion_color": body.color})
        .eq("id", game_id)
        .execute()
    )
    if not updated.data:
        raise HTTPException(status_code=500, detail="Failed to update color")
    return GameSummary(**updated.data[0])
