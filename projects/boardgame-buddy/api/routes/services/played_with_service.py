"""Played-with discovery + ghost-player linking.

"Played with" surfaces real-account players (boardgamebuddy_play_players rows
with player_user_id set) the viewer has shared a play with. Ghost players are
free-text nicknames the viewer logged without an account; the link endpoint
promotes them by stamping player_user_id on every matching row.

The three read paths — buddies, ghosts, played-with — are one RPC
(bgb_play_partners, migration 047). They were twelve round trips across three
endpoints, one of which pulled every play id the viewer touches into Python to
count them in a dict.
"""

from fastapi import HTTPException
from supabase import Client

from ..constants import MAX_IMPORT_NAME_CHARS
from ..models import (
    BuddyEdgeResponse,
    GhostPlayer,
    PlayedWithUser,
    PlayPartnersResponse,
)


def fetch_play_partners(sb: Client, viewer_id: str) -> PlayPartnersResponse:
    """Everything the Gather player picker needs, in ONE round trip.

    bgb_play_partners (migration 047) does the buddy edges, the ghost roll-up
    and the played-with counts as SQL aggregates. The three lists used to be
    three endpoints and twelve round trips — including a pass that pulled every
    play id the viewer touches into Python just to count them in a dict, which
    is unbounded for a BGG-synced account.
    """
    data = sb.rpc("bgb_play_partners", {"p_viewer": viewer_id}).execute().data or {}
    return PlayPartnersResponse(
        accounts=[BuddyEdgeResponse.model_validate(x) for x in (data.get("accounts") or [])],
        ghosts=[GhostPlayer.model_validate(x) for x in (data.get("ghosts") or [])],
        recent=[PlayedWithUser.model_validate(x) for x in (data.get("recent") or [])],
    )


def fetch_played_with(sb: Client, viewer_id: str) -> list[PlayedWithUser]:
    """Real-account players who appear in plays the viewer is involved in
    (either logged it or appears as a participant), ranked by play count."""
    return fetch_play_partners(sb, viewer_id).recent


def fetch_ghost_players(sb: Client, viewer_id: str) -> list[GhostPlayer]:
    """Free-text ghost players the viewer recorded in their own plays.

    Grouped by case-sensitive display_name; carries play_count and the most
    recent played_at date so the user can recognize who they are.
    """
    return fetch_play_partners(sb, viewer_id).ghosts


def link_ghost(
    sb: Client,
    viewer_id: str,
    display_name: str,
    target_user_id: str,
) -> int:
    """Stamp `target_user_id` onto every ghost row the viewer logged that
    matches `display_name` (case-insensitive). Returns the number of rows
    updated."""
    if not display_name.strip():
        raise HTTPException(status_code=400, detail="display_name is required")
    if target_user_id == viewer_id:
        raise HTTPException(status_code=400, detail="Cannot link a ghost to yourself")

    # One statement (migration 050). This used to SELECT every play id the
    # viewer owns and hand the list back as a PostgREST `in_` filter — which
    # rides in the query string, so a few thousand plays produced a URL that
    # failed outright rather than merely slowly.
    data = sb.rpc("bgb_link_ghost", {
        "p_viewer": viewer_id,
        "p_display_name": display_name.strip(),
        "p_target": target_user_id,
    }).execute().data or {}
    if data.get("error") == "not_found":
        raise HTTPException(status_code=404, detail="Target user not found")
    return int(data.get("updated") or 0)


def ghost_out_of_plays(
    sb: Client,
    viewer_id: str,
    play_ids: list[str] | None = None,
    group_ids: list[str] | None = None,
    batch_ids: list[str] | None = None,
) -> int:
    """Convert the caller's own player rows back into ghosts, in one statement.

    The inverse of `link_ghost`: instead of stamping a `player_user_id` onto a
    free-text ghost, it nulls the caller's `player_user_id` while keeping the
    display name. Used when someone was added to plays they didn't take part in
    — they self-remove from the game log without deleting anything (the owner
    keeps the play, seeing them as a named ghost). Returns the rows moved.

    Takes runs and batches as well as individual plays, because that is what
    the notifications screen selects: one tick on an imported batch has to
    unlink 214 plays without the client holding 214 ids.

    One RPC rather than the two PostgREST calls it replaced, for two reasons.
    A per-play loop over a batch is two round trips per play. And the
    identity-check backfill and the null-out are now a single UPDATE, so no
    concurrent write can land between them and abort on
    bgb_play_players_identity_chk.

    Scoping lives in the RPC and is doubled: `player_user_id = viewer_id` (a
    caller can only ever move their own seat) and `plays.user_id <> viewer_id`
    (never a play they logged themselves). An id failing either — including
    somebody else's batch — matches zero rows and contributes 0 rather than
    erroring, so one stale id cannot sink a batch of sixty. The fallback
    display name is read from the profile inside the function rather than
    trusted from the client.
    """
    res = sb.rpc(
        "bgb_ghost_out_of_plays",
        {
            "p_viewer": viewer_id,
            "p_play_ids": play_ids or [],
            "p_group_ids": group_ids or [],
            "p_batch_ids": batch_ids or [],
        },
    ).execute()
    return int(res.data or 0)


def ghost_out_of_play(sb: Client, viewer_id: str, play_id: str) -> int:
    """Single-play wrapper over `ghost_out_of_plays`, for POST /plays/{id}/leave.

    Kept as its own name because the route around it has a different error
    contract — it 404s an unknown play and 400s one the caller logged, which
    the play-detail popup relies on — but the write itself is the same one.
    """
    return ghost_out_of_plays(sb, viewer_id, play_ids=[play_id])


def merge_ghosts(
    sb: Client,
    viewer_id: str,
    source_display_name: str,
    target_display_name: str,
) -> int:
    """Rename every ghost row matching `source_display_name` (case-insensitive)
    to `target_display_name`, scoped to the viewer's own plays. Used to
    collapse the same friend logged under different spellings into a
    single ghost. Returns the number of rows updated.
    """
    src = (source_display_name or "").strip()
    tgt = (target_display_name or "").strip()
    if not src or not tgt:
        raise HTTPException(status_code=400, detail="Both display names are required")
    if src.lower() == tgt.lower():
        raise HTTPException(status_code=400, detail="Source and target ghost must differ")

    return _write_ghost_name(sb, viewer_id, src, tgt)


def rename_ghost(
    sb: Client,
    viewer_id: str,
    display_name: str,
    new_display_name: str,
) -> int:
    """Correct the spelling of one ghost nickname across the viewer's plays.

    The same write as `merge_ghosts` — a ghost has no id, so its name IS its
    identity and every edit to it is an UPDATE over the matching rows — with
    two differences that follow from it being a typo fix rather than a claim
    that two people are one:

    * The new name is free text, so its length is checked here. Merge's target
      is always a name already in the viewer's plays, which passed this same
      limit on the way in.
    * A change of CASE alone is allowed. "dave" → "Dave" is the single most
      likely correction on this screen, and merge rejects it as a no-op
      because for merge that is exactly what it is.

    Typing an existing ghost's name is not an error and is not blocked: the
    UPDATE simply lands both spellings on one name, which is the merge the
    user just asked for in the only words this screen gives them. The caller
    confirms that case before sending it (buddies-view `_openGhostRename`).

    Returns the number of rows updated.
    """
    src = (display_name or "").strip()
    tgt = (new_display_name or "").strip()
    if not src or not tgt:
        raise HTTPException(status_code=400, detail="Both the old and new name are required")
    if len(tgt) > MAX_IMPORT_NAME_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"A player name can be at most {MAX_IMPORT_NAME_CHARS} characters",
        )
    if src == tgt:
        raise HTTPException(status_code=400, detail="That is already their name")

    return _write_ghost_name(sb, viewer_id, src, tgt)


def _write_ghost_name(sb: Client, viewer_id: str, src: str, tgt: str) -> int:
    """Set `tgt` as the display name on every ghost row of the viewer's own
    plays whose name matches `src` case-insensitively. Returns the row count.

    One statement (migration 050) — same query-string cliff as link_ghost.
    """
    data = sb.rpc("bgb_merge_ghosts", {
        "p_viewer": viewer_id,
        "p_source": src,
        "p_target": tgt,
    }).execute().data or {}
    return int(data.get("updated") or 0)
