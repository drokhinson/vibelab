"""Played-with discovery + ghost-player linking.

"Played with" surfaces real-account players (boardgamebuddy_play_players rows
with player_user_id set) the viewer has shared a play with. Ghost players are
free-text nicknames the viewer logged without an account; the link endpoint
promotes them by stamping player_user_id on every matching row.
"""

from typing import Any

from fastapi import HTTPException

from ..models import GhostPlayer, PlayedWithUser
from . import buddy_service


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
        .select("id, display_name, avatar_url")
        .in_("id", list(counts.keys()))
        .execute()
    )
    profiles = {p["id"]: p for p in (profile_rows.data or [])}
    out: list[PlayedWithUser] = []
    for uid, n in counts.items():
        prof = profiles.get(uid)
        if not prof:
            continue
        rel = buddy_service.relation_to(sb, viewer_id, uid)
        out.append(PlayedWithUser(
            user_id=uid,
            display_name=prof["display_name"],
            avatar_url=prof.get("avatar_url"),
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
