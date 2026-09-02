// @ts-check
// ui/back-guard.js — the device back gesture belongs to whatever is on top.
//
// Every overlay in this app is a body-level element painted over a screen that
// never went anywhere: the sheet shell, the polaroid modals, the play-detail
// card. The router, meanwhile, owns one history entry per screen. So with a
// picker open, the phone's back button (Android) or the edge swipe (iOS) walked
// the page BEHIND the picker to the previous screen — and left the picker
// sitting on top of it. The user's mental model is the opposite: back means
// "close this thing", the same as the X they can see.
//
// The fix is one entry per overlay. Opening arms a guard — a history entry at
// the SAME url as the screen under it, so nothing about the address bar or a
// reload changes — and the back press that pops that entry closes the overlay
// instead of reaching the router. Closing by any other means (X, backdrop,
// Escape, a pick) unwinds the entry again, so back still means "previous
// screen" the moment the overlay is gone.
//
// The entry is an optimisation, not the mechanism. A browser can refuse the
// pushState — History API throttling is the one seen in the wild — and an
// overlay is registered either way, so the press is spent on it regardless.
// What the entry buys is a still address bar: pop it and nothing moves. Without
// one the press reaches the router's entry instead, so the close is followed by
// putting the url back (restoreScreen), which also repairs the url when the
// router replaced it out from under an open overlay.
//
// Two presses, not one, when a keyboard is up: the first dismisses the
// keyboard, the second closes the overlay. That is what every native picker
// does. No overlay raises a keyboard on open any more (overlays.md §5), but the
// user still raises one by tapping the search field, and back is how they put it
// away. Android's own back-with-keyboard is swallowed by the system and never
// reaches the page, so the branch here is what makes iOS and desktop agree with
// it rather than what implements it.
//
// Wiring an overlay in is two calls — arm() when it goes into the DOM, and
// release() on EVERY exit path, next to the listener teardown it already has:
//
//   this._back = window.BgbBackGuard.arm({ root, close: () => this.close() });
//   window.BgbBackGuard.release(this._back);
//
// See .claude/rules/overlays.md §8 for the contract and the consumer list.

(function () {
  // The key our entries carry in history.state. Everything else in a state
  // object is the router's (name, params) — an armed entry keeps those too, so
  // an entry of ours that somehow gets navigated to still resolves to the right
  // screen instead of a blank match.
  const KEY = "bgbOverlay";

  let _seq = 0;

  /**
   * @typedef {Object} Layer
   * @property {number} token
   * @property {() => void} close
   * @property {Element|null} root
   * @property {boolean} owns  Did an entry of ours actually land? A browser
   *   may refuse the pushState (History API throttling is the one seen in the
   *   wild), and an overlay whose entry never landed still has to eat the
   *   press — see arm().
   */

  /** Innermost overlay last. @type {Layer[]} */
  const _layers = [];

  // Pops we asked for ourselves — unwinding our own entry on a close, or
  // collapsing a duplicate we are standing on. The popstate each produces is
  // bookkeeping, never a navigation, so swallow that many.
  let _suppress = 0;

  /** The router state for the screen the overlay opened over. */
  function routeState() {
    const st = history.state;
    if (st && st.name) return { name: st.name, params: st.params || {} };
    const route = window.store && window.store.get("currentRoute");
    if (route && route.name) return { name: route.name, params: route.params || {} };
    return {};
  }

  /** Push (or re-push) the guard entry for `token`. Same url, new entry. */
  function pushEntry(token) {
    const state = routeState();
    state[KEY] = token;
    try {
      history.pushState(state, "", window.location.href);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Step over a guard entry nobody is using any more. One exists whenever an
   * overlay closed by navigating (a pick that routes somewhere): the close
   * happened under a history entry the navigation had already pushed over, so
   * the guard could not be unwound then and is buried instead. Walking back
   * onto it must not cost the user a press.
   *
   * `swallow` says whether the pop this produces is bookkeeping too, and the
   * two callers genuinely differ. Collapsing a duplicate we are STANDING on
   * (after an unwind, or after closing a layer) swallows it: the screen below
   * is the one already rendered. ARRIVING on one from a press means the screen
   * above it is what's rendered, so the landing entry is a real destination and
   * belongs to the router — a spent guard shares its url with the screen below,
   * but not with the screen the user is coming from.
   *
   * @param {boolean} swallow
   */
  function skipSpent(swallow) {
    const st = history.state;
    const token = st && st[KEY];
    // Spent, not merely ours: an entry whose overlay is still on screen (the
    // modal under an open sheet, or a guard just re-armed from inside its own
    // close) is the next press's business, not this one's.
    if (!token || isArmed(token)) return false;
    if (swallow) _suppress++;
    try {
      history.back();
    } catch (_) {
      if (swallow) _suppress--;
      return false;
    }
    return true;
  }

  /**
   * Put the address bar back on the screen the overlay was opened over.
   *
   * Usually a no-op, and that is the point: a guard entry shares its url with
   * the screen below, so the press that pops it moves nothing. Two cases DO
   * move it, and in both the screen behind never navigated — only the url did,
   * which is worse than it sounds because a reload then resolves it. On
   * play-flow that is the sharp end: /play opens a FRESH lobby where
   * /play/{code} resumes the one the host is in the middle of.
   *
   *   1. The overlay owns no entry (arm()'s push was refused), so the press
   *      landed on whatever sat under the screen. Push the screen back on:
   *      the entry we walked onto has to stay reachable behind us.
   *   2. The router replaced the url while the overlay was open — play-flow
   *      swapping /play for /play/{code} once _ensureLobbyOpen resolves. Only
   *      the guard entry, the one being replaced, got the new url; the screen's
   *      own entry below it still carries the old one. That entry IS the
   *      screen, so fix it in place rather than pushing a second copy of it.
   *
   * The route comes from the store rather than the popped entry: the router
   * never navigated, so `currentRoute` is still the screen on display, and
   * replaceUrl() keeps it in step with the url the screen ought to have.
   *
   * @param {Layer} layer
   */
  function restoreScreen(layer) {
    // close() is allowed to re-arm rather than close (the onboarding deck
    // answers a press by walking back a slide). Its fresh entry is the current
    // one and is exactly where the user should be — anything pushed on top of
    // it would bury it. This also covers landing on the entry of an overlay
    // still open underneath, which is likewise nobody's to restore.
    const armedNow = history.state && history.state[KEY];
    if (armedNow && isArmed(armedNow)) return;

    const route = window.store && window.store.get("currentRoute");
    if (!route || !route.name) return;
    if (!window.router || !window.router.pathFor) return;
    const url = window.router.pathFor(route.name, route.params || {});
    if (!url) return;
    let want;
    try { want = new URL(url, window.location.href).href; } catch (_) { return; }

    const st = history.state;
    // Case 2 only when our entry really was the one consumed AND we landed on
    // this same screen. Anything else is case 1 — including our entry being
    // skipped rather than popped, which lands on a foreign entry that must not
    // be overwritten.
    const onScreenEntry = layer.owns && st && st.name === route.name;
    if (onScreenEntry && want === window.location.href) return;

    const state = { name: route.name, params: route.params || {} };
    try {
      if (onScreenEntry) history.replaceState(state, "", want);
      else history.pushState(state, "", want);
    } catch (_) {}
  }

  function isArmed(token) {
    for (let i = 0; i < _layers.length; i++) {
      if (_layers[i].token === token) return true;
    }
    return false;
  }

  function isTextEntry(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    if (tag !== "INPUT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ["button", "submit", "reset", "checkbox", "radio", "range", "file", "image", "color"]
      .indexOf(type) === -1;
  }

  /**
   * The keyboard half of the gesture. Returns true when this press was spent
   * closing the keyboard — the overlay stays, and its entry is put back so the
   * next press closes it.
   *
   * `.bgb-kb-open` (ui/viewport-lock.js) is the signal rather than "is a field
   * focused", on purpose: Android hides the keyboard on its own back press
   * without blurring anything, so focus alone would demand a THIRD press for a
   * keyboard that is already gone. A browser with no visualViewport never sets
   * the class and so never takes this branch — one press closes the overlay
   * there, which is right for a device with no software keyboard.
   */
  function keyboardFirst(layer) {
    if (!document.documentElement.classList.contains("bgb-kb-open")) return false;
    const el = document.activeElement;
    if (!isTextEntry(el)) return false;
    if (layer.root && !layer.root.contains(el)) return false;
    try { /** @type {any} */ (el).blur(); } catch (_) {}
    // The press we are spending on the keyboard consumed our entry, so put one
    // back for the press that closes the overlay. If that push is refused too,
    // the layer simply stops owning an entry — same fallback as arm().
    layer.owns = pushEntry(layer.token);
    return true;
  }

  /**
   * Arm a guard for an overlay that is now on screen.
   *
   * The layer is registered whether or not the entry lands. It used to be
   * registered only on a successful pushState, which made a refused push
   * (History API throttling; a browser with no History API at all) fail in the
   * worst possible way — SILENTLY, and as the pre-guard bug itself: the sheet
   * stays up and the back press walks the page behind it, host → play → feed,
   * with nothing in the console to say why. Registering regardless means the
   * press is still spent on the overlay; all that is lost is the entry that
   * would have kept the address bar still, and handlePopstate puts that back.
   *
   * @param {{close: () => void, root?: Element|null}} opts
   *   `close` runs the overlay's own dismissal — the same path its X takes.
   *   `root` is the overlay's outermost element; when given, a keyboard is only
   *   dismissed first if the focus that raised it is inside this overlay.
   * @returns {number} the token to hand back to release().
   */
  function arm(opts) {
    const token = ++_seq;
    const owns = pushEntry(token);
    _layers.push({ token, close: opts.close, root: opts.root || null, owns });
    return token;
  }

  /**
   * Release a guard whose overlay closed by some other means. Safe to call
   * twice, and safe to call from inside the close() arm() was given.
   * @param {number} token
   */
  function release(token) {
    if (!token) return;
    let found = -1;
    for (let i = 0; i < _layers.length; i++) {
      if (_layers[i].token === token) { found = i; break; }
    }
    if (found === -1) return;   // already popped — the back press did it
    const layer = _layers[found];
    _layers.splice(found, 1);
    // No entry of ours to unwind (arm()'s pushState was refused). Unwinding
    // anyway would take the press out of the router's stack and walk the user
    // off the screen they are still looking at.
    if (!layer.owns) return;

    // Deferred a task on purpose. A pick that closes the overlay and then
    // navigates (game picker → the play flow) does both synchronously, and an
    // unwind fired between them would land the router's brand-new entry on this
    // guard's url. By the next task the pushState has happened, history.state is
    // no longer ours, and the guard is left buried for skipSpent() instead.
    setTimeout(function () {
      const st = history.state;
      if (!st || st[KEY] !== token) return;
      _suppress++;
      try { history.back(); } catch (_) { _suppress--; }
    }, 0);
  }

  /**
   * The router hands every popstate here first. Returns true when the press
   * belonged to an overlay (or to our own bookkeeping) and must not navigate.
   */
  function handlePopstate() {
    if (_suppress > 0) {
      _suppress--;
      skipSpent(true);
      return true;
    }
    const layer = _layers[_layers.length - 1];
    if (layer) {
      if (keyboardFirst(layer)) return true;
      _layers.pop();
      try { layer.close(); } catch (e) { console.warn("back guard close:", e); }
      // The press closed the overlay; it must not also have moved the page.
      restoreScreen(layer);
      // Two overlays in a row (one opened as the last was closing) leave a
      // spent entry directly under this one. Collapse it now rather than
      // spending the user's next press on an entry for the screen they are
      // already looking at.
      skipSpent(true);
      return true;
    }
    return skipSpent(false);
  }

  /**
   * Carry the guard key across a replaceState the router does for its own
   * reasons (Router.replaceUrl). Without it the entry the overlay is standing
   * on loses its marking and becomes an unrecognisable dead press.
   * @param {any} state
   */
  function stamp(state) {
    const st = history.state;
    if (st && st[KEY]) state[KEY] = st[KEY];
    return state;
  }

  window.BgbBackGuard = { arm, release, handlePopstate, stamp };
})();
