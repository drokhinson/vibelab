// ui/install-prompt.js — dismissable "add Buddy to your home screen" banner.
//
// Docked just above the bottom tab bar on phone-sized viewports. The point
// isn't the home-screen icon: per STRUCTURE.md the Gather → Play → Settle host
// cascade runs with no connectivity at all off the sw.js app-shell cache, and
// installing is what makes that reachable. The browser's own mini-infobar is
// easy to miss (and suppressed outright on iOS), so we surface it ourselves.
//
// Two paths, because the platforms differ:
//   • Chrome / Edge / Samsung fire `beforeinstallprompt`. We preventDefault()
//     it (killing the mini-infobar), stash the event, and replay it on tap.
//   • iOS Safari has no programmatic install API at all. There, the CTA
//     expands an inline "Share → Add to Home Screen" hint instead.
//
// Dismissal is deliberately session-scoped (sessionStorage): it comes back on
// the next browser session rather than being gone forever.
(function () {
  const SS_KEY = "bgb.pwa.installDismissed";

  // Let first paint, auth and the splash→feed handoff finish before we slide
  // anything over the UI.
  const SETTLE_MS = 3000;

  // The banner lives on the feed and nowhere else — it's the app's browsing
  // surface, so a nudge there is least in the way of what someone came to do.
  // An allowlist also means splash, auth and the play-flow cascade (which has
  // its own bottom-docked CTAs) are excluded for free. The Feed tab maps to
  // exactly one route: its nav button carries no data-nav-views, unlike Play
  // and Profile.
  const ALLOWED_ROUTES = ["feed"];

  // `beforeinstallprompt` is single-use and is NOT replayed, so it has to be
  // captured at file scope — Chrome routinely fires it before auth resolves
  // and init() runs.
  let _deferred = null;
  let _el = null;
  let _inited = false;
  let _settled = false;
  let _done = false;          // installed, or dismissed for this session
  let _unsub = [];
  let _leaveTimer = null;

  // sessionStorage throws outright in Safari private mode; matchMedia is
  // missing in old WebViews. Neither should take the app down.
  function _safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function _isStandalone() {
    return _safe(() => window.matchMedia("(display-mode: standalone)").matches, false)
      || window.navigator.standalone === true;
  }

  function _isPhone() {
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

  function _authed() {
    return !!(window.store && window.store.get("user"));
  }

  function _routeAllows() {
    const r = window.store && window.store.get("currentRoute");
    return !!r && ALLOWED_ROUTES.includes(r.name);
  }

  // Every gate that must hold for the banner to be on screen.
  function _shouldShow() {
    return _inited
      && _settled
      && !_done
      && !_isStandalone()
      && _isPhone()
      && !_dismissed()
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

  function _render() {
    const root = document.createElement("div");
    root.className = "bgb-install";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Install BoardgameBuddy");
    root.innerHTML = `
      <div class="bgb-install__row" data-role="main">
        <img class="bgb-install__logo" src="assets/brand/bgb-logo.svg"
             alt="" width="44" height="44" />
        <div class="bgb-install__body">
          <div class="bgb-install__title">Take Buddy with you</div>
          <div class="bgb-install__sub">Works offline once installed</div>
        </div>
        <button class="bgb-install__cta" type="button" data-act="install">Install</button>
      </div>
      <div class="bgb-install__row bgb-install__row--hint hidden" data-role="hint">
        ${SHARE_SVG}
        <div class="bgb-install__body">
          <div class="bgb-install__title">Add to Home Screen</div>
          <div class="bgb-install__sub">Tap Share in Safari, then <b>Add to Home Screen</b></div>
        </div>
      </div>
      <button class="bgb-install__close" type="button"
              aria-label="Not now" data-act="dismiss">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>`;

    root.addEventListener("click", (ev) => {
      const act = ev.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "dismiss") BgbInstallPrompt.dismiss();
      else BgbInstallPrompt._install();
    });

    document.body.appendChild(root);
    if (window.lucide) window.lucide.createIcons({ root });
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

  // Show / hide against the current gate state. Cheap and idempotent — safe to
  // call from every route change and store event.
  function _sync() {
    const want = _shouldShow();
    if (want && !_el) {
      _el = _render();
      return;
    }
    if (!want && _el && !_leaveTimer) {
      _el.remove();
      _el = null;
    }
  }

  const BgbInstallPrompt = {
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
      _watch("(max-width: 767px)");
      _watch("(display-mode: standalone)");

      setTimeout(() => { _settled = true; _sync(); }, SETTLE_MS);
    },

    async _install() {
      if (_isIOS() && !_deferred) {
        // No install API on iOS — swap in the manual Add-to-Home-Screen hint.
        if (!_el) return;
        _el.querySelector('[data-role="main"]').classList.add("hidden");
        _el.querySelector('[data-role="hint"]').classList.remove("hidden");
        return;
      }
      if (!_deferred) return;

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

    // "Not now" — hide for the rest of this browser session.
    dismiss() {
      _safe(() => sessionStorage.setItem(SS_KEY, "1"));
      _done = true;
      this._leave();
    },

    // Installed (or accepted) — gone for good; _isStandalone() keeps it gone
    // on subsequent launches.
    _teardown() {
      _done = true;
      _unsub.forEach((fn) => _safe(() => fn()));
      _unsub = [];
      this._leave();
    },

    // Fade + slide out, then drop the node.
    _leave() {
      if (!_el) return;
      const el = _el;
      _el = null;
      el.classList.add("bgb-install--leaving");
      clearTimeout(_leaveTimer);
      _leaveTimer = setTimeout(() => {
        el.remove();
        _leaveTimer = null;
      }, 200);
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
