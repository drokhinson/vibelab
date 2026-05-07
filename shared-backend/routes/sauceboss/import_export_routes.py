"""SauceBoss recipe import / export — JSON + Markdown downloads, JSON upload."""

import datetime
import io
import json
import logging
import re
import secrets
from typing import Any

from fastapi import Depends, File, HTTPException, Path, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_admin, get_current_user
from .models import (
    BulkSauceExportEnvelope,
    CreateSauceRequest,
    ImportResultResponse,
    SauceExportEnvelope,
)
from .public_routes import _build_sauce_payload, _validate_parent_sauce

logger = logging.getLogger("sauceboss")

_MAX_IMPORT_BYTES = 1_000_000
_SUPPORTED_VERSION = 1


# ── Helpers ──────────────────────────────────────────────────────────────────

def _slugify(name: str) -> str:
    """Lowercase + non-alphanumeric → hyphen; matches public_routes.create_sauce."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "sauce"


def _now_iso() -> str:
    """Current UTC time in ISO 8601 (used for export envelopes)."""
    return datetime.datetime.now(datetime.UTC).isoformat()


def _all_sauces() -> list[dict]:
    """Fetch every sauce in export-ready shape via the existing RPC."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces_full", {}).execute()
    return result.data or []


def _load_sauce_or_404(sauce_id: str) -> dict:
    """Find a single sauce by id from the all-sauces RPC, or raise 404."""
    for s in _all_sauces():
        if s.get("id") == sauce_id:
            return s
    raise HTTPException(status_code=404, detail=f"Sauce {sauce_id!r} not found")


def _fmt_amount(amount: Any, unit: str, original: str | None) -> str:
    """Format ``"<amount> <unit> <name>"``-style ingredient quantities.

    Falls back to ``originalText`` for qualitative rows (amount=0 with a unit
    like "to taste") so the markdown reads naturally.
    """
    try:
        amt = float(amount) if amount is not None else 0.0
    except (TypeError, ValueError):
        amt = 0.0
    u = (unit or "").strip()
    if amt == 0 and original:
        return original.strip()
    if amt == int(amt):
        amt_str = str(int(amt))
    else:
        amt_str = f"{amt:g}"
    return f"{amt_str} {u}".strip()


def _render_sauce_markdown(s: dict) -> str:
    """Pure formatter — turn a sauce dict (RPC shape) into a Markdown document."""
    lines: list[str] = []
    name = s.get("name") or "Untitled sauce"
    lines.append(f"# {name}")
    lines.append("")

    cuisine = s.get("cuisine") or ""
    cuisine_emoji = s.get("cuisineEmoji") or ""
    sauce_type = (s.get("sauceType") or "sauce").title()
    pairs = ", ".join(s.get("compatibleItems") or [])
    source = s.get("sourceUrl") or ""

    meta_bits: list[str] = []
    if cuisine:
        prefix = f"{cuisine_emoji} ".strip()
        meta_bits.append(f"**Cuisine:** {prefix} {cuisine}".replace("  ", " ").strip())
    meta_bits.append(f"**Type:** {sauce_type}")
    if pairs:
        meta_bits.append(f"**Pairs with:** {pairs}")
    if source:
        meta_bits.append(f"**Source:** {source}")
    lines.extend(meta_bits)
    lines.append("")

    description = (s.get("description") or "").strip()
    if description:
        lines.append(description)
        lines.append("")

    ingredients = s.get("ingredients") or []
    if ingredients:
        lines.append("## Ingredients")
        for ing in ingredients:
            qty = _fmt_amount(ing.get("amount"), ing.get("unit") or "", ing.get("originalText"))
            food = ing.get("name") or ing.get("originalText") or ""
            if qty and food and qty != food:
                lines.append(f"- {qty} {food}".rstrip())
            else:
                lines.append(f"- {food or qty}".rstrip())
        lines.append("")

    steps = s.get("steps") or []
    if steps:
        lines.append("## Steps")
        lines.append("")
        for idx, step in enumerate(steps, start=1):
            title = step.get("title") or f"Step {idx}"
            est = step.get("estimatedTime")
            est_str = f" (~{est} min)" if est else ""
            lines.append(f"### Step {idx} — {title}{est_str}")
            input_from = step.get("inputFromStep")
            if input_from:
                lines.append(f"*Combines all of Step {input_from} into this bowl.*")
            instructions = (step.get("instructions") or "").strip()
            if instructions:
                lines.append(instructions)
            step_ings = step.get("ingredients") or []
            if step_ings:
                lines.append("")
                for ing in step_ings:
                    qty = _fmt_amount(ing.get("amount"), ing.get("unit") or "", ing.get("originalText"))
                    food = ing.get("name") or ing.get("originalText") or ""
                    if qty and food and qty != food:
                        lines.append(f"- {qty} {food}".rstrip())
                    else:
                        lines.append(f"- {food or qty}".rstrip())
            lines.append("")

    today = datetime.date.today().isoformat()
    lines.append("---")
    lines.append(f"*Exported from SauceBoss on {today}.*")
    return "\n".join(lines) + "\n"


def _unwrap_import_payload(raw: dict) -> dict:
    """Validate the envelope and strip read-only fields. Returns a CreateSauceRequest-shaped dict.

    Accepts:
      • ``{"version": 1, "sauce": {...}}`` — single export envelope.
      • Bare sauce dict (with ``name`` + ``steps``) — hand-authored.
    Rejects:
      • Bulk envelope (``"sauces"`` list).
      • Unknown / future ``version``.
    """
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="Top-level JSON must be an object")

    version = raw.get("version")
    if version is not None and version != _SUPPORTED_VERSION:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported export version: {version}",
        )

    if isinstance(raw.get("sauces"), list):
        raise HTTPException(
            status_code=422,
            detail="Bulk imports not supported — split the file into per-sauce JSONs",
        )

    inner = raw.get("sauce") if isinstance(raw.get("sauce"), dict) else raw
    if not isinstance(inner, dict) or "name" not in inner or "steps" not in inner:
        raise HTTPException(
            status_code=422,
            detail="Could not locate sauce payload (expected an object with `name` and `steps`)",
        )

    cleaned = dict(inner)
    cleaned.pop("id", None)
    cleaned.pop("createdBy", None)
    if "itemIds" not in cleaned:
        cleaned["itemIds"] = cleaned.pop("compatibleItems", []) or []
    else:
        cleaned.pop("compatibleItems", None)

    cleaned_steps: list[dict] = []
    for step in cleaned.get("steps") or []:
        if not isinstance(step, dict):
            continue
        ings = []
        for ing in step.get("ingredients") or []:
            if not isinstance(ing, dict):
                continue
            ing = dict(ing)
            for derived in ("foodId", "unitId", "canonicalMl", "canonicalG"):
                ing.pop(derived, None)
            ings.append(ing)
        new_step = dict(step)
        new_step["ingredients"] = ings
        cleaned_steps.append(new_step)
    cleaned["steps"] = cleaned_steps

    return cleaned


def _resolve_parent(parent_id: str | None, new_id: str, warnings: list[str]) -> str | None:
    """Validate ``parentSauceId`` from an imported file. Drops it (with warning) if not found locally."""
    if not parent_id:
        return None
    sb = get_supabase()
    parent = (
        sb.table("sauceboss_sauces")
        .select("id, parent_sauce_id")
        .eq("id", parent_id)
        .execute()
    )
    if not parent.data:
        warnings.append(f"Parent sauce {parent_id!r} not found in this catalog — link dropped.")
        return None
    _validate_parent_sauce(parent_id, new_id)
    return parent_id


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get(
    "/sauces/{sauce_id}/export.json",
    summary="Download a single sauce as JSON (public)",
)
async def export_sauce_json(
    sauce_id: str = Path(..., description="Target sauce id"),
) -> StreamingResponse:
    """Return one sauce wrapped in a versioned envelope as a JSON download."""
    sauce = _load_sauce_or_404(sauce_id)
    envelope = SauceExportEnvelope(version=_SUPPORTED_VERSION, exportedAt=_now_iso(), sauce=sauce)
    body = json.dumps(envelope.model_dump(), indent=2, ensure_ascii=False).encode("utf-8")
    filename = f"{_slugify(sauce.get('name') or sauce_id)}.sauce.json"
    return StreamingResponse(
        io.BytesIO(body),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get(
    "/sauces/{sauce_id}/export.md",
    summary="Download a single sauce as Markdown (public)",
)
async def export_sauce_markdown(
    sauce_id: str = Path(..., description="Target sauce id"),
) -> StreamingResponse:
    """Return one sauce as a human-readable Markdown document."""
    sauce = _load_sauce_or_404(sauce_id)
    md = _render_sauce_markdown(sauce)
    filename = f"{_slugify(sauce.get('name') or sauce_id)}.sauce.md"
    return StreamingResponse(
        io.BytesIO(md.encode("utf-8")),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get(
    "/admin/sauces/export.json",
    summary="Download every sauce as a single JSON file (admin)",
)
async def admin_export_all_sauces(
    _admin: CurrentUser = Depends(get_current_admin),
) -> StreamingResponse:
    """Bundle every sauce in the catalog into one versioned JSON download."""
    sauces = _all_sauces()
    envelope = BulkSauceExportEnvelope(
        version=_SUPPORTED_VERSION,
        exportedAt=_now_iso(),
        count=len(sauces),
        sauces=sauces,
    )
    body = json.dumps(envelope.model_dump(), indent=2, ensure_ascii=False).encode("utf-8")
    filename = f"sauceboss-sauces-{datetime.date.today().isoformat()}.json"
    return StreamingResponse(
        io.BytesIO(body),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/sauces/import",
    response_model=ImportResultResponse,
    status_code=201,
    summary="Import a single sauce from a JSON file (logged-in)",
)
async def import_sauce(
    file: UploadFile = File(..., description="JSON export of one sauce."),
    user: CurrentUser = Depends(get_current_user),
) -> ImportResultResponse:
    """Create a sauce owned by the current user from an uploaded JSON file."""
    contents = await file.read()
    if len(contents) > _MAX_IMPORT_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 1 MB)")

    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=422, detail=f"File is not UTF-8 text: {e}")

    try:
        raw = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"File is not valid JSON: {e}")

    inner = _unwrap_import_payload(raw)

    warnings: list[str] = []
    new_id = f"user-{_slugify(str(inner.get('name') or 'sauce'))}-{secrets.token_hex(2)}"
    inner["parentSauceId"] = _resolve_parent(inner.get("parentSauceId"), new_id, warnings)

    try:
        body = CreateSauceRequest.model_validate(inner)
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=e.errors())

    payload = _build_sauce_payload(new_id, body, created_by=user.user_id)

    sb = get_supabase()
    try:
        result = sb.rpc("create_sauceboss_sauce", {"p_data": payload}).execute()
    except Exception as e:
        logger.exception("import_sauce: create RPC failed")
        raise HTTPException(500, f"Database error: {e}")
    if result.data is None:
        raise HTTPException(500, "Failed to create sauce — RPC returned null")

    return ImportResultResponse(id=new_id, name=body.name, warnings=warnings, status="created")
