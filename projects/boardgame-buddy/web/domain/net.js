// @ts-check
// domain/net.js — Connectivity state. The single answer to "are we offline?".
//
// Offline mode exists because board games get played in basements, cabins and
// pub back rooms. The host still needs to run the Gather → Play → Settle
// cascade and record the result; the play then uploads on the next online
// session (see domain/outbox.js).
//
// Entirely automatic — there is no "play offline" switch. Two signals decide:
//
//   1. `navigator.onLine === false` — the browser is certain there's no link.
//      Trustworthy when false, near-worthless when true.
//   2. Consecutive fetch failures — what actually catches a connection that
//      resolves and then times out. Two in a row, not one: a single request
//      can fail for reasons that have nothing to do with the link (a cold
//      dyno, one dropped packet), and flipping the whole app to offline on
//      that would be worse than the problem.
//
// A completed response outranks both: see isOffline().
//
// Deliberately NOT wired to anything that tears down user state. Per
// .claude/rules/web-frontend.md ("don't treat a transient blip as a real state
// change"), going offline must never sign the user out, abandon a lobby, or
// re-mint a session — it only gates NEW behaviour.

(function () {
  const FAILURE_THRESHOLD = 2;

  // Cheap, unauthenticated, and already required on every project by
  // .claude/rules/backend-python.md — so the probe can't fail for a reason
  // that isn't connectivity.
  const PROBE_PATH = "/health";

  class Net {
    constructor() {
      this._failures = 0;
      // "ok" once a request has demonstrably completed, "fail" after a network
      // error, null when we have no evidence either way. See isOffline().
      this._lastOutcome = null;
      // In-flight probe(), so a leaning-on-the-button user fires one check.
      this._probing = null;
      // Last value published to the store, so we only notify on real edges.
      this._published = null;
    }

    /** Wire the browser events. Called once from init.js. */
    start() {
      // Drop the sticky flag the short-lived "Play offline" card used to set.
      // Nothing reads it any more, and a device still carrying it would look
      // like it had unexplained offline state to anyone inspecting storage.
      try { localStorage.removeItem("bgb_offline_v1"); } catch (_) {}

      window.addEventListener("offline", () => {
        // The OS says the interface is down. That outranks our own evidence,
        // which is now stale by definition.
        this._lastOutcome = null;
        this._publish();
      });
      window.addEventListener("online", () => {
        // The link is back as far as the browser knows. Clear the learned
        // strikes so one stale failure can't keep the app in offline mode.
        this._failures = 0;
        this._lastOutcome = null;
        this._publish();
      });
      this._publish();
    }

    /** @returns {boolean} */
    isOffline() {
      // A completed HTTP response is direct proof of reachability, so it beats
      // navigator.onLine — which can sit stale-false after a network change and
      // would otherwise strand the app in offline mode with no way out, since
      // every probe would be judged by the very flag it is trying to correct.
      if (this._lastOutcome === "ok") return false;
      if (navigator.onLine === false) return true;
      return this._failures >= FAILURE_THRESHOLD;
    }

    /** True while a user-triggered connectivity check is in flight. */
    isProbing() {
      return !!this._probing;
    }

    /**
     * Actively test the connection. Backs the offline banner's "Try again".
     *
     * Everything else here is passive — it learns from requests the app was
     * making anyway. This is the one path that asks on purpose, for the case
     * where the user can see they have signal and the app hasn't noticed yet
     * (walked out of the dead zone, joined the wifi, turned off airplane mode).
     *
     * The probe goes through window.api, so api._fetch does the bookkeeping:
     * a response calls noteSuccess(), a network error calls noteFailure().
     * Any status counts as reachable — a 500 still proves we got there.
     *
     * @returns {Promise<boolean>} true when the connection came back
     */
    probe() {
      if (this._probing) return this._probing;
      this._probing = (async () => {
        try {
          await window.api.get(PROBE_PATH);
        } catch (_) {
          // Swallowed: noteFailure already recorded it, and the caller reads
          // the outcome from the return value rather than a rejection.
        }
        return !this.isOffline();
      })().finally(() => { this._probing = null; });
      return this._probing;
    }

    /** A request failed at the network layer (not an HTTP error). */
    noteFailure() {
      this._failures++;
      this._lastOutcome = "fail";
      this._publish();
    }

    /** A request completed — the link demonstrably works. */
    noteSuccess() {
      if (this._failures === 0 && this._lastOutcome === "ok") return;
      this._failures = 0;
      this._lastOutcome = "ok";
      this._publish();
    }

    // Publish to the store so views can subscribe through View.listen(), which
    // already auto-unsubscribes on unmount. Edge-triggered: store.set() bails
    // on an unchanged value anyway, but computing isOffline() once here keeps
    // the inputs from being re-derived by every subscriber.
    _publish() {
      const next = this.isOffline();
      if (next === this._published) return;
      const wasOffline = this._published === true;
      this._published = next;
      if (window.store) window.store.set("offline", next);
      // The single place connectivity is regained, whatever caused it — the
      // browser's online event, a successful probe, or an ordinary background
      // request clearing the strikes. Push whatever the host recorded while
      // disconnected. flush() is single-flight and no-ops when empty.
      if (wasOffline && !next && window.Outbox) window.Outbox.flush();
    }
  }

  window.BgbNet = new Net();
})();
