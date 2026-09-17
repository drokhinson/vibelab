"""The Dev feedback board — reads, writes and the like toggle.

Its own module for the reason reaction_service.py is: the board is its own object
with its own lifecycle, and the route file stays thin enough to read.

Everything here is BLOCKING. The Supabase client is synchronous, so every
function in this file is called through `asyncio.to_thread` from
feedback_routes.py — blocking the loop stalls every in-flight request in the
service.

TWO THINGS THIS MODULE IS RESPONSIBLE FOR AND THE ROUTES ARE NOT:

  * The author's own like. POST /feedback writes the item AND a like from its
    author, so a new item lands on the board at 1 rather than 0. That is a
    deliberate departure from reaction_service, which drops the caller's own
    plays — you cannot kudos yourself. Here the count measures how many people
    want a thing, and the person who asked for it is one of them. They can still
    take it back, which is the honest reading of "I no longer want this".

  * Validating type and topic against their lookup tables. They are seeded rows,
    not enums (see constants.FeedbackStatus for why the split falls where it
    does), so an unknown id is a 400 rather than a foreign-key 500 surfacing as
    an opaque "Failed to fetch" in the browser.
"""

from typing import Any

from fastapi import HTTPException
from supabase import Client

TABLE = "boardgamebuddy_feedback"
LIKES_TABLE = "boardgamebuddy_feedback_likes"
TYPES_TABLE = "boardgamebuddy_feedback_types"
TOPICS_TABLE = "boardgamebuddy_feedback_topics"

_OPTION_COLUMNS = "id, label, icon, display_order"


# ── Lookups ───────────────────────────────────────────────────────────────────

def list_types(sb: Client) -> list[dict[str, Any]]:
    """The feedback-type lookup rows, in display order."""
    return (
        sb.table(TYPES_TABLE)
        .select(_OPTION_COLUMNS)
        .order("display_order")
        .execute()
    ).data or []


def list_topics(sb: Client) -> list[dict[str, Any]]:
    """The feedback-topic lookup rows, in display order."""
    return (
        sb.table(TOPICS_TABLE)
        .select(_OPTION_COLUMNS)
        .order("display_order")
        .execute()
    ).data or []


def _validate_option(sb: Client, table: str, value: str, what: str) -> None:
    """Raise 400 if `value` is not a row in `table`.

    The same shape as _validate_chapter_type in chapter_routes. Without it the
    insert fails on the foreign key, which reaches the client as a generic 500
    from main.py's APIError handler — technically a refusal, but one that tells
    a user nothing and a developer almost nothing.
    """
    row = sb.table(table).select("id").eq("id", value).execute()
    if not row.data:
        raise HTTPException(status_code=400, detail=f"Unknown feedback {what}")


# ── Read ──────────────────────────────────────────────────────────────────────

def list_feedback(
    sb: Client,
    viewer_id: str,
    status: str,
    feedback_type: str | None = None,
    topic: str | None = None,
    feedback_id: str | None = None,
) -> list[dict[str, Any]]:
    """The board: filtered, like-counted, and ordered by that count.

    Goes through the bgb_feedback_list RPC rather than PostgREST because the
    sort key is an aggregate over a second table — see the function's header in
    migration 040. Empty filter strings are normalised to NULL here rather than
    in SQL, so a client that sends `?type=` gets "no filter" instead of a search
    for a type whose id is the empty string.

    `status` is passed through verbatim and is the caller's responsibility: the
    route forces it to 'open' for a non-admin. `feedback_id` narrows to one item
    and, per the RPC's contract, overrides the status filter entirely.
    """
    rows = sb.rpc(
        "bgb_feedback_list",
        {
            "viewer_id": viewer_id,
            "want_status": status,
            "want_type": feedback_type or None,
            "want_topic": topic or None,
            "want_id": feedback_id or None,
        },
    ).execute().data or []
    return rows


def _one(sb: Client, viewer_id: str, feedback_id: str) -> dict[str, Any]:
    """Re-read a single item through the same RPC, or 404.

    Every write path returns this, so the client has one row renderer rather
    than two. `want_id` makes it one round trip and — crucially — one that
    ignores the status filter, since a resolve has just moved the item across it.
    `status` is therefore arbitrary here; 'open' is passed only because the
    argument has no default.
    """
    rows = list_feedback(sb, viewer_id, "open", feedback_id=feedback_id)
    if not rows:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return rows[0]


# ── Write ─────────────────────────────────────────────────────────────────────

def create(
    sb: Client,
    user_id: str,
    feedback_type: str,
    topic: str,
    body: str,
) -> dict[str, Any]:
    """Insert an item plus its author's own like, and return the board row."""
    _validate_option(sb, TYPES_TABLE, feedback_type, "type")
    _validate_option(sb, TOPICS_TABLE, topic, "topic")

    inserted = (
        sb.table(TABLE)
        .insert({
            "user_id": user_id,
            "feedback_type": feedback_type,
            "topic": topic,
            "body": body,
        })
        .execute()
    ).data
    if not inserted:
        raise HTTPException(status_code=500, detail="Failed to create feedback")
    feedback_id = inserted[0]["id"]

    # The author's own like. Not conditional and not optional: the board is
    # sorted by demand, and an item nobody has voted for — including the person
    # who wrote it — would sort below every item that had been up for an hour.
    sb.table(LIKES_TABLE).upsert(
        {"feedback_id": feedback_id, "user_id": user_id},
        on_conflict="feedback_id,user_id",
        ignore_duplicates=True,
    ).execute()

    return _one(sb, user_id, feedback_id)


def _exists(sb: Client, feedback_id: str) -> None:
    """Raise 404 if the item is gone, before writing a like against it."""
    row = sb.table(TABLE).select("id").eq("id", feedback_id).execute()
    if not row.data:
        raise HTTPException(status_code=404, detail="Feedback not found")


def _like_count(sb: Client, feedback_id: str) -> int:
    """The item's current like count, read back after a toggle.

    An exact count off PostgREST's Content-Range header with `head=True`, so the
    body is empty rather than a list of rows we would only measure — the same
    idiom admin_routes._count_query uses. The client painted its own guess
    before the request went out and reconciles against this, which is what stops
    two people liking at once from leaving either of them one behind.
    """
    res = (
        sb.table(LIKES_TABLE)
        .select("user_id", count="exact", head=True)
        .eq("feedback_id", feedback_id)
        .execute()
    )
    return res.count or 0


def like(sb: Client, viewer_id: str, feedback_id: str) -> int:
    """Add the viewer's like. Idempotent — a second tap writes nothing."""
    _exists(sb, feedback_id)
    # The composite PK is what makes this idempotent; ignore_duplicates keeps the
    # original created_at rather than bumping it on every re-tap.
    sb.table(LIKES_TABLE).upsert(
        {"feedback_id": feedback_id, "user_id": viewer_id},
        on_conflict="feedback_id,user_id",
        ignore_duplicates=True,
    ).execute()
    return _like_count(sb, feedback_id)


def unlike(sb: Client, viewer_id: str, feedback_id: str) -> int:
    """Remove the viewer's like.

    Not authorization-filtered beyond `user_id`, and it does not need to be: the
    filter IS the authorization, so this can only ever touch the caller's own
    row. Same reasoning as reaction_service.remove.
    """
    _exists(sb, feedback_id)
    sb.table(LIKES_TABLE).delete().eq("feedback_id", feedback_id).eq(
        "user_id", viewer_id
    ).execute()
    return _like_count(sb, feedback_id)


def set_status(
    sb: Client,
    admin_id: str,
    feedback_id: str,
    resolved: bool,
) -> dict[str, Any]:
    """Resolve or reopen an item, and return its refreshed board row.

    One function for both directions rather than two near-identical ones: the
    only difference is which three values get written, and keeping them in one
    place is what stops a reopen leaving a stale resolved_by behind. That was
    the whole failure mode worth guarding — a reopened item still naming the
    admin who closed it reads as resolved to anyone looking at the row.
    """
    updates: dict[str, Any] = (
        {"status": "resolved", "resolved_by": admin_id, "resolved_at": "now()"}
        if resolved
        else {"status": "open", "resolved_by": None, "resolved_at": None}
    )
    updated = (
        sb.table(TABLE).update(updates).eq("id", feedback_id).execute()
    ).data
    if not updated:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return _one(sb, admin_id, feedback_id)
