// @ts-check
// widgets/game-picker-sheet.js — "which game?" as a searchable bottom sheet.
//
// Built for the Stats spoke's By-game breakdown, which used to hang an inline
// 15rem scroller off its trigger: it shoved the panel below it down the page,
// and with no search a player past their top handful of games had to scroll a
// letterbox to find one.
//
// Deliberately NOT a GameFinder: that widget searches the whole library over
// the network. Everything here is already in memory — the caller hands over
// the rows it has — so the filter is a plain client-side substring pass with
// no debounce and no request, the same call the import-expansions filter
// makes. Matching is case-insensitive substring, not prefix or fuzzy, to agree
// with domain/shelf-filter.js (and the backend it mirrors).
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; only the .game-picker__row family is ours.

(function () {
  /**
   * One row. Field names are `detail.games` from /users/me/stats/detail — the
   * caller passes those objects straight through.
   * @typedef {Object} PickerGame
   * @property {string} game_id
   * @property {string} name
   * @property {string} [thumbnail_url]
   * @property {number} plays
   * @property {number} wins
   * @property {string} [last_played_at]
   * @property {string} [play_mode]   "coop" suppresses the win rate.
   */

  /**
   * @typedef {Object} GamePickerOpts
   * @property {PickerGame[]} games              Rows, in the order to show them.
   * @property {string|null} [selectedId]        Marked, checked and focused.
   * @property {(game: PickerGame) => void} onPick
   * @property {Element|null} [returnFocus]      Focus goes back here on close.
   * @property {string} [title]
   */

  const LIST_SEL = "[data-picker-list]";

  class GamePickerSheet {
    constructor() {
      /** @type {PickerGame[]} */
      this._games = [];
      this._selectedId = /** @type {string|null} */ (null);
      this._onPick = /** @type {any} */ (null);
      this._query = "";

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-game-picker-sheet",
        className: "game-picker-sheet",
        label: "Choose a game",
      });
    }

    // ── Markup ──────────────────────────────────────────────────────────────

    _matches() {
      const q = this._query.trim().toLowerCase();
      if (!q) return this._games;
      return this._games.filter((g) => (g.name || "").toLowerCase().includes(q));
    }

    /** @param {PickerGame} g */
    _row(g) {
      const on = g.game_id === this._selectedId;
      const isCoop = g.play_mode === "coop";
      // gameArtImg returns "" for a game with no cover — fall back to the same
      // dice placeholder the game-finder rows use.
      const art = gameArtImg(g, "chip", { alt: "" });
      const plays = `${g.plays} play${g.plays === 1 ? "" : "s"}`;
      const meta = g.last_played_at
        ? `${plays} · last ${escapeHtml(formatDate(g.last_played_at))}`
        : plays;
      // A co-op game has no per-player win to rate, so it says what it is
      // rather than reporting a meaningless 0%.
      const rate = isCoop
        ? `<span class="game-picker__rate game-picker__rate--coop">Co-op</span>`
        : `<span class="game-picker__rate">${g.plays ? Math.round((g.wins / g.plays) * 100) : 0}% won</span>`;
      return `
        <button class="game-picker__row" type="button" role="option"
                aria-selected="${on}" data-picker-game-id="${escapeAttr(g.game_id)}">
          <span class="game-picker__art${art ? "" : " game-picker__art--empty"}">${art
            || `<i data-icon="dice-6" class="w-5 h-5"></i>`}</span>
          <span class="game-picker__body">
            <span class="game-picker__name">${escapeHtml(g.name || "")}</span>
            <span class="game-picker__meta">${meta}</span>
          </span>
          ${rate}
          <span class="game-picker__check">${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}</span>
        </button>
      `;
    }

    _renderList() {
      const rows = this._matches();
      if (!rows.length) {
        return `<p class="bgb-sheet__empty">No games match “${escapeHtml(this._query.trim())}”.</p>`;
      }
      return rows.map((g) => this._row(g)).join("");
    }

    _renderPanel(title) {
      const n = this._games.length;
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">${escapeHtml(title)}</h3>
          <p class="bgb-sheet__sub">${n} game${n === 1 ? "" : "s"} with logged plays</p>
          <div class="game-finder bgb-sheet__search">
            <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
            <input type="text" id="game-picker-search"
                   class="input input-bordered game-finder__input"
                   placeholder="Search your games…" aria-label="Search your games"
                   autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            <button type="button" class="field-clear-btn" data-picker-action="clear"
                    aria-label="Clear search" hidden>
              <i data-icon="x" class="w-4 h-4"></i>
            </button>
          </div>
          <div class="bgb-sheet__list" role="listbox" aria-label="${escapeAttr(title)}"
               data-picker-list>${this._renderList()}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }

    // ── Open / close ────────────────────────────────────────────────────────

    /** @param {GamePickerOpts} opts */
    open(opts) {
      this._games = Array.isArray(opts.games) ? opts.games : [];
      this._selectedId = opts.selectedId || null;
      this._onPick = opts.onPick;
      this._query = "";

      const title = opts.title || "Choose a game";

      this._sheet.open({
        html: this._renderPanel(title),
        label: title,
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest('[data-picker-action="clear"]')) { this._clear(); return; }
          const row = e.target.closest("[data-picker-game-id]");
          if (row) this._pick(row.dataset.pickerGameId);
        },
        // Layered, mirroring add-game-modal / import-expansions-modal: the
        // first Escape backs out of the search, the next closes the sheet.
        onEscape: () => {
          if (!this._query) return false;
          this._clear();
          return true;
        },
        onOpen: (root) => {
          const input = /** @type {HTMLInputElement|null} */ (root.querySelector(".game-finder__input"));
          if (input) input.addEventListener("input", () => this._setQuery(input.value));
          // Pin the list at the height it opened with. Without this the panel
          // is sized by its content, so the sheet jumps down the screen on
          // every keystroke that narrows the results and back up on every
          // backspace — with the row under your thumb moving as it goes.
          const list = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
          if (list) list.style.minHeight = list.clientHeight + "px";
          // Focus the current pick, not the search box: opening the sheet
          // shouldn't throw a software keyboard over the list the user came
          // to read. Tapping the field is the opt-in.
          const sel = root.querySelector('[aria-selected="true"]')
            || root.querySelector(".game-picker__row");
          if (sel) /** @type {HTMLElement} */ (sel).focus();
        },
        onClose: () => {
          this._games = [];
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
      const clear = /** @type {HTMLElement|null} */ (root.querySelector('[data-picker-action="clear"]'));
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

    /** @param {string} gameId */
    _pick(gameId) {
      const game = this._games.find((g) => g.game_id === gameId);
      const cb = this._onPick;
      this.close();
      if (game && cb) cb(game);
    }
  }

  window.GamePickerSheet = new GamePickerSheet();
})();
