// widgets/release-notice-deck.js — what shipped, on the way in.
//
// ONE CARD WITH A TRACK, not a queue of modals. The argument is mechanical:
//
//   • BgbModal carries explicit orphan-teardown for "a second open while one is
//     closing" (ui/modal-shell.js) because that case is hazardous. A queue of N
//     hits it N-1 times by design.
//   • Each open arms its own BgbBackGuard entry, so three notices would put
//     three entries on the stack and the phone's back gesture would walk
//     BACKWARDS THROUGH THE ANNOUNCEMENT — which is not what back means
//     anywhere else in this app.
//   • overlays.md §8: four exits, one meaning. In a queue the x on card 1 and
//     the x on card 3 are the same control with different consequences.
//
// The slide mechanics are widgets/onboarding-deck.js's, deliberately: one
// track at width N*100%, one transform, the panel count published to CSS as a
// custom property so it lives in one place rather than four. What is NOT
// borrowed is that deck's Escape rule — it refuses Escape because it is the
// app's own first screen and the way out is Skip. This is dismissible by
// design, so all four exits close it and mean the same thing.
//
// MARKING SEEN HAPPENS ON CLOSE, ONCE, FOR THE WHOLE BATCH. Not per-slide:
// "cycle through them OR close out" means the x after slide 1 and Done after
// slide N must have identical consequences, or one control means two things
// depending on where the reader is standing. Someone who dismisses a stack of
// three has made a decision; the Settings archive is the way back to anything
// they skipped. Not on open either — a tab killed mid-read should re-show.

(function () {
  const _modal = new window.BgbModal({
    id: "bgb-release-deck",
    label: "What's new",
  });

  // One deck per page load, whatever happens to the write. Without this a dead
  // network would re-open it on every boot-ish event in the same session.
  let _shownThisLoad = false;

  let _notices = [];
  let _step = 0;

  /** The newest published_at in the batch that was actually staged. */
  function _through() {
    return _notices.reduce(
      (max, n) => (n.published_at && (!max || n.published_at > max) ? n.published_at : max),
      null,
    );
  }

  function _counter() {
    if (_notices.length < 2) return "";
    return `
      <div class="rel-deck__count" aria-live="polite">
        ${_step + 1} of ${_notices.length}
      </div>
      <div class="rel-deck__dots" role="tablist" aria-label="Release notices">
        ${_notices
          .map(
            (n, i) => `
          <button class="rel-deck__dot${i === _step ? " is-on" : ""}" type="button"
                  role="tab" aria-selected="${i === _step}"
                  data-act="dot" data-i="${i}"
                  aria-label="${escapeAttr(n.title || `Notice ${i + 1}`)}"></button>`,
          )
          .join("")}
      </div>
    `;
  }

  function _actions() {
    const last = _step >= _notices.length - 1;
    const back = _step > 0
      ? `<button class="rel-deck__back" type="button" data-act="prev">
           <i data-icon="chevron-left" class="w-4 h-4"></i><span>Back</span>
         </button>`
      : "";
    // "Got it" when there is nothing to page through, so a single notice never
    // shows a Next that would be a lie.
    const nextLabel = last ? (_notices.length < 2 ? "Got it" : "Done") : "Next";
    const nextAct = last ? "close" : "next";
    return `
      <div class="rel-deck__actions">
        ${back}
        <button class="rel-deck__next" type="button" data-act="${nextAct}">
          ${escapeHtml(nextLabel)}
        </button>
      </div>
    `;
  }

  function _html() {
    return `
      <div class="polaroid-popup__card rel-deck" tabindex="-1">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-icon="x" class="w-4 h-4"></i>
        </button>
        <div class="rel-deck__head">
          <div class="rel-deck__eyebrow">What's new</div>
          ${_counter()}
        </div>
        <div class="rel-deck__clip">
          <div class="rel-deck__track" data-track
               style="width:${_notices.length * 100}%; --rel-panels:${_notices.length}">
            ${_notices
              .map(
                (n) => `<section class="rel-deck__slide">
                          ${window.ReleaseNoticeBody.render(n)}
                        </section>`,
              )
              .join("")}
          </div>
        </div>
        ${_actions()}
      </div>
    `;
  }

  /**
   * Repaint the head and the actions only, and move the track.
   *
   * Never the card: re-rendering the panel would rebuild the slide the user is
   * reading, throwing away its scroll position mid-paragraph (overlays.md §6).
   * The track itself is moved by transform, so the slides are never touched.
   */
  function _sync() {
    const root = _modal.el;
    if (!root) return;
    const track = root.querySelector("[data-track]");
    if (track) {
      // Percent OF THE TRACK, which is N screens wide — so one screen is
      // 100/N of it, not a hardcoded number.
      track.style.transform = `translateX(-${_step * (100 / _notices.length)}%)`;
    }
    const head = root.querySelector(".rel-deck__head");
    if (head) {
      head.innerHTML = `<div class="rel-deck__eyebrow">What's new</div>${_counter()}`;
    }
    const actions = root.querySelector(".rel-deck__actions");
    if (actions) actions.outerHTML = _actions();
    window.BgbIcons.render(root);
    // The slide that just arrived starts at its own top; a reader who scrolled
    // notice 1 should not land halfway down notice 2.
    const slide = root.querySelectorAll(".rel-deck__slide")[_step];
    if (slide) slide.scrollTop = 0;
  }

  function _go(i) {
    _step = Math.max(0, Math.min(_notices.length - 1, i));
    _sync();
  }

  function _onClick(e) {
    const t = e.target;
    const hit = t.closest && t.closest("[data-act]");
    if (!hit) return;
    const act = hit.dataset.act;
    if (act === "next") return _go(_step + 1);
    if (act === "prev") return _go(_step - 1);
    if (act === "dot") return _go(Number(hit.dataset.i) || 0);
    if (act === "go") {
      // Close FIRST so the watermark write goes through the one funnel every
      // exit uses (onClose), then route. Reversing these would navigate out
      // from under the card and leave the modal over the destination.
      const route = hit.dataset.route;
      _modal.close();
      if (route && window.router) window.router.go(route);
    }
  }

  /**
   * Open the deck over whatever is on screen.
   *
   * @param {Array} notices  unseen notices, oldest-first (the RPC's order)
   * @returns {boolean}      whether it opened
   */
  function open(notices) {
    if (_shownThisLoad) return false;
    if (!Array.isArray(notices) || !notices.length) return false;
    if (!window.BgbModal || !window.ReleaseNoticeBody) return false;

    _shownThisLoad = true;
    _notices = notices;
    _step = 0;

    _modal.open({
      html: _html(),
      label: notices.length > 1 ? `What's new — ${notices.length} updates` : "What's new",
      onClick: _onClick,
      onOpen: (root) => {
        // The card itself takes focus, so a screen reader reads the dialog
        // label and Tab walks the deck rather than the feed behind it. There
        // is no text input here and there must never be one — overlays.md §5.
        const card = root.querySelector(".rel-deck");
        if (card) {
          try { card.focus(); } catch (_) {}
        }
      },
      onClose: () => {
        // The ONE funnel: the x, a tap outside, Escape, the back gesture and
        // Done all arrive here, which is what makes them mean the same thing.
        const through = _through();
        _notices = [];
        _step = 0;
        if (through && window.ReleaseNotices) window.ReleaseNotices.markSeen(through);
      },
    });
    return true;
  }

  window.ReleaseNoticeDeck = {
    open,
    isOpen: () => _modal.isOpen,
  };
})();
