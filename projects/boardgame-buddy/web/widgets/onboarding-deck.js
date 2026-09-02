// widgets/onboarding-deck.js — first-run setup as one slide deck.
//
// Replaces a queue of three modals (PolaroidPopup.avatarCustomizer →
// AddBuddiesModal → OnboardingBggModal, each awaited before the next opened)
// with a single mounted surface. Three things follow from that, and they are
// the whole point of the file:
//
//   • THE STEPS ARE SLIDES. One track, one transform. Nothing opens, closes
//     and hands off, so the user never sees the empty feed flash between
//     cards, and Back is a real move rather than a dead end.
//   • THE COUNTER IS PINNED. "Step 2 of 4" plus a segment bar, above every
//     slide. Someone deciding whether to skip can see what skipping costs.
//   • CONTINUE AND SKIP NEVER AWAIT. The handler queues the write and moves
//     the track in the same frame. There is no spinner, no disabled button
//     and no "Sending…" anywhere in this flow — the 240ms is the slide
//     travelling, not a request. Results land on the finale slide's ledger.
//
// The finale is deliberately UNCOUNTED: the bar is full and the counter says
// "All set", so "Step 5 of 4" never has to be printed.
//
// Slide bodies live in widgets/onboarding-deck-slides.js — this file is the
// shell, the queue and the ledger. Both stay under the ~300-line rule in
// CLAUDE.md, and the split is along the seam that matters: what a slide IS
// versus how the deck moves between them.

(function () {
  const ROOT_ID = "bgb-onboarding-deck";
  // Must match the .is-closing animation duration in styles.css.
  const CLOSE_MS = 200;
  // Counted steps. The finale sits at index STEPS and is uncounted, so this
  // one number drives the segment bar, the clamp, the counter, "All set" and
  // the back-hidden rule. The PANEL geometry does not follow from it — see the
  // width/transform below, and .ob-slide's width in styles.css.
  const STEPS = 4;

  let _open = false;

  /**
   * One queued write. `run` is called once, immediately; the deck never waits
   * on the promise it returns.
   * @typedef {Object} DeckJob
   * @property {string} label     what the ledger calls it ("Profile saved")
   * @property {function(): Promise} run
   * @property {string} [detail]  the line under the label once it lands
   * @property {"running"|"done"|"failed"} status
   * @property {string} [error]
   */

  /**
   * Fire-and-forget write queue.
   *
   * Every job starts the instant it is pushed and reports into the ledger
   * whenever it finishes — which may be two slides later, or after the deck
   * has closed. One retry, because the common failure here is a phone waking
   * up on a bad connection rather than a rejected request; past that the
   * ledger says what did not land and where to do it again, which is the
   * honest end of a step nobody is waiting on.
   */
  function createQueue(onChange) {
    /** @type {DeckJob[]} */
    const jobs = [];
    function push(label, run, detail) {
      const job = { label, run, detail, status: "running" };
      jobs.push(job);
      onChange(jobs);
      const attempt = (retriesLeft) => run().catch((err) => {
        if (retriesLeft > 0) return attempt(retriesLeft - 1);
        throw err;
      });
      // Kept on the job so ONE write can depend on another — the BGG import
      // waits on the link, and reports as not-run rather than inventing a
      // collection when the credentials were wrong.
      job.promise = attempt(1).then(
        (res) => {
          job.status = "done";
          if (typeof detail === "function") job.detail = detail(res);
          onChange(jobs);
          return res;
        },
        (err) => {
          job.status = "failed";
          job.error = (err && err.message) ? String(err.message) : "";
          onChange(jobs);
          throw err;
        },
      );
      // The ledger is the only consumer of an outcome, so nothing else awaits
      // this. Marked handled here or a failed write reaches the console as an
      // unhandled rejection; a dependent job still sees the rejection.
      job.promise.catch(() => {});
      return job;
    }
    return { jobs, push };
  }

  /**
   * Open the deck. Resolves when the user leaves it — there is nothing to
   * hand back, because every write the deck makes has already been fired.
   *
   * @param {Object} me  the current user (needs_setup profile)
   * @returns {Promise<void>}
   */
  function open(me) {
    if (_open) return Promise.resolve();
    _open = true;
    return new Promise((resolve) => {
      const stale = document.getElementById(ROOT_ID);
      if (stale) stale.remove();

      const root = document.createElement("div");
      root.id = ROOT_ID;
      root.className = "ob-deck";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", "Set up your account");
      root.innerHTML = `
        <div class="ob-deck__head">
          <button class="ob-deck__back" data-act="back" aria-label="Back">
            <i data-icon="chevron-left" class="w-4 h-4"></i>
          </button>
          <div class="ob-deck__count" data-count aria-live="polite"></div>
          <div class="ob-deck__bar" data-bar>
            ${'<div class="ob-deck__seg"></div>'.repeat(STEPS)}
          </div>
        </div>
        <div class="ob-deck__clip">
          <div class="ob-deck__track" data-track></div>
        </div>
      `;
      document.body.appendChild(root);
      // The deck owns the screen for its lifetime; the page behind it must not
      // scroll under it. Matched by the restore in finish().
      document.body.style.overflow = "hidden";

      const track = root.querySelector("[data-track]");
      const countEl = root.querySelector("[data-count]");
      const backBtn = root.querySelector("[data-act='back']");
      const segs = Array.prototype.slice.call(root.querySelectorAll(".ob-deck__seg"));

      let step = 0;
      let settled = false;
      // Device-back guard token — see ui/back-guard.js and armBack() below.
      let backGuard = 0;

      // Declared before the queue so the queue's callback can close over it;
      // assigned below, once the deck object it needs exists.
      let slides = null;

      const queue = createQueue(function (jobs) {
        if (slides && slides.finale) slides.finale.renderLedger(jobs);
      });

      // The deck's own API, handed to each slide so a slide never reaches for
      // the shell's internals: it says "I am done" and the shell decides what
      // that means.
      const deck = {
        me: me,
        steps: STEPS,
        /** Queue a write and move on in the same frame. Never awaited. */
        queue: queue.push,
        /** Advance one slide. */
        next: function () { go(step + 1); },
        /** Leave the deck (the finale's "Start playing"). */
        finish: function () { finish(); },
      };

      slides = window.OnboardingDeckSlides.build(deck);
      // ORDER IS THE DECK. This literal and the one inside go() must list the
      // same slides in the same order — they are the append order and the
      // index→slide lookup for onEnter, and a mismatch shows as the wrong
      // slide's hook firing rather than as an error.
      const PANELS = [
        slides.profile, slides.buddies, slides.bgg, slides.importHint, slides.finale,
      ];
      PANELS.forEach(function (s) { track.appendChild(s.el); });
      // 5 panels: four counted steps plus the uncounted finale. The panel
      // count used to live in FOUR places — this width, the transform below,
      // and .ob-slide's width AND flex-basis in styles.css — so adding a slide
      // meant changing all four or watching the track land on two half-slides.
      // It is now one number, published to CSS as a custom property.
      track.style.width = `${PANELS.length * 100}%`;
      track.style.setProperty("--ob-panels", String(PANELS.length));

      function go(i) {
        step = Math.max(0, Math.min(STEPS, i));
        // Percent OF THE TRACK, which is PANELS.length screens wide — so one
        // screen is 100/PANELS.length of it, not a hardcoded 25.
        track.style.transform = `translateX(-${step * (100 / PANELS.length)}%)`;
        countEl.innerHTML = step >= STEPS
          ? "All set"
          : `Step <b>${step + 1}</b> of ${STEPS}`;
        segs.forEach(function (seg, n) { seg.classList.toggle("is-done", n <= step); });
        // Back is hidden on the first slide (nowhere to go) and on the finale
        // (every write behind it has already fired — walking back into a step
        // whose job is queued would offer to do it twice).
        backBtn.hidden = step === 0 || step === STEPS;
        const slide = PANELS[step];
        if (slide && slide.onEnter) slide.onEnter();
      }

      function finish() {
        if (settled) return;
        settled = true;
        if (window.BgbBackGuard) window.BgbBackGuard.release(backGuard);
        backGuard = 0;
        root.classList.add("is-closing");
        setTimeout(function () {
          root.remove();
          // Only this deck's lock to release — nothing else is open during
          // first run, and the three modals it replaced are the reason that
          // is now true.
          document.body.style.overflow = "";
          _open = false;
          resolve();
        }, CLOSE_MS);
      }

      backBtn.addEventListener("click", function () { go(step - 1); });
      // Escape does NOT close the deck. Every other overlay in the app is
      // something the user opened; this one is the app's own first screen,
      // and the way out of it is Skip, three times if that is what they want.
      //
      // The phone's back gesture gets the same answer, and it needs a guard to
      // give it: with nothing armed it would walk the page BEHIND the deck
      // (ui/back-guard.js). So it does what the header's own Back button does
      // — one slide back, and nothing at all on the slides where that button
      // is hidden — then re-arms, because the press it just answered spent the
      // guard's history entry.
      function armBack() {
        if (!window.BgbBackGuard) return;
        backGuard = window.BgbBackGuard.arm({
          root: root,
          close: function () {
            if (!backBtn.hidden) go(step - 1);
            armBack();
          },
        });
      }
      armBack();
      window.BgbIcons.render(root);
      go(0);
    });
  }

  window.OnboardingDeck = { open, isOpen: function () { return _open; } };
})();
