// @ts-check
// widgets/player-picker-sheet.js — "who's playing?" as a multi-select bottom sheet.
//
// Replaces the Gather screen's inline buddy combo. That list was
// `position: absolute` inside the Players card, and the Players card sits at
// the bottom of Gather with the roster above it — so with four players already
// added, ui/dropdown-fit.js had to squeeze it to its own MIN (132px) "below
// this a dropdown is a keyhole" floor, on top of the docked Continue CTA, and
// it still ran off the bottom edge. A sheet is position:fixed and sized off
// --bgb-vv-h, so none of that geometry can happen: no fit pass, no flip, no
// z-index race with .cascade-cta-wrap, and the keyboard shrinks it correctly.
//
// It is MULTI-SELECT: a game night is a set of people, not one person picked
// five times. Tap to tick, tap again to untick, then Add — the old combo made
// you re-open it, re-focus it and re-read the same list once per player.
//
// Selection order is preserved, and that matters: the roster array IS the
// scoring grid's column order (widgets/round-score-grid.js maps it straight to
// columns), so ticking Marcus then Priya seats them in that order.
//
// Two behaviours the dropdown couldn't offer, both from being able to afford
// the height:
//   - no 8-row cap (the dropdown capped because it was a keyhole);
//   - a typed name with no match gets an explicit "add as a guest" row. The
//     dropdown HID itself on zero matches, so the guest path was invisible
//     unless you already knew Enter would do it.
//
// Two more the play importer needed, both about a list that is no longer
// simply "your buddies in alphabetical order":
//   - SUGGESTIONS. A caller that already knows which rows are likely (the
//     importer ranks its buddies against the name a note wrote) passes them as
//     `suggestions`, and they sit above the full list rather than replacing it.
//     Nobody is hidden; the likely answers are just first.
//   - A GLOBAL SEARCH BUTTON. `candidates` is a cached bundle and filters with
//     no round trip, which is what makes typing feel instant — so reaching past
//     it is a separate, explicit act (`searchAll`) rather than a debounce that
//     quietly turns every keystroke into a request.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; only the .player-picker__* row family is ours.

(function () {
  /**
   * A candidate, exactly the shape play-flow-view's `_buddyCandidates()` emits.
   * @typedef {Object} PlayerCandidate
   * @property {"account"|"ghost"} source
   * @property {string|null} user_id   null ⇒ a name-only guest.
   * @property {string} name
   * @property {string|null} [username]
   * @property {string|null} [avatar]
   * @property {number} [plays]        Plays together, when known.
   * @property {boolean} [isViewer]    This candidate is the signed-in user.
   *   Labelled "You" and pinned first — the play importer is the one caller
   *   that offers the viewer at all, since everywhere else they are already
   *   seated.
   */

  /**
   * @typedef {Object} PlayerPickerOpts
   * @property {PlayerCandidate[]} candidates  Everyone addable, already filtered
   *   of people in the roster by the caller.
   * @property {PlayerCandidate[]} [recent]    Shown first while the search box
   *   is empty. Falls back to `candidates`.
   * @property {number} [seated]               Players already at the table.
   * @property {(picks: PlayerCandidate[]) => void} onConfirm  In tick order.
   * @property {Element|null} [returnFocus]
   * @property {boolean} [singleSelect]        One answer, not a set: a tap
   *   confirms and closes, there is no confirm button, and rows read as radios.
   *   The play importer's "who is this name?" step is one question per row, so
   *   a multi-select sheet would make every answer take three taps.
   * @property {string} [title]                Defaults to "Add players".
   * @property {string} [sub]                  Replaces the seated-count line.
   * @property {string} [guestName]           The name the guest row offers when
   *   the search box is empty. Deliberately NOT a pre-filled query: seeding the
   *   box would filter every buddy out of a list whose whole job is to offer
   *   them. Typing still overrides it, so a different spelling is one field away.
   * @property {string|null} [selectedName]    Ticked on open (singleSelect).
   * @property {string} [guestTitle]           Overrides the guest row's title,
   *   as PLAIN TEXT — escaped here, so a caller never has to remember to.
   *   Written by the caller rather than templated here: "Add X as a guest" and
   *   "Keep X as a ghost" are different acts, not one act in two voices.
   * @property {string} [guestHint]            The subtitle, same contract.
   * @property {PlayerCandidate[]} [suggestions]  Rows worth reading first,
   *   already ranked by the caller — the play importer ranks its buddy list by
   *   how close each name is to the one the note wrote. Shown above the full
   *   list while the search box is empty, so "who is this?" opens on the
   *   likely answers WITHOUT hiding everyone else behind a search.
   * @property {string} [suggestionsLabel]     Heading over them. Say what made
   *   them suggestions ("Closest to “Jas”"), not that they are suggestions.
   * @property {string} [restLabel]            Heading over everyone else.
   * @property {(q: string) => Promise<PlayerCandidate[]>} [searchAll]
   *   Look beyond the caller's own list — the whole app's accounts. A round
   *   trip, so it is a BUTTON rather than something that fires as you type:
   *   `candidates` is cached and filters instantly, and quietly turning every
   *   keystroke into a request would spend that.
   * @property {string} [searchAllLabel]       The button's title.
   * @property {boolean} [allowGuest]          Default true. False when a name
   *   that matches nobody is not an answer the caller can take — linking a
   *   ghost player to an account is a choice among people who already exist,
   *   and "add “xyz” as a guest" there would offer an act with nothing behind
   *   it. Suppresses the row entirely, typed query or not.
   */

  const LIST_SEL = "[data-picker-list]";
  const INPUT_ID = "player-picker-search";
  const key = (name) => String(name || "").toLowerCase();

  class PlayerPickerSheet {
    constructor() {
      /** @type {PlayerCandidate[]} */
      this._candidates = [];
      /** @type {PlayerCandidate[]} */
      this._recent = [];
      /** Tick order — the seating order the roster will take. @type {PlayerCandidate[]} */
      this._picked = [];
      this._seated = 0;
      this._onConfirm = /** @type {any} */ (null);
      this._query = "";
      this._single = false;
      this._title = "Add players";
      this._sub = "";
      this._selected = "";
      this._guestName = "";
      this._guestTitle = "";
      this._guestHint = "";
      this._allowGuest = true;
      /** @type {PlayerCandidate[]} */
      this._suggestions = [];
      this._suggestionsLabel = "";
      this._restLabel = "";
      /** @type {((q: string) => Promise<PlayerCandidate[]>)|null} */
      this._searchAll = null;
      this._searchAllLabel = "";
      /** @type {PlayerCandidate[]} Results of the last global search. */
      this._globalRows = [];
      /** The query those results answer — cleared the moment it changes. */
      this._globalQuery = "";
      this._globalBusy = false;
      this._globalError = "";
      // Monotonic, so a slow search the user has typed past can't land under a
      // different question (.claude/rules/web-frontend.md § Async state).
      this._globalSeq = 0;

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-player-picker-sheet",
        className: "player-picker-sheet",
        label: "Add players",
      });
    }

    // ── Markup ──────────────────────────────────────────────────────────────

    /**
     * Same predicate the dropdown used: case-insensitive substring over name
     * OR username. Kept identical so the sheet can't quietly surface a
     * different set from the one people are used to.
     *
     * LOCAL ONLY, and that is the point: these rows come off a cached bundle
     * (domain/buddy.js SWRs it for a day), so typing filters them with no
     * round trip. `searchAll` is the deliberate, button-pressed alternative.
     */
    _matches() {
      const q = this._query.trim().toLowerCase();
      // Suggestions take over the empty-box slot when the caller ranked any,
      // and the FULL list goes underneath them — so `recent` is not the base.
      const base = !q && !this._suggestions.length && this._recent.length
        ? this._recent
        : this._candidates;
      if (!q) return base;
      return this._candidates.filter((c) => {
        const name = (c.name || "").toLowerCase();
        const username = (c.username || "").toLowerCase();
        return name.includes(q) || (username && username.includes(q));
      });
    }

    /** @param {string} name */
    _isPicked(name) {
      return this._picked.some((p) => key(p.name) === key(name));
    }

    /** @param {PlayerCandidate} c */
    _row(c) {
      const ghost = !c.user_id;
      const on = this._single ? key(c.name) === key(this._selected) : this._isPicked(c.name);
      const badge = window.BgbBadge.render({
        avatar: c.avatar,
        displayName: c.name,
        size: "sm",
        isGhost: ghost,
        extraClass: "player-picker__avatar",
      });
      const bits = [];
      if (c.isViewer) bits.push("You");
      if (c.username) bits.push("@" + c.username);
      if (c.plays) bits.push(`${c.plays} play${c.plays === 1 ? "" : "s"} together`);
      const meta = bits.length
        ? `<span class="player-picker__meta">${escapeHtml(bits.join(" · "))}</span>`
        : "";
      return `
        <button class="player-picker__row" type="button"
                role="${this._single ? "radio" : "checkbox"}"
                aria-checked="${on}" data-picker-name="${escapeAttr(c.name)}">
          ${badge}
          <span class="player-picker__body">
            <span class="player-picker__name">${escapeHtml(c.name)}</span>
            ${meta}
          </span>
          ${c.isViewer ? `<span class="player-picker__pill player-picker__pill--you">You</span>`
            : (ghost ? `<span class="player-picker__pill">Guest</span>` : "")}
          <span class="player-picker__tick" aria-hidden="true">
            ${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}
          </span>
        </button>
      `;
    }

    /**
     * The guest row. In multi-select it offers the TYPED name, and only when
     * that name doesn't already match someone listed or ticked — in which case
     * that row is the better action and two near-identical rows would be a
     * trap. In single-select it is the "none of these" answer and is always
     * offered, falling back to `guestName` before anybody types.
     */
    _guestRow() {
      if (!this._allowGuest) return "";
      // The typed name wins; falling back to guestName is what keeps the
      // "keep them as they are" answer on screen before anybody types.
      const q = this._query.trim() || this._guestName.trim();
      if (!q) return "";
      // Multi-select hides the row once the typed name matches somebody listed
      // or ticked, because that row is the better action. Single-select keeps
      // it: "keep this name as a ghost" stays a legitimate answer even when a
      // buddy of the same name exists, and it is often the RIGHT one.
      if (!this._single
          && (this._candidates.some((c) => key(c.name) === key(q)) || this._isPicked(q))) {
        return "";
      }
      const title = this._guestTitle
        ? escapeHtml(this._guestTitle)
        : `Add “${escapeHtml(q)}” as a guest`;
      const hint = escapeHtml(
        this._guestHint || "No account — they'll show as a guest on the scorecard");
      return `
        <button class="player-picker__row player-picker__row--guest" type="button"
                data-picker-action="guest">
          <span class="player-picker__plus"><i data-icon="plus" class="w-5 h-5"></i></span>
          <span class="player-picker__body">
            <span class="player-picker__name">${title}</span>
            <span class="player-picker__meta">${hint}</span>
          </span>
        </button>
      `;
    }

    /**
     * Ticked people ride at the top while a query is active. Without this,
     * searching for your second player scrolls your first one out of sight and
     * the sheet stops showing what it is about to do.
     */
    _pickedSection() {
      if (!this._picked.length || !this._query.trim()) return "";
      return `<div class="bgb-sheet__sec">Selected</div>`
        + this._picked.map((c) => this._row(c)).join("");
    }

    /** A section heading. @param {string} text */
    _sec(text) {
      return `<div class="bgb-sheet__sec">${escapeHtml(text)}</div>`;
    }

    /**
     * What the global search has to say right now: nothing before it is used,
     * then a spinner, then either its rows or the fact that it found none.
     * Rendered above the guest row, because "this person has an account after
     * all" is a better answer than "keep them as a ghost".
     */
    _globalSection() {
      if (this._globalBusy) {
        return this._sec("Searching BoardgameBuddy…")
          + `<div class="player-picker__busy">
               <i data-icon="loader-2" class="w-5 h-5 animate-spin"></i>
             </div>`;
      }
      if (this._globalError) {
        return `<p class="bgb-sheet__empty">${escapeHtml(this._globalError)}</p>`;
      }
      if (!this._globalQuery) return "";
      if (!this._globalRows.length) {
        return this._sec(`No other account matches “${this._globalQuery}”`);
      }
      return this._sec("On BoardgameBuddy")
        + this._globalRows.map((c) => this._row(c)).join("");
    }

    /**
     * The button that reaches past the buddy list. Disabled until something is
     * typed — searching everyone for the empty string is not a question — and
     * it stands down once its own results are on screen, reappearing as a
     * retry if the request failed or the query moved on.
     */
    _globalRow() {
      if (!this._searchAll || this._globalBusy) return "";
      const q = this._query.trim();
      if (!this._globalError && this._globalQuery && key(this._globalQuery) === key(q)) return "";
      const label = this._searchAllLabel || "Search all of BoardgameBuddy";
      const hint = this._globalError
        ? "Tap to try again"
        : (q ? `Look beyond your buddies for “${escapeHtml(q)}”`
             : "Type a name first — your buddies filter as you type");
      return `
        <button class="player-picker__row player-picker__row--global" type="button"
                data-picker-action="global" ${q ? "" : "disabled"}>
          <span class="player-picker__plus"><i data-icon="search" class="w-5 h-5"></i></span>
          <span class="player-picker__body">
            <span class="player-picker__name">${escapeHtml(label)}</span>
            <span class="player-picker__meta">${hint}</span>
          </span>
        </button>
      `;
    }

    /**
     * The local rows, sectioned. With a query it is one flat filtered list;
     * without one it is either the caller's ranking (closest first, everyone
     * else underneath) or the old recent-first behaviour.
     * @param {string} q
     * @param {PlayerCandidate[]} local
     */
    _localSections(q, local) {
      if (q || !this._suggestions.length) {
        const header = !q && this._recent.length ? this._sec("Recently played with") : "";
        return header + local.map((c) => this._row(c)).join("");
      }
      // Both lists are already in memory, so "search my whole buddy list" is
      // scrolling rather than typing — the suggestions do not hide anyone.
      const shown = new Set(this._suggestions.map((c) => key(c.name)));
      const rest = local.filter((c) => !shown.has(key(c.name)));
      return this._sec(this._suggestionsLabel || "Closest matches")
        + this._suggestions.map((c) => this._row(c)).join("")
        + (rest.length
            ? this._sec(this._restLabel || "Everyone else") + rest.map((c) => this._row(c)).join("")
            : "");
    }

    _renderList() {
      const q = this._query.trim();
      const guest = this._guestRow();
      const pickedFirst = this._pickedSection();
      const local = this._matches().filter((c) => !(q && this._isPicked(c.name)));
      const hasLocal = local.length || (!q && this._suggestions.length);
      const tail = this._globalSection() + this._globalRow();

      if (!hasLocal && !pickedFirst) {
        const note = q
          ? this._sec(`No buddy matches “${q}”`)
          : this._sec("No buddies yet — search to find one");
        // Once the global search has been asked, ITS answer leads: the user
        // pressed a button to get those rows, and burying them under "keep
        // them as a ghost" would answer a question they didn't ask.
        if (this._globalQuery || this._globalBusy || this._globalError) {
          return note + tail + (guest ? this._sec(this._single ? "Or" : "Not in your buddies?") + guest : "");
        }
        // Until then the guest row IS the answer: lead with it, let the note
        // underneath explain the absence, and offer the search below both.
        if (!guest) {
          if (tail) return note + tail;
          return `<p class="bgb-sheet__empty">${this._allowGuest
            ? "No buddies yet — type a name to add a guest."
            : escapeHtml(q ? `Nobody matches “${q}”.` : "Nobody to pick yet.")}</p>`;
        }
        return guest + note + tail;
      }
      // Real people first when the query matched any: "add a guest called ok"
      // above Jess Okoro would be a strange thing to lead with. It stays
      // offered, though — the buddy list can hold a Dan while a different Dan
      // is at the table tonight.
      // Single-select's guest row is the "none of these" answer, not an
      // "add somebody new" one — and it is offered even when a buddy of the
      // same name is listed, so "Not in your buddies?" would be a lie there.
      const guestSec = this._single ? "Or" : "Not in your buddies?";
      return pickedFirst + this._localSections(q, local) + tail
        + (guest ? this._sec(guestSec) + guest : "");
    }

    /** The confirm button's label and disabled state both track the tick count. */
    _renderConfirm() {
      // A tap IS the answer in single-select, so a confirm button would only
      // ever be a second tap on a decision already made.
      if (this._single) return "";
      const n = this._picked.length;
      return `
        <button class="bgb-sheet__confirm" type="button" data-picker-action="confirm"
                ${n ? "" : "disabled"}>
          ${n ? `Add ${n} player${n === 1 ? "" : "s"}` : "Select players to add"}
        </button>
      `;
    }

    _renderPanel() {
      const seated = this._seated;
      return `
        <div class="bgb-sheet__panel" tabindex="-1">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">${escapeHtml(this._title)}</h3>
          ${this._sub
            ? `<p class="bgb-sheet__sub">${escapeHtml(this._sub)}</p>`
            : (seated ? `<p class="bgb-sheet__sub">${seated} already at the table</p>` : "")}
          <div class="game-finder bgb-sheet__search" data-search-host>
            <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
            <input type="text" id="${INPUT_ID}"
                   class="input input-bordered game-finder__input"
                   placeholder="Search buddies, or type a name…"
                   aria-label="Search buddies, or type a name"
                   autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" />
            ${window.BgbSearchField.clearButton()}
          </div>
          <div class="bgb-sheet__list"
               role="${this._single ? "radiogroup" : "group"}"
               aria-label="${escapeAttr(this._title)}"
               data-picker-list>${this._renderList()}</div>
          <div class="bgb-sheet__foot" data-picker-foot>${this._renderConfirm()}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }

    // ── Open / close ────────────────────────────────────────────────────────

    /** @param {PlayerPickerOpts} opts */
    open(opts) {
      this._candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
      this._recent = Array.isArray(opts.recent) ? opts.recent : [];
      this._seated = opts.seated || 0;
      this._onConfirm = opts.onConfirm;
      this._picked = [];
      this._single = !!opts.singleSelect;
      this._title = opts.title || "Add players";
      this._sub = opts.sub || "";
      this._selected = opts.selectedName || "";
      this._guestName = opts.guestName || "";
      this._guestTitle = opts.guestTitle || "";
      this._guestHint = opts.guestHint || "";
      this._allowGuest = opts.allowGuest !== false;
      this._suggestions = Array.isArray(opts.suggestions) ? opts.suggestions : [];
      this._suggestionsLabel = opts.suggestionsLabel || "";
      this._restLabel = opts.restLabel || "";
      this._searchAll = typeof opts.searchAll === "function" ? opts.searchAll : null;
      this._searchAllLabel = opts.searchAllLabel || "";
      this._resetGlobal();
      this._query = "";

      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest('[data-picker-action="guest"]')) { this._pickGuest(); return; }
          if (e.target.closest('[data-picker-action="global"]')) { this._runGlobalSearch(); return; }
          if (e.target.closest('[data-picker-action="confirm"]')) { this._confirm(); return; }
          const row = e.target.closest("[data-picker-name]");
          if (row) this._toggle(row.dataset.pickerName);
        },
        // Layered, as add-game-modal / import-expansions-modal: the first
        // Escape backs out of the search, the next closes the sheet. Ticks are
        // deliberately NOT unwound by Escape — that is what Cancel is for.
        onEscape: () => {
          if (!this._query) return false;
          this._clear();
          return true;
        },
        onOpen: (root) => {
          const input = /** @type {HTMLInputElement|null} */ (root.querySelector(`#${INPUT_ID}`));
          if (input) {
            input.addEventListener("input", () => this._setQuery(input.value));
            // Enter ticks the typed name — the same key that added one from the
            // old combo — and leaves the sheet open for the next person.
            input.addEventListener("keydown", (e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              this._submitTyped();
            });
          }
          const list = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
          // Written as a custom property, not min-height, so the stylesheet can
          // drop the pin when the software keyboard shrinks the sheet — an
          // inline min-height would out-specify any rule trying to.
          if (list) list.style.setProperty("--bgb-sheet-list-min", list.clientHeight + "px");
          // Focus the first buddy, not the search box: opening the sheet must
          // not raise a software keyboard over the list of people it is
          // offering (.claude/rules/overlays.md §5). Typing a name is still one
          // tap away. With nobody to list, the panel takes focus instead so a
          // screen reader still lands on the sheet's label.
          const firstRow = /** @type {HTMLElement|null} */ (root.querySelector(".player-picker__row"));
          const panel = /** @type {HTMLElement|null} */ (root.querySelector(".bgb-sheet__panel"));
          const landing = firstRow || panel;
          if (landing) landing.focus({ preventScroll: true });
        },
        onClose: () => {
          this._candidates = [];
          this._recent = [];
          this._picked = [];
          this._onConfirm = null;
          this._query = "";
          // This is a singleton, so a mode left set would reach the next
          // opener — Gather would get a sheet that closes on the first tap.
          this._single = false;
          this._title = "Add players";
          this._sub = "";
          this._selected = "";
          this._guestName = "";
          this._guestTitle = "";
          this._guestHint = "";
          this._allowGuest = true;
          this._suggestions = [];
          this._suggestionsLabel = "";
          this._restLabel = "";
          this._searchAll = null;
          this._searchAllLabel = "";
          this._resetGlobal();
        },
      });
    }

    close() {
      this._sheet.close();
    }

    isOpen() {
      return this._sheet.isOpen;
    }

    /**
     * Swap in the real rows on a sheet that opened before the buddy preload
     * landed. Ticks survive: `_picked` holds whole candidate objects, so a
     * guest the host typed while waiting is unaffected, and a buddy row is
     * re-rendered from the same name key.
     * @param {PlayerCandidate[]} candidates
     * @param {PlayerCandidate[]} [recent]
     * @param {PlayerCandidate[]} [suggestions] Re-ranked with the new list.
     */
    setCandidates(candidates, recent, suggestions) {
      if (!this._sheet.isOpen) return;
      this._candidates = Array.isArray(candidates) ? candidates : [];
      this._recent = Array.isArray(recent) ? recent : [];
      if (suggestions !== undefined) {
        this._suggestions = Array.isArray(suggestions) ? suggestions : [];
      }
      this._repaintList(true);
    }

    // ── Filtering ───────────────────────────────────────────────────────────

    /** @param {string} value */
    _setQuery(value) {
      this._query = value || "";
      // Global results answer the query that fetched them and nothing else, so
      // typing past one drops it — along with any request still in the air,
      // which would otherwise land under a different question.
      if (this._globalQuery && key(this._globalQuery) !== key(this._query.trim())) {
        this._resetGlobal();
      } else if (this._globalError) {
        this._globalError = "";
      }
      this._repaintList();
    }

    /** Forget the global search entirely, dropping anything in flight. */
    _resetGlobal() {
      this._globalSeq++;
      this._globalRows = [];
      this._globalQuery = "";
      this._globalBusy = false;
      this._globalError = "";
    }

    /**
     * Search every account in the app for the typed name, on purpose and once.
     * Anyone already listed above is filtered out rather than offered twice —
     * the buddy row carries their play count and is the better row.
     */
    async _runGlobalSearch() {
      const q = this._query.trim();
      if (!q || !this._searchAll || this._globalBusy) return;
      const seq = ++this._globalSeq;
      this._globalRows = [];
      this._globalError = "";
      this._globalQuery = q;
      this._globalBusy = true;
      this._repaintList(true);

      let rows = null;
      try {
        rows = await this._searchAll(q);
      } catch (_) {
        if (seq !== this._globalSeq || !this._sheet.isOpen) return;
        this._globalBusy = false;
        this._globalQuery = "";
        this._globalError = "Couldn't search right now.";
        this._repaintList(true);
        return;
      }
      if (seq !== this._globalSeq || !this._sheet.isOpen) return;
      this._globalBusy = false;
      const listed = new Set(this._candidates.map((c) => c.user_id).filter(Boolean));
      this._globalRows = (rows || []).filter((r) => r && r.name && !listed.has(r.user_id));
      this._repaintList(true);
    }

    /**
     * Patch the list and the footer only. Re-rendering the panel would blow
     * away the input the user is typing into, along with its focus and caret.
     * @param {boolean} [keepScroll]
     */
    _repaintList(keepScroll) {
      const root = this._sheet.el;
      if (!root) return;
      const host = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
      if (host) {
        const top = host.scrollTop;
        host.innerHTML = this._renderList();
        host.scrollTop = keepScroll ? top : 0;
        window.BgbIcons.render(host);
      }
      const foot = /** @type {HTMLElement|null} */ (root.querySelector("[data-picker-foot]"));
      if (foot) foot.innerHTML = this._renderConfirm();
    }

    /**
     * Escape's first press backs out of the search. The × does the same thing
     * through the shared field's own click path — both land back in _setQuery
     * via the `input` event BgbSearchField dispatches, so "empty the box and
     * repaint the list" is written once, in ui/search-field.js.
     */
    _clear() {
      window.BgbSearchField.clear(this._sheet.el);
    }

    // ── Selection ───────────────────────────────────────────────────────────

    /**
     * The candidate behind a row, wherever it came from. Global results are
     * searched too — a row the user can see must be a row the user can pick.
     * @param {string} name
     */
    _find(name) {
      const hit = (list) => (list || []).find((x) => key(x.name) === key(name));
      return hit(this._candidates) || hit(this._suggestions)
        || hit(this._recent) || hit(this._globalRows) || null;
    }

    /** @param {string} name */
    _toggle(name) {
      if (this._single) {
        const c = this._find(name);
        if (c) this._answer(c);
        return;
      }
      const i = this._picked.findIndex((p) => key(p.name) === key(name));
      if (i >= 0) {
        this._picked.splice(i, 1);
      } else {
        const c = this._find(name);
        if (!c) return;
        this._picked.push(c);
      }
      // Ticking must not scroll the list out from under the thumb.
      this._repaintList(true);
    }

    /**
     * Multi-select: tick the typed name as a guest and clear the box, ready for
     * the next. Single-select: it IS the answer, so it closes.
     */
    _pickGuest() {
      const name = this._query.trim() || this._guestName.trim();
      if (!name) return;
      const guest = { source: "ghost", user_id: null, name, username: null, avatar: null };
      if (this._single) { this._answer(guest); return; }
      if (this._isPicked(name)) return;
      this._picked.push(guest);
      this._clear();
    }

    /**
     * Single-select's whole path: close first, then hand the pick back.
     * Closing first means the caller's own re-render lands on a screen the
     * sheet has already let go of, rather than under it.
     * @param {PlayerCandidate} pick
     */
    _answer(pick) {
      const cb = this._onConfirm;
      this.close();
      if (cb) cb([pick]);
    }

    /**
     * Enter on the search field. An exact match ticks that person as
     * themselves — with their account and avatar — rather than a same-named
     * guest; this mirrors the old `_addPlayerFromInput`, which did the same
     * lookup before deciding account-vs-ghost.
     */
    _submitTyped() {
      const q = this._query.trim();
      if (!q) return;
      const exact = this._find(q);
      if (exact) {
        if (this._single) { this._answer(exact); return; }
        if (!this._isPicked(exact.name)) this._picked.push(exact);
        this._clear();
        return;
      }
      this._pickGuest();
    }

    _confirm() {
      const picks = this._picked.slice();
      const cb = this._onConfirm;
      this.close();
      if (picks.length && cb) cb(picks);
    }
  }

  window.PlayerPickerSheet = new PlayerPickerSheet();
})();
