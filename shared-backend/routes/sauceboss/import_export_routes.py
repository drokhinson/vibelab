"""SauceBoss recipe export — JSON + Markdown downloads.

Single-sauce import is handled client-side: the web UI parses the uploaded
JSON, populates the builder draft, and routes through the normal review +
``POST /sauces`` save path so users always confirm before persisting. There
is no server-side import endpoint.
"""

import datetime
import io
import json
import logging
import re
from typing import Any

from fastapi import Depends, HTTPException, Path
from fastapi.responses import StreamingResponse

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_admin
from .models import BulkSauceExportEnvelope, SauceExportEnvelope

logger = logging.getLogger("sauceboss")

_SUPPORTED_VERSION = 1

# Per-ingredient fields we omit from JSON exports — all are derived server-side
# on save (``_resolve_ingredient_for_save`` rebuilds ``originalText`` from
# amount/unit/name; ingredientId/unitId/canonical* come from the registry lookup).
# Keeping them in the export bloats files and rots when ids drift between
# Supabase projects. The Markdown formatter still uses ``originalText`` (it
# reads the raw RPC payload, not the stripped one) for qualitative rows.
_INGREDIENT_DROP_FIELDS = ("originalText", "ingredientId", "unitId", "canonicalMl", "canonicalG")


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


def _strip_ing(ing: dict) -> dict:
    cleaned = dict(ing)
    for f in _INGREDIENT_DROP_FIELDS:
        cleaned.pop(f, None)
    return cleaned


def _strip_export_only_fields(sauce: dict) -> dict:
    """Return a shallow copy of the sauce with derived ingredient fields removed.

    Keeps the JSON export shape symmetric with what the import unwrapper
    accepts and what the builder edit flow already discards: ``originalText``
    is rebuilt server-side from ``amount + unit + name`` on save, and
    ``ingredientId``/``unitId``/``canonical*`` are looked up against this
    installation's registry.
    """
    out = dict(sauce)
    out["ingredients"] = [_strip_ing(i) for i in (sauce.get("ingredients") or [])]
    new_steps: list[dict] = []
    for step in sauce.get("steps") or []:
        s = dict(step)
        s["ingredients"] = [_strip_ing(i) for i in (step.get("ingredients") or [])]
        new_steps.append(s)
    out["steps"] = new_steps
    return out


def _fmt_amount(amount: Any, unit: str, original: str | None) -> str:
    """Format ``"<amount> <unit>"``-style ingredient quantities for Markdown.

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
    # Attachments replaced compatibleItems post-013; emit dish-level targets
    # in the same comma-separated form for Markdown readers.
    pairs = ", ".join(
        a.get("value", "")
        for a in (s.get("attachments") or [])
        if a.get("kind") == "dish" and a.get("value")
    )
    source = s.get("sourceUrl") or ""

    meta_bits: list[str] = []
    if cuisine:
        prefix = f"{cuisine_emoji} ".strip()
        meta_bits.append(f"**Cuisine:** {prefix} {cuisine}".replace("  ", " ").strip())
    meta_bits.append(f"**Type:** {sauce_type}")
    default_servings = s.get("defaultServings") or s.get("default_servings") or 2
    meta_bits.append(f"**Servings:** {default_servings}")
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
            modifier = (ing.get("modifier") or "").strip()
            # Skip the prefix when food fell back to originalText (which already
            # carries the modifier — `_resolve_ingredient_for_save` rebuilds it).
            if modifier and food and food != (ing.get("originalText") or ""):
                food = f"{modifier} {food}"
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
            input_from = step.get("inputFromSteps") or ([step.get("inputFromStep")] if step.get("inputFromStep") else [])
            if input_from:
                refs = ', '.join(f'Step {r}' for r in input_from)
                lines.append(f"*Combines all of {refs} into this bowl.*")
            instructions = (step.get("instructions") or "").strip()
            if instructions:
                lines.append(instructions)
            step_ings = step.get("ingredients") or []
            if step_ings:
                lines.append("")
                for ing in step_ings:
                    qty = _fmt_amount(ing.get("amount"), ing.get("unit") or "", ing.get("originalText"))
                    food = ing.get("name") or ing.get("originalText") or ""
                    modifier = (ing.get("modifier") or "").strip()
                    if modifier and food and food != (ing.get("originalText") or ""):
                        food = f"{modifier} {food}"
                    if qty and food and qty != food:
                        lines.append(f"- {qty} {food}".rstrip())
                    else:
                        lines.append(f"- {food or qty}".rstrip())
            lines.append("")

    today = datetime.date.today().isoformat()
    lines.append("---")
    lines.append(f"*Exported from SauceBoss on {today}.*")
    return "\n".join(lines) + "\n"


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
    envelope = SauceExportEnvelope(
        version=_SUPPORTED_VERSION,
        exportedAt=_now_iso(),
        sauce=_strip_export_only_fields(sauce),
    )
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
    sauces = [_strip_export_only_fields(s) for s in _all_sauces()]
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
