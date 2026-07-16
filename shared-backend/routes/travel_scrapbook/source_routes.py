"""Capture (the phone/share entry point), capture tokens, and the inbox."""

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import BackgroundTasks, Depends, HTTPException, Path

from db import get_supabase

from . import router
from .constants import (
    CAPTURE_TOKEN_PREFIX,
    CapturedVia,
    ScrapStatus,
    SOURCE_PROCESSING_TIMEOUT_SECONDS,
    SourceStatus,
    EnrichErrorKind,
)
from .dependencies import (
    CurrentUser,
    get_capture_user,
    get_current_user,
    hash_capture_token,
)
from .models import (
    CaptureRequest,
    CaptureTokenCreateResponse,
    CaptureTokenStatusResponse,
    InboxCountResponse,
    InboxResponse,
    InboxScrapResponse,
    MessageResponse,
    SourceResponse,
)
from .services import places as places_svc
from .services.enrichment import process_source
from .services.hydrate import hydrate_scraps
from .trip_routes import get_owned_trip

_URL_RE = re.compile(r"https?://\S+")


def _resolve_capture_url(body: CaptureRequest) -> str:
    """The shared URL: body.url when present, else the first http(s) URL in
    body.text (Android share sheets put the link inside the text field)."""
    if body.url:
        return str(body.url)
    if body.text:
        match = _URL_RE.search(body.text)
        if match:
            return match.group(0).rstrip(").,;\"'")
    raise HTTPException(status_code=422, detail="No URL found in the shared content")


def _get_owned_source(sb, source_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        sb.table("travelscrapbook_sources")
        .select("*")
        .eq("id", source_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Source not found")
    return rows.data[0]


@router.post(
    "/capture",
    response_model=SourceResponse,
    status_code=202,
    summary="Capture a shared URL",
)
async def capture(
    body: CaptureRequest,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_capture_user),
) -> SourceResponse:
    """Silent capture: accepts a URL from the share sheet (Android PWA), an
    iOS Shortcut (capture-token auth), the bookmarklet, or quick-paste.
    Returns immediately; place extraction runs in the background and files the
    resulting scraps into a matching trip's staging area or the inbox.
    Re-capturing a URL reuses its source instead of duplicating it."""
    sb = get_supabase()
    url = _resolve_capture_url(body)
    if body.trip_id:
        get_owned_trip(sb, body.trip_id, user.user_id)

    # Keep the caption for LLM context, minus the URL itself.
    shared_text: Optional[str] = None
    if body.text:
        shared_text = _URL_RE.sub("", body.text).strip() or None
    if body.title:
        shared_text = f"{body.title}\n{shared_text}" if shared_text else body.title

    url_normalized = places_svc.normalize_url(url)
    existing = (
        sb.table("travelscrapbook_sources")
        .select("*")
        .eq("user_id", user.user_id)
        .eq("url_normalized", url_normalized)
        .execute()
    ).data

    if existing:
        source = existing[0]
        if source["status"] == SourceStatus.READY:
            if body.trip_id:
                # Re-shared straight into a trip: move this source's inbox
                # scraps there, already approved (explicit user intent).
                place_ids = [
                    l["place_id"]
                    for l in (
                        sb.table("travelscrapbook_place_sources")
                        .select("place_id")
                        .eq("source_id", source["id"])
                        .execute()
                    ).data or []
                ]
                if place_ids:
                    sb.table("travelscrapbook_scraps").update({
                        "trip_id": body.trip_id,
                        "status": ScrapStatus.APPROVED,
                        "updated_at": "now()",
                    }).eq("user_id", user.user_id).eq("status", ScrapStatus.INBOX) \
                      .in_("place_id", place_ids).execute()
            return SourceResponse(**source)
        # failed or stale processing → reset and re-run
        update = {
            "status": SourceStatus.PROCESSING,
            "error_kind": None,
            "shared_text": shared_text or source.get("shared_text"),
            "trip_hint_id": body.trip_id or source.get("trip_hint_id"),
            "updated_at": "now()",
        }
        updated = (
            sb.table("travelscrapbook_sources")
            .update(update)
            .eq("id", source["id"])
            .execute()
        )
        background_tasks.add_task(process_source, source["id"])
        return SourceResponse(**updated.data[0])

    row = {
        "user_id": user.user_id,
        "url": url,
        "url_normalized": url_normalized,
        "source_domain": places_svc.source_domain(url),
        "status": SourceStatus.PROCESSING,
        "captured_via": body.via,
        "shared_text": shared_text,
        "capture_notes": body.notes,
        "trip_hint_id": body.trip_id,
    }
    created = sb.table("travelscrapbook_sources").insert(row).execute()
    source = created.data[0]
    background_tasks.add_task(process_source, source["id"])
    return SourceResponse(**source)


# ── Capture tokens (iOS Shortcut) ─────────────────────────────────────────────

@router.post(
    "/capture-token",
    response_model=CaptureTokenCreateResponse,
    status_code=201,
    summary="Create a capture token",
)
async def create_capture_token(
    user: CurrentUser = Depends(get_current_user),
) -> CaptureTokenCreateResponse:
    """Mint a personal capture token for the iOS Shortcut. The plaintext is
    shown once; creating a new token revokes any previous one."""
    sb = get_supabase()
    sb.table("travelscrapbook_capture_tokens").update(
        {"revoked_at": "now()"}
    ).eq("user_id", user.user_id).is_("revoked_at", "null").execute()

    token = CAPTURE_TOKEN_PREFIX + secrets.token_urlsafe(32)
    created = sb.table("travelscrapbook_capture_tokens").insert({
        "user_id": user.user_id,
        "token_hash": hash_capture_token(token),
    }).execute()
    return CaptureTokenCreateResponse(token=token, created_at=created.data[0]["created_at"])


@router.get(
    "/capture-token",
    response_model=CaptureTokenStatusResponse,
    status_code=200,
    summary="Capture token status",
)
async def get_capture_token_status(
    user: CurrentUser = Depends(get_current_user),
) -> CaptureTokenStatusResponse:
    """Whether an active capture token exists (the plaintext is never shown again)."""
    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_capture_tokens")
        .select("created_at, last_used_at")
        .eq("user_id", user.user_id)
        .is_("revoked_at", "null")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if not rows.data:
        return CaptureTokenStatusResponse(active=False)
    row = rows.data[0]
    return CaptureTokenStatusResponse(
        active=True, created_at=row["created_at"], last_used_at=row.get("last_used_at")
    )


@router.delete(
    "/capture-token",
    response_model=MessageResponse,
    status_code=200,
    summary="Revoke the capture token",
)
async def revoke_capture_token(
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Revoke the active capture token; the iOS Shortcut stops working."""
    sb = get_supabase()
    sb.table("travelscrapbook_capture_tokens").update(
        {"revoked_at": "now()"}
    ).eq("user_id", user.user_id).is_("revoked_at", "null").execute()
    return MessageResponse(message="Capture token revoked")


# ── Inbox ─────────────────────────────────────────────────────────────────────

def _sweep_stale_processing(sb, user_id: str, sources: list[dict[str, Any]]) -> None:
    """Sources stuck in 'processing' lost their BackgroundTask to a restart —
    flip them to failed/network so the UI offers a retry."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=SOURCE_PROCESSING_TIMEOUT_SECONDS)
    for source in sources:
        if source["status"] != SourceStatus.PROCESSING:
            continue
        updated_at = datetime.fromisoformat(source["updated_at"].replace("Z", "+00:00"))
        if updated_at < cutoff:
            source["status"] = SourceStatus.FAILED
            source["error_kind"] = EnrichErrorKind.NETWORK
            sb.table("travelscrapbook_sources").update({
                "status": SourceStatus.FAILED,
                "error_kind": EnrichErrorKind.NETWORK,
                "updated_at": "now()",
            }).eq("id", source["id"]).execute()


@router.get(
    "/inbox",
    response_model=InboxResponse,
    status_code=200,
    summary="Get the inbox",
)
async def get_inbox(user: CurrentUser = Depends(get_current_user)) -> InboxResponse:
    """Everything awaiting the user's attention: sources still processing,
    sources that failed, and unassigned scraps with trip suggestions."""
    sb = get_supabase()
    sources = (
        sb.table("travelscrapbook_sources")
        .select("*")
        .eq("user_id", user.user_id)
        .in_("status", [SourceStatus.PROCESSING, SourceStatus.FAILED])
        .order("created_at", desc=True)
        .execute()
    ).data or []
    _sweep_stale_processing(sb, user.user_id, sources)

    scraps = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user.user_id)
        .eq("status", ScrapStatus.INBOX)
        .is_("visited_at", "null")   # visited places move to the Visited view
        .order("created_at", desc=True)
        .execute()
    ).data or []
    hydrated = hydrate_scraps(sb, scraps)
    inbox_scraps = [
        InboxScrapResponse(
            **s,
            suggestions=places_svc.suggest_trips(
                sb, user.user_id,
                lat=s["lat"], lng=s["lng"],
                city=s.get("place_city"), region=s.get("place_region"),
                country=s.get("place_country"),
            ),
        )
        for s in hydrated
    ]
    return InboxResponse(
        processing_sources=[
            SourceResponse(**s) for s in sources if s["status"] == SourceStatus.PROCESSING
        ],
        failed_sources=[
            SourceResponse(**s) for s in sources if s["status"] == SourceStatus.FAILED
        ],
        scraps=inbox_scraps,
    )


@router.get(
    "/inbox/count",
    response_model=InboxCountResponse,
    status_code=200,
    summary="Inbox badge count",
)
async def get_inbox_count(user: CurrentUser = Depends(get_current_user)) -> InboxCountResponse:
    """Inbox scraps + processing/failed sources — drives the nav badge."""
    sb = get_supabase()
    scraps = (
        sb.table("travelscrapbook_scraps")
        .select("id", count="exact")
        .eq("user_id", user.user_id)
        .eq("status", ScrapStatus.INBOX)
        .is_("visited_at", "null")
        .execute()
    )
    sources = (
        sb.table("travelscrapbook_sources")
        .select("id", count="exact")
        .eq("user_id", user.user_id)
        .in_("status", [SourceStatus.PROCESSING, SourceStatus.FAILED])
        .execute()
    )
    return InboxCountResponse(count=(scraps.count or 0) + (sources.count or 0))


# ── Source retry / dismiss ────────────────────────────────────────────────────

@router.post(
    "/sources/{source_id}/retry",
    response_model=SourceResponse,
    status_code=202,
    summary="Retry a failed source",
)
async def retry_source(
    background_tasks: BackgroundTasks,
    source_id: str = Path(..., description="Source UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> SourceResponse:
    """Re-run the enrichment pipeline for a failed or stuck source."""
    sb = get_supabase()
    _get_owned_source(sb, source_id, user.user_id)
    updated = (
        sb.table("travelscrapbook_sources")
        .update({
            "status": SourceStatus.PROCESSING,
            "error_kind": None,
            "updated_at": "now()",
        })
        .eq("id", source_id)
        .execute()
    )
    background_tasks.add_task(process_source, source_id)
    return SourceResponse(**updated.data[0])


@router.delete(
    "/sources/{source_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Dismiss a source",
)
async def delete_source(
    source_id: str = Path(..., description="Source UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a source (its place links cascade; places and scraps stay)."""
    sb = get_supabase()
    _get_owned_source(sb, source_id, user.user_id)
    sb.table("travelscrapbook_sources").delete().eq("id", source_id).execute()
    return MessageResponse(message="Source dismissed")
