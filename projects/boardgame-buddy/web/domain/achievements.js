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
//
// TWO device-side sets, and they answer different questions. Do not merge them:
//   • `known`  — which badges this DEVICE has ever observed as earned. Advanced
//     by every payload the app sees. A badge that is earned but not known is
//     one that landed just now, which is what fires the unlock polaroid.
//   • `seen`   — which badges the user has actually LOOKED at, written only
//     once the Achievements spoke has painted them. Drives the "New" ribbons
//     and the hub's dot.
// A user who earns a badge and never opens the spoke has it in `known` (the
// popup showed it) but not in `seen` (the ribbon is still waiting).

// @ts-check

(function () {
  const NS = "achievements";
  // Nothing here moves without a play, a buddy, a chapter or a BGG link — all
  // of which invalidate below — so the window is long and re-entering the
  // screen costs nothing.
  const FRESH_TTL_MS = 5 * 60 * 1000;
  const STALE_TTL_MS = 60 * 60 * 1000;

  const SEEN_KEY_PREFIX = "bgb.achievements.seen.";
  const KNOWN_KEY_PREFIX = "bgb.achievements.known.";
  const INSTALL_KEY_PREFIX = "bgb.achievements.installed.";

  // A play save invalidates through two paths at once (the play's own deps and
  // the buddy roster), so the check has to coalesce or it fires twice. The
  // delay also lets a burst of writes — a BGG sync, a finalize that touches
  // plays, players and expansions — settle into one request.
  const CHECK_DEBOUNCE_MS = 1500;

  // Fired on `window` with { detail: { unlocked: Achievement[] } } whenever a
  // payload reveals badges this device had not observed as earned. A DOM event
  // rather than a direct call into the UI: the domain layer should not know
  // that a polaroid exists, and it makes the behaviour testable by listening.
  const UNLOCK_EVENT = "bgb:achievements-unlocked";

  /**
   * @typedef {Object} Achievement
   * @property {string} id
   * @property {string} group_id
   * @property {string} name
   * @property {string} tagline     plain, past tense — shown once earned
   * @property {string} requirement the same fact in the imperative — shown while locked
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
  let _checkTimer = null;

  /** Earned ids this device has already observed. */
  function _known(uid) {
    const raw = _safe(() => localStorage.getItem(KNOWN_KEY_PREFIX + uid), null);
    const parsed = raw ? _safe(() => JSON.parse(raw), null) : null;
    return Array.isArray(parsed) ? parsed : null;   // null = never observed
  }

  /**
   * Fold a freshly-fetched payload into the `known` set and announce whatever
   * it revealed. Every path that fetches goes through here, so the baseline
   * advances no matter which screen did the fetching.
   *
   * The FIRST observation on a device records silently and announces nothing:
   * a returning user signing in on a new phone has earned badges already, and
   * they did not earn them just now. That is the whole reason `known` is
   * stored separately from `seen` — `seen` is empty for anyone who has never
   * opened the spoke, so diffing against it would fire the popup for every
   * badge they already hold.
   *
   * @param {AchievementsPayload|null} payload
   * @returns {any[]} the newly-earned achievements, oldest-first by catalog order
   */
  function _observe(payload) {
    const uid = _uid();
    if (!uid || !payload || !Array.isArray(payload.achievements)) return [];
    const earned = payload.achievements.filter((a) => a.earned);
    const earnedIds = earned.map((a) => a.id);
    const before = _known(uid);
    _safe(() => localStorage.setItem(KNOWN_KEY_PREFIX + uid, JSON.stringify(earnedIds)));
    if (before === null) return [];
    const had = new Set(before);
    const fresh = earned.filter((a) => !had.has(a.id));
    if (fresh.length) {
      _safe(() => window.dispatchEvent(new CustomEvent(UNLOCK_EVENT, {
        detail: { unlocked: fresh },
      })));
    }
    return fresh;
  }

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
      const payload = await window.bgbCache.swr(
        NS,
        uid,
        // _observe hangs off the FETCHER, not off the returned value: swr()
        // serves a cached payload without calling this at all, and re-observing
        // a copy the device has already folded in would announce nothing while
        // costing a localStorage round trip on every read.
        () => window.api.get("/achievements").then((p) => {
          _observe(p);
          // The nav dot has to move on a background refresh too, and a
          // background refresh never reaches the await below — the caller
          // already has the cached copy by then.
          Achievements.publishUnseen(p);
          return p;
        }),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
      // …and on the cache-served path, where the fetcher above never ran.
      Achievements.publishUnseen(payload);
      return payload;
    },

    /**
     * Ask the server whether anything just unlocked, and announce it if so.
     *
     * Scheduled by invalidate(), i.e. by the writes that can actually move a
     * badge, rather than polled. Debounced and inherently single-flight (the
     * work is one `all({force:true})`, and bgbCache.swr collapses concurrent
     * fetches for the same key). Failures are swallowed: a badge is not worth
     * an error toast, and the next screen that reads the payload finds it.
     */
    scheduleUnlockCheck() {
      if (!_uid()) return;
      clearTimeout(_checkTimer);
      _checkTimer = setTimeout(() => {
        _checkTimer = null;
        if (!_uid()) return;
        this.all({ force: true }).catch(() => {});
      }, CHECK_DEBOUNCE_MS);
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

    /** Drop the cached payload AND go look for what the write just unlocked.
     *  Called from every write that can move a badge — logging a play,
     *  accepting a buddy, keeping a chapter, linking BGG. Dropping alone would
     *  mean a badge earned mid-session stayed invisible until the user next
     *  wandered onto the Profile hub, which is exactly the moment the celebration
     *  is worth nothing. */
    invalidate() {
      const uid = _uid();
      if (!window.bgbCache) return;
      if (uid == null) window.bgbCache.clear(NS);
      else window.bgbCache.delete(NS, uid);
      this.scheduleUnlockCheck();
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
          // Seeded straight into the cache, so it never passes through all()'s
          // fetcher — observe it here or Pocket Buddy unlocks in silence.
          window.bgbCache.setWithTtls(NS, uid, payload, {
            freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS,
          });
          _observe(payload);
          Achievements.publishUnseen(payload);
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
      // The ribbons are spent, so the dot goes with them — from here rather
      // than from the spoke, because this write is what made it untrue.
      Achievements.publishUnseen(payload);
    },

    // ── The Profile tab's dot ────────────────────────────────────────────────
    // Unseen badges are the second half of the app's one notification signal
    // (the first is pending buddy requests — see domain/buddy.js). The count
    // goes into the store because the nav bar outlives every view and has no
    // payload of its own to count, while the Achievements card on the hub
    // still counts its own copy: the card knows exactly what it painted.
    //
    // Every path that can move the number publishes: a fetch, a cache-served
    // read, the install echo, and markSeen(). The seen set lives in
    // localStorage, so `unseen` can change with no payload changing at all.

    /** @returns {number} */
    unseenCount() { return window.store.get("achievementUnseenCount") || 0; },

    /** @param {AchievementsPayload|null} payload */
    publishUnseen(payload) {
      if (!payload || !Array.isArray(payload.achievements)) return;
      window.store.set("achievementUnseenCount", Achievements.unseen(payload).length);
    },

    /** Publish from whatever this device already has on disk. Called on the
     *  sign-in that lands a session, so the dot is right on the Feed at boot
     *  rather than waiting for the first screen that reads /achievements. */
    publishUnseenFromCache() {
      Achievements.publishUnseen(Achievements.cached());
    },

    /** Wipe this account's local receipts. Called on sign-out so the next
     *  account on the device does not inherit them. */
    forget(userId) {
      const uid = userId || _uid();
      if (!uid) return;
      _safe(() => localStorage.removeItem(SEEN_KEY_PREFIX + uid));
      _safe(() => localStorage.removeItem(KNOWN_KEY_PREFIX + uid));
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

    /** The event ui/achievement-popup.js listens on. */
    UNLOCK_EVENT,
  };

  window.Achievements = Achievements;
})();
