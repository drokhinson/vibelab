"""Ingredient modifier vocabulary (form/state + cut/prep words).

A modifier describes how an ingredient is prepared without changing which
ingredient it is — "fresh thyme" and "dried thyme" both resolve to a single
``thyme`` row in ``sauceboss_ingredient`` but carry different ``modifier``
values on ``sauceboss_sauce_step_ingredient``. The vocabulary lives in
``sauceboss_ingredient_modifier`` (seeded in
``db/migrations/sauceboss/023_ingredient_modifiers.sql``); we load it once at
FastAPI startup and use it from two places:

* The parser strips known modifier words off ``food_raw`` during recipe import.
* The frontend reads it via ``GET /api/v1/sauceboss/ingredient-modifiers`` to
  populate the per-row dropdown in the builder.

"canned" / "sun-dried" are deliberately not in the seed — those words indicate
a different ingredient (canned tomato ≠ tomato), so they stay part of the name.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

log = logging.getLogger("sauceboss.modifiers")


@dataclass(frozen=True)
class ModifierDef:
    id: str
    label: str        # canonical lowercase string stored on step_ingredient.modifier
    kind: str         # 'form' | 'prep'
    sort_order: int


# Ordered by sort_order, then label, so iteration order matches what the
# frontend dropdown shows (form words first, prep words after).
MODIFIER_REGISTRY: list[ModifierDef] = []

# Pre-compiled longest-first matcher for the parser. Multi-word labels like
# "thinly sliced" must beat "sliced" to avoid splitting `thinly sliced basil`
# into `("sliced basil", "thinly")`.
_MATCH_RE: re.Pattern[str] | None = None
_LABEL_SET: set[str] = set()


def _rebuild_match_re() -> None:
    """Rebuild ``_MATCH_RE`` and ``_LABEL_SET`` from the current registry."""
    global _MATCH_RE
    _LABEL_SET.clear()
    if not MODIFIER_REGISTRY:
        _MATCH_RE = None
        return
    labels = [m.label for m in MODIFIER_REGISTRY]
    _LABEL_SET.update(lbl.lower() for lbl in labels)
    # Sort longest-first so the regex alternation prefers multi-word matches.
    labels_sorted = sorted(labels, key=len, reverse=True)
    pattern = r"\b(?:" + "|".join(re.escape(lbl) for lbl in labels_sorted) + r")\b"
    _MATCH_RE = re.compile(pattern, flags=re.IGNORECASE)


def load_modifier_registry() -> None:
    """Load the modifier vocabulary from Supabase into the module-level cache.

    Intended to be called once at FastAPI startup. Safe to re-call; failures
    are logged but non-fatal (parser falls back to no modifier extraction).
    """
    from db import get_supabase

    try:
        sb = get_supabase()
        resp = (
            sb.table("sauceboss_ingredient_modifier")
            .select("id,label,kind,sort_order")
            .order("sort_order")
            .order("label")
            .execute()
        )
        rows = resp.data or []
    except Exception as e:
        log.warning("Could not load sauceboss_ingredient_modifier: %s", e)
        MODIFIER_REGISTRY.clear()
        _rebuild_match_re()
        return

    MODIFIER_REGISTRY.clear()
    for row in rows:
        MODIFIER_REGISTRY.append(ModifierDef(
            id=row["id"],
            label=str(row["label"]).strip().lower(),
            kind=row["kind"],
            sort_order=int(row.get("sort_order") or 100),
        ))
    _rebuild_match_re()
    log.info("Loaded %d ingredient modifiers", len(MODIFIER_REGISTRY))


def _canonical_order(labels: list[str]) -> list[str]:
    """Return the matched labels sorted by the registry's sort_order, deduped."""
    order = {m.label: m.sort_order for m in MODIFIER_REGISTRY}
    seen: set[str] = set()
    deduped: list[str] = []
    for lbl in labels:
        low = lbl.lower()
        if low in seen:
            continue
        seen.add(low)
        deduped.append(low)
    deduped.sort(key=lambda lbl: (order.get(lbl, 999), lbl))
    return deduped


def extract_modifier(food: str, note: str | None) -> tuple[str, str | None, str | None]:
    """Split known modifier words out of ``food`` (and optionally ``note``).

    Returns ``(clean_food, modifier_or_none, leftover_note)``.

    * Leading modifier words are peeled off: ``"fresh thyme" → ("thyme", "fresh")``.
    * Trailing comma fragments that are entirely modifiers are peeled off:
      ``"basil, thinly sliced" → ("basil", "thinly sliced")``.
    * If ``note`` is a single known modifier (e.g. parenthesised ``(crushed)``)
      it is promoted into the modifier; otherwise note passes through.
    * Multiple matches are concatenated as ``"fresh, thinly sliced"`` in the
      registry's sort order (form words first).
    * Unknown words like "canned" or "sun-dried" stay in ``food``.
    """
    clean = (food or "").strip()
    found: list[str] = []
    leftover_note = note

    if not _MATCH_RE or not clean:
        # Still try note-promotion below if registry is empty? No — if registry
        # is empty there are no modifier words to recognize.
        return (clean, None, leftover_note)

    # ── Trailing comma fragments ────────────────────────────────────────────
    # Example: "basil, thinly sliced" → trailing fragment is "thinly sliced".
    # We accept the fragment as a modifier only if the fragment matches a
    # known label exactly (case-insensitive).
    while "," in clean:
        head, _, tail = clean.rpartition(",")
        tail_stripped = tail.strip().lower()
        if tail_stripped in _LABEL_SET:
            found.append(tail_stripped)
            clean = head.rstrip().rstrip(",").rstrip()
        else:
            break

    # ── Leading modifier words ──────────────────────────────────────────────
    # Greedily peel modifier matches off the start (longest first via regex).
    # Allow whitespace or "," as the boundary char so "fresh, thinly sliced
    # basil" peels both modifiers cleanly.
    while clean:
        m = _MATCH_RE.match(clean)
        if not m:
            break
        token = m.group(0).strip().lower()
        rest = clean[m.end():]
        if rest and not (rest[0].isspace() or rest[0] == ","):
            break
        found.append(token)
        # Drop any leading separator chars before the next pass.
        clean = rest.lstrip(" ,\t")

    # ── Note promotion ──────────────────────────────────────────────────────
    if note:
        note_stripped = note.strip().lower()
        if note_stripped in _LABEL_SET:
            found.append(note_stripped)
            leftover_note = None

    if not found:
        return (clean, None, leftover_note)

    ordered = _canonical_order(found)
    return (clean, ", ".join(ordered), leftover_note)
