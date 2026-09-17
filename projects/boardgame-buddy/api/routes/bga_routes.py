"""Board Game Arena import endpoints (the wizard's third source).

Five calls, and deliberately no sixth: **there is no write route here.** The
sweep produces a draft, the user reviews it in the wizard, and the write goes
through the existing `POST /plays/import` like every other source. That is the
whole reason the BGA draft model answers the same `ImportSource` interface the
note and photo models do.

The account link lives here rather than under Settings → Connections, which is
a product decision with one consequence worth naming: `DELETE /bga/link` is the
ONLY way to unlink, so the wizard's account step has to carry that control. A
user who can link and cannot unlink is not a user who consented.

WHY THE SWEEP RUNS IN-HANDLER rather than as a BackgroundTask like
`POST /bgg/sync` — the argument is in `services/bga_progress.py`, and it is not
a style choice. Short version: `/bgg/sync` defers catalog WRITES worth having
whether or not anyone is watching; this writes nothing, so deferring it would
leave a durable record of a proposal that died with the connection. It is also
what keeps every BGA request inside a request a person is watching, which is
what this feature's terms require of it (Docs/BGA_IMPORT.md).
"""

import asyncio
import logging

from fastapi import Depends, HTTPException

from db import get_supabase

from . import router
from .bga_client import clear_user_session, store_user_credentials
from .bga_credentials import login_to_bga
from .constants import BgaAuthState, BgaFetchState, bga_auth_state_from
from .dependencies import CurrentUser, get_current_user
from .models import (
    BgaFetchProgressResponse,
    BgaFetchResponse,
    BgaLinkRequest,
    BgaLinkStatus,
    BgaRememberRequest,
    BgaRememberResponse,
)
from .services import bga_import_service, bga_progress

logger = logging.getLogger(__name__)

_LINK_COLUMNS = "bga_username, bga_player_id, bga_password_enc, bga_last_import_at"


def _read_link(user_id: str) -> dict:
    """The profile's BGA link columns, or an empty dict."""
    sb = get_supabase()
    res = (
        sb.table("boardgamebuddy_profiles")
        .select(_LINK_COLUMNS)
        .eq("id", user_id)
        .limit(1)
        .execute()
    )
    return (res.data or [{}])[0] or {}


def _status_from(row: dict) -> BgaLinkStatus:
    """Build the status the account step renders.

    Note what is NOT carried across: `bga_password_enc` decides the auth state
    and then stays here. A response model that leaked it would be a credential
    disclosure that reads like a field copy.
    """
    return BgaLinkStatus(
        bga_username=row.get("bga_username"),
        bga_player_id=row.get("bga_player_id"),
        auth_state=bga_auth_state_from(row),
        last_import_at=row.get("bga_last_import_at"),
    )


@router.get(
    "/bga/link",
    response_model=BgaLinkStatus,
    status_code=200,
    summary="Whether a Board Game Arena account is linked",
)
async def get_bga_link(
    user: CurrentUser = Depends(get_current_user),
) -> BgaLinkStatus:
    """Read the viewer's Board Game Arena link state."""
    row = await asyncio.to_thread(_read_link, user.user_id)
    return _status_from(row)


@router.post(
    "/bga/link",
    response_model=BgaLinkStatus,
    status_code=200,
    summary="Link a Board Game Arena account (username + password)",
)
async def link_bga(
    body: BgaLinkRequest,
    user: CurrentUser = Depends(get_current_user),
) -> BgaLinkStatus:
    """Sign in to Board Game Arena and store the session for later imports."""
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Enter your Board Game Arena username.")

    # get_secret_value() at the last possible moment, and never assigned to
    # anything that outlives this call.
    session = await login_to_bga(username, body.password.get_secret_value())

    sb = get_supabase()
    await asyncio.to_thread(
        store_user_credentials, sb, user.user_id, username, body.password.get_secret_value(), session
    )
    row = await asyncio.to_thread(_read_link, user.user_id)
    return _status_from(row)


@router.delete(
    "/bga/link",
    response_model=BgaLinkStatus,
    status_code=200,
    summary="Unlink the Board Game Arena account",
)
async def unlink_bga(
    user: CurrentUser = Depends(get_current_user),
) -> BgaLinkStatus:
    """Forget the handle, the stored password and the session in one write."""
    sb = get_supabase()
    await asyncio.to_thread(clear_user_session, sb, user.user_id)
    # Imported plays keep their bga_table_id on purpose: unlinking is "stop
    # using my account", not "forget what I already imported", and dropping it
    # would silently offer every one of those plays again on a future re-link.
    return BgaLinkStatus(auth_state=BgaAuthState.UNLINKED)


@router.post(
    "/bga/tables/fetch",
    response_model=BgaFetchResponse,
    status_code=200,
    summary="Read finished Board Game Arena tables not yet imported",
)
async def fetch_bga_tables(
    user: CurrentUser = Depends(get_current_user),
) -> BgaFetchResponse:
    """Sweep the linked account's finished tables into reviewable draft plays."""
    row = await asyncio.to_thread(_read_link, user.user_id)
    state = bga_auth_state_from(row)
    if state is BgaAuthState.UNLINKED:
        raise HTTPException(status_code=400, detail="No Board Game Arena account is linked yet.")
    if state is BgaAuthState.RELINK_REQUIRED:
        raise HTTPException(
            status_code=409,
            detail="Board Game Arena re-link required: sign in again to keep importing.",
        )

    # One sweep per user at a time. Two in flight would double the request rate
    # against a site that bans for it, and the ledger only has room for one.
    running = bga_progress.read(user.user_id)
    if running and running.get("state") == BgaFetchState.RUNNING.value:
        raise HTTPException(
            status_code=409,
            detail="An import is already reading your Board Game Arena history.",
        )

    player_id = row.get("bga_player_id") or row.get("bga_username") or ""
    return await bga_import_service.sweep(
        user.user_id, str(player_id), row.get("bga_username") or ""
    )


@router.get(
    "/bga/tables/progress",
    response_model=BgaFetchProgressResponse,
    status_code=200,
    summary="How far the Board Game Arena sweep has got",
)
async def bga_fetch_progress(
    user: CurrentUser = Depends(get_current_user),
) -> BgaFetchProgressResponse:
    """Read the in-process ledger for the viewer's running sweep."""
    snapshot = bga_progress.read(user.user_id)
    if not snapshot:
        # Not an error: an in-process ledger this worker never wrote reads as
        # UNKNOWN while the POST is perfectly alive. The FE renders it as
        # "still working".
        return BgaFetchProgressResponse(state=BgaFetchState.UNKNOWN)
    return BgaFetchProgressResponse(**snapshot)


@router.post(
    "/bga/players/remember",
    response_model=BgaRememberResponse,
    status_code=200,
    summary="Remember which person a Board Game Arena handle is",
)
async def remember_bga_players(
    body: BgaRememberRequest,
    user: CurrentUser = Depends(get_current_user),
) -> BgaRememberResponse:
    """Store handle → person mappings so the next import pre-seats them."""
    sb = get_supabase()
    stored = await asyncio.to_thread(
        bga_import_service.remember_links,
        sb,
        user.user_id,
        [link.model_dump() for link in body.links],
    )
    return BgaRememberResponse(stored=stored)
