// ui/push-prompt.js — the one time the app suggests turning notifications on.
//
// Notifications are OFF by default and stay that way: `push_tier` defaults to
// 'none' and nothing is ever sent to an account that has not asked for it.
// (Migration 018 briefly defaulted it to 'all' on the argument that the column
// is intent and delivers nothing on its own; 019 put it back, because an
// account nobody asked should read as off wherever it is shown.) This file is
// the other half of an opt-in that actually works — because an opt-in nobody is
// told about is not a choice, it is a feature that quietly does not exist. So
// the app makes the offer once, plainly, and takes no for an answer.
//
// WHY A CARD OF OUR OWN RATHER THAN Notification.requestPermission() AT BOOT.
// The browser's prompt can be answered "block", and a block is permanent: no
// script can ever re-ask, and the Settings card degrades to a sentence about
// site settings for the rest of that install's life. Spending that one
// irreversible question on a person who has not yet been told what they are
// being asked for is how an app loses notifications forever on the first
// launch. So this asks first, in our own words, and only the people who say
// yes ever meet the real prompt. "Not now" costs nothing and is askable again.
//
// It also has to be a tap for a mechanical reason: browsers require a transient
// user activation for requestPermission(), and Safari refuses without one
// silently. A boot-time call would fail on exactly the platform that matters
// most here (an installed iOS PWA).
//
// THE CAP IS THE POINT, and it is lower than the install card's. This suggests
// something the person has not opted into, so MAX_ASKS is two: the one offer
// the app owes them, plus a single later reminder for the session where the
// card landed at a bad moment. The first-run deck's own notifications slide
// spends one of those, so somebody who skipped it there sees this at most once
// more, and then never again. Everything else is gating shared with
// ui/install-prompt.js: a settle delay, the feed and nowhere else, a clear
// screen to land on, and session-scoped dismissal. The two cards cannot
// collide — each treats any `.polaroid-popup__backdrop` as a busy screen, so
// whichever gets there first makes the other wait its turn.

// @ts-check

(function () {
  const SS_KEY = "bgb.push.askDismissed";
  const LS_ASKS = "bgb.push.askDeclines";
  const MAX_ASKS = 2;

  // Same dwell as the install card: long enough for the splash→feed handoff to
  // finish, so this reads as part of opening the app rather than as an
  // interruption of something already being read.
  const SETTLE_MS = 1200;

  const RETRY_MS = 800;
  const GIVE_UP_MS = 30000;

  // Must match the .is-closing animation duration in styles.css.
  const CLOSE_MS = 200;

  // Anything of this app's own already covering the screen — every sheet and
  // popup rides the polaroid backdrop; the first-run deck does not.
  const BUSY_SEL = ".polaroid-popup__backdrop, .ob-deck";

  // The feed and nowhere else, for install-prompt's reason: it is the app's
  // browsing surface, so a nudge there is least in the way of what someone
  // came to do, and splash, auth and the play cascade are excluded for free.
  const ALLOWED_ROUTES = ["feed"];

  /** @type {HTMLElement|null} */
  let _el = null;
  let _inited = false;
  let _settled = false;
  let _done = false;
  /** Last read of BgbPush.state(). null until the first read lands. */
  let _state = null;
  /** @type {Array<() => void>} */
  let _unsub = [];
  /** @type {any} */
  let _retryTimer = null;
  /** @type {any} */
  let _closeTimer = null;
  let _waitingSince = 0;
  let _back = 0;
  let _prevOverflow = "";
  /** @type {((e: KeyboardEvent) => void)|null} */
  let _onKeyDown = null;

  // Storage throws outright in Safari private mode; nothing here is worth
  // taking the app down for.
  function _safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function _dismissed() {
    return _safe(() => sessionStorage.getItem(SS_KEY) === "1", false);
  }

  function _declines() {
    return _safe(() => parseInt(localStorage.getItem(LS_ASKS) || "0", 10) || 0, 0);
  }

  function _authed() {
    return !!(window.store && window.store.get("user"));
  }

  function _routeAllows() {
    const r = window.store && window.store.get("currentRoute");
    return !!r && ALLOWED_ROUTES.includes(r.name);
  }

  /**
   * Is there anything to ask FOR?
   *
   * Every clause is a state in which the real prompt could not be raised, or
   * would be pointless:
   *   • unsupported / server has no keys — there is nothing behind the yes
   *   • not installed on iOS — requestPermission() resolves "denied" without
   *     asking there, burning the grant. ui/install-prompt.js is the card that
   *     belongs on that screen, and it has its own gates
   *   • permission already decided — "granted" needs no card (the account is
   *     either already on or one tap away in Settings), "denied" cannot be
   *     undone from script
   *
   * THERE IS DELIBERATELY NO TIER CLAUSE. `push_tier: 'none'` is the state this
   * card exists for — it is what every account starts on, and suggesting the
   * feature to someone who has it switched off is the whole job. It is also
   * why the permission clause carries the weight of not nagging: switching
   * notifications off in Settings runs an unsubscribe, which is only reachable
   * from a device that granted permission, so a deliberate "off" reads as
   * "granted" here and this card stands down without needing to know why.
   */
  function _askable() {
    const st = _state;
    return !!st
      && st.supported
      && st.configEnabled
      && st.standaloneOk
      && st.permission === "default";
  }

  function _screenBusy() {
    return !!document.querySelector(BUSY_SEL);
  }

  function _shouldShow() {
    return _inited
      && _settled
      && !_done
      && !_el
      && !_dismissed()
      && _declines() < MAX_ASKS
      && _authed()
      && _routeAllows()
      && _askable();
  }

  function _render() {
    const root = document.createElement("div");
    // The backdrop class is what dims, blurs and centres — and what every other
    // overlay in the app tests for when it needs a clear screen.
    root.className = "polaroid-popup__backdrop bgb-pushask";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "bgb-pushask-title");
    root.innerHTML = `
      <div class="polaroid-popup__card bgb-pushask__card" tabindex="-1">
        <button class="polaroid-popup__close" type="button"
                aria-label="Not now" data-act="dismiss">
          <i data-icon="x" class="w-5 h-5"></i>
        </button>
        <span class="bgb-pushask__mark"><i data-icon="bell" class="w-7 h-7"></i></span>
        <div class="polaroid-popup__title" id="bgb-pushask-title">Don't miss your table</div>
        <p class="polaroid-popup__body bgb-pushask__blurb">
          Get a nudge when a buddy adds you to a play, sends you a request or
          accepts yours. You can change how much you hear — or switch it off
          again — in Settings.
        </p>
        <div class="polaroid-popup__actions bgb-pushask__actions">
          <button class="btn btn-ghost btn-sm" type="button" data-act="dismiss">Not now</button>
          <button class="btn btn-sm btn-primary bgb-pushask__cta" type="button" data-act="allow">
            <i data-icon="bell" class="w-4 h-4"></i> Turn on
          </button>
        </div>
      </div>`;

    // Outside the card is outside, whatever it landed on (overlays.md §8a).
    root.addEventListener("click", (ev) => {
      const t = /** @type {any} */ (ev.target);
      const act = t && t.closest && t.closest("[data-act]");
      if (act) {
        if (act.dataset.act === "allow") BgbPushPrompt._allow();
        else BgbPushPrompt.decline();
        return;
      }
      if (!(t && t.closest && t.closest(".polaroid-popup__card"))) {
        BgbPushPrompt.decline();
      }
    });

    document.body.appendChild(root);
    window.BgbIcons.render(root);

    _onKeyDown = (e) => {
      if (e.key !== "Escape" || !_el) return;
      e.preventDefault();
      BgbPushPrompt.decline();
    };
    document.addEventListener("keydown", _onKeyDown, true);

    // The device back gesture closes the card, not the feed behind it
    // (overlays.md §8b) — the same exit as the X and the backdrop.
    _back = window.BgbBackGuard
      ? window.BgbBackGuard.arm({ root: root, close: () => BgbPushPrompt.decline() })
      : 0;

    _prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const card = /** @type {HTMLElement|null} */ (root.querySelector(".polaroid-popup__card"));
    if (card) card.focus();

    return root;
  }

  // Test the gates and, if they hold, wait for a clear screen. Cheap and
  // idempotent — safe to call from every route change and store event.
  function _sync() {
    clearTimeout(_retryTimer);
    _retryTimer = null;
    if (!_shouldShow()) return;

    if (_screenBusy()) {
      if (!_waitingSince) _waitingSince = Date.now();
      if (Date.now() - _waitingSince > GIVE_UP_MS) { _done = true; return; }
      _retryTimer = setTimeout(_sync, RETRY_MS);
      return;
    }

    _el = _render();
  }

  /** Re-read the three states the ask depends on, then re-run the gates. */
  function _readState() {
    if (!window.BgbPush) return;
    window.BgbPush.state().then(
      (st) => { _state = st; _sync(); },
      // A failed read is "we don't know", which is not a reason to ask: the
      // card would offer a yes that BgbPush.setTier is about to refuse.
      () => { _state = null; },
    );
  }

  const BgbPushPrompt = {
    // Called once from init.js after the shell has booted.
    init() {
      if (_inited) return;
      _inited = true;

      if (window.store) {
        _unsub.push(window.store.subscribe("currentRoute", _sync));
        // The tier arrives with the profile, which resolves after boot — and a
        // sign-out/sign-in swaps the account under a card that never showed.
        _unsub.push(window.store.subscribe("user", () => _readState()));
      }

      setTimeout(() => {
        _settled = true;
        _readState();
      }, SETTLE_MS);
    },

    /**
     * "Not now", from every exit this card has, and from the first-run deck's
     * own notifications slide — which is why it is public. Hidden for the rest
     * of this browser session, and counted so the ask retires itself after
     * MAX_ASKS refusals. It writes nothing to the account: the tier is already
     * 'none' for anybody this card was shown to, and saying "not now" to an
     * offer is not a preference worth a round trip.
     */
    decline() {
      _safe(() => sessionStorage.setItem(SS_KEY, "1"));
      _safe(() => localStorage.setItem(LS_ASKS, String(_declines() + 1)));
      _done = true;
      this._leave();
    },

    /**
     * The yes. Calls straight into setTier — NOT async up to that point and
     * awaiting nothing first, because the browser's activation is spent by the
     * time an await resolves on Safari and requestPermission() would be
     * refused (see domain/push.js).
     *
     * The card closes on the tap rather than on the outcome: the browser's own
     * prompt is already on top of it, and a card still sitting underneath the
     * answer reads as a question that was not heard. Nothing is reported back
     * — a granted permission is self-evident (the OS says so), and a refusal
     * is the browser's message to give, not ours to repeat.
     */
    _allow() {
      const tier = window.BgbPush ? window.BgbPush.tier() : "none";
      // 'all' is what the yes means for the account this card is actually for:
      // one that is off, which is every account until somebody turns it on.
      // The ladder's middle rung is a Settings decision made by someone who
      // already has notifications — so a person on 'actionable' whose device is
      // simply unsubscribed keeps their rung rather than being quietly promoted
      // to everything by a card that only offered them a device.
      const wanted = tier === "none" ? "all" : tier;
      if (window.BgbPush) window.BgbPush.setTier(wanted).catch(() => {});
      _done = true;
      this._teardown();
    },

    _teardown() {
      _done = true;
      _unsub.forEach((fn) => _safe(() => fn()));
      _unsub = [];
      clearTimeout(_retryTimer);
      _retryTimer = null;
      this._leave();
    },

    // The one close path: unwind everything the card took, then fade it out.
    _leave() {
      if (!_el) return;
      const el = _el;
      _el = null;

      if (window.BgbBackGuard) window.BgbBackGuard.release(_back);
      _back = 0;
      if (_onKeyDown) document.removeEventListener("keydown", _onKeyDown, true);
      _onKeyDown = null;
      document.body.style.overflow = _prevOverflow;
      _prevOverflow = "";

      el.classList.add("is-closing");
      clearTimeout(_closeTimer);
      _closeTimer = setTimeout(() => {
        el.remove();
        _closeTimer = null;
      }, CLOSE_MS);
    },

    _sync,
  };

  window.BgbPushPrompt = BgbPushPrompt;
})();
