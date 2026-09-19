// widgets/feedback-compose-sheet.js — writing a piece of Dev feedback.
//
// A BgbBottomSheet, and the first one in this project to contain a <textarea>.
// That is worth stating because it makes two of the rules in
// .claude/rules/overlays.md load-bearing here rather than incidental:
//
//   §5 — THIS SHEET MUST NOT FOCUS THE TEXTAREA ON OPEN. Focus lands on the
//   panel via tabindex="-1". A field focused on open raises the software
//   keyboard over the type and topic controls the person has to set first, and
//   on iOS it would also have to clear the 16px floor to avoid zooming the page.
//   Tapping the field is the opt-in. (Never the Submit button either: it is
//   disabled until there is a body, and a disabled button cannot take focus, so
//   focus would silently stay on whatever opened the sheet.)
//
//   §4 — the panel's ceiling is a percentage of the backdrop, not a vh, so the
//   keyboard shrinks it. That lives in the shared .bgb-sheet__panel rules; this
//   file must not add a vh ceiling of its own.
//
// THE CHOICE CONTROLS ARE INLINE. Type is a .bgb-sheet__tabs strip — the shared
// in-sheet segmented control, already used by the buddy-QR and shelf sheets.
// Topic has seven options, which will not fit a tab strip at 390px, so it is the
// .bgb-sheet__opt radio-row list instead. Neither opens a second sheet: a sheet
// on top of a sheet has no precedent in this project, and overlays.md's
// "dropdown inside a fixed panel" escape hatch names an `inlineDropdown` option
// that was deleted with ui/dropdown-fit.js (Docs/UI_AUDIT.md).
//
// EXACTLY ONE CHILD OF THIS PANEL SCROLLS, AND IT IS THE TOPIC LIST. That is the
// shared chrome's own shape ("the list is the only growable child, so the panel
// stops at its max-height and the list scrolls inside it"), and this sheet had
// broken it: the textarea, its label and the topic list all sat inside a
// .feedback-sheet__scroll, which made the sheet TWO nested overflow boxes.
// Measured at 393x820, the outer one had 208px to give and the inner one — the
// topic list, `overflow-y: auto` and covering most of the panel — had none,
// while still carrying `overscroll-behavior: contain`. A non-scrollable box with
// `contain` does not pass the gesture on, so a drag anywhere over the topics did
// nothing at all and only the thin label strips scrolled the sheet; when they
// did, they carried the textarea off the top. Grip, title, type strip, the
// field and the topic heading are all `flex: none` now, and the list is the one
// thing that moves. Do not put a scroller back around the field.
//
// THE BACK GUARD IS THE SHELL'S. ui/bottom-sheet.js arms and releases it. Arming
// it again here would push two history entries for one overlay.

(function () {
  class FeedbackComposeSheet {
    constructor() {
      /** @type {import("../domain/feedback.js").FeedbackOption[]} */
      this._types = [];
      /** @type {any[]} */
      this._topics = [];
      this._type = "";
      this._topic = "";
      this._body = "";
      this._saving = false;
      /** @type {((item: any) => void)|null} */
      this._onDone = null;

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-feedback-sheet",
        className: "feedback-sheet",
        label: "Add feedback",
      });
    }

    // ── markup ───────────────────────────────────────────────────────────────

    _renderTypes() {
      return this._types.map((t) => `
        <button class="bgb-sheet__tab" type="button" role="tab"
                aria-selected="${this._type === t.id}" data-fb-type="${escapeAttr(t.id)}">
          <i data-icon="${escapeAttr(t.icon || "circle")}" class="w-4 h-4"></i> ${escapeHtml(t.label)}
        </button>`).join("");
    }

    _renderTopics() {
      return this._topics.map((t) => `
        <button class="bgb-sheet__opt" type="button" role="option"
                aria-selected="${this._topic === t.id}" data-fb-topic="${escapeAttr(t.id)}">
          <i data-icon="${escapeAttr(t.icon || "circle")}" class="w-5 h-5"></i>
          <span class="bgb-sheet__opt-label">${escapeHtml(t.label)}</span>
          <span class="bgb-sheet__radio" aria-hidden="true"></span>
        </button>`).join("");
    }

    /** The submit button, in its own host so its disabled state can be patched. */
    _renderFoot() {
      const ready = !!(this._type && this._topic && this._body.trim()) && !this._saving;
      return `
        <button class="btn btn-primary feedback-sheet__send" type="button"
                data-fb-send ${ready ? "" : "disabled"}>
          ${this._saving ? "Sending…" : "Send feedback"}
        </button>`;
    }

    _renderPanel() {
      return `
        <div class="bgb-sheet__panel feedback-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h2 class="bgb-sheet__title">Add feedback</h2>
          <p class="bgb-sheet__sub">Everyone using BoardgameBuddy can see this and vote it up.</p>

          <div class="bgb-sheet__tabs" role="tablist" aria-label="What kind of feedback">
            ${this._renderTypes()}
          </div>

          <div class="feedback-sheet__field">
            <label class="feedback-sheet__label" for="feedback-body">What's on your mind?</label>
            <textarea id="feedback-body" class="feedback-sheet__text"
                      rows="4" maxlength="2000" data-fb-body
                      placeholder="What happened, or what would you like to see?"></textarea>

            <div class="feedback-sheet__label" id="feedback-topic-label">Which part of the app?</div>
          </div>

          <div class="bgb-sheet__list" role="listbox" aria-labelledby="feedback-topic-label">
            ${this._renderTopics()}
          </div>

          <div class="bgb-sheet__foot" data-fb-foot>${this._renderFoot()}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>`;
    }

    // ── surgical repaints ────────────────────────────────────────────────────
    //
    // Never the whole panel: it holds the textarea the user is typing into, and
    // rebuilding it would take the caret and the focus with it
    // (.claude/rules/overlays.md §6). Each of these touches one host.

    _patch(selector, html) {
      const root = this._sheet.el;
      if (!root) return;
      const host = root.querySelector(selector);
      if (!host) return;
      host.innerHTML = html;
      window.BgbIcons.render(host);
    }

    _patchFoot() {
      this._patch("[data-fb-foot]", this._renderFoot());
    }

    /** Re-tick one group without touching the other, or the textarea. */
    _patchChoices() {
      const root = this._sheet.el;
      if (!root) return;
      for (const el of root.querySelectorAll("[data-fb-type]")) {
        el.setAttribute("aria-selected", String(el.getAttribute("data-fb-type") === this._type));
      }
      for (const el of root.querySelectorAll("[data-fb-topic]")) {
        el.setAttribute("aria-selected", String(el.getAttribute("data-fb-topic") === this._topic));
      }
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    /**
     * @param {Object} opts
     * @param {any[]} opts.types
     * @param {any[]} opts.topics
     * @param {string} [opts.type]   Preselect a type — "bug" from the Settings
     *   row that exists for quick bug reporting. Empty leaves it unset.
     * @param {Element|null} [opts.returnFocus]
     * @param {(item: any) => void} opts.onDone  The created item, already
     *   rendered by the server, so the caller can put it straight on the board.
     */
    open({ types, topics, type, returnFocus, onDone }) {
      this._types = Array.isArray(types) ? types : [];
      this._topics = Array.isArray(topics) ? topics : [];
      // Only honour a preselect the lookup table actually knows, so a stale
      // bookmark to ?compose=whatever opens a normal empty sheet rather than a
      // sheet with an invisible selection the server will reject.
      this._type = this._types.some((t) => t.id === type) ? type : "";
      this._topic = "";
      this._body = "";
      this._saving = false;
      this._onDone = onDone || null;

      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: returnFocus || null,
        label: this._type ? "Report a bug" : "Add feedback",
        onClick: (e) => this._onClick(e),
        onOpen: (root) => {
          // The textarea is deliberately NOT focused — see the header. The
          // panel takes focus so a screen reader reads the dialog's label and
          // Tab walks the sheet rather than the page behind it.
          const panel = root.querySelector(".bgb-sheet__panel");
          if (panel) {
            panel.setAttribute("tabindex", "-1");
            /** @type {HTMLElement} */ (panel).focus();
          }
          // The bottom fade on the topic list, only while there is more of it
          // below the fold. Once, here: the option set is fixed for the life of
          // the sheet, so nothing after this can change the answer.
          const list = root.querySelector(".bgb-sheet__list");
          if (list) {
            list.classList.toggle("is-scrollable",
                                  list.scrollHeight > list.clientHeight + 1);
          }
          const text = root.querySelector("[data-fb-body]");
          if (text) {
            text.addEventListener("input", () => {
              const was = !!this._body.trim();
              this._body = /** @type {HTMLTextAreaElement} */ (text).value;
              // Only when the button's enabled-ness actually flips. Patching the
              // foot on every keystroke would be pointless work under the
              // user's finger.
              if (was !== !!this._body.trim()) this._patchFoot();
            });
          }
        },
      });
    }

    _onClick(e) {
      const typeBtn = e.target.closest("[data-fb-type]");
      if (typeBtn) {
        this._type = typeBtn.getAttribute("data-fb-type") || "";
        this._patchChoices();
        this._patchFoot();
        return;
      }
      const topicBtn = e.target.closest("[data-fb-topic]");
      if (topicBtn) {
        this._topic = topicBtn.getAttribute("data-fb-topic") || "";
        this._patchChoices();
        this._patchFoot();
        return;
      }
      if (e.target.closest("[data-fb-send]")) this._send();
    }

    async _send() {
      if (this._saving) return;
      const body = this._body.trim();
      if (!this._type || !this._topic || !body) return;

      this._saving = true;
      this._patchFoot();
      try {
        const item = await window.Feedback.submit({
          feedback_type: this._type,
          topic: this._topic,
          body,
        });
        const done = this._onDone;
        // Close before handing the item over: the caller repaints the board
        // underneath, and the shell's focus return checks that focus is still
        // inside the sheet — which it is now and would not be a frame later.
        this.close();
        showToast("Thanks — it's on the board", "success");
        if (done) done(item);
      } catch (err) {
        this._saving = false;
        this._patchFoot();
        // A toast rather than a silent snap-back, unlike the like button: the
        // person typed a paragraph, and the sheet staying open with their text
        // intact is the whole recovery path.
        notifyRequestError(err, "send your feedback");
      }
    }

    close() {
      this._sheet.close();
    }

    get isOpen() {
      return this._sheet.isOpen;
    }
  }

  window.FeedbackComposeSheet = new FeedbackComposeSheet();
})();
