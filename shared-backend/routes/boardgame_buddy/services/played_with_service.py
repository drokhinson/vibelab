"""Played-with discovery + ghost-player linking.

"Played with" surfaces real-account players (boardgamebuddy_play_players rows
with player_user_id set) the viewer has shared a play with. Ghost players are
free-text nicknames the viewer logged without an account; the link endpoint
promotes them by stamping player_user_id on every matching row.
"""

from typing import Any, Optional

from fastapi import HTTPException

from ..constants import BuddyEdgeStatus
from ..models import GhostPlayer, PlayedWithUser


_NO_RELATION: dict[str, Any] = {
    "is_buddy": False,
    "has_pending_request": False,
    "pending_request_direction": None,
}


def _relations_for_viewer(sb, viewer_id: str) -> dict[str, dict[str, Any]]:
    """Relationship flags for every user the viewer has an edge with, in ONE
    query. Replaces a per-co-player relation_to() N+1 that ran inside every
    /bootstrap (unbounded — one round trip per person ever played with)."""
    edges = (
        sb.table("boardgamebuddy_buddy_edges")
        .select("user_a, user_b, status, requested_by")
        .or_(f"user_a.eq.{viewer_id},user_b.eq.{viewer_id}")
        .in_("status", [BuddyEdgeStatus.ACCEPTED.value, BuddyEdgeStatus.PENDING.value])
        .execute()
    )
    relations: dict[str, dict[str, Any]] = {}
    for e in edges.data or []:
        other = e["user_b"] if e["user_a"] == viewer_id else e["user_a"]
        if e["status"] == BuddyEdgeStatus.ACCEPTED.value:
            relations[other] = {
                "is_buddy": True,
                "has_pending_request": False,
                "pending_request_direction": None,
            }
        else:  # pending
            direction: Optional[str] = (
                "outgoing" if e["requested_by"] == viewer_id else "incoming"
            )
            relations[other] = {
                "is_buddy": False,
                "has_pending_request": True,
                "pending_request_direction": direction,
            }
    return relations


def fetch_played_with(sb, viewer_id: str) -> list[PlayedWithUser]:
    """Real-account players who appear in plays the viewer is involved in
    (either logged it or appears as a participant), ranked by play count."""
    own = (
        sb.table("boardgamebuddy_plays")
        .select("id")
        .eq("user_id", viewer_id)
        .execute()
    )
    own_ids = [r["id"] for r in own.data or []]
    part = (
        sb.table("boardgamebuddy_play_players")
        .select("play_id")
        .eq("player_user_id", viewer_id)
        .execute()
    )
    part_ids = [r["play_id"] for r in part.data or []]
    play_ids = list({*own_ids, *part_ids})
    if not play_ids:
        return []

    parts = (
        sb.table("boardgamebuddy_play_players")
        .select("player_user_id")
        .in_("play_id", play_ids)
        .not_.is_("player_user_id", "null")
        .execute()
    )
    counts: dict[str, int] = {}
    for r in parts.data or []:
        uid = r.get("player_user_id")
        if uid and uid != viewer_id:
            counts[uid] = counts.get(uid, 0) + 1
    if not counts:
        return []

    profile_rows = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, avatar")
        .in_("id", list(counts.keys()))
        .execute()
    )
    profiles = {p["id"]: p for p in (profile_rows.data or [])}
    relations = _relations_for_viewer(sb, viewer_id)
    out: list[PlayedWithUser] = []
    for uid, n in counts.items():
        prof = profiles.get(uid)
        if not prof:
            continue
        rel = relations.get(uid, _NO_RELATION)
        out.append(PlayedWithUser(
            user_id=uid,
            display_name=prof["display_name"],
            avatar=prof.get("avatar"),
            play_count=n,
            is_buddy=bool(rel["is_buddy"]),
            has_pending_request=bool(rel["has_pending_request"]),
            pending_request_direction=rel["pending_request_direction"],
        ))
    out.sort(key=lambda x: (-x.play_count, x.display_name.lower()))
    return out


def fetch_ghost_players(sb, viewer_id: str) -> list[GhostPlayer]:
    """Free-text ghost players the viewer recorded in their own plays.

    Grouped by case-sensitive display_name; carries play_count and the most
    recent played_at date so the user can recognize who they are.
    """
    own = (
        sb.table("boardgamebuddy_plays")
        .select("id, played_at")
        .eq("user_id", viewer_id)
        .execute()
    )
    play_dates: dict[str, str] = {}
    for r in own.data or []:
        play_dates[r["id"]] = r.get("played_at")
    if not play_dates:
        return []

    rows = (
        sb.table("boardgamebuddy_play_players")
        .select("play_id, player_display_name")
        .in_("play_id", list(play_dates.keys()))
        .is_("player_user_id", "null")
        .execute()
    )
    grouped: dict[str, dict[str, Any]] = {}
    for r in rows.data or []:
        name = (r.get("player_display_name") or "").strip()
        if not name:
            continue
        played = play_dates.get(r["play_id"])
        agg = grouped.setdefault(name, {"count": 0, "last": None})
        agg["count"] += 1
        if played and (agg["last"] is None or played > agg["last"]):
            agg["last"] = played

    out = [
        GhostPlayer(
            display_name=name,
            play_count=v["count"],
            last_played_at=v["last"],
        )
        for name, v in grouped.items()
    ]
    out.sort(key=lambda x: (-x.play_count, x.display_name.lower()))
    return out


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
