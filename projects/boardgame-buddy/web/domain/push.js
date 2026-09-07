// domain/push.js — Web Push, from the page's side.
//
// The device half of the notification setting (migration 017). Two independent
// pieces of state, and most of this file is keeping them straight:
//
//   * THE TIER lives on the profile and is per ACCOUNT. It answers "how much do
//     you want to hear", follows the person to a new phone, and is saved
//     through POST /profile like display name and avatar.
//   * THE SUBSCRIPTION lives in the browser and is per DEVICE. It answers "can
//     we reach this particular copy of the app", and is meaningless anywhere
//     else.
//
// Turning notifications off therefore does two things — silences the account
// and unsubscribes THIS device — while turning them on somewhere new only ever
// adds a device. That asymmetry is deliberate: a person who switched off on
// their phone has not asked to be re-prompted for permission on their laptop.
//
// A THIRD STATE NOBODY OWNS: the browser's permission grant. It is not ours to
// set (only a user gesture can move it) and, once denied, cannot be asked for
// again from script — so the UI's job is to report it accurately rather than to
// try. state() returns all three so the Settings card renders one truth.

// @ts-check

(function () {
  // Long TTL: the VAPID public key changes only on a deliberate rotation, which
  // invalidates every subscription anyway and so is followed by everyone
  // re-subscribing from scratch.
  const CONFIG_NS = "push.config";
  const CONFIG_KEY = "vapid";
  const CONFIG_TTL_MS = 24 * 60 * 60 * 1000;

  /** @typedef {"none"|"actionable"|"all"} PushTier */

  /** Base64url (what the server sends) → Uint8Array (what subscribe wants). */
  function _keyBytes(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** ArrayBuffer → base64url, for the two subscription keys we post back. */
  function _b64(buf) {
    const bytes = new Uint8Array(buf || new ArrayBuffer(0));
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const BgbPush = {
    // Account id the subscription has already been re-posted for this session,
    // so a store update that is not a sign-in (a rename, an avatar change —
    // "user" is published on all of them) doesn't re-post on every keystroke.
    _syncedFor: null,

    /**
     * Could this browser ever do push?
     *
     * A capability test, not a permission test. Safari on iOS reports both of
     * these in a TAB while refusing to subscribe there, which is what
     * installedForPush() below covers separately.
     */
    supported() {
      return (
        typeof navigator !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window
      );
    },

    /**
     * Is this copy installed enough to subscribe?
     *
     * iOS grants push ONLY to a Home Screen install — in Safari proper,
     * requestPermission() resolves "denied" without ever asking, which would
     * burn the one grant the user can never give again from script. So on iOS
     * the Settings card must send them to install first. Everywhere else a tab
     * is fine.
     *
     * Both primitives come from ui/install-prompt.js rather than being
     * re-derived here — its iPadOS-reports-as-a-Mac detection is fiddly enough
     * that a second copy would drift, and the two must agree about what
     * "installed" means.
     */
    installedForPush() {
      const ip = window.BgbInstallPrompt;
      if (!ip || !ip.isIOS) return true;
      return !ip.isIOS() || ip.isStandalone();
    },

    /** "default" | "granted" | "denied" — or "unsupported". */
    permission() {
      if (!this.supported()) return "unsupported";
      try { return Notification.permission; } catch (_) { return "unsupported"; }
    },

    /** The account's tier. Absent on a profile cached before 018 — read as off. */
    tier() {
      const me = window.store && window.store.get("user");
      return (me && me.push_tier) || "none";
    },

    /**
     * Whether the SERVER can send push at all, and the key to subscribe with.
     *
     * Cached rather than re-fetched: with no VAPID keys configured this is a
     * permanent "no", and the Settings card asks on every open.
     */
    async config() {
      try {
        return await window.bgbCache.swr(CONFIG_NS, CONFIG_KEY,
          () => window.api.get("/push/config"),
          { freshTtl: CONFIG_TTL_MS, staleTtl: CONFIG_TTL_MS });
      } catch (_) {
        // A failed config read is not "push is off" — it is "we don't know".
        // Reported as disabled so the card degrades to an explanation rather
        // than to a control that would fail on tap.
        return { enabled: false, vapid_public_key: null };
      }
    },

    /**
     * Everything the Settings card renders from, in one object.
     *
     * One call rather than five getters because the card has to reason about
     * the combination — "supported but not installed" and "installed but
     * denied" are different sentences, and computing them from separately
     * fetched pieces invites a render where two of them disagree.
     */
    async state() {
      const supported = this.supported();
      const cfg = supported ? await this.config() : { enabled: false };
      return {
        supported,
        standaloneOk: this.installedForPush(),
        permission: this.permission(),
        tier: /** @type {PushTier} */ (this.tier()),
        subscribed: supported ? !!(await this._subscription()) : false,
        configEnabled: !!cfg.enabled,
      };
    },

    /** This device's current subscription, or null. Never throws. */
    async _subscription() {
      try {
        const reg = await navigator.serviceWorker.ready;
        return await reg.pushManager.getSubscription();
      } catch (_) {
        return null;
      }
    },

    /**
     * Set the account's tier, subscribing or unsubscribing this device to match.
     *
     * ORDER MATTERS BOTH WAYS, and it is not the same order.
     *
     * Turning ON, the subscription is registered BEFORE the tier is saved: if
     * the permission prompt is dismissed or the subscribe fails, the account is
     * left exactly as it was rather than claiming to be on with nowhere to
     * send. Turning OFF, the tier is saved LAST for the mirror-image reason —
     * an unsubscribe that fails must not leave the account still notifying a
     * device the user just switched off.
     *
     * Throws on failure so the caller can say why. Every other function here
     * swallows; this one is the user's own gesture and silence would read as a
     * control that does nothing.
     *
     * @param {PushTier} tier
     */
    async setTier(tier) {
      if (tier !== "none") {
        await this._subscribe();
      } else {
        await this._unsubscribe();
      }
      const updated = await window.api.post("/profile", { push_tier: tier });
      const me = window.store.get("user");
      window.store.set("user", new window.User({ ...(me || {}), ...updated }));
      return tier;
    },

    async _subscribe() {
      if (!this.supported()) throw new Error("This browser can't do notifications.");
      if (!this.installedForPush()) {
        throw new Error("Add BoardgameBuddy to your Home Screen first.");
      }
      const cfg = await this.config();
      if (!cfg.enabled || !cfg.vapid_public_key) {
        throw new Error("Notifications aren't switched on for this server yet.");
      }
      // MUST be called from the user's tap. Browsers reject a permission
      // request without a transient activation, and Safari does so silently —
      // hence setTier being wired straight to the segment's onclick rather than
      // to anything that awaits first.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error(
          permission === "denied"
            ? "Notifications are blocked for this site in your browser settings."
            : "Notifications weren't allowed."
        );
      }
      const reg = await navigator.serviceWorker.ready;
      // Reuse an existing subscription rather than re-subscribing: a second
      // subscribe with the same key returns the same endpoint anyway, and with
      // a DIFFERENT key it throws rather than replacing — which is what a
      // rotated server key looks like from here.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          // Required, and honest: every push this app sends shows a
          // notification. A worker that receives a push and shows nothing
          // spends the origin's budget and eventually loses the subscription.
          userVisibleOnly: true,
          applicationServerKey: _keyBytes(cfg.vapid_public_key),
        });
      }
      await this._register(sub);
      return sub;
    },

    async _unsubscribe() {
      const sub = await this._subscription();
      if (!sub) return;
      // Tell the server BEFORE dropping it locally: once unsubscribe() has run
      // the endpoint is gone from this side and the row would be unreachable,
      // left to be pruned only when a future send 410s against it.
      try {
        await window.api.del("/push/subscriptions", { endpoint: sub.endpoint });
      } catch (_) {}
      try { await sub.unsubscribe(); } catch (_) {}
    },

    /** POST one subscription to the backend, in the shape the API expects. */
    async _register(sub) {
      const json = sub.toJSON ? sub.toJSON() : { keys: {} };
      const keys = json.keys || {};
      await window.api.post("/push/subscriptions", {
        endpoint: sub.endpoint,
        p256dh: keys.p256dh || _b64(sub.getKey && sub.getKey("p256dh")),
        auth: keys.auth || _b64(sub.getKey && sub.getKey("auth")),
        // Only so a person could tell their own devices apart if a management
        // screen is ever built. Nothing reads it today.
        user_agent: (navigator.userAgent || "").slice(0, 512),
      });
    },

    /**
     * Re-post this device's subscription once the account is known.
     *
     * THIS IS THE AUTHORITATIVE HALF OF THE ROTATION FIX. A browser can rotate
     * an endpoint whenever it likes; sw.js's pushsubscriptionchange handler
     * re-subscribes at the OS level but cannot tell the API, because it has no
     * bearer token — the Supabase session lives in the page's localStorage.
     * So the page re-posts whatever the device currently holds, and the upsert
     * on `endpoint` makes that free when nothing has changed. A rotation costs
     * at most the notifications sent before the app is next opened.
     *
     * WAITS FOR THE USER RATHER THAN READING IT. init.js calls this while the
     * shell is coming up, and initSupabase() resolves auth asynchronously
     * afterwards — so at call time the store almost always holds no user, the
     * tier reads as "none", and a straight read would skip the sync on exactly
     * the cold launch it exists for. Subscribing instead means it runs on the
     * first account that appears, and again after a logout→login.
     *
     * Nothing happens for an account that is off, so this is not a way to
     * quietly re-subscribe somebody who opted out.
     */
    syncOnBoot() {
      if (!this.supported()) return;
      const run = (me) => {
        if (!me || !me.id || me.id === this._syncedFor) return;
        this._syncedFor = me.id;
        this._syncNow();
      };
      run(window.store && window.store.get("user"));
      if (window.store) window.store.subscribe("user", run);
    },

    async _syncNow() {
      try {
        if (this.tier() === "none" || this.permission() !== "granted") return;
        const sub = await this._subscription();
        if (sub) await this._register(sub);
      } catch (_) {}
    },

    /** Send a test notification to this account's devices. */
    test() {
      return window.api.post("/push/test", {});
    },

    /**
     * Route a tap on a notification, without reloading the app.
     *
     * sw.js posts here rather than calling client.navigate() because this is a
     * History-API SPA: a real navigation would throw away the booted app — its
     * cache, its session, its Realtime subscription — and pay the whole
     * splash-and-bootstrap cost to reach somewhere the router can get to in a
     * frame.
     */
    _onMessage(ev) {
      const msg = ev && ev.data;
      if (!msg || msg.type !== "bgb:push-nav" || !msg.url) return;
      try {
        const url = new URL(msg.url, window.location.origin);
        const route = window.router.matchPath(url.pathname, url.search);
        if (route) window.router.go(route.name, route.params);
      } catch (_) {}
    },

    /** Called once from init.js, after the service worker is registered. */
    listen() {
      if (!("serviceWorker" in navigator)) return;
      navigator.serviceWorker.addEventListener("message", (ev) => this._onMessage(ev));
    },
  };

  window.BgbPush = BgbPush;
})();
