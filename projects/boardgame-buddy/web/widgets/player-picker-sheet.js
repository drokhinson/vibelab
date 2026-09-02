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
     */
    _matches() {
      const q = this._query.trim().toLowerCase();
      const base = !q && this._recent.length ? this._recent : this._candidates;
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

    _renderList() {
      const q = this._query.trim();
      const guest = this._guestRow();
      const pickedFirst = this._pickedSection();
      const rows = this._matches().filter((c) => !(q && this._isPicked(c.name)));
      const header = !q && this._recent.length
        ? `<div class="bgb-sheet__sec">Recently played with</div>`
        : "";

      if (!rows.length && !pickedFirst) {
        // Nothing matched, so the guest row IS the answer: lead with it and let
        // the note underneath explain the absence.
        if (!guest) return `<p class="bgb-sheet__empty">No buddies yet — type a name to add a guest.</p>`;
        return guest + (q
          ? `<div class="bgb-sheet__sec">No buddy matches “${escapeHtml(q)}”</div>`
          : `<div class="bgb-sheet__sec">No buddies yet — search to find one</div>`);
      }
      // Real people first when the query matched any: "add a guest called ok"
      // above Jess Okoro would be a strange thing to lead with. It stays
      // offered, though — the buddy list can hold a Dan while a different Dan
      // is at the table tonight.
      // Single-select's guest row is the "none of these" answer, not an
      // "add somebody new" one — and it is offered even when a buddy of the
      // same name is listed, so "Not in your buddies?" would be a lie there.
      const guestSec = this._single ? "Or" : "Not in your buddies?";
      return pickedFirst + header + rows.map((c) => this._row(c)).join("")
        + (guest ? `<div class="bgb-sheet__sec">${guestSec}</div>` + guest : "");
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
        <div class="bgb-sheet__panel">
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
      this._query = "";

      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest('[data-picker-action="guest"]')) { this._pickGuest(); return; }
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
            // Unlike the game picker, this sheet takes focus: adding people is
            // a typing task as often as a picking one, and the list is short
            // enough that the keyboard doesn't bury it.
            input.focus();
          }
          const list = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
          // Written as a custom property, not min-height, so the stylesheet can
          // drop the pin when the software keyboard shrinks the sheet — an
          // inline min-height would out-specify any rule trying to.
          if (list) list.style.setProperty("--bgb-sheet-list-min", list.clientHeight + "px");
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
     */
    setCandidates(candidates, recent) {
      if (!this._sheet.isOpen) return;
      this._candidates = Array.isArray(candidates) ? candidates : [];
      this._recent = Array.isArray(recent) ? recent : [];
      this._repaintList(true);
    }

    // ── Filtering ───────────────────────────────────────────────────────────

    /** @param {string} value */
    _setQuery(value) {
      this._query = value || "";
      this._repaintList();
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

    /** @param {string} name */
    _toggle(name) {
      if (this._single) {
        const c = this._candidates.find((x) => key(x.name) === key(name))
          || this._recent.find((x) => key(x.name) === key(name));
        if (c) this._answer(c);
        return;
      }
      const i = this._picked.findIndex((p) => key(p.name) === key(name));
      if (i >= 0) {
        this._picked.splice(i, 1);
      } else {
        const c = this._candidates.find((x) => key(x.name) === key(name))
          || this._recent.find((x) => key(x.name) === key(name));
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
      const exact = this._candidates.find((c) => key(c.name) === key(q));
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
