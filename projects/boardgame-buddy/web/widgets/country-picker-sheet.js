// @ts-check
// widgets/country-picker-sheet.js — "where are you playing?" as a searchable
// bottom sheet.
//
// One call site: the Where card on Settle Up (views/play-flow-view.js). The
// country is detected from the device (domain/geo.js) and is right almost
// always; this sheet exists for the almost-never — a shared timezone, a border
// town, a laptop still set to the last trip — and for the host who would
// rather not record it at all.
//
// NOT a <select>. Choice lists in this app are sheets (.claude/rules/
// overlays.md), and 247 options is exactly the case a sheet is for: it needs a
// search field, and a native select gives no way to filter.
//
// The list comes from domain/geo.js, whose country set is the key set of the
// timezone table — so every country the picker offers is one detection could
// have produced, and every detected country has a row here. Names come from
// Intl.DisplayNames, i.e. in the user's own language, which is why the filter
// matches the localized name AND the raw code: a German speaker searching
// "Deutschland" and an English speaker searching "DE" both land on Germany.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; only the .country-picker__row family is ours.

(function () {
  /**
   * @typedef {Object} CountryPickerOpts
   * @property {string|null} [selectedCode]  Marked, checked and focused.
   * @property {(code: string|null) => void} onPick  null = "don't record one".
   * @property {Element|null} [returnFocus]   Focus goes back here on close.
   * @property {string} [title]
   */

  const LIST_SEL = "[data-country-list]";
  // The row that clears the field. Empty string rather than a sentinel word so
  // it can't collide with a real ISO code.
  const NONE = "";

  class CountryPickerSheet {
    constructor() {
      /** @type {{code: string, name: string}[]} */
      this._countries = [];
      this._selectedCode = /** @type {string|null} */ (null);
      this._onPick = /** @type {any} */ (null);
      this._query = "";

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-country-picker-sheet",
        className: "country-picker-sheet",
        label: "Choose a country",
      });
    }

    // ── Markup ──────────────────────────────────────────────────────────────

    _matches() {
      const q = this._query.trim().toLowerCase();
      if (!q) return this._countries;
      // Substring on both name and code, to agree with every other filter in
      // the app (widgets/game-picker-sheet.js, domain/shelf-filter.js).
      return this._countries.filter(
        (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
      );
    }

    /** @param {{code: string, name: string}} c */
    _row(c) {
      const on = c.code === this._selectedCode;
      return `
        <button class="country-picker__row" type="button" role="option"
                aria-selected="${on}" data-country-code="${escapeAttr(c.code)}">
          <span class="country-picker__name">${escapeHtml(c.name)}</span>
          <span class="country-picker__code">${escapeHtml(c.code)}</span>
          <span class="country-picker__check">${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}</span>
        </button>
      `;
    }

    /**
     * The opt-out row.
     *
     * Kept above the search results rather than buried at the bottom of 247
     * rows: a host who doesn't want their country on the play should not have
     * to scroll past every country to say so. It survives filtering for the
     * same reason — the escape hatch must not disappear behind a query.
     */
    _noneRow() {
      const on = !this._selectedCode;
      return `
        <button class="country-picker__row country-picker__row--none" type="button"
                role="option" aria-selected="${on}" data-country-code="">
          <span class="country-picker__name">Don’t record a country</span>
          <span class="country-picker__check">${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}</span>
        </button>
      `;
    }

    _renderList() {
      const rows = this._matches();
      const none = this._noneRow();
      if (!rows.length) {
        return `${none}<p class="bgb-sheet__empty">No countries match “${escapeHtml(this._query.trim())}”.</p>`;
      }
      return none + rows.map((c) => this._row(c)).join("");
    }

    _renderPanel(title) {
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">${escapeHtml(title)}</h3>
          <p class="bgb-sheet__sub">Country level data used for game popularity analytics</p>
          <div class="game-finder bgb-sheet__search">
            <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
            <input type="text" id="country-picker-search"
                   class="input input-bordered game-finder__input"
                   placeholder="Search countries…" aria-label="Search countries"
                   autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            <button type="button" class="field-clear-btn" data-country-action="clear"
                    aria-label="Clear search" hidden>
              <i data-icon="x" class="w-4 h-4"></i>
            </button>
          </div>
          <div class="bgb-sheet__list" role="listbox" aria-label="${escapeAttr(title)}"
               data-country-list>${this._renderList()}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }

    // ── Open / close ────────────────────────────────────────────────────────

    /** @param {CountryPickerOpts} opts */
    open(opts) {
      // Built per open, not once at construction: Intl.DisplayNames resolves
      // against the locale, and the sort collates in it, so a list cached at
      // load would be stale for anyone who changes their language.
      this._countries = window.Geo ? window.Geo.countryList() : [];
      const wanted = String(opts.selectedCode || "").toUpperCase();
      this._selectedCode = wanted && window.Geo && window.Geo.isKnown(wanted) ? wanted : null;
      this._onPick = opts.onPick;
      this._query = "";

      const title = opts.title || "Where are you playing?";

      this._sheet.open({
        html: this._renderPanel(title),
        label: title,
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest('[data-country-action="clear"]')) { this._clear(); return; }
          const row = e.target.closest("[data-country-code]");
          if (row) this._pick(row.dataset.countryCode);
        },
        // Layered, as in game-picker-sheet: the first Escape backs out of the
        // search, the next closes the sheet.
        onEscape: () => {
          if (!this._query) return false;
          this._clear();
          return true;
        },
        onOpen: (root) => {
          const input = /** @type {HTMLInputElement|null} */ (
            root.querySelector(".game-finder__input")
          );
          if (input) input.addEventListener("input", () => this._setQuery(input.value));
          // Pin the list at its opening height so the sheet doesn't walk up
          // and down the screen as the query narrows it. A custom property,
          // not min-height, so the stylesheet can drop the pin when the
          // keyboard shrinks the panel (.claude/rules/overlays.md §4).
          const list = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
          if (list) list.style.setProperty("--bgb-sheet-list-min", list.clientHeight + "px");
          // Focus the current pick rather than the search box — opening the
          // sheet shouldn't throw a keyboard over the list, and with the right
          // country almost always already selected, the common interaction
          // here is to look and cancel.
          const sel = root.querySelector('[aria-selected="true"]')
            || root.querySelector(".country-picker__row");
          if (sel) {
            /** @type {HTMLElement} */ (sel).focus();
            // 247 rows: the selected one is usually far down the scroller and
            // focus() alone leaves it at the very bottom of the visible list.
            if (typeof (/** @type {any} */ (sel).scrollIntoView) === "function") {
              /** @type {HTMLElement} */ (sel).scrollIntoView({ block: "center" });
            }
          }
        },
        onClose: () => {
          this._countries = [];
          this._onPick = null;
          this._query = "";
        },
      });
    }

    close() {
      this._sheet.close();
    }

    // ── Filtering ───────────────────────────────────────────────────────────

    /** @param {string} value */
    _setQuery(value) {
      this._query = value || "";
      const root = this._sheet.el;
      if (!root) return;
      // Patch the list alone — re-rendering the panel would blow away the
      // input the user is typing into, along with its focus and caret.
      const host = root.querySelector(LIST_SEL);
      if (host) {
        host.innerHTML = this._renderList();
        host.scrollTop = 0;
        window.BgbIcons.render(/** @type {HTMLElement} */ (host));
      }
      const clear = /** @type {HTMLElement|null} */ (
        root.querySelector('[data-country-action="clear"]')
      );
      if (clear) clear.hidden = !this._query;
    }

    _clear() {
      const root = this._sheet.el;
      const input = root
        ? /** @type {HTMLInputElement|null} */ (root.querySelector(".game-finder__input"))
        : null;
      if (input) { input.value = ""; input.focus(); }
      this._setQuery("");
    }

    // ── Pick ────────────────────────────────────────────────────────────────

    /** @param {string} code  "" for the opt-out row. */
    _pick(code) {
      const value = code === NONE ? null : String(code || "").toUpperCase();
      const cb = this._onPick;
      this.close();
      if (cb) cb(value);
    }
  }

  window.CountryPickerSheet = new CountryPickerSheet();
})();
