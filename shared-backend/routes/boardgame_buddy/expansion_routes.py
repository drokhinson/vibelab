"""Expansion linking, BGG import, and per-user toggle endpoints.

Expansions are first-class games (`is_expansion=true`, `base_game_bgg_id=N`)
imported via the BGG flow. Since expansions are hidden from game search
(migration 041), this module owns the only path by which one enters the
catalog. It exposes:

- listing the expansions linked to a base game (with the caller's enable state),
- listing the base game's not-yet-imported expansions straight from BGG,
- importing one of those under this base game,
- toggling one on/off per-user (legacy — the chapter system no longer reads it),
- an admin override for the auto-assigned dot color.
"""

import re
from typing import Optional

from fastapi import Depends, Header, HTTPException, Path

from db import get_supabase

from . import router
from .bgg_client import fetch_bgg, parse_bgg_xml
from .game_routes import (
    _invalidate_game_caches,
    _next_expansion_color,
    _sync_denormalized_game_fields,
    import_game_from_bgg,
)
from .dependencies import (
    CurrentUser,
    get_current_user,
    maybe_supabase_user,
)
from .models import (
    BggExpansionCandidate,
    ExpansionListItem,
    ExpansionToggleRequest,
    MessageResponse,
)

# Separators BGG uses between a base game's name and the expansion's own name:
# "Catan: Cities & Knights", "Carcassonne – Inns & Cathedrals", "Azul, Crystal
# Mosaic". Matched after the base name in _strip_base_prefix.
_BASE_NAME_SEPARATORS = r"[:\-–—,]"


def _strip_base_prefix(name: str, base_name: str) -> str:
    """Drop a leading base-game name (plus separator) from an expansion's name.

    "Catan: Cities & Knights" + base "Catan" → "Cities & Knights". Falls back
    to the original string when the base name isn't a prefix, or when stripping
    it would leave nothing behind (e.g. an expansion literally named after its
    base game).
    """
    raw = (name or "").strip()
    base = (base_name or "").strip()
    if not raw or not base:
        return raw
    pattern = rf"^{re.escape(base)}\s*{_BASE_NAME_SEPARATORS}\s*"
    stripped = re.sub(pattern, "", raw, count=1, flags=re.IGNORECASE).strip()
    return stripped or raw


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

    return [
        ExpansionListItem(
            expansion_game_id=r["id"],
            bgg_id=r.get("bgg_id"),
            name=r["name"],
            thumbnail_url=r.get("thumbnail_url"),
            color=r.get("expansion_color"),
            is_enabled=r["id"] in enabled_ids,
            rulebook_url=r.get("rulebook_url"),
        )
        for r in rows
    ]


def _load_base_game(base_id: str) -> dict:
    """Fetch the base game's id/bgg_id/name, rejecting missing or expansion rows."""
    sb = get_supabase()
    res = (
        sb.table("boardgamebuddy_games")
        .select("id, bgg_id, name, is_expansion")
        .eq("id", base_id)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Game not found")
    row = res.data[0]
    if row.get("is_expansion"):
        raise HTTPException(
            status_code=400,
            detail="That game is itself an expansion — it has no expansions of its own.",
        )
    return row


@router.get(
    "/games/{base_id}/expansions/available",
    response_model=list[BggExpansionCandidate],
    status_code=200,
    summary="List a base game's expansions on BGG that aren't imported yet",
)
async def list_available_expansions(
    base_id: str = Path(..., description="Base game UUID"),
) -> list[BggExpansionCandidate]:
    """Read the base game's BGG record and return every expansion BgB is missing.

    Backs the "Import expansions" popup. Expansions already in the catalog are
    filtered out, and each name has the base game's name stripped off the
    front. BGG `/thing` responses are cached in-process for 24h, so reopening
    the popup costs nothing.
    """
    base = _load_base_game(base_id)
    base_bgg_id = base.get("bgg_id")
    if not base_bgg_id:
        return []

    body = await fetch_bgg("/thing", {"id": base_bgg_id, "stats": 0}, timeout=15.0)
    root = parse_bgg_xml(body, context=f"thing id={base_bgg_id}")
    item = root.find("item")
    if item is None:
        raise HTTPException(status_code=404, detail="Game not found on BGG")

    # Outbound links from a base game point at its expansions; inbound ones
    # point back at a base game and are skipped.
    candidates: dict[int, str] = {}
    for link in item.findall("link[@type='boardgameexpansion']"):
        if link.get("inbound") == "true":
            continue
        try:
            exp_id = int(link.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if not exp_id or exp_id in candidates:
            continue
        candidates[exp_id] = link.get("value", "") or ""
    if not candidates:
        return []

    sb = get_supabase()
    existing = (
        sb.table("boardgamebuddy_games")
        .select("bgg_id")
        .in_("bgg_id", list(candidates))
        .execute()
    )
    already_imported = {r["bgg_id"] for r in (existing.data or [])}

    base_name = base.get("name") or ""
    results = [
        BggExpansionCandidate(
            bgg_id=exp_id,
            name=_strip_base_prefix(full_name, base_name),
            full_name=full_name,
        )
        for exp_id, full_name in candidates.items()
        if exp_id not in already_imported
    ]
    results.sort(key=lambda c: c.name.lower())
    return results


@router.post(
    "/games/{base_id}/expansions/import/{bgg_id}",
    response_model=ExpansionListItem,
    status_code=201,
    summary="Import a BGG expansion and link it to this base game",
)
async def import_expansion(
    base_id: str = Path(..., description="Base game UUID"),
    bgg_id: int = Path(..., description="BoardGameGeek ID of the expansion to import"),
) -> ExpansionListItem:
    """Pull one expansion into the catalog and pin it to this base game.

    Idempotent via `import_game_from_bgg`. The import derives `is_expansion` /
    `base_game_bgg_id` from the expansion's own BGG record, which keeps only
    the *first* inbound link — so an expansion that extends several base games
    can land pointing at a different one and never surface here. This re-pins
    it to the base game the caller imported it from.
    """
    base = _load_base_game(base_id)
    base_bgg_id = base.get("bgg_id")
    if not base_bgg_id:
        raise HTTPException(
            status_code=400,
            detail="This game has no BoardGameGeek ID, so its expansions can't be looked up.",
        )

    sb = get_supabase()
    row = await import_game_from_bgg(sb, bgg_id)

    if not row.get("is_expansion") or row.get("base_game_bgg_id") != base_bgg_id:
        patch: dict = {"is_expansion": True, "base_game_bgg_id": base_bgg_id}
        if not row.get("expansion_color"):
            patch["expansion_color"] = _next_expansion_color(sb, base_bgg_id)
        updated = (
            sb.table("boardgamebuddy_games")
            .update(patch)
            .eq("id", row["id"])
            .execute()
        )
        if not updated.data:
            raise HTTPException(status_code=500, detail="Failed to link the expansion")
        row = updated.data[0]

    # Fan the new expansion metadata out to any plays/collections rows caching
    # it, then bust the game caches so the next read sees the link.
    _sync_denormalized_game_fields(sb, row["id"])
    _invalidate_game_caches()

    return ExpansionListItem(
        expansion_game_id=row["id"],
        bgg_id=row.get("bgg_id"),
        name=row["name"],
        thumbnail_url=row.get("thumbnail_url"),
        color=row.get("expansion_color"),
        is_enabled=False,
        rulebook_url=row.get("rulebook_url"),
    )


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


