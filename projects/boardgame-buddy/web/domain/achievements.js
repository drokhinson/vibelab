// domain/achievements.js — the Achievements spoke's data layer.
//
// ONE endpoint backs the whole feature: GET /achievements returns the catalog
// joined to the viewer's own progress (see bgb_sync_achievements, migration
// 062). That call also WRITES — it stamps the unlock date for anything newly
// earned — which is why it is not treated as a cheap re-read: the fresh window
// is generous and the writes that move a badge are what invalidate it.
//
// The "New" ribbons are deliberately NOT server state. The server knows when a
// badge was unlocked; it cannot know whether this person has laid eyes on it.
// That belongs to the device, so the seen set lives in localStorage keyed by
// user, exactly like the install prompt's dismissal.

// @ts-check

(function () {
  const NS = "achievements";
  // Nothing here moves without a play, a buddy, a chapter or a BGG link — all
  // of which invalidate below — so the window is long and re-entering the
  // screen costs nothing.
  const FRESH_TTL_MS = 5 * 60 * 1000;
  const STALE_TTL_MS = 60 * 60 * 1000;

  const SEEN_KEY_PREFIX = "bgb.achievements.seen.";
  const INSTALL_KEY_PREFIX = "bgb.achievements.installed.";

  /**
   * @typedef {Object} Achievement
   * @property {string} id
   * @property {string} group_id
   * @property {string} name
   * @property {string} tagline
   * @property {string} requirement
   * @property {string} icon         sprite slug — see spriteUrl()
   * @property {string} metric
   * @property {number} threshold
   * @property {number} progress     clamped to threshold
   * @property {boolean} earned
   * @property {?string} unlocked_at ISO timestamp, null while locked
   *
   * @typedef {Object} AchievementGroup
   * @property {string} id
   * @property {string} label
   * @property {string} blurb
   *
   * @typedef {Object} AchievementsPayload
   * @property {number} total
   * @property {number} earned_count
   * @property {Object<string, number>} metrics  raw counts, unclamped
   * @property {AchievementGroup[]} groups
   * @property {Achievement[]} achievements
   */

  // localStorage throws outright in Safari private mode.
  function _safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  // Guards reportInstalled() against overlapping calls — see there.
  let _installInFlight = false;

  function _uid() {
    const me = window.store && window.store.get("user");
    return (me && me.id) || null;
  }

  const Achievements = {
    /**
     * The whole spoke in one call.
     * @param {{force?: boolean}} [opts]
     * @returns {Promise<AchievementsPayload|null>}
     */
    async all({ force = false } = {}) {
      const uid = _uid();
      if (!uid) return null;
      if (force) window.bgbCache.delete(NS, uid);
      return window.bgbCache.swr(
        NS,
        uid,
        () => window.api.get("/achievements"),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    },

    /** Synchronous stale-tolerant read, or null. Lets the hub card and the
     *  spoke paint before the SWR round trip resolves — including after a
     *  hard reload, since bgbCache writes through to localStorage.
     *  @returns {AchievementsPayload|null} */
    cached() {
      const uid = _uid();
      if (!uid || !window.bgbCache) return null;
      return window.bgbCache.peek(NS, uid);
    },

    /** Drop the cached payload. Called from every write that can move a badge
     *  — logging a play, accepting a buddy, keeping a chapter, linking BGG. */
    invalidate() {
      const uid = _uid();
      if (!window.bgbCache) return;
      if (uid == null) window.bgbCache.clear(NS);
      else window.bgbCache.delete(NS, uid);
    },

    /**
     * Tell the backend this account is running the installed app. Fired once
     * per device per account — the local receipt is what makes it once, since
     * every cold start of an installed PWA looks identical from here.
     * Failures are swallowed: a badge is not worth an error toast, and the
     * next launch tries again because the receipt is only written on success.
     * @returns {Promise<void>}
     */
    async reportInstalled() {
      const uid = _uid();
      if (!uid) return;
      const key = INSTALL_KEY_PREFIX + uid;
      if (_safe(() => localStorage.getItem(key) === "1", false)) return;
      // The receipt is only written on success, so without this two `user`
      // events in quick succession (sign-in, then a profile edit) would each
      // fire a POST. Harmless — the endpoint is idempotent — but pointless.
      if (_installInFlight) return;
      _installInFlight = true;
      try {
        const payload = await window.api.post("/achievements/installed", {});
        _safe(() => localStorage.setItem(key, "1"));
        // The response IS the refreshed payload, so seed the cache with it
        // rather than leaving a stale copy that still shows Pocket Buddy
        // locked.
        if (payload) {
          window.bgbCache.setWithTtls(NS, uid, payload, {
            freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS,
          });
        }
      } catch (_) { /* try again next launch */
      } finally { _installInFlight = false; }
    },

    // ── "New" ribbons ────────────────────────────────────────────────────────

    /** @returns {string[]} ids this device has already shown as earned. */
    seen() {
      const uid = _uid();
      if (!uid) return [];
      const raw = _safe(() => localStorage.getItem(SEEN_KEY_PREFIX + uid), null);
      if (!raw) return [];
      const parsed = _safe(() => JSON.parse(raw), null);
      return Array.isArray(parsed) ? parsed : [];
    },

    /**
     * Earned badges this device has not shown yet.
     * @param {AchievementsPayload|null} payload
     * @returns {Achievement[]}
     */
    unseen(payload) {
      if (!payload || !Array.isArray(payload.achievements)) return [];
      const seen = new Set(this.seen());
      return payload.achievements.filter((a) => a.earned && !seen.has(a.id));
    },

    /** Mark every currently-earned badge as shown. Called by the spoke once it
     *  has painted them, never by the hub — the hub only counts them, and
     *  clearing the dot from a screen that never showed the badges would be a
     *  lie. */
    markSeen(payload) {
      const uid = _uid();
      if (!uid || !payload || !Array.isArray(payload.achievements)) return;
      const ids = payload.achievements.filter((a) => a.earned).map((a) => a.id);
      _safe(() => localStorage.setItem(SEEN_KEY_PREFIX + uid, JSON.stringify(ids)));
    },

    /** Wipe this account's local receipts. Called on sign-out so the next
     *  account on the device does not inherit them. */
    forget(userId) {
      const uid = userId || _uid();
      if (!uid) return;
      _safe(() => localStorage.removeItem(SEEN_KEY_PREFIX + uid));
      _safe(() => localStorage.removeItem(INSTALL_KEY_PREFIX + uid));
    },

    /**
     * Sprite path for a badge. Relative, per .claude/rules/assets.md — the app
     * deploys at its own root and index.html sets <base href="/">.
     * @param {string} icon
     * @returns {string}
     */
    spriteUrl(icon) {
      return `assets/sprites/achievements/bgb-ach-${icon}.svg`;
    },
  };

  window.Achievements = Achievements;
})();
