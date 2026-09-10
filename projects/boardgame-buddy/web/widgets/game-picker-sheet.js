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
   * @property {number} [decided_plays]  the subset of `plays` that recorded a
   *   result; the denominator `wins` is read against.
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
      // Same denominator as the Stats panel's ring: plays that recorded a
      // result, not every play. A game only ever logged without a winner or a
      // score has no rate to report, so it says so instead of "0% won".
      const decided = g.decided_plays != null ? g.decided_plays : g.plays;
      const rate = isCoop
        ? `<span class="game-picker__rate game-picker__rate--coop">Co-op</span>`
        : (decided
          ? `<span class="game-picker__rate">${Math.round((g.wins / decided) * 100)}% won</span>`
          : `<span class="game-picker__rate game-picker__rate--coop">No results</span>`);
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
          <div class="game-finder bgb-sheet__search" data-search-host>
            <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
            <input type="text" id="game-picker-search"
                   class="input input-bordered game-finder__input"
                   placeholder="Search your games…" aria-label="Search your games"
                   autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            ${window.BgbSearchField.clearButton()}
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
          const row = e.target.closest("[data-picker-game-id]");
          if (row) this._pick(row.dataset.pickerGameId);
        },
        search: { listSel: LIST_SEL, onQuery: (v) => this._setQuery(v) },
        onOpen: (root) => {
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
