// domain/stats.js — Strava-style aggregate stats for a profile.

(function () {
  class Stats {
    static for(userId) {
      const me = window.store.get("user");
      const isSelf = me && userId === me.id;
      const path = isSelf ? "/users/me/stats" : `/users/${userId}/stats`;
      return window.api.get(path);
    }

    static format(stats) {
      const hours = Number(stats.hours_played || 0);
      const hoursLabel = hours >= 10 ? Math.round(hours) : hours.toFixed(1);
      return {
        plays: stats.total_plays || 0,
        games: stats.unique_games || 0,
        wins: stats.win_count || 0,
        hours: hoursLabel,
        lastPlayed: stats.last_played_at || null,
      };
    }
  }

  window.Stats = Stats;
})();
