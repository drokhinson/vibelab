"""Release notices — the what's-new popup, and the archive behind it.

Purely informational: an admin writes a short note when something big ships,
and the next time each user opens the app it appears once. Nothing is asked of
the reader, so nothing here is a queue and nothing carries an unread badge.

TWO THINGS ARE LOAD-BEARING and both live in migration 042 rather than here.

`published_at IS NULL` is the ONLY draft flag. There is no status column and no
status field on the model — the same timestamp is the draft flag, the sort key,
and the unit the per-user watermark compares against. A status column beside it
would be two sources of truth for one fact, written by three routes and correct
only if all three remember.

`profiles.release_notices_seen_at` is the whole of seen-state — one watermark
per user, the shape `link_notifications_seen_at` has carried since 008, not a
per-(user, notice) table. Its `NOT NULL DEFAULT now()` is what implements "a new
account does not see the backlog", which is why no function in this module has
to know about signup dates.

The writes are plain PostgREST; only the two reads that need the watermark go
through RPCs, so "what counts as unseen" is stated once in SQL rather than
reassembled in Python.
"""

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from supabase import Client

from ..constants import RELEASE_NOTICES_POPUP_MAX, ReleaseNoticeStatus
from ..models import (
    ReleaseNotice,
    ReleaseNoticePatchRequest,
    ReleaseNoticesSeenResponse,
    ReleaseNoticeWriteRequest,
)

_TABLE = "boardgamebuddy_release_notices"

# Everything the client is ever allowed to see. `created_by` is deliberately
# absent: it is an audit column for the database, not something the admin list
# renders, and it is another account's uuid.
_COLUMNS = "id,title,body_md,link_route,link_label,published_at,created_at,updated_at"


def _row(raw: dict[str, Any]) -> ReleaseNotice:
    """One PostgREST row as the response model."""
    return ReleaseNotice(**{k: raw.get(k) for k in ReleaseNotice.model_fields})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def unseen(
    sb: Client, viewer_id: str, limit: int = RELEASE_NOTICES_POPUP_MAX
) -> list[ReleaseNotice]:
    """The published notices this viewer has not been shown, oldest-first.

    Ordering is the RPC's, not ours — it hands back the NEWEST `limit` notices
    sorted oldest-first so the popup reads as a chronology. Do not re-sort here.
    """
    res = sb.rpc(
        "bgb_release_notices_unseen",
        {"p_viewer": viewer_id, "p_limit": limit},
    ).execute()
    return [_row(r) for r in (res.data or [])]


def mark_seen(
    sb: Client, viewer_id: str, through: datetime | None = None
) -> ReleaseNoticesSeenResponse:
    """Advance the watermark to `through` (default now), monotonically.

    `through` is passed through untouched. Substituting now() when the client
    sent a value would defeat the point of the parameter: a notice published
    between /bootstrap and this call would be marked seen without ever having
    appeared. The RPC's GREATEST makes a stale retry harmless.
    """
    res = sb.rpc(
        "bgb_mark_release_notices_seen",
        {
            "p_viewer": viewer_id,
            "p_through": through.isoformat() if through else None,
        },
    ).execute()
    return ReleaseNoticesSeenResponse(seen_at=res.data)


def list_published(sb: Client, limit: int = 50) -> list[ReleaseNotice]:
    """Every published notice, newest first — the Settings "What's new" archive."""
    res = (
        sb.table(_TABLE)
        .select(_COLUMNS)
        .not_.is_("published_at", "null")
        .order("published_at", desc=True)
        .limit(limit)
        .execute()
    )
    return [_row(r) for r in (res.data or [])]


def list_all(
    sb: Client, status: ReleaseNoticeStatus = ReleaseNoticeStatus.ALL
) -> list[ReleaseNotice]:
    """The admin list: drafts and published together, drafts first.

    `published_at DESC NULLS FIRST` puts the drafts at the top because that is
    where the admin is working — the published ones are done.
    """
    query = sb.table(_TABLE).select(_COLUMNS)
    if status == ReleaseNoticeStatus.DRAFT:
        query = query.is_("published_at", "null")
    elif status == ReleaseNoticeStatus.PUBLISHED:
        query = query.not_.is_("published_at", "null")
    res = (
        query.order("published_at", desc=True, nullsfirst=True)
        .order("created_at", desc=True)
        .execute()
    )
    return [_row(r) for r in (res.data or [])]


def get(sb: Client, notice_id: str) -> ReleaseNotice:
    """One notice, or 404."""
    res = sb.table(_TABLE).select(_COLUMNS).eq("id", notice_id).limit(1).execute()
    rows = res.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Release notice not found")
    return _row(rows[0])


def create(
    sb: Client, author_id: str, payload: ReleaseNoticeWriteRequest
) -> ReleaseNotice:
    """Create a notice as a DRAFT. Publishing is a separate act."""
    res = (
        sb.table(_TABLE)
        .insert(
            {
                "title": payload.title.strip(),
                "body_md": payload.body_md.strip(),
                "link_route": payload.link_route or None,
                "link_label": (payload.link_label or "").strip() or None,
                "created_by": author_id,
            }
        )
        .execute()
    )
    rows = res.data or []
    if not rows:
        raise HTTPException(status_code=500, detail="Could not create the notice")
    return _row(rows[0])


def update(
    sb: Client, notice_id: str, patch: ReleaseNoticePatchRequest
) -> ReleaseNotice:
    """Edit a notice's copy. Never touches `published_at`.

    Editing a live notice is allowed and does not re-show it — the watermark
    compares against publish time, not edit time, so a typo fix reaches only
    people who had not seen it yet. That is the intended behaviour: the
    alternative makes every correction a second interruption.
    """
    changes: dict[str, Any] = {"updated_at": _now()}
    if patch.title is not None:
        changes["title"] = patch.title.strip()
    if patch.body_md is not None:
        changes["body_md"] = patch.body_md.strip()
    if patch.clear_link:
        # An absent key means "leave the link alone"; this is the only way to
        # say "remove it", since None is also the absent value.
        changes["link_route"] = None
        changes["link_label"] = None
    else:
        if patch.link_route is not None:
            changes["link_route"] = patch.link_route or None
        if patch.link_label is not None:
            changes["link_label"] = patch.link_label.strip() or None

    res = sb.table(_TABLE).update(changes).eq("id", notice_id).execute()
    rows = res.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Release notice not found")
    return _row(rows[0])


def set_published(sb: Client, notice_id: str, published: bool) -> ReleaseNotice:
    """Publish (stamp now()) or unpublish (clear the stamp).

    Publishing always writes now() and never a caller-supplied timestamp: a
    backdated notice sorts behind watermarks users already hold, so it would be
    invisible to exactly the people it was written for.

    REPUBLISHING MOVES THE STAMP FORWARD, so an unpublish/republish cycle
    re-shows the notice to people who already saw it. That follows from
    published_at being the only flag, and it is the right reading of unpublish
    ("this should not have gone out"). Anyone who has already seen a notice has
    a watermark past it, so unpublishing alone cannot retract it from them.
    """
    res = (
        sb.table(_TABLE)
        .update({"published_at": _now() if published else None, "updated_at": _now()})
        .eq("id", notice_id)
        .execute()
    )
    rows = res.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Release notice not found")
    return _row(rows[0])


def delete(sb: Client, notice_id: str) -> None:
    """Remove a notice. Does not un-show it to anyone who already saw it."""
    res = sb.table(_TABLE).delete().eq("id", notice_id).execute()
    if not (res.data or []):
        raise HTTPException(status_code=404, detail="Release notice not found")
