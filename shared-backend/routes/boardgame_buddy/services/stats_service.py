"""Per-user stats — wraps the bgb_user_stats RPC."""

from ..models import StatsResponse


def fetch_stats(sb, user_id: str) -> StatsResponse:
    """Return Strava-style aggregate stats for a single user."""
    rows = sb.rpc("bgb_user_stats", {"uid": user_id}).execute().data or []
    if not rows:
        return StatsResponse()
    r = rows[0]
    return StatsResponse(
        total_plays=int(r.get("total_plays") or 0),
        unique_games=int(r.get("unique_games") or 0),
        win_count=int(r.get("win_count") or 0),
        last_played_at=r.get("last_played_at"),
        hours_played=float(r.get("hours_played") or 0.0),
    )
