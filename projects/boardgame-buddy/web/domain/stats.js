// domain/stats.js — Strava-style aggregate stats for a profile.

(function () {
  const NS = "stats";
  const FRESH_TTL_MS = 60 * 1000;
  const STALE_TTL_MS = 10 * 60 * 1000;

  class Stats {
    static for(userId) {
      const me = window.store.get("user");
      const isSelf = me && userId === me.id;
      const path = isSelf ? "/users/me/stats" : `/users/${userId}/stats`;
      return window.bgbCache.swr(
        NS,
        userId,
        () => window.api.get(path),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    }

    // Drop the cached stats for one user (or all when omitted). Called from
    // Play.log() so the viewer's own counts repaint after logging a play.
    static invalidate(userId) {
      if (userId == null) window.bgbCache.clear(NS);
      else window.bgbCache.delete(NS, userId);
    }

    static format(stats) {
      const hours = Number(stats.hours_played || 0);
      const hoursLabel = hours >= 10 ? Math.round(hours) : hours.toFixed(1);
      const fav = stats.favorite_game || null;
      return {
        plays: stats.total_plays || 0,
        games: stats.unique_games || 0,
        wins: stats.win_count || 0,
        hours: hoursLabel,
        owned: stats.owned_games || 0,
        ownedExpansions: stats.owned_expansions || 0,
        favorite: fav ? {
          id: fav.game_id,
          name: fav.name,
          playCount: fav.play_count || 0,
        } : null,
        lastPlayed: stats.last_played_at || null,
      };
    }
  }

  window.Stats = Stats;
})();
