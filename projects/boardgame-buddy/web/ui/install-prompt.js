// ui/install-prompt.js — the "add Buddy to your home screen" modal.
//
// A centred card over the app's shared modal chrome, shown once a phone-browser
// session has settled onto the feed. It used to be a strip docked above the tab
// bar, which read as one more row of the feed and was missed accordingly — the
// whole point is that it is NOT part of the page behind it.
//
// The point isn't the home-screen icon: per STRUCTURE.md the Gather → Play →
// Settle host cascade runs with no connectivity at all off the sw.js app-shell
// cache, and installing is what makes that reachable. The browser's own
// mini-infobar is easy to miss (and suppressed outright on iOS), so we surface
// it ourselves.
//
// Two paths, because the platforms differ:
//   • Chrome / Edge / Samsung fire `beforeinstallprompt`. We preventDefault()
//     it (killing the mini-infobar), stash the event, and replay it on tap.
//   • iOS Safari has no programmatic install API at all. There the card shows
//     the "Share → Add to Home Screen" steps outright — inside a modal there is
//     room for them, and hiding them behind a fake Install button would have
//     charged a tap for instructions.
//
// Overlay contract (.claude/rules/overlays.md §7, §8): centred modal on the
// shared `.polaroid-popup__backdrop` + `.polaroid-popup__card` chrome, four
// exits (X, outside tap, Escape, device back) all meaning "not now", body
// scroll locked while up, and it waits for a clear screen rather than landing
// on top of a sheet or a wrap-up card.
//
// Asking is capped two ways: dismissal is session-scoped (sessionStorage), so
// the card comes back next browser session rather than being gone forever — but
// a running count in localStorage retires it for good after MAX_ASKS refusals.
// A modal that interrupts is worth showing a few times and not more.

// @ts-check

(function () {
  const SS_KEY = "bgb.pwa.installDismissed";
  const LS_ASKS = "bgb.pwa.installDeclines";
  const MAX_ASKS = 3;

  // Let first paint, auth and the splash→feed handoff finish before we put a
  // card over the UI. Shorter than the banner's dwell was: a modal that lands
  // while someone is already reading the feed interrupts, whereas one that
  // lands as the feed settles reads as part of opening the app.
  const SETTLE_MS = 1200;

  // How often to re-test for a clear screen, and how long to keep trying —
  // same shape as the achievement queue's wait in ui/achievement-popup.js. If a
  // sheet is open this long, the moment has passed; there is always next
  // session.
  const RETRY_MS = 800;
  const GIVE_UP_MS = 30000;

  // Must match the .is-closing animation duration in styles.css.
  const CLOSE_MS = 200;

  // Anything of this app's own already covering the screen: a wrap-up polaroid,
  // a confirm, any bottom sheet (they all ride the polaroid backdrop — see
  // ui/bottom-sheet.js), or the first-run onboarding deck, which does not.
  const BUSY_SEL = ".polaroid-popup__backdrop, .ob-deck";

  // The card lives on the feed and nowhere else — it's the app's browsing
  // surface, so a nudge there is least in the way of what someone came to do.
  // An allowlist also means splash, auth and the play-flow cascade are excluded
  // for free. The Feed tab maps to exactly one route: its nav button carries no
  // data-nav-views, unlike Play and Profile.
  const ALLOWED_ROUTES = ["feed"];

  // `beforeinstallprompt` is single-use and is NOT replayed, so it has to be
  // captured at file scope — Chrome routinely fires it before auth resolves
  // and init() runs.
  /** @type {any} */
  let _deferred = null;
  /** @type {HTMLElement|null} */
  let _el = null;
  let _inited = false;
  let _settled = false;
  let _done = false;          // installed, or dismissed for this session
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

  // sessionStorage throws outright in Safari private mode; matchMedia is
  // missing in old WebViews. Neither should take the app down.
  function _safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function _isStandalone() {
    return _safe(() => window.matchMedia("(display-mode: standalone)").matches, false)
      || window.navigator.standalone === true;
  }

  // The viewport's OWN answer (BgbLayout.auto), not the tier on screen: a
  // desktop user who pinned the phone layout in Settings is still on a desktop,
  // and must not be offered Add to Home Screen.
  function _isPhone() {
    if (window.BgbLayout) return window.BgbLayout.auto() === "phone";
    return _safe(() => window.matchMedia("(max-width: 767px)").matches, false);
  }

  function _isIOS() {
    const ua = navigator.userAgent || "";
    // iPadOS 13+ reports as a Mac; the touch-point check separates it from a
    // real desktop Safari, which can't Add to Home Screen.
    return /iphone|ipad|ipod/i.test(ua)
      || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  }

  function _dismissed() {
    return _safe(() => sessionStorage.getItem(SS_KEY) === "1", false);
  }

  /** How many times this browser has said no. Retires the card at MAX_ASKS. */
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

  function _screenBusy() {
    return !!document.querySelector(BUSY_SEL);
  }

  // Every gate that must hold before the card goes up. Deliberately does NOT
  // gate the card once it IS up: a modal that vanished because the phone was
  // rotated past the 767px breakpoint would look like a crash.
  function _shouldShow() {
    return _inited
      && _settled
      && !_done
      && !_el
      && !_isStandalone()
      && _isPhone()
      && !_dismissed()
      && _declines() < MAX_ASKS
      && _authed()
      && _routeAllows()
      && (_deferred !== null || _isIOS());
  }

  // iOS share glyph — inline because it's a one-off mark inside this
  // component, not part of the project's asset identity.
  const SHARE_SVG = `
    <svg class="bgb-install__share" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.9" stroke-linecap="round"
         stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v12" /><path d="M8 7l4-4 4 4" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>`;

  /** The Add-to-Home-Screen recipe, for the platform with no install API. */
  function _iosBody() {
    return `
      <ol class="bgb-install__steps">
        <li>
          <span class="bgb-install__step-n">1</span>
          <span>Tap ${SHARE_SVG} <b>Share</b> in Safari's toolbar</span>
        </li>
        <li>
          <span class="bgb-install__step-n">2</span>
          <span>Choose <b>Add to Home Screen</b></span>
        </li>
      </ol>
      <div class="polaroid-popup__actions bgb-install__actions bgb-install__actions--one">
        <button class="btn btn-sm btn-primary" type="button" data-act="dismiss">Got it</button>
      </div>`;
  }

  /** Chrome / Edge / Samsung: the real thing, one tap. */
  function _promptBody() {
    return `
      <div class="polaroid-popup__actions bgb-install__actions">
        <button class="btn btn-ghost btn-sm" type="button" data-act="dismiss">Not now</button>
        <button class="btn btn-sm btn-primary bgb-install__cta" type="button" data-act="install">
          <i data-icon="download" class="w-4 h-4"></i> Install
        </button>
      </div>`;
  }

  function _render() {
    const root = document.createElement("div");
    // The backdrop class is what dims, blurs and centres — and what every
    // other overlay in the app tests for when it needs a clear screen.
    root.className = "polaroid-popup__backdrop bgb-install";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "bgb-install-title");
    root.innerHTML = `
      <div class="polaroid-popup__card bgb-install__card" tabindex="-1">
        <button class="polaroid-popup__close" type="button"
                aria-label="Not now" data-act="dismiss">
          <i data-icon="x" class="w-5 h-5"></i>
        </button>
        <img class="bgb-install__logo" src="assets/brand/bgb-logo.svg"
             alt="" width="72" height="72" />
        <div class="polaroid-popup__title" id="bgb-install-title">Take Buddy with you</div>
        <p class="polaroid-popup__body bgb-install__blurb">
          Add BoardgameBuddy to your home screen. Install the PWA to access
          offline game recording!
        </p>
        ${_deferred ? _promptBody() : _iosBody()}
      </div>`;

    // Outside the card is outside, whatever it landed on (overlays.md §8a).
    root.addEventListener("click", (ev) => {
      const t = /** @type {any} */ (ev.target);
      const act = t && t.closest && t.closest("[data-act]");
      if (act) {
        if (act.dataset.act === "install") BgbInstallPrompt._install();
        else BgbInstallPrompt.dismiss();
        return;
      }
      if (!(t && t.closest && t.closest(".polaroid-popup__card"))) {
        BgbInstallPrompt.dismiss();
      }
    });

    document.body.appendChild(root);
    window.BgbIcons.render(root);

    // Escape is the keyboard's version of the same one exit. Nothing here owns
    // a query to clear first, so there is no layered refusal (overlays.md §5).
    _onKeyDown = (e) => {
      if (e.key !== "Escape" || !_el) return;
      e.preventDefault();
      BgbInstallPrompt.dismiss();
    };
    document.addEventListener("keydown", _onKeyDown, true);

    // The device back gesture closes the card, not the feed behind it
    // (overlays.md §8b) — the same exit as the X and the backdrop.
    _back = window.BgbBackGuard
      ? window.BgbBackGuard.arm({ root: root, close: () => BgbInstallPrompt.dismiss() })
      : 0;

    _prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // No row worth landing on and no text field to raise a keyboard, so the
    // card itself takes focus: a screen reader reads the dialog's label, and
    // Tab walks the card rather than the feed underneath.
    const card = /** @type {HTMLElement|null} */ (root.querySelector(".polaroid-popup__card"));
    if (card) card.focus();

    return root;
  }

  // Re-run the gates whenever a media query flips. addEventListener on a
  // MediaQueryList is unsupported on older Safari, which only has addListener.
  function _watch(query) {
    const mq = _safe(() => window.matchMedia(query), null);
    if (!mq) return;
    if (mq.addEventListener) {
      mq.addEventListener("change", _sync);
      _unsub.push(() => mq.removeEventListener("change", _sync));
    } else if (mq.addListener) {
      mq.addListener(_sync);
      _unsub.push(() => mq.removeListener(_sync));
    }
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

    // No orphan-teardown dance here, unlike the sheet shell: every close path
    // sets _done, so the card is asked for at most once per page load and a
    // second _render() can never race a close that is still animating out.
    _el = _render();
  }

  const BgbInstallPrompt = {
    /**
     * Is the app running as an installed PWA rather than in a browser tab?
     *
     * Public because push needs the same answer for a different reason: on iOS,
     * Notification.requestPermission() and pushManager both exist ONLY in an
     * installed copy, so the Settings card has to know whether to offer the
     * control or send the user here first. Exposed rather than copied so the
     * two cannot disagree about what "installed" means.
     */
    isStandalone() {
      return _isStandalone();
    },

    /**
     * Is this an iOS/iPadOS browser?
     *
     * Also public for push, and for the same reason as isStandalone: iOS is the
     * one platform where an uninstalled copy cannot subscribe at all, so the
     * two together are what the Settings card needs to decide between offering
     * the control and pointing at the install steps. The iPadOS-reports-as-a-Mac
     * detection is fiddly enough that a second copy would drift.
     */
    isIOS() {
      return _isIOS();
    },

    // Called once from init.js after the shell has booted.
    init() {
      if (_inited) return;
      _inited = true;

      if (window.store) {
        _unsub.push(window.store.subscribe("currentRoute", _sync));
        _unsub.push(window.store.subscribe("user", _sync));
      }

      // Rotating a phone into landscape crosses the 767px gate, and launching
      // an installed copy flips display-mode without a reload. Re-run the
      // gates on both rather than waiting for the next navigation.
      _watch("(max-width: " + ((window.BgbLayout ? window.BgbLayout.BREAKPOINTS.tablet : 768) - 1) + "px)");
      _watch("(display-mode: standalone)");

      setTimeout(() => { _settled = true; _sync(); }, SETTLE_MS);
    },

    async _install() {
      if (!_deferred) return;          // iOS never gets here — its card has no Install

      const evt = _deferred;
      _deferred = null;                     // the event is single-use
      try {
        evt.prompt();
        const { outcome } = await evt.userChoice;
        if (outcome === "accepted") this._teardown();
        else this.dismiss();                // declining the native sheet is a "not now"
      } catch (_) {
        this._teardown();
      }
    },

    // "Not now" — hide for the rest of this browser session, and count the
    // refusal so the card retires itself after MAX_ASKS of them.
    dismiss() {
      _safe(() => sessionStorage.setItem(SS_KEY, "1"));
      _safe(() => localStorage.setItem(LS_ASKS, String(_declines() + 1)));
      _done = true;
      this._leave();
    },

    // Installed (or accepted) — gone for good; _isStandalone() keeps it gone
    // on subsequent launches.
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

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();                     // suppress Chrome's mini-infobar
    _deferred = e;
    _sync();                                // no-op until init() + settle
  });

  window.addEventListener("appinstalled", () => BgbInstallPrompt._teardown());

  window.BgbInstallPrompt = BgbInstallPrompt;
})();
