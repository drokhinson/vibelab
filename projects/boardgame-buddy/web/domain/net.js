// @ts-check
// domain/net.js — Connectivity state. The single answer to "are we offline?".
//
// WHAT THIS IS AND IS NOT
// -----------------------
// It is internal truth, not a UI mode. Nothing in the app renders "you are
// offline" from it except the two play-recording notices (the Gather invite
// card and the Play step's game-info strip), because recording a play is the
// one flow being offline actually changes: the play saves to the device, and
// with no lobby there is no code, no joiners and no live scores. Everywhere
// else an action is attempted and reports its own failure — api.js fails it
// instantly rather than after the deadline when this latch is set, and
// helpers.js#notifyRequestError turns that into a sentence.
//
// That matters because a latch can be wrong, and a wrong latch used to disable
// real controls and paint a banner over screens that were working fine.
// Consumed the way it is now, being wrong costs one toast and a probe.
//
// The concept exists at all because board games get played in basements,
// cabins and pub back rooms. The host still needs to run the Gather → Play →
// Settle cascade and record the result; the play then uploads on the next
// online session (see domain/outbox.js).
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
// Offline is a latch by construction: while it reads true api.js short-circuits
// every request, and noteSuccess() — the only thing that clears it — is fed by
// requests. A state that can only be left by evidence it also stops anyone
// from gathering will stay put forever.
//
// (The short-circuit is why. It replaced a pile of per-caller isOffline()
// gates, which had exactly the same property one layer up: the pickers, the
// join panel and the guide each declined to ask, for the same reason.)
//
// The browser's `online` event is not the answer on its own: it fires on a
// TRANSITION, and the failure modes that get the app here don't involve one.
// A phone that never lost its link (a stalled socket, a cold dyno, a PWA the
// OS froze mid-request) has no transition to report, so nothing fires and the
// user is left with a "No connection" banner on full bars. That was the bug:
// "stuck in offline mode when my phone is online."
//
// So everything below exists purely to make the latch let go:
//   * an epoch on every failure, so evidence from before a connectivity change
//     (or before the OS froze the page) is discarded rather than counted;
//   * a re-probe when the app comes back in front of the user, which is where a
//     stale offline state is most likely to be sitting and most likely to be
//     wrong — read from three events, because no one of them is reliable in an
//     installed PWA (see _onResume);
//   * a backing-off auto-probe while offline and on screen, so recovery never
//     depends on the user doing anything at all;
//   * a probe kicked by any request the short-circuit blocks, since the
//     offline banner's "Try again" button is gone and the user's own retry tap
//     is what replaces it (throttled — see ATTEMPT_PROBE_MIN_MS).
//
// AND NONE OF IT MAY DEPEND ON A REQUEST ANSWERING
// ------------------------------------------------
// The version before this one had all of the above and still stranded the app
// offline until it was force-quit, because both halves of recovery hung off one
// promise:
//
//   * probe() is single-flight, so while `_probing` is set every later probe
//     hands back that same promise instead of asking again; and
//   * the ladder was a CHAIN — each rung armed by the previous probe settling.
//
// A fetch that never settles therefore ended recovery permanently. That is the
// exact failure this app already knows it has to survive: api.js's header
// describes requests that stall instead of failing, and the deadline it puts on
// every fetch assumes the abort lands. When it doesn't — sockets the OS has
// dropped, a connection pool full of them, a page thawing out of suspension —
// the deadline never fires either. Seen in the field: the app latched offline
// with a working connection, and from that moment the server logged not one
// /health probe, while fire-and-forget analytics pings (which bypass
// api._fetch, so they never see the latch) kept arriving 200 for another
// quarter of an hour.
//
// Two rules fall out of that, and every change here is one of them:
//   * A PROBE THAT DOES NOT ANSWER STANDS ASIDE — the single-flight slot is
//     held for a bounded time, then the request is abandoned (see probe()).
//   * THE LADDER IS A HEARTBEAT, NOT A CHAIN — each rung arms the next itself,
//     so nothing it waited on can stop it (see _armRecovery).
//
// Deliberately NOT wired to anything that tears down user state. Per
// .claude/rules/web-frontend.md ("don't treat a transient blip as a real state
// change"), going offline must never sign the user out, abandon a lobby, or
// re-mint a session — and it must never disable a control or hide a screen
// either. It changes how a request fails and what a host is told before they
// start a play. Nothing else.

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

  // A blocked request asks for a probe (noteAttemptWhileOffline), and not
  // every blocked request is a user tapping something: the spectator poll, the
  // joinable-sessions poll and the BGG sync poll all tick on their own. Those
  // pollers stand themselves down while offline, but a future one that forgets
  // to must not be able to turn the ladder into a continuous probe — so the
  // attempt path never asks more often than the ladder's own first rung.
  const ATTEMPT_PROBE_MIN_MS = 5000;

  // Cheap, unauthenticated, and already required on every project by
  // .claude/rules/backend-python.md — so the probe can't fail for a reason
  // that isn't connectivity.
  const PROBE_PATH = "/health";

  // How long one probe may own the single-flight slot before it is abandoned.
  //
  // Sized off what an answering probe can honestly cost: api.js gives a JSON
  // GET 15s, and retries a stalled one once on a fresh connection, so 30s is
  // the worst case for a probe that is still going to come back. Past that it
  // is not slow, it is gone — and holding the slot for something that is gone
  // is the wedge the header above describes.
  const PROBE_DEADLINE_MS = 35000;

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
      // When the attempt path last asked, for ATTEMPT_PROBE_MIN_MS above.
      this._lastAttemptProbeAt = null;
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

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") {
          this._stopRecovery();
          return;
        }
        this._onResume();
      });

      // The same resume, by two other names, because no single event reports it
      // reliably in an installed PWA. `pageshow` is the one a page restored
      // from the back/forward cache fires — the OS parked the app, or the user
      // swiped back — and WebKit does not always pair it with a
      // visibilitychange. `focus` is the window coming back with neither, which
      // is still somebody looking at a screen that may be wrongly telling them
      // they have no connection.
      //
      // Both are safe to double up on: _onResume's probe is single-flight, and
      // it only asks at all while the latch is set.
      window.addEventListener("pageshow", () => this._onResume());
      window.addEventListener("focus", () => this._onResume());

      this._publish();
    }

    /**
     * The app is back in front of the user. Throw away evidence from before the
     * gap, and ask the network rather than waiting to be told.
     *
     * This is the highest-yield moment to re-check, for two reasons that
     * compound. The link genuinely may have changed while the app was away with
     * no `online` event to show for it (the OS suspends a backgrounded PWA, and
     * a suspended page hears nothing). And the strikes on the books may be an
     * artefact of the suspension itself: iOS freezes the page mid-request, every
     * in-flight fetch rejects on resume, and the deadline timers that were
     * frozen fire the moment they thaw — a handful of failures, all of them
     * about a page that wasn't running rather than about the network. The epoch
     * bump discards exactly those, and the probe replaces them with a fresh
     * answer.
     *
     * The epoch bump is why this is wired to a plain window `focus` too, even
     * though that fires more often than a real resume: its cost is that a
     * genuine failure in flight is forgotten and the app takes one more request
     * to notice it is offline, which is the cheap direction to be wrong in (see
     * the header — a wrong latch is the expensive one).
     */
    _onResume() {
      this._epoch++;
      this._recoveryStep = 0;
      if (this.isOffline()) this.probe();
      this._syncRecovery();
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
     * Never rejects: callers read the answer off the return value, and several
     * of them (the ladder, a resume) fire it without looking at all.
     *
     * @returns {Promise<boolean>} true when the connection came back
     */
    probe() {
      if (this._probing) return this._probing;
      // Aborting through a CALLER signal, not the deadline api.js arms itself,
      // is deliberate: api._fetch reads a caller abort as "superseded" and
      // records nothing (`err.aborted`, no noteFailure). An abandoned probe is
      // exactly that — we stopped waiting, which is not evidence about the link.
      const ctl = new AbortController();
      const asked = (async () => {
        try {
          await window.api.get(PROBE_PATH, null, {
            allowWhileOffline: true,
            signal: ctl.signal,
          });
        } catch (_) {
          // Swallowed: noteFailure already recorded it, and the caller reads
          // the outcome from the return value rather than a rejection.
        }
        return !this.isOffline();
      })();
      // THE SLOT IS HELD FOR A BOUNDED TIME AND NO LONGER.
      //
      // Single-flight is what keeps a leaning-on-the-button user to one check,
      // and it is also what turned one request that never settled into an app
      // that could not get back online: every later probe() handed back that
      // same pending promise, so no further request was ever made. api.js's own
      // deadline does not cover this, because it assumes the abort settles the
      // fetch — and the case that wedges here is the one where it doesn't.
      //
      // So past PROBE_DEADLINE_MS the in-flight request is abandoned and the
      // next probe starts clean. The abort is best-effort housekeeping; the
      // point is the slot.
      let timer = null;
      const gaveUp = new Promise((resolve) => {
        timer = setTimeout(() => {
          try { ctl.abort(); } catch (_) {}
          resolve(!this.isOffline());
        }, PROBE_DEADLINE_MS);
      });
      this._probing = Promise.race([asked, gaveUp]).finally(() => {
        clearTimeout(timer);
        this._probing = null;
      });
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
     * Safe to call on every blocked request. The throttle is what makes it so —
     * probe()'s single-flight guard alone would not, since a 2s poller would
     * still land one probe per tick once each had settled.
     */
    noteAttemptWhileOffline() {
      const now = Date.now();
      if (this._lastAttemptProbeAt !== null
          && now - this._lastAttemptProbeAt < ATTEMPT_PROBE_MIN_MS) return;
      this._lastAttemptProbeAt = now;
      // Drop the pending rung before resetting the step, or the reset is
      // undone: _armRecovery() reads _recoveryStep when it ARMS, so a timer
      // already waiting out 60s would still fire, still increment, and still
      // re-arm from where the old outage had backed off to.
      this._stopRecovery();
      this._recoveryStep = 0;
      this.probe();
      // Re-armed here rather than when the probe settles, for the reason the
      // header gives: a probe that never answers must not be able to take the
      // ladder down with it.
      this._syncRecovery();
    }

    /** A request completed — the link demonstrably works. */
    noteSuccess() {
      this._lastFailureAt = null;
      // The next outage gets its own first attempt answered immediately.
      this._lastAttemptProbeAt = null;
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
      const offline = this.isOffline();
      // Asked of isOffline(), not of the published copy, which can lag it:
      // navigator.onLine is an INPUT to the answer, and a browser that moves it
      // without firing the matching event (iOS does, across a network change)
      // moves the answer with nothing calling _publish(). Gating the ladder on
      // the stale copy meant the one state where recovery matters most — offline
      // by a flag nobody announced — was the one state with no auto-probe
      // running at all.
      //
      // Republishing lands back in here via _publish(), which then does the
      // arming; hence the return rather than a fall-through.
      if (offline !== (this._published === true)) {
        this._publish();
        return;
      }
      const wanted = offline
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
        // Fired, not awaited — and the next rung is armed right here rather than
        // when this probe settles. The ladder used to be a chain, which made it
        // exactly as durable as the flakiest thing it waited on: one probe that
        // never answered ended recovery for the life of the page, which is the
        // field bug the header describes. A heartbeat cannot be stopped that
        // way. probe() is single-flight, so a rung that lands while the previous
        // probe is still out costs nothing — and by then PROBE_DEADLINE_MS has
        // handed the slot back anyway.
        this.probe();
        this._syncRecovery();
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
