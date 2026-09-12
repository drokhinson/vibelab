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
// GETTING BACK OUT IS THE HARD HALF
// ---------------------------------
// Offline is a latch by construction: nearly every caller in the app gates on
// isOffline() (the pickers, the outbox, the join panel, the lobby poll), so
// once it reads true almost nothing issues a request — and noteSuccess(), the
// only thing that clears it, is fed by requests. A state that can only be left
// by evidence it also stops anyone from gathering will stay put forever.
//
// The browser's `online` event is not the answer on its own: it fires on a
// TRANSITION, and the failure modes that get the app here don't involve one.
// A phone that never lost its link (a stalled socket, a cold dyno, a PWA the
// OS froze mid-request) has no transition to report, so nothing fires and the
// user is left with a "No connection" banner on full bars. That was the bug:
// "stuck in offline mode when my phone is online."
//
// So three things below exist purely to make the latch let go:
//   * an epoch on every failure, so evidence from before a connectivity change
//     (or before the OS froze the page) is discarded rather than counted;
//   * a re-probe when the app becomes visible again, which is where a stale
//     offline state is most likely to be sitting and most likely to be wrong;
//   * a backing-off auto-probe while offline and on screen, so recovery never
//     depends on the user finding the "Try again" button.
//
// Deliberately NOT wired to anything that tears down user state. Per
// .claude/rules/web-frontend.md ("don't treat a transient blip as a real state
// change"), going offline must never sign the user out, abandon a lobby, or
// re-mint a session — it only gates NEW behaviour.

(function () {
  const FAILURE_THRESHOLD = 2;

  // Failures this close together are ONE piece of evidence, not two.
  //
  // "Two in a row" is about two moments, and the app does not make requests one
  // at a time: a boot fires /bootstrap, the feed page, the profile bundle,
  // stats and the collection map together, and warmRefresh() re-fires most of
  // them on every focus. One blip catching a fan-out would otherwise clear a
  // threshold meant to need a second, independent failure — the exact
  // single-blip flip the threshold exists to prevent.
  //
  // 1.5s because the fan-out members do not fail simultaneously: staggered
  // starts mean staggered deadlines, so the rejections arrive spread out.
  const FAILURE_BURST_MS = 1500;

  // The ladder the auto-probe walks while offline, in ms. Quick at first —
  // the common case is a blip that has already passed and only needs one
  // request to prove it — then backing off to a minute, which is a cheap
  // standing cost for a device that really is in a basement. Only ever runs
  // while the page is visible, so a pocketed phone probes nothing.
  const RECOVERY_DELAYS_MS = [5000, 10000, 20000, 30000, 60000];

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
      // When the last COUNTED failure landed, for the burst rule above.
      this._lastFailureAt = null;
      // Bumped by every connectivity change and every return to the
      // foreground. A failure carries the epoch its request started in; see
      // noteFailure().
      this._epoch = 0;
      // In-flight probe(), so a leaning-on-the-button user fires one check.
      this._probing = null;
      // Last value published to the store, so we only notify on real edges.
      this._published = null;
      // The auto-probe ladder: pending timer and how far up it we are.
      this._recoveryTimer = null;
      this._recoveryStep = 0;
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
        this._epoch++;
        this._lastOutcome = null;
        this._publish();
      });
      window.addEventListener("online", () => {
        // The link is back as far as the browser knows. Clear the learned
        // strikes so one stale failure can't keep the app in offline mode.
        this._epoch++;
        this._failures = 0;
        this._lastFailureAt = null;
        this._lastOutcome = null;
        this._publish();
      });

      // Coming back to the foreground is the highest-yield moment to re-check,
      // for two reasons that compound. The link genuinely may have changed
      // while the app was away with no `online` event to show for it (the OS
      // suspends a backgrounded PWA, and a suspended page hears nothing). And
      // the strikes on the books may be an artefact of the suspension itself:
      // iOS freezes the page mid-request, every in-flight fetch rejects on
      // resume, and the deadline timers that were frozen fire the moment they
      // thaw — a handful of failures, all of them about a page that wasn't
      // running rather than about the network. The epoch bump discards exactly
      // those, and the probe replaces them with a fresh answer.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") {
          this._stopRecovery();
          return;
        }
        this._epoch++;
        this._recoveryStep = 0;
        if (this.isOffline()) this.probe();
        this._syncRecovery();
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
     * The current connectivity epoch. A caller reads this BEFORE it starts a
     * request and hands it back to noteFailure() — see there for why.
     * @returns {number}
     */
    epoch() {
      return this._epoch;
    }

    /**
     * Actively test the connection. Backs the offline banner's "Try again" and
     * the automatic recovery ladder.
     *
     * Everything else here is passive — it learns from requests the app was
     * making anyway. This is the one path that asks on purpose, for the case
     * where the app is offline and nothing else is going to find out
     * otherwise: every other caller gates on isOffline(), so with the latch
     * set there are no requests left to learn from.
     *
     * The probe goes through window.api, so api._fetch does the bookkeeping:
     * a response calls noteSuccess(), a network error calls noteFailure().
     * Any status counts as reachable — a 500 still proves we got there.
     *
     * `allowWhileOffline` is not optional here. api._fetch short-circuits every
     * request while this latch is set, and a probe judged by the latch it
     * exists to clear is the deadlock the header above is about.
     *
     * @returns {Promise<boolean>} true when the connection came back
     */
    probe() {
      if (this._probing) return this._probing;
      this._probing = (async () => {
        try {
          await window.api.get(PROBE_PATH, null, { allowWhileOffline: true });
        } catch (_) {
          // Swallowed: noteFailure already recorded it, and the caller reads
          // the outcome from the return value rather than a rejection.
        }
        return !this.isOffline();
      })().finally(() => { this._probing = null; });
      return this._probing;
    }

    /**
     * A request failed at the network layer (not an HTTP error).
     *
     * @param {number} [epoch] the epoch the request STARTED in. A failure from
     *   an older epoch is dropped: the connectivity state it was evidence
     *   about has already been superseded (the browser reported a change, or
     *   the page came back from being frozen), and counting it would let a
     *   dead era's requests hold the app offline in the current one.
     */
    noteFailure(epoch) {
      if (epoch !== undefined && epoch !== this._epoch) return;
      const now = Date.now();
      const burst = this._lastFailureAt !== null
        && now - this._lastFailureAt < FAILURE_BURST_MS;
      if (!burst) {
        this._lastFailureAt = now;
        this._failures++;
      }
      this._lastOutcome = "fail";
      this._publish();
    }

    /**
     * Somebody tried to do something and api._fetch short-circuited it.
     *
     * Not evidence — no request was made — so nothing here touches the strike
     * count or _lastOutcome. It is an intent signal, and it exists because the
     * offline banner's "Try again" button was removed: a user who can see they
     * have signal has no button left to press, so their own retry tap has to
     * BE the button. Restart the ladder at its quick first rung and ask now.
     *
     * Cheap to call on every blocked request: probe() is single-flight, and
     * _armRecovery() no-ops while a timer is already pending.
     */
    noteAttemptWhileOffline() {
      // Drop the pending rung before resetting the step, or the reset is
      // undone: _armRecovery() reads _recoveryStep when it ARMS, so a timer
      // already waiting out 60s would still fire, still increment, and still
      // re-arm from where the old outage had backed off to.
      this._stopRecovery();
      this._recoveryStep = 0;
      this.probe().then(() => this._syncRecovery(), () => this._syncRecovery());
    }

    /** A request completed — the link demonstrably works. */
    noteSuccess() {
      this._lastFailureAt = null;
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
      // A fresh descent into offline starts the ladder from the bottom: the
      // blip that just happened deserves the quick first re-check, not
      // whatever delay a previous outage had backed off to.
      if (next) this._recoveryStep = 0;
      this._syncRecovery();
      // The single place connectivity is regained, whatever caused it — the
      // browser's online event, a successful probe, or an ordinary background
      // request clearing the strikes. Push whatever the host recorded while
      // disconnected. flush() is single-flight and no-ops when empty.
      if (wasOffline && !next && window.Outbox) window.Outbox.flush();
    }

    // The auto-probe runs exactly while the app is offline and on screen.
    _syncRecovery() {
      const wanted = this._published === true
        && (typeof document === "undefined" || document.visibilityState !== "hidden");
      if (wanted) this._armRecovery();
      else this._stopRecovery();
    }

    _armRecovery() {
      if (this._recoveryTimer) return;
      const i = Math.min(this._recoveryStep, RECOVERY_DELAYS_MS.length - 1);
      this._recoveryTimer = setTimeout(() => {
        this._recoveryTimer = null;
        // Re-checked rather than assumed: the delay is long enough for an
        // ordinary background request to have cleared the strikes already, or
        // for the user to have pocketed the phone.
        if (!this.isOffline() || document.visibilityState === "hidden") {
          this._syncRecovery();
          return;
        }
        this._recoveryStep++;
        this.probe().then(() => this._syncRecovery(), () => this._syncRecovery());
      }, RECOVERY_DELAYS_MS[i]);
    }

    _stopRecovery() {
      if (!this._recoveryTimer) return;
      clearTimeout(this._recoveryTimer);
      this._recoveryTimer = null;
    }
  }

  window.BgbNet = new Net();
})();
