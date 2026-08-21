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

from ..models import (
    BuddyEdgeResponse,
    GhostPlayer,
    PlayedWithUser,
    PlayPartnersResponse,
)


def fetch_play_partners(sb, viewer_id: str) -> PlayPartnersResponse:
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


def fetch_played_with(sb, viewer_id: str) -> list[PlayedWithUser]:
    """Real-account players who appear in plays the viewer is involved in
    (either logged it or appears as a participant), ranked by play count."""
    return fetch_play_partners(sb, viewer_id).recent


def fetch_ghost_players(sb, viewer_id: str) -> list[GhostPlayer]:
    """Free-text ghost players the viewer recorded in their own plays.

    Grouped by case-sensitive display_name; carries play_count and the most
    recent played_at date so the user can recognize who they are.
    """
    return fetch_play_partners(sb, viewer_id).ghosts


def link_ghost(
    sb,
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

    target = (
        sb.table("boardgamebuddy_profiles")
        .select("id")
        .eq("id", target_user_id)
        .execute()
    )
    if not target.data:
        raise HTTPException(status_code=404, detail="Target user not found")

    own = (
        sb.table("boardgamebuddy_plays")
        .select("id")
        .eq("user_id", viewer_id)
        .execute()
    )
    play_ids = [r["id"] for r in own.data or []]
    if not play_ids:
        return 0

    # ilike with no wildcards == case-insensitive exact match.
    res = (
        sb.table("boardgamebuddy_play_players")
        .update({"player_user_id": target_user_id})
        .in_("play_id", play_ids)
        .ilike("player_display_name", display_name)
        .is_("player_user_id", "null")
        .execute()
    )
    return len(res.data or [])


def ghost_out_of_play(
    sb,
    viewer_id: str,
    play_id: str,
    fallback_display_name: str,
) -> int:
    """Convert the caller's own player row in `play_id` back into a ghost.

    The inverse of `link_ghost`: instead of stamping a `player_user_id` onto a
    free-text ghost, it nulls the caller's `player_user_id` while keeping the
    display name. Used when someone was added to a play they didn't actually
    take part in — they self-remove from the game log without deleting the play
    (the owner keeps it, seeing them as a named ghost). Returns the number of
    rows updated (0 if the caller isn't a player in this play).

    Scoped on `player_user_id = viewer_id`, so a caller can only ever affect
    their own row — the play owner is never trusted from the client.
    """
    # Step 1 — defensive backfill so nulling player_user_id can never trip the
    # bgb_play_players_identity_chk constraint (a row must keep either a
    # user_id or a display_name). Rows written by _write_play_players always
    # carry a display_name, so this normally updates nothing.
    sb.table("boardgamebuddy_play_players").update(
        {"player_display_name": fallback_display_name}
    ).eq("play_id", play_id).eq("player_user_id", viewer_id).is_(
        "player_display_name", "null"
    ).execute()

    # Step 2 — drop the account link; the row lives on as a ghost.
    res = (
        sb.table("boardgamebuddy_play_players")
        .update({"player_user_id": None})
        .eq("play_id", play_id)
        .eq("player_user_id", viewer_id)
        .execute()
    )
    return len(res.data or [])


def merge_ghosts(
    sb,
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

    own = (
        sb.table("boardgamebuddy_plays")
        .select("id")
        .eq("user_id", viewer_id)
        .execute()
    )
    play_ids = [r["id"] for r in own.data or []]
    if not play_ids:
        return 0

    res = (
        sb.table("boardgamebuddy_play_players")
        .update({"player_display_name": tgt})
        .in_("play_id", play_ids)
        .ilike("player_display_name", src)
        .is_("player_user_id", "null")
        .execute()
    )
    return len(res.data or [])
