"""Achievements — wraps the bgb_sync_achievements RPC.

Thin by design, exactly like stats_service: the RPC composes every metric,
writes the unlock rows that are newly due, and returns the screen's whole
payload, so there is nothing to reshape here.
"""

from ..models import AchievementsResponse


def fetch_achievements(sb, user_id: str) -> AchievementsResponse:
    """Recompute every badge for one user and return the whole spoke."""
    payload = sb.rpc("bgb_sync_achievements", {"uid": user_id}).execute().data or {}
    return AchievementsResponse(**payload)


def mark_installed(sb, user_id: str) -> AchievementsResponse:
    """Stamp the first time this account was seen as an installed PWA.

    Guarded on the column still being NULL so re-launching the installed app
    (which re-fires the client-side signal on every cold start) keeps the
    original date rather than sliding it forward. The follow-up sync is what
    turns the stamp into the unlocked "Pocket Buddy" badge, so the caller gets
    a payload it can paint immediately.
    """
    (
        sb.table("boardgamebuddy_profiles")
        .update({"app_installed_at": "now()"})
        .eq("id", user_id)
        .is_("app_installed_at", "null")
        .execute()
    )
    return fetch_achievements(sb, user_id)
