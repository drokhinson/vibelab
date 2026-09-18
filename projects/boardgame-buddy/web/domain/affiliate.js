// domain/affiliate.js — retailer partner links under a game, and their admin.
//
// NOTHING RENDERS UNTIL A PARTNER IS LIVE, and that decision is the server's:
// GET /affiliate/links answers `{links: [], live: false}` until an admin has
// pasted a credential and switched a partner on (migration 045,
// Docs/AFFILIATE_LINKS.md). Every surface that paints from this module renders
// nothing from an empty list — there is no client-side default, no placeholder
// pill, no "coming soon".
//
// CACHED SHORT ON PURPOSE. Five minutes fresh, thirty stale — the shortest
// window in the app, because a toggle in Settings → Admin tools should reach
// the next game page open, not the next half hour. Every admin write below
// clears the namespace outright, so the operator's own device sees it at once.
//
// THE CLICK IS FIRE-AND-FORGET, in exactly api.trackEvent's shape: it bypasses
// api._request so a stalled ping cannot trip offline detection, it still gets
// an abort deadline, and nothing awaits it. The pill is a real <a target=
// _blank>; the navigation happens whether or not the count lands. The server
// stores partner + game + surface + time and no account identifier (privacy
// §5), which is why no auth header is sent either.

(function () {
  const NS = "affiliate.links";
  const FRESH_TTL_MS = 5 * 60 * 1000;
  const STALE_TTL_MS = 30 * 60 * 1000;
  const CLICK_TIMEOUT_MS = 15000;
  const PATH = "/api/v1/boardgame_buddy/affiliate";

  class Affiliate {
    /** Synchronous peek for a first-frame paint; null when nothing is cached. */
    static cachedLinks(gameId) {
      if (!gameId || !window.bgbCache) return null;
      return window.bgbCache.peek(NS, gameId);
    }

    /** `{game_id, links, live}` for one game. Empty until a partner is live. */
    static links(gameId) {
      if (!gameId) return Promise.resolve({ game_id: null, links: [], live: false });
      return window.bgbCache.swr(
        NS,
        gameId,
        () => window.api.get("/affiliate/links", { game_id: gameId }),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    }

    static invalidate() {
      if (window.bgbCache) window.bgbCache.clear(NS);
    }

    /**
     * Count a tap. Never awaited, never blocks the outbound navigation, sends
     * no auth header. `surface` is "game_detail" or "discover".
     */
    static click(partnerId, gameId, surface) {
      if (!partnerId || !window.api) return;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), CLICK_TIMEOUT_MS);
      const body = { partner_id: partnerId, surface: surface || "game_detail" };
      if (gameId) body.game_id = gameId;
      fetch(window.api.base + PATH + "/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      }).catch(() => {}).finally(() => clearTimeout(timer));
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    // Gated server-side by get_current_admin; ui/admin-gate.js keeps a
    // non-admin off the screen that calls these. Every write clears the
    // reader cache so the operator's next game page shows the new state.

    static adminList() {
      return window.api.get("/affiliate/admin/partners").then((res) => (res && res.items) || []);
    }

    static adminClicks(days) {
      return window.api.get("/affiliate/admin/clicks", days ? { days } : undefined);
    }

    static adminPreview(id, gameId) {
      return window.api.get(
        `/affiliate/admin/partners/${encodeURIComponent(id)}/preview`,
        gameId ? { game_id: gameId } : undefined,
      );
    }

    static adminUpdate(id, patch) {
      return window.api
        .patch(`/affiliate/admin/partners/${encodeURIComponent(id)}`, patch)
        .then((r) => { Affiliate.invalidate(); return r; });
    }

    static adminEnable(id) {
      return window.api
        .post(`/affiliate/admin/partners/${encodeURIComponent(id)}/enable`)
        .then((r) => { Affiliate.invalidate(); return r; });
    }

    static adminDisable(id) {
      return window.api
        .post(`/affiliate/admin/partners/${encodeURIComponent(id)}/disable`)
        .then((r) => { Affiliate.invalidate(); return r; });
    }
  }

  window.Affiliate = Affiliate;
})();
