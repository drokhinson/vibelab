"""Capture (the phone/share entry point), capture tokens, and the inbox."""

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import BackgroundTasks, Depends, HTTPException, Path, Query

from db import get_supabase

from . import router
from .constants import (
    CAPTURE_TOKEN_PREFIX,
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
    GeoFacets,
    InboxCountResponse,
    InboxResponse,
    InboxScrapResponse,
    MessageResponse,
    ScrapResponse,
    SourceResponse,
    SourceScrapsResponse,
)
from .services import places as places_svc
from .services.checkpoints import checkpoint_category_slugs
from .services.enrichment import process_source
from .access import get_accessible_trip
from .services.hydrate import hydrate_scraps

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
        # Collaborators (and the owner) can capture straight onto a shared trip.
        get_accessible_trip(sb, body.trip_id, user.user_id, need_write=True)

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
                # Re-shared straight into a trip: add this source's places to
                # that trip as approved memberships (explicit user intent). The
                # places stay on the Wander List.
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
                    scrap_ids = [
                        s["id"]
                        for s in (
                            sb.table("travelscrapbook_scraps")
                            .select("id")
                            .eq("user_id", user.user_id)
                            .in_("place_id", place_ids)
                            .execute()
                        ).data or []
                    ]
                    if scrap_ids:
                        # RPC: plan uniqueness is a partial index (020) that
                        # PostgREST's on_conflict can't arbitrate.
                        sb.rpc("travelscrapbook_add_plan_memberships", {
                            "p_rows": [
                                {"scrap_id": sid, "trip_id": body.trip_id}
                                for sid in scrap_ids
                            ],
                        }).execute()
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

def _sweep_stale_processing(sb, sources: list[dict[str, Any]]) -> None:
    """Sources stuck in 'processing' lost their BackgroundTask to a restart —
    flip them to failed/network so the UI offers a retry. One batched UPDATE
    covers every stale row (was one UPDATE per row)."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=SOURCE_PROCESSING_TIMEOUT_SECONDS)
    stale_ids = []
    for source in sources:
        if source["status"] != SourceStatus.PROCESSING:
            continue
        updated_at = datetime.fromisoformat(source["updated_at"].replace("Z", "+00:00"))
        if updated_at < cutoff:
            source["status"] = SourceStatus.FAILED
            source["error_kind"] = EnrichErrorKind.NETWORK
            stale_ids.append(source["id"])
    if stale_ids:
        sb.table("travelscrapbook_sources").update({
            "status": SourceStatus.FAILED,
            "error_kind": EnrichErrorKind.NETWORK,
            "updated_at": "now()",
        }).in_("id", stale_ids).execute()


@router.get(
    "/inbox",
    response_model=InboxResponse,
    status_code=200,
    summary="Get the inbox",
)
async def get_inbox(
    region: Optional[str] = Query(None, max_length=120, description="Filter: macro-region"),
    country: Optional[str] = Query(None, max_length=120, description="Filter: country (within the region)"),
    city: Optional[str] = Query(None, max_length=120, description="Filter: city (within the country)"),
    limit: int = Query(24, ge=1, le=100, description="Page size"),
    offset: int = Query(0, ge=0, description="Page start"),
    user: CurrentUser = Depends(get_current_user),
) -> InboxResponse:
    """Everything awaiting the user's attention: sources still processing,
    sources that failed, and one filtered PAGE of unassigned scraps with trip
    suggestions — plus drill-down facets (regions → countries → cities), the
    filtered total, and the global badge count. Fetched in ONE DB round-trip
    (travelscrapbook_inbox_bundle: page + facets + counts + sources + the
    geocoded trips that feed suggestions — previously one trips query PER
    SCRAP on the page)."""
    sb = get_supabase()
    bundle = (
        sb.rpc("travelscrapbook_inbox_bundle", {
            "p_viewer": user.user_id,
            "p_region": region,
            "p_country": country,
            "p_city": city,
            "p_limit": limit,
            "p_offset": offset,
        }).execute()
    ).data or {}
    sources = [
        *bundle.get("processing_sources", []),
        *bundle.get("failed_sources", []),
    ]
    _sweep_stale_processing(sb, sources)

    trips = bundle.get("geocoded_trips", [])
    inbox_scraps = [
        InboxScrapResponse(
            **s,
            suggestions=places_svc.suggest_trips(
                trips,
                lat=s.get("lat"), lng=s.get("lng"),
                city=s.get("place_city"), region=s.get("place_region"),
                country=s.get("place_country"),
            ),
        )
        for s in bundle.get("scraps", [])
    ]
    # Checkpoint places (hotels/transport, 020) get no trip suggestions — they
    # join trips as checkpoints via the trip screen, not the plan picker.
    checkpoint_scraps = [
        InboxScrapResponse(**s) for s in bundle.get("checkpoint_scraps", [])
    ]
    return InboxResponse(
        processing_sources=[
            SourceResponse(**s) for s in sources if s["status"] == SourceStatus.PROCESSING
        ],
        failed_sources=[
            SourceResponse(**s) for s in sources if s["status"] == SourceStatus.FAILED
        ],
        scraps=inbox_scraps,
        checkpoint_scraps=checkpoint_scraps,
        total=bundle.get("total", 0),
        checkpoint_total=bundle.get("checkpoint_total", 0),
        facets=bundle.get("facets") or GeoFacets(),
        inbox_count=bundle.get("unvisited_count", 0) + len(sources),
    )


@router.get(
    "/inbox/count",
    response_model=InboxCountResponse,
    status_code=200,
    summary="Inbox badge count",
)
async def get_inbox_count(
    since: Optional[datetime] = Query(
        None,
        description="Only count places imported after this time — the 'new since "
        "last visit' Wander List badge. Omit for the full pending count.",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> InboxCountResponse:
    """Drives the nav badge. With `since`, counts only unfiled places imported
    after that time (new since the user last opened the Wander List) and leaves
    out in-progress captures. Without it, the full pending count: unvisited
    scraps + processing/failed sources. Checkpoint-category places (hotels/
    transport, 020) don't count — matches the inbox bundle's unvisited_count."""
    sb = get_supabase()
    scraps_q = (
        sb.table("travelscrapbook_scraps")
        .select("id, travelscrapbook_places!inner(category)", count="exact")
        .eq("user_id", user.user_id)
        .is_("visited_at", "null")
    )
    cp_slugs = checkpoint_category_slugs(sb)
    if cp_slugs:
        # places.category is NOT NULL-by-construction (DEFAULT 'other'), so the
        # negative filter never drops rows on a null comparison.
        scraps_q = scraps_q.not_.in_(
            "travelscrapbook_places.category", sorted(cp_slugs)
        )
    if since is not None:
        # "New" badge: freshly imported places only, not in-progress captures.
        scraps_q = scraps_q.gt("created_at", since.isoformat())
        return InboxCountResponse(count=(scraps_q.execute().count or 0))
    scraps = scraps_q.execute()
    sources = (
        sb.table("travelscrapbook_sources")
        .select("id", count="exact")
        .eq("user_id", user.user_id)
        .in_("status", [SourceStatus.PROCESSING, SourceStatus.FAILED])
        .execute()
    )
    return InboxCountResponse(count=(scraps.count or 0) + (sources.count or 0))


# ── Source progress ───────────────────────────────────────────────────────────

@router.get(
    "/sources/{source_id}/scraps",
    response_model=SourceScrapsResponse,
    status_code=200,
    summary="A source's processing status + the scraps it created",
)
async def get_source_scraps(
    source_id: str = Path(..., description="Source UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> SourceScrapsResponse:
    """Poll a capture in flight: the source's status plus the scraps extracted
    from it so far (via place_sources), so the share screen can show cards as
    they land."""
    sb = get_supabase()
    source = _get_owned_source(sb, source_id, user.user_id)
    links = (
        sb.table("travelscrapbook_place_sources")
        .select("place_id")
        .eq("source_id", source_id)
        .execute()
    ).data or []
    place_ids = sorted({l["place_id"] for l in links if l.get("place_id")})
    scraps: list[dict[str, Any]] = []
    if place_ids:
        rows = (
            sb.table("travelscrapbook_scraps")
            .select("*")
            .eq("user_id", user.user_id)
            .in_("place_id", place_ids)
            .order("created_at", desc=True)
            .execute()
        ).data or []
        scraps = hydrate_scraps(sb, rows)
    return SourceScrapsResponse(
        status=source["status"],
        error_kind=source.get("error_kind"),
        scraps=[ScrapResponse(**s) for s in scraps],
    )


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
