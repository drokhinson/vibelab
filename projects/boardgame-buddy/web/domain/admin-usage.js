// domain/admin-usage.js — app-wide usage figures for the admin Usage spoke.
//
// Shaped like domain/stats.js: one SWR read per endpoint, a synchronous peek so
// the screen can paint before the network resolves, and an invalidate() for
// Refresh. This file owns the payload's SHAPE CONTRACT — the endpoint returns
// the RPC's JSONB verbatim (`response_model=dict`, the same call
// GET /users/me/stats/detail makes and for the same reason), so the typedefs
// below are the only declaration of it on this side. `047_usage_stats.sql` is
// the other.

// @ts-check

/**
 * @typedef {Object} UsageWindowed
 * @property {number} all_time
 * @property {number} last_30d
 * @property {number} last_7d
 * @property {number} last_24h
 */

/**
 * @typedef {Object} UsagePayload
 * @property {string} generated_at
 * @property {{ total:number, new_24h:number, new_7d:number, new_30d:number,
 *             admins:number, bgg_linked:number, push_enabled:number,
 *             first_signup:string|null }} users
 * @property {{ dau:number, wau:number, mau:number,
 *             daily:{day:string,users:number}[],
 *             oldest_sample_at:string|null }} active
 *   Active ACCOUNTS, counted from api_logs — signed-in accounts that made a
 *   boot-critical request. `oldest_sample_at` dates the instrumentation, not
 *   the app, and the screen says so: a short log must not read as low usage.
 * @property {{ total_bytes:number,
 *             tables:{table_name:string,total_bytes:number,row_estimate:number}[] }} database
 *   `row_estimate` is pg_class.reltuples — an estimate, refreshed by ANALYZE.
 * @property {(UsageWindowed & {screen:string})[]} screens
 * @property {(UsageWindowed & {event:string})[]} events
 * @property {(UsageWindowed & {feature:string})[]} domain
 * @property {(UsageWindowed & {origin:string})[]} play_origins
 */

/**
 * @typedef {Object} BucketUsage
 * @property {boolean} configured
 * @property {number} objects
 * @property {number} bytes
 * @property {boolean} truncated  figures are a floor; render as "at least"
 * @property {string|null} error  a listing failure for THIS bucket only
 */

(function () {
  const NS = "admin.usage";
  const BUCKETS_NS = "admin.usage.buckets";
  const KEY = "all";

  // Short fresh window: the server caches the RPC for five minutes anyway, so
  // a longer one here would only stack two staleness budgets on a number an
  // operator is reading to make a decision.
  const FRESH_TTL_MS = 60 * 1000;
  const STALE_TTL_MS = 10 * 60 * 1000;

  // The bucket walk is dozens of round trips behind a six-hour server cache.
  // Matching that here keeps re-entering the screen free.
  const BUCKETS_FRESH_TTL_MS = 30 * 60 * 1000;
  const BUCKETS_STALE_TTL_MS = 12 * 60 * 60 * 1000;

  class AdminUsage {
    /**
     * @param {{refresh?: boolean}} [opts]
     * @returns {Promise<UsagePayload>}
     */
    static load(opts) {
      const refresh = !!(opts && opts.refresh);
      if (refresh) window.bgbCache.delete(NS, KEY);
      return window.bgbCache.swr(
        NS,
        KEY,
        () => window.api.get("/admin/usage", refresh ? { refresh: true } : undefined),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    }

    /**
     * @param {{refresh?: boolean}} [opts]
     * @returns {Promise<{buckets: Object<string, BucketUsage>}>}
     */
    static buckets(opts) {
      const refresh = !!(opts && opts.refresh);
      if (refresh) window.bgbCache.delete(BUCKETS_NS, KEY);
      return window.bgbCache.swr(
        BUCKETS_NS,
        KEY,
        () => window.api.get("/admin/usage/buckets", refresh ? { refresh: true } : undefined),
        { freshTtl: BUCKETS_FRESH_TTL_MS, staleTtl: BUCKETS_STALE_TTL_MS },
      );
    }

    /** Stale-tolerant synchronous read, or null. Lets the spoke paint first. */
    static cached() {
      return window.bgbCache.peek(NS, KEY);
    }

    /** Same, for the buckets block. */
    static cachedBuckets() {
      return window.bgbCache.peek(BUCKETS_NS, KEY);
    }

    static invalidate() {
      window.bgbCache.clear(NS);
      window.bgbCache.clear(BUCKETS_NS);
    }
  }

  window.AdminUsage = AdminUsage;
})();
