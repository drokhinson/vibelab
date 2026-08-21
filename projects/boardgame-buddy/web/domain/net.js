// @ts-check
// domain/net.js — Connectivity state. The single answer to "are we offline?".
//
// Offline mode exists because board games get played in basements, cabins and
// pub back rooms. The host still needs to run the Gather → Play → Settle
// cascade and record the result; the play then uploads on the next online
// session (see domain/outbox.js).
//
// Three signals feed one boolean:
//
//   1. `manual`  — the user tapped "Play offline". Sticky and persisted, so a
//                  reload mid-game doesn't silently reconnect the host into a
//                  lobby they deliberately opted out of. Only the user (or a
//                  completed save) clears it.
//   2. `navigator.onLine === false` — the browser is certain there's no link.
//                  Trustworthy when false, near-worthless when true.
//   3. Consecutive fetch failures — what actually catches the venue this
//                  feature is for. navigator.onLine reports true on a captive
//                  portal and on one bar of signal that times out rather than
//                  fails, so the app has to learn from its own requests.
//
// Deliberately NOT wired to anything that tears down user state. Per
// .claude/rules/web-frontend.md ("don't treat a transient blip as a real state
// change"), going offline must never sign the user out, abandon a lobby, or
// re-mint a session — it only gates NEW behaviour.

(function () {
  const LS_KEY = "bgb_offline_v1";

  // Two failures, not one: a single request can fail for reasons that have
  // nothing to do with the link (a cold Railway dyno, one dropped packet), and
  // flipping the whole app into offline mode on that would be worse than the
  // problem. Two in a row with no success between them is a pattern.
  const FAILURE_THRESHOLD = 2;

  class Net {
    constructor() {
      this._manual = false;
      this._failures = 0;
      // Last value published to the store, so we only notify on real edges.
      this._published = null;
      try {
        this._manual = localStorage.getItem(LS_KEY) === "1";
      } catch (_) {}
    }

    /** Wire the browser events. Called once from init.js. */
    start() {
      window.addEventListener("offline", () => {
        this._publish();
      });
      window.addEventListener("online", () => {
        // The browser says the link is back. Clear the learned failure count
        // so one stale strike can't keep the app in offline mode, then drain
        // whatever the host recorded while disconnected.
        this._failures = 0;
        this._publish();
        if (window.Outbox) window.Outbox.flush();
      });
      this._publish();
    }

    /** @returns {boolean} */
    isOffline() {
      if (this._manual) return true;
      // navigator.onLine is only believed when it says NO. A true reading
      // proves an interface is up, not that anything is reachable.
      if (navigator.onLine === false) return true;
      return this._failures >= FAILURE_THRESHOLD;
    }

    /** True when the user chose offline mode rather than the app detecting it. */
    isManual() {
      return this._manual;
    }

    /**
     * Turn user-chosen offline mode on or off. Persisted so it survives the
     * reload an OS can force on a backgrounded tab mid-game.
     * @param {boolean} on
     */
    manual(on) {
      this._manual = !!on;
      try {
        if (this._manual) localStorage.setItem(LS_KEY, "1");
        else localStorage.removeItem(LS_KEY);
      } catch (_) {}
      // Leaving manual mode is the user asserting the link is back — drop the
      // learned strikes too, or isOffline() would stay true off stale history.
      if (!this._manual) this._failures = 0;
      this._publish();
      if (!this.isOffline() && window.Outbox) window.Outbox.flush();
    }

    /** A request failed at the network layer (not an HTTP error). */
    noteFailure() {
      this._failures++;
      this._publish();
    }

    /** A request completed — the link demonstrably works. */
    noteSuccess() {
      if (this._failures === 0) return;
      this._failures = 0;
      this._publish();
    }

    // Publish to the store so views can subscribe through View.listen(), which
    // already auto-unsubscribes on unmount. Edge-triggered: store.set() bails
    // on an unchanged value anyway, but computing isOffline() once here keeps
    // the three inputs from being re-derived by every subscriber.
    _publish() {
      const next = this.isOffline();
      if (next === this._published) return;
      this._published = next;
      if (window.store) window.store.set("offline", next);
    }
  }

  window.BgbNet = new Net();
})();
