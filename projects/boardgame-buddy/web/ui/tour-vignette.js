// @ts-check
// ui/tour-vignette.js — the shell every feature-tour vignette runs inside.
//
// A vignette is a miniature, animated depiction of one of the app's five
// features, drawn from the app's own tokens so it re-themes for free and
// cannot drift into a different visual language. The tour (views/tour-view.js)
// mounts one per chapter; the auth screen mounts one as its hero.
//
// Nothing about how a vignette LOOKS lives here — same split as
// ui/bottom-sheet.js and ui/modal-shell.js (.claude/rules/ui-object-design.md
// §4). The shell owns the frame, the clock and when to stop.
//
// BEATS ARE STATE, NOT KEYFRAMES
// ------------------------------
// A vignette declares an ordered list of beats, each of which puts the scene
// into a named state and is safe to apply twice. Getting to beat N is always
// "reset, then apply 0..N" — never "wait for N transitions to finish". That
// one decision buys three things at once:
//
//   • prefers-reduced-motion is free. Seek to the last beat, hold it, never
//     run the clock. A still picture of the finished state, never a blank one.
//   • Looping is free, and cannot drift. Each cycle starts from reset().
//   • seek("template-on") lands on exactly one frame, deterministically —
//     which is what a still-frame capture for a store screenshot needs, and
//     why Docs/STORE_LISTING.md can name a beat instead of a timestamp.
//
// Transitions are suppressed during a seek by a class on the root, so seeking
// paints the destination rather than animating towards it.
//
// THE CLOCK STOPS WHEN NOBODY IS WATCHING
// ---------------------------------------
// An IntersectionObserver pauses a vignette scrolled off the tour panel, and
// visibilitychange pauses every vignette on a backgrounded phone. Five looping
// scenes running behind a locked screen is exactly the kind of thing that
// turns up later as a battery complaint with no obvious cause.

(function () {
  /**
   * @typedef {Object} VignetteBeat
   * @property {string} name   stable id — Docs/STORE_LISTING.md cites these
   * @property {number} at     ms from the start of the cycle
   * @property {function(HTMLElement): void} apply  idempotent state application
   */

  /**
   * @typedef {Object} VignetteDef
   * @property {string} id
   * @property {string} label            aria-label for the frame
   * @property {string} html             the scene's markup
   * @property {VignetteBeat[]} beats
   * @property {function(HTMLElement): void} reset  back to the pre-beat state
   * @property {number} [hold]           ms to hold the last beat before looping
   */

  /** @type {Map<string, VignetteDef>} */
  const REGISTRY = new Map();

  // Must match the .vig--instant rule in styles.css, which zeroes every
  // transition and animation inside the frame.
  const INSTANT_CLASS = "vig--instant";

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) { return false; }
  }

  /**
   * Register a scene. Called by each of the widgets/tour-vignette-*.js
   * modules, all of which load lazily.
   * @param {VignetteDef} def
   */
  function register(def) {
    if (!def || !def.id) return;
    REGISTRY.set(def.id, def);
  }

  /**
   * Mount `id` into `host`. Returns null when the scene is not registered —
   * the caller (a tour panel) keeps its skeleton rather than throwing, because
   * the vignette modules load lazily and a dead connection is an ordinary
   * outcome on a phone.
   *
   * @param {HTMLElement} host
   * @param {string} id
   * @returns {?{play: function(): void, pause: function(): void,
   *            seek: function(string): void, destroy: function(): void}}
   */
  function mount(host, id) {
    const def = REGISTRY.get(id);
    if (!host || !def) return null;

    host.innerHTML = `
      <div class="vig" data-vig="${id}" role="img" aria-label="${def.label}">
        <div class="vig__screen">${def.html}</div>
      </div>
    `;
    const root = /** @type {HTMLElement} */ (host.querySelector(".vig"));
    const scene = /** @type {HTMLElement} */ (root.querySelector(".vig__screen"));
    window.BgbIcons.render(root);

    /** @type {number[]} */
    let timers = [];
    let running = false;
    let destroyed = false;
    // Two independent reasons to hold the clock. Both must be false to run, or
    // a vignette scrolled out of view on a backgrounded tab resumes on the
    // first of the two events to come back.
    let offScreen = false;
    let hidden = document.hidden;
    const still = prefersReducedMotion();

    function clearTimers() {
      timers.forEach((t) => clearTimeout(t));
      timers = [];
    }

    /**
     * Put the scene into the state at beat index `upto` (-1 = reset only).
     * `instant` suppresses transitions so the destination paints rather than
     * animating — a forced reflow between add and remove is what makes the
     * browser actually honour it instead of coalescing both into one style
     * recalculation and animating anyway.
     */
    function applyThrough(upto, instant) {
      if (instant) {
        root.classList.add(INSTANT_CLASS);
        // eslint-disable-next-line no-unused-expressions
        root.offsetHeight;
      }
      try { def.reset(scene); } catch (_) {}
      for (let i = 0; i <= upto && i < def.beats.length; i++) {
        try { def.beats[i].apply(scene); } catch (_) {}
      }
      window.BgbIcons.render(scene);
      if (instant) {
        // eslint-disable-next-line no-unused-expressions
        root.offsetHeight;
        root.classList.remove(INSTANT_CLASS);
      }
    }

    function cycle() {
      if (destroyed || !running) return;
      applyThrough(-1, true);
      def.beats.forEach((beat, i) => {
        timers.push(window.setTimeout(function () {
          if (destroyed || !running) return;
          try { beat.apply(scene); } catch (_) {}
          window.BgbIcons.render(scene);
          if (i === def.beats.length - 1) {
            timers.push(window.setTimeout(cycle, def.hold || 2200));
          }
        }, beat.at));
      });
    }

    const api = {
      play() {
        // A reduced-motion viewer gets the end state and nothing else. This is
        // checked here rather than at the call sites so no caller can forget.
        if (destroyed || still || running || offScreen || hidden) return;
        running = true;
        clearTimers();
        cycle();
      },
      pause() {
        running = false;
        clearTimers();
      },
      /**
       * Hold one named beat, transitions suppressed. Unknown names hold the
       * last beat, which is the honest answer for "show me the finished
       * scene" and is what reduced motion asks for.
       * @param {string} name
       */
      seek(name) {
        api.pause();
        let idx = def.beats.findIndex((b) => b.name === name);
        if (idx < 0) idx = def.beats.length - 1;
        applyThrough(idx, true);
      },
      destroy() {
        destroyed = true;
        api.pause();
        if (observer) observer.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        host.innerHTML = "";
      },
    };

    function onVisibility() {
      hidden = document.hidden;
      if (hidden) api.pause(); else api.play();
    }
    document.addEventListener("visibilitychange", onVisibility);

    /** @type {?IntersectionObserver} */
    let observer = null;
    if (window.IntersectionObserver) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          offScreen = !entry.isIntersecting;
          if (offScreen) api.pause(); else api.play();
        });
      }, { threshold: 0.15 });
      observer.observe(root);
    }

    if (still) api.seek(def.beats.length ? def.beats[def.beats.length - 1].name : "");
    else applyThrough(-1, true);

    return api;
  }

  window.BgbTourVignette = {
    register,
    mount,
    /** @param {string} id */
    has(id) { return REGISTRY.has(id); },
    ids() { return Array.from(REGISTRY.keys()); },
    /** Exposed for tools/check-tour.mjs. @param {string} id */
    beatsOf(id) {
      const def = REGISTRY.get(id);
      return def ? def.beats.map((b) => b.name) : [];
    },
  };
})();
