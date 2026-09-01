"""Writing a collection status back to BoardGameGeek.

BGG HAS NO WRITE API. Collection edits go to `geekcollection.php`, the same
form endpoint BGG's own site posts to, authenticated by the session cookies
bgg_credentials already mints. The field names below come from observing that
form, not from documentation, so they can be wrong today and can break without
notice tomorrow.

Everything about this module is shaped by that. `build_status_form` is a pure
function and the ONLY place the wire format is expressed, so correcting it is a
one-function edit that unit tests cover without touching the network. Set
BGG_PUSH_DRY_RUN=true to log the payload and skip the request entirely.

Two rules the whole feature rests on:

  1. ECHO WHAT WE DO NOT OWN. `fieldname=status` is believed to replace the
     entire status block, so every attribute BGG sent us goes back verbatim
     except the three BgB actually manages. If that belief is wrong the echo is
     harmless; if it is right, omitting it silently wipes the user's
     for-trade, want-to-buy and wishlist-priority flags.
  2. FAIL CLOSED. BGG answers a dead session with HTTP 200 and an error body,
     so a 200 is not proof a save landed. `interpret_save_response` treats
     anything it does not positively recognise as a failure — a queue that
     drains green while nothing changed is the worst outcome available here,
     because the user believes it worked.

TODO once verified against a real account: paste the confirmed request here.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

import httpx
from fastapi import HTTPException

from .bgg_client import post_bgg_form_as_user

logger = logging.getLogger(__name__)

BGG_COLLECTION_SAVE_URL = "https://boardgamegeek.com/geekcollection.php"
_WRITE_TIMEOUT = 20.0

# The three flags BgB manages. Everything else on <status> belongs to the user.
BGB_OWNED_FLAGS: tuple[str, ...] = ("own", "prevowned", "wishlist")

# Documented, not enforced: these are the attributes we know BGG emits that BgB
# must never author. The echo is a whitelist of nothing — it copies every key it
# receives — so a flag BGG adds next year survives without a code change.
BGG_PRESERVED_FLAGS: tuple[str, ...] = (
    "want", "wanttobuy", "wanttoplay", "fortrade", "preordered", "wishlistpriority",
)

# BGG stamps this on every read; sending it back would be asserting a
# modification time we have no business setting.
_DROPPED_ATTRS: frozenset[str] = frozenset({"lastmodified"})

# BgB's status vocabulary -> the three flags, at their target values.
#
# `wanttoplay` is absent from every row on purpose. BgB's importer collapses it
# into `wishlist` (_BGG_STATUSES), so a game the user marked want-to-play on BGG
# reads as `wishlist` here. Setting `wishlist=1` on it would be a write caused
# purely by that lossy import — the comparison treats wanttoplay as already
# satisfying a BgB wishlist, so such a game never reaches this table at all.
_TARGET_FLAGS: dict[Optional[str], dict[str, str]] = {
    "owned":      {"own": "1", "prevowned": "0", "wishlist": "0"},
    "prev_owned": {"own": "0", "prevowned": "1", "wishlist": "0"},
    "wishlist":   {"own": "0", "prevowned": "0", "wishlist": "1"},
    None:         {"own": "0", "prevowned": "0", "wishlist": "0"},  # a clear
}


def dry_run_enabled() -> bool:
    """True when pushes are logged instead of sent. Defaults to OFF."""
    return os.getenv("BGG_PUSH_DRY_RUN", "").strip().lower() in ("1", "true", "yes")


def build_status_form(
    *,
    bgg_id: int,
    collid: Optional[int],
    target_status: Optional[str],
    raw_status: dict[str, str],
) -> dict[str, str]:
    """THE payload shape. If BGG's form changes, this is the only thing to fix.

    `raw_status` is dict(status_el.attrib) straight off the live read.
    `target_status` is a BgB CollectionStatus value, or None to clear.
    `collid` omitted (None) is what tells BGG to create a row rather than edit
    one — sent as an empty string it would be ambiguous, so the key is dropped.
    """
    if target_status not in _TARGET_FLAGS:
        raise ValueError(f"unknown target status {target_status!r}")

    # Start from everything BGG told us, so unmanaged flags round-trip intact.
    form: dict[str, str] = {
        k: ("" if v is None else str(v))
        for k, v in raw_status.items()
        if k not in _DROPPED_ATTRS
    }
    form.update(_TARGET_FLAGS[target_status])
    form.update({
        "ajax": "1",
        "action": "savedata",
        "objecttype": "thing",
        "objectid": str(bgg_id),
        "fieldname": "status",
    })
    if collid is not None:
        form["collid"] = str(collid)
    return form


def interpret_save_response(resp: httpx.Response) -> None:
    """Raise unless the save demonstrably landed. HTTP 200 is not enough.

    Fails closed: an unrecognised body is an error, never a silent success.
    """
    body = (resp.text or "").strip()

    # A stale session gets bounced to the login form, with a 200.
    lowered = body[:2000].lower()
    if "login" in lowered and ("password" in lowered or "signin" in lowered):
        raise HTTPException(
            status_code=409,
            detail="BGG re-link required: BoardGameGeek asked us to log in again.",
        )

    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        logger.warning("BGG write returned an unparseable body: %r", body[:200])
        raise HTTPException(
            status_code=502,
            detail="BoardGameGeek returned an unexpected response to a collection write.",
        )

    if isinstance(parsed, dict):
        for key in ("error", "errors", "message"):
            problem = parsed.get(key)
            if problem:
                logger.warning("BGG write reported %s=%r", key, problem)
                raise HTTPException(
                    status_code=502,
                    detail=f"BoardGameGeek rejected the change: {str(problem)[:160]}",
                )
        return

    # A bare list/string/number is not something we know how to trust.
    logger.warning("BGG write returned an unrecognised shape: %r", body[:200])
    raise HTTPException(
        status_code=502,
        detail="BoardGameGeek returned an unexpected response to a collection write.",
    )


async def push_collection_status(
    user_id: str,
    username: str,
    *,
    bgg_id: int,
    collid: Optional[int],
    target_status: Optional[str],
    raw_status: dict[str, str],
) -> None:
    """Set one game's BgB-owned status flags on the user's BGG collection.

    Raises on anything short of a confirmed save; the caller records the row as
    errored and moves on.
    """
    form = build_status_form(
        bgg_id=bgg_id, collid=collid,
        target_status=target_status, raw_status=raw_status,
    )
    if dry_run_enabled():
        logger.info(
            "BGG_PUSH_DRY_RUN: would POST %s %s",
            BGG_COLLECTION_SAVE_URL, json.dumps(form, sort_keys=True),
        )
        return

    resp = await post_bgg_form_as_user(
        user_id, username, BGG_COLLECTION_SAVE_URL, form, timeout=_WRITE_TIMEOUT,
    )
    interpret_save_response(resp)
