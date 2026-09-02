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
// Two presses, not one, when a keyboard is up: the first dismisses the
// keyboard, the second closes the overlay. That is what every native picker
// does, and both of the search-shaped overlays this was reported against
// (Add buddies, the game finder) open with a field focused. Android's own
// back-with-keyboard is swallowed by the system and never reaches the page, so
// the branch here is what makes iOS and desktop agree with it rather than what
// implements it.
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
    pushEntry(layer.token);
    return true;
  }

  /**
   * Arm a guard for an overlay that is now on screen.
   * @param {{close: () => void, root?: Element|null}} opts
   *   `close` runs the overlay's own dismissal — the same path its X takes.
   *   `root` is the overlay's outermost element; when given, a keyboard is only
   *   dismissed first if the focus that raised it is inside this overlay.
   * @returns {number} the token to hand back to release(), or 0 when no guard
   *   could be armed (no History API) — release(0) is a no-op, so callers never
   *   need to branch on it.
   */
  function arm(opts) {
    const token = ++_seq;
    if (!pushEntry(token)) return 0;
    _layers.push({ token, close: opts.close, root: opts.root || null });
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
    _layers.splice(found, 1);

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
