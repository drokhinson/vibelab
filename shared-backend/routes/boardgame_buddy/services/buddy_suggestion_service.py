"""Suggestion-list lifecycle — "stop suggesting this person".

Reading suggestions lives in feed_service (the three RPCs that rank them);
this module owns the one row that takes somebody OUT of those lists, and the
one place that puts them back.

A dismissal is deliberately the weakest negative signal in the app. It is
per-viewer, one-directional and silent: the person dismissed is never told,
keeps every ability they had, and still turns up in `/profiles/search` — which
is also the recovery path for a mis-tapped X, since search is the one people
list the dismissal does not filter. What it does is stop the app from
volunteering them, which is the whole complaint it answers.

It is NOT a block. Blocking is a status on boardgamebuddy_buddy_edges and cuts
both directions; if that is ever wanted it belongs there, not here.
"""

from fastapi import HTTPException
from supabase import Client

_TABLE = "boardgamebuddy_buddy_suggestion_dismissals"


def dismiss(sb: Client, viewer_id: str, target_user_id: str) -> None:
    """Stop suggesting `target_user_id` to `viewer_id`.

    Idempotent — a second dismissal of the same person is the same row, not a
    409. The client removes the tile optimistically and a retry after a dropped
    response must not surface as an error on a screen where the tile is already
    gone.
    """
    if target_user_id == viewer_id:
        raise HTTPException(status_code=400, detail="Cannot dismiss yourself")

    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id")
        .eq("id", target_user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="User not found")

    sb.table(_TABLE).upsert(
        {"user_id": viewer_id, "dismissed_user_id": target_user_id},
        on_conflict="user_id,dismissed_user_id",
    ).execute()


def clear(sb: Client, viewer_id: str, target_user_id: str) -> None:
    """Undo a dismissal, if there is one.

    Called when the viewer sends that person a buddy request: asking to be
    somebody's buddy contradicts "stop suggesting them" outright, so the older
    signal goes rather than sitting there ready to hide them again if the
    request is later withdrawn or the friendship ends.

    Unconditional delete, no read first — the row usually does not exist and
    PostgREST is happy to delete nothing.
    """
    (
        sb.table(_TABLE)
        .delete()
        .eq("user_id", viewer_id)
        .eq("dismissed_user_id", target_user_id)
        .execute()
    )
