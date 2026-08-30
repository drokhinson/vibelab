"""Per-user stats — wraps the bgb_user_stats RPC."""

from ..models import FavoriteGame, StatsResponse


def fetch_stats(sb, user_id: str) -> StatsResponse:
    """Return Strava-style aggregate stats for a single user."""
    rows = sb.rpc("bgb_user_stats", {"uid": user_id}).execute().data or []
    if not rows:
        return StatsResponse()
    r = rows[0]
    fav: FavoriteGame | None = None
    fav_id = r.get("favorite_game_id")
    fav_name = r.get("favorite_game_name")
    if fav_id and fav_name:
        fav = FavoriteGame(
            game_id=fav_id,
            name=fav_name,
            play_count=int(r.get("favorite_play_count") or 0),
        )
    return StatsResponse(
        total_plays=int(r.get("total_plays") or 0),
        unique_games=int(r.get("unique_games") or 0),
        win_count=int(r.get("win_count") or 0),
        last_played_at=r.get("last_played_at"),
        hours_played=float(r.get("hours_played") or 0.0),
        owned_games=int(r.get("owned_games") or 0),
        owned_expansions=int(r.get("owned_expansions") or 0),
        favorite_game=fav,
    )


def fetch_stats_detail(sb, user_id: str) -> dict:
    """Return the whole Stats spoke payload in one call.

    Thin by design: `bgb_user_stats_detail` composes every block server-side
    (podium, per-game breakdown, nemesis, rhythm, shelf, table size, taste,
    comeback, co-op record, personal bests) so there is nothing to reshape
    here. Every top-level key is always present; `nemesis`,
    `table_size.avg` and `rhythm.busiest_weekday` are null when there is
    nothing to compute from.
    """
    return sb.rpc("bgb_user_stats_detail", {"uid": user_id}).execute().data or {}
