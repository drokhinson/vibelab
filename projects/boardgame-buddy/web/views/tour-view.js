// views/tour-view.js — the feature tour, as a screen.
//
// Five chapters and a closer, one horizontal track. Content lives in
// widgets/tour-chapters.js; the animated scenes are registered by the two
// vignette modules and driven by ui/tour-vignette.js. This file is the deck.
//
// WHY A ROUTE AND NOT AN OVERLAY
// ------------------------------
// It looks like widgets/onboarding-deck.js and deliberately is not one:
//
//   • It is a DESTINATION, reachable from the sign-in screen and from
//     Settings, rather than a mode thrown over the screen you were on.
//   • /tour is a shareable, link-previewable URL, which is half the point of
//     building a marketing surface at all.
//   • .claude/rules/overlays.md §8b: only arm a back guard on something with
//     no history entry of its own. A routed screen already has one, and arming
//     over it is the double-entry bug the chapter wizard shipped. So this deck
//     arms NOTHING, and back leaves the tour because the router says so.
//
// The ~15 lines of track geometry below are the same shape as the onboarding
// deck's, on purpose rather than as an extraction waiting to happen: what
// ui-object-design.md §4 says to share is the LIFECYCLE (scroll lock, back
// guard, close animation, orphan teardown), and an overlay and a routed screen
// have different ones by construction. Pulling the geometry out alone would
// mean rewiring first-run setup to share a transform.
//
// Moving between chapters REPLACES the history entry rather than pushing one:
// a push per chapter would make leaving a six-press job, while a replace keeps
// /tour?c=scoring deep-linkable and lets one back press out.

(function () {
  const CHAPTERS = () => window.TourChapters.all();
  // The vignette scenes are not on the boot path — see index.html, where they
  // are rel=prefetch rather than <script src>. Loading them here means the
  // sign-in screen pays nothing for a tour nobody opened.
  const SCENE_SRCS = [
    "ui/tour-vignette.js",
    "widgets/tour-vignette-ambient.js",
    "widgets/tour-vignette-scripted.js",
    "widgets/tour-vignette-stats.js",
  ];
  // Horizontal travel, in px, past which a drag is a chapter change.
  const SWIPE_PX = 40;
  // How long a beat-gated bullet list waits for its scene's first beat before
  // giving up and showing everything (see _armPointsWatchdog). Comfortably
  // past the first beat of every scene — the earliest is at 600ms — and short
  // enough that a reader who lands on a dead panel is not left reading
  // headings.
  const POINTS_WATCHDOG_MS = 6000;

  class TourView extends window.View {
    constructor() {
      super("tour");
      this._reset();
    }

    _reset() {
      this._step = 0;
      /** @type {Object<string, {play:Function,pause:Function,seek:Function,destroy:Function}>} */
      this._scenes = {};
      this._scenesLoaded = false;
      this._dragX = null;
      clearTimeout(this._pointsTimer);
      this._pointsTimer = 0;
      // Cleared here so the next mount re-binds — see _bindOnce().
      this._bound = false;
    }

    get _signedIn() { return !!window.store.get("user"); }
    /** Where the × lands on a cold deep link, with no history to go back to. */
    get _exitRoute() { return this._signedIn ? "settings" : "auth"; }

    // renderLoading paints the whole deck synchronously — the chapter text is
    // already in the bundle, so there is nothing to wait for and no skeleton
    // to show. Only the vignettes arrive late, and each panel holds a frame
    // for its own until then.
    renderLoading() {
      this._step = window.TourChapters.indexOf((this.params || {}).c);
      this.render();
    }

    async onMount() {
      window.api.trackEvent("tour_open", {
        chapter: CHAPTERS()[this._step] ? CHAPTERS()[this._step].slug : null,
        signed_in: this._signedIn,
      });
      await this._loadScenes();
    }

    async onParamsChange(params) {
      this._go(window.TourChapters.indexOf((params || {}).c), { silent: true });
    }

    async onUnmount() {
      this._destroyScenes();
      this._reset();
    }

    /**
     * Stop and unwire every mounted scene.
     *
     * Not just a matter of dropping references: each controller owns interval
     * timers, an IntersectionObserver and a visibilitychange listener, so a
     * forgotten one keeps animating a node that left the document.
     *
     * This has to run before every repaint, because the View lifecycle paints
     * TWICE on a cold mount — renderLoading() puts the deck up synchronously,
     * then mount() calls render() again once onMount() resolves. The second
     * paint replaces the container's innerHTML and detaches whatever the
     * lazily-loaded scenes had just been mounted into. Without this, every
     * chapter showed its loading frame forever: _mountScenes skips a slug it
     * has already seen, so nothing re-mounted and nothing reported an error.
     */
    _destroyScenes() {
      Object.values(this._scenes).forEach((s) => { try { s.destroy(); } catch (_) {} });
      this._scenes = {};
    }

    async _loadScenes() {
      try {
        // Sequential rather than parallel: the two scene modules both call
        // BgbTourVignette.register, so the shell has to exist first.
        await window.BgbLazyScript.load(SCENE_SRCS[0]);
        await Promise.all(SCENE_SRCS.slice(1).map((s) => window.BgbLazyScript.load(s)));
      } catch (_) {
        // A dead connection leaves every panel on its still frame, which still
        // reads correctly — the chapter's words are the claim, the vignette is
        // the evidence. Nothing here is worth an error branch the user has to
        // dismiss on a marketing screen.
        return;
      }
      if (!this._mounted) return;
      this._scenesLoaded = true;
      this._mountScenes();
    }

    _mountScenes() {
      const root = this.container;
      if (!root || !window.BgbTourVignette) return;
      CHAPTERS().forEach((ch) => {
        if (this._scenes[ch.slug]) return;
        const host = root.querySelector(`[data-scene="${ch.slug}"]`);
        if (!host) return;
        const list = root.querySelector(`[data-points="${ch.slug}"]`);
        const gated = !!(list && list.querySelector("li[data-beat]"));
        const beats = window.BgbTourVignette.beatsOf(ch.vignette);
        const ctl = window.BgbTourVignette.mount(host, ch.vignette, gated ? {
          onBeat: (name, index) => this._revealPoints(list, beats, index),
        } : undefined);
        if (!ctl) return;
        this._scenes[ch.slug] = ctl;
        // ONLY NOW is the gate armed. The hiding rule is scoped to this class,
        // so a scene that failed to register or failed to load never gets one
        // — the chapter keeps the plain staggered reveal and every claim is
        // on screen. A marketing screen does not hide its own copy because a
        // decoration did not arrive.
        if (gated) list.classList.add("tour__points--live");
      });
      // Every scene pauses itself when its panel is off-screen, so the four
      // chapters either side of this one cost nothing while they wait.
      Object.values(this._scenes).forEach((s) => s.play());
    }

    /**
     * Show every gated point the scene has reached, and hide the rest.
     *
     * By INDEX, not by name-equality with the beat that just fired. Two
     * reasons, and each one is a bug on its own:
     *
     *   • prefers-reduced-motion never runs the clock. The shell seeks
     *     straight to the last beat and reports only that one, so a
     *     name-equality test would leave the first two bullets of a
     *     three-bullet chapter permanently invisible to exactly the readers
     *     least able to wait for them.
     *   • A cycle restart reports (null, -1), which is what clears the list
     *     so the reveal can happen again with the scene.
     *
     * A beat name the scene does not have resolves to -1 and so never shows.
     * That is deliberate — silently showing an unknown name would hide the
     * typo — and tools/check-tour.mjs is what catches it before a user does.
     */
    _revealPoints(list, beats, index) {
      list.querySelectorAll("li[data-beat]").forEach((li) => {
        const at = beats.indexOf(li.dataset.beat);
        li.classList.toggle("is-shown", at >= 0 && at <= index);
      });
    }

    /**
     * Last resort for a gated list whose scene never gets going.
     *
     * The clock is held while a vignette is off-screen or the tab is
     * backgrounded, and it is started from an IntersectionObserver callback —
     * so "the scene mounted" is not the same as "the scene will run". If the
     * reader is looking at a chapter whose first beat has not landed several
     * seconds later, something upstream is not going to happen, and the
     * honest failure is all three claims at once rather than a panel of
     * headings with nothing under them.
     *
     * Dropping the class is one-way on purpose: whatever went wrong, having
     * seen the copy is not a state worth reversing.
     */
    _armPointsWatchdog(slug) {
      clearTimeout(this._pointsTimer);
      const root = this.container;
      const list = root && root.querySelector(`[data-points="${slug}"]`);
      if (!list || !list.classList.contains("tour__points--live")) return;
      if (list.querySelector("li[data-beat].is-shown")) return;
      this._pointsTimer = window.setTimeout(() => {
        if (!list.querySelector("li[data-beat].is-shown")) {
          list.classList.remove("tour__points--live");
        }
      }, POINTS_WATCHDOG_MS);
    }

    render() {
      // The paint below replaces the container's innerHTML, so any scene the
      // last one mounted is about to be detached. See _destroyScenes().
      this._destroyScenes();
      const chapters = CHAPTERS();
      const closer = window.TourChapters.closer();
      const panels = chapters.length + 1;
      const exitLabel = this._signedIn ? "Close the tour" : "Back to sign in";

      this.container.innerHTML = `
        <div class="tour" style="--tour-panels:${panels}">
          <div class="tour__head">
            <div class="tour__count" data-count aria-live="polite"></div>
            <button class="tour__exit" data-act="exit" aria-label="${exitLabel}">
              <i data-icon="x" class="w-4 h-4"></i>
            </button>
            <div class="tour__bar">
              ${'<div class="tour__seg"></div>'.repeat(chapters.length)}
            </div>
          </div>

          <div class="tour__clip" data-clip>
            <div class="tour__track" data-track>
              ${chapters.map((ch, i) => `
                <section class="tour__panel" aria-label="${ch.title}">
                  <div class="tour__scroll">
                    <p class="tour__eyebrow">${ch.eyebrow}</p>
                    <h2 class="tour__title font-display">${ch.title}</h2>
                    <div class="tour__stage" data-scene="${ch.slug}">
                      <div class="tour__stage-wait" aria-hidden="true"></div>
                    </div>
                    ${ch.body ? `<p class="tour__body">${ch.body}</p>` : ""}
                    <ul class="tour__points" data-points="${ch.slug}">
                      ${ch.points.map((p, n) => {
                        const text = typeof p === "string" ? p : p.text;
                        const beat = typeof p === "string" ? "" : p.beat;
                        return `
                        <li style="--i:${n}"${beat ? ` data-beat="${beat}"` : ""}>
                          <i data-icon="check" class="w-3.5 h-3.5"></i><span>${text}</span>
                        </li>`;
                      }).join("")}
                    </ul>
                  </div>
                  <div class="tour__actions">
                    ${i > 0 ? `<button class="btn btn-ghost tour__btn" data-act="prev">Back</button>` : ""}
                    <button class="btn btn-primary tour__btn tour__btn--go" data-act="next">
                      ${i === chapters.length - 1 ? "Finish" : "Next"}
                    </button>
                  </div>
                </section>`).join("")}

              <section class="tour__panel tour__panel--end" aria-label="${closer.title}">
                <div class="tour__scroll tour__scroll--center">
                  <img src="assets/brand/bgb-logo.svg" alt="" class="tour__mark" />
                  <h2 class="tour__title tour__title--center font-display">${closer.title}</h2>
                  <p class="tour__body tour__body--center">${closer.body}</p>
                </div>
                <div class="tour__actions">
                  <button class="btn btn-ghost tour__btn" data-act="prev">Back</button>
                  <button class="btn btn-primary tour__btn tour__btn--go" data-act="done">
                    ${this._signedIn ? closer.ctaIn : closer.ctaOut}
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>`;

      this.refreshIcons();
      this._bindOnce();
      this._bindClip();
      this._go(this._step, { silent: true });
      if (this._scenesLoaded) this._mountScenes();
    }

    /**
     * Listeners that must be attached EXACTLY ONCE per mount.
     *
     * render() runs TWICE on a cold mount — renderLoading() paints the deck,
     * then View.mount() calls render() again once onMount() resolves — and
     * these two go on the CONTAINER, which innerHTML does not replace. Bound
     * from render() they stacked: two identical click handlers on the first
     * visit, so one tap on Next ran _go(step + 1) twice and the deck skipped a
     * chapter. Nothing removed them on unmount either, so the second visit
     * jumped four.
     *
     * Hence the latch, and hence the remover going into _unsubs: _reset()
     * clears the latch on unmount, View.unmount() runs the removers before it,
     * and the pair stays in step however many times the tour is opened.
     */
    _bindOnce() {
      if (this._bound) return;
      this._bound = true;
      const root = this.container;

      const onClick = (ev) => {
        const btn = ev.target.closest("[data-act]");
        if (!btn || !root.contains(btn)) return;
        const act = btn.dataset.act;
        if (act === "next") this._go(this._step + 1);
        else if (act === "prev") this._go(this._step - 1);
        else if (act === "exit") this._leave();
        else if (act === "done") this._finish();
      };
      root.addEventListener("click", onClick);
      this._unsubs.push(() => root.removeEventListener("click", onClick));

      // Arrow keys on the document rather than the panel: nothing inside the
      // tour is focusable except its buttons, and listenDom drops the handler
      // on unmount so it cannot fire over another screen.
      this.listenDom("keydown", (ev) => {
        if (!this._mounted) return;
        if (ev.key === "ArrowRight") this._go(this._step + 1);
        else if (ev.key === "ArrowLeft") this._go(this._step - 1);
      });
    }

    /**
     * The swipe, which is the opposite case: [data-clip] is inside the markup
     * render() replaces, so every paint hands us a NEW element that has never
     * been bound. This one has to run every time — the old clip is detached
     * and takes its listeners with it.
     */
    _bindClip() {
      const clip = this.container.querySelector("[data-clip]");
      if (!clip) return;
      clip.addEventListener("touchstart", (ev) => {
        this._dragX = ev.touches && ev.touches[0] ? ev.touches[0].clientX : null;
      }, { passive: true });
      clip.addEventListener("touchend", (ev) => {
        const start = this._dragX;
        this._dragX = null;
        const t = ev.changedTouches && ev.changedTouches[0];
        if (start == null || !t) return;
        const dx = t.clientX - start;
        if (dx <= -SWIPE_PX) this._go(this._step + 1);
        else if (dx >= SWIPE_PX) this._go(this._step - 1);
      }, { passive: true });
    }

    /**
     * Move to panel `i`. The closer sits at index CHAPTERS().length and is
     * uncounted — the bar is full and the counter reads "That's the tour", so
     * "Chapter 6 of 5" never has to be printed.
     * @param {number} i
     * @param {{silent?: boolean}} [opts] silent skips the URL replace, for the
     *   paths where the URL is already correct (first paint, a popstate).
     */
    _go(i, opts) {
      const chapters = CHAPTERS();
      const last = chapters.length;
      const step = Math.max(0, Math.min(last, i));
      const root = this.container;
      if (!root) return;
      const track = root.querySelector("[data-track]");
      const count = root.querySelector("[data-count]");
      const segs = Array.prototype.slice.call(root.querySelectorAll(".tour__seg"));
      const panels = last + 1;

      this._step = step;
      // Percent OF THE TRACK, which is `panels` screens wide — so one screen is
      // 100/panels of it, never a hardcoded fraction.
      if (track) track.style.transform = `translateX(-${step * (100 / panels)}%)`;
      if (count) {
        count.innerHTML = step >= last
          ? "That's the tour"
          : `Chapter <b>${step + 1}</b> of ${last}`;
      }
      segs.forEach((seg, n) => seg.classList.toggle("is-done", n <= step));

      if (chapters[step]) this._armPointsWatchdog(chapters[step].slug);

      if (!(opts && opts.silent)) {
        const slug = chapters[step] ? chapters[step].slug : "end";
        window.router.replaceUrl("tour", { c: slug });
      }
    }

    /** The × and a browser back mean the same thing: leave the tour. */
    _leave() {
      window.router.back(this._exitRoute);
    }

    _finish() {
      window.api.trackEvent("tour_complete", { signed_in: this._signedIn });
      // Signed out, the closer's job is conversion, so it goes to the sign-in
      // screen rather than wherever the reader happened to arrive from.
      if (!this._signedIn) window.router.go("auth");
      else this._leave();
    }
  }

  window.TourView = TourView;
})();
