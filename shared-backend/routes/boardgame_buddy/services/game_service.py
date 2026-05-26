"""Game catalog reads that are shared across routes.

Currently just the recently-played list — the host flow's game picker seeds
its dropdown from this, and `/bootstrap` preloads it on login so the picker
opens with data on first paint.
"""

from supabase import Client

from ..models import GameSummary


def recently_played(sb: Client, viewer_id: str, limit: int = 6) -> list[GameSummary]:
    """Distinct games the viewer has plays for, sorted by latest played_at DESC.

    Caps the play scan at the 200 most recent rows — enough to surface all
    distinct games for any realistic user without paying for a full scan.
    """
    plays = (
        sb.table("boardgamebuddy_plays")
        .select("game_id, played_at")
        .eq("user_id", viewer_id)
        .order("played_at", desc=True)
        .limit(200)
        .execute()
        .data
        or []
    )
    seen: set[str] = set()
    ordered_ids: list[str] = []
    for p in plays:
        gid = p["game_id"]
        if gid in seen:
            continue
        seen.add(gid)
        ordered_ids.append(gid)
        if len(ordered_ids) >= limit:
            break
    if not ordered_ids:
        return []
    rows = (
        sb.table("boardgamebuddy_games")
        .select(
            "id, bgg_id, name, year_published, min_players, max_players, "
            "playing_time, thumbnail_url, image_url, theme_color, "
            "is_expansion, base_game_bgg_id, expansion_color, rulebook_url, "
            "play_mode"
        )
        .in_("id", ordered_ids)
        .execute()
        .data
        or []
    )
    by_id = {r["id"]: r for r in rows}
    return [GameSummary(**by_id[gid]) for gid in ordered_ids if gid in by_id]
