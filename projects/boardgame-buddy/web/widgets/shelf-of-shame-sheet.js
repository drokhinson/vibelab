// @ts-check
// widgets/shelf-of-shame-sheet.js — the list behind the Stats spoke's Shelf of
// shame card.
//
// The card says "63 of 74 games have never hit the table" and, until this, gave
// you no way to see WHICH 63 — and no way to argue with the number. It is wrong
// for anyone whose gaming predates their BoardgameBuddy account: a game played
// for years before signing up has no play rows, so it reads as shame, and the
// only way to clear it was to log a fake session — which would then land in the
// podium, the rhythm heatmap and personal bests. So every row here is a toggle
// that writes `collections.played_before_at` (migration 059), a mark scoped to
// the shelf block of bgb_user_stats_detail and to nothing else.
//
// NO FETCH. The rows arrive in `detail.shelf.games`, which the Stats spoke
// already holds — see the "everything from ONE call" note at the top of
// views/stats-view.js. That is also what guarantees the sheet's row count and
// the sentence on the card that opened it can never disagree.
//
// Modelled on widgets/game-picker-sheet.js, which is the sheet this same screen
// already opens from its By-game picker: same shell (ui/bottom-sheet.js), same
// .bgb-sheet__* panel chrome, same client-side substring filter, same surgical
// list patch. Only .shelf-sheet__* and the tab strip are ours. Two things
// differ, both because rows here are toggles rather than picks: the sheet does
// not close on a tap, and there is no footer commit — each toggle writes on its
// own, optimistically.
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * One row, straight out of `detail.shelf.games`.
   * @typedef {Object} ShelfGame
   * @property {string} game_id
   * @property {string} name
   * @property {string} [thumbnail_url]
   * @property {number} [year_published]
   * @property {boolean} played_before
   */

  /**
   * @typedef {Object} ShelfSheetOpts
   * @property {ShelfGame[]} games            Owned base games with no logged plays.
   * @property {boolean} [loading]            Rows are still on their way; the
   *   opener calls setGames() / setError() when they land.
   * @property {boolean} [truncated]          The RPC capped the list.
   * @property {Element|null} [returnFocus]   Focus goes back here on close.
   * @property {(gameId: string, playedBefore: boolean) => void} [onToggle]
   *   Fired for every state change the sheet applies, the optimistic paint and
   *   any rollback alike — so it must APPLY the state it is handed, not flip.
   */

  const LIST_SEL = "[data-shelf-list]";
  const TABS_SEL = "[data-shelf-tabs]";

  /** Game ids are UUIDs, so this is belt-and-braces — but an attribute
   *  selector built by concatenation is worth escaping on principle, and
   *  CSS.escape is missing on old WebKit. */
  const cssEscape = (v) =>
    (window.CSS && window.CSS.escape) ? window.CSS.escape(v) : String(v).replace(/"/g, '\\"');

  class ShelfOfShameSheet {
    constructor() {
      /** @type {ShelfGame[]} */
      this._games = [];
      this._truncated = false;
      this._loading = false;
      /** @type {string|null} */
      this._error = null;
      this._query = "";
      /** @type {"unplayed"|"marked"} */
      this._tab = "unplayed";
      this._onToggle = /** @type {any} */ (null);
      // "<gameId>|<tab>" for every row toggled while that tab was showing.
      // A ticked row stays put, rendered in its new state, instead of
      // vanishing from under the thumb — ticking six games in a row should not
      // reshuffle the list six times, and a row you just ticked is the one you
      // are most likely to want back. Keyed by TAB, not just by game, so each
      // tab still shows its own truth: tick a game on Never played and it
      // stays there AND appears on Marked played, where it genuinely belongs.
      // Cleared on close, so the next open sorts cleanly.
      /** @type {Set<string>} */
      this._pinned = new Set();
      // Per-game monotonic token, captured before the await and re-checked
      // after it. Two quick taps on one row fire two writes that can settle in
      // either order, and without this the older one reconciles last and the
      // check ends up backwards (.claude/rules/web-frontend.md § Async state).
      /** @type {Object<string, number>} */
      this._seq = {};

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-shelf-sheet",
        className: "shelf-sheet",
        label: "Games you've never played",
      });
    }

    // ── Markup ──────────────────────────────────────────────────────────────

    /** @param {string} gameId */
    _pinKey(gameId) {
      return gameId + "|" + this._tab;
    }

    /** Rows in the active tab, before the search filter: the tab's true set,
     *  plus anything pinned into it by a toggle earlier in this opening. */
    _inTab() {
      const belongs = this._tab === "marked"
        ? (/** @type {ShelfGame} */ g) => g.played_before
        : (/** @type {ShelfGame} */ g) => !g.played_before;
      return this._games.filter((g) => belongs(g) || this._pinned.has(this._pinKey(g.game_id)));
    }

    _matches() {
      const q = this._query.trim().toLowerCase();
      const rows = this._inTab();
      if (!q) return rows;
      return rows.filter((g) => (g.name || "").toLowerCase().includes(q));
    }

    /** @param {ShelfGame} g */
    _row(g) {
      const on = !!g.played_before;
      // gameArtImg returns "" for a coverless game — same dice placeholder the
      // picker rows fall back to.
      const art = gameArtImg(g, "chip", { alt: "" });
      const meta = on
        ? "Marked as played before you joined"
        : (g.year_published ? String(g.year_published) : "Never logged");
      return `
        <button class="shelf-sheet__row" type="button" role="option"
                aria-checked="${on}" aria-selected="${on}"
                data-shelf-game-id="${escapeAttr(g.game_id)}"
                aria-label="${escapeAttr(
                  `${g.name || ""} — ${on ? "marked as played, tap to undo" : "mark as played before you joined"}`,
                )}">
          <span class="shelf-sheet__art${art ? "" : " shelf-sheet__art--empty"}">${art
            || `<i data-icon="dice-6" class="w-5 h-5"></i>`}</span>
          <span class="shelf-sheet__body">
            <span class="shelf-sheet__name">${escapeHtml(g.name || "")}</span>
            <span class="shelf-sheet__meta">${escapeHtml(meta)}</span>
          </span>
          <span class="shelf-sheet__check">${on ? `<i data-icon="check" class="w-3.5 h-3.5"></i>` : ""}</span>
        </button>
      `;
    }

    // Loading, error and empty are three branches, not one: an empty state
    // painted while the rows are still in flight says "there is nothing here"
    // about a list nobody has looked at yet, and a failed load is not an empty
    // shelf (.claude/rules/web-frontend.md § Loading, empty and error states).
    _renderList() {
      if (this._loading) {
        return `<div class="bgb-sheet__empty">${window.buddyLoader({ size: 72, label: "Reading your shelf…" })}</div>`;
      }
      if (this._error) {
        return `<p class="bgb-sheet__empty">${escapeHtml(this._error)}</p>`;
      }
      const rows = this._matches();
      if (!rows.length) {
        if (this._query.trim()) {
          return `<p class="bgb-sheet__empty">No games match “${escapeHtml(this._query.trim())}”.</p>`;
        }
        return this._tab === "marked"
          ? `<p class="bgb-sheet__empty">Nothing marked yet. Tick a game on the Never played tab and it lands here.</p>`
          : `<p class="bgb-sheet__empty">Every box on the shelf has hit the table.</p>`;
      }
      return rows.map((g) => this._row(g)).join("");
    }

    /** The tab strip, in its own host so a toggle can repaint the counts
     *  without touching the search field the user may be typing in.
     *
     *  Counts are the TRUE state, not the number of rows on screen: a pinned
     *  row is still on the Never-played list but has already left the count,
     *  and that decrement is the feedback that the tick landed. Rendered even
     *  when nothing is marked yet — revealing the strip on the first tick
     *  would shove the list down a row at the exact moment a thumb is on it. */
    _renderTabs() {
      if (this._loading || this._error) return "";
      const unplayed = this._games.filter((g) => !g.played_before).length;
      const marked = this._games.length - unplayed;
      const tab = (key, label, n) => `
        <button class="shelf-sheet__tab" type="button" role="tab"
                aria-selected="${this._tab === key}" data-shelf-tab="${key}">
          ${escapeHtml(label)} (${n})
        </button>
      `;
      return `
        <div class="shelf-sheet__tabs" role="tablist" aria-label="Which games to show">
          ${tab("unplayed", "Never played", unplayed)}
          ${tab("marked", "Marked played", marked)}
        </div>
      `;
    }

    _renderPanel() {
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Shelf of shame</h3>
          <p class="bgb-sheet__sub" data-shelf-sub>${this._sub()}</p>
          <div class="game-finder bgb-sheet__search">
            <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
            <input type="text" id="shelf-sheet-search"
                   class="input input-bordered game-finder__input"
                   placeholder="Search the shelf…" aria-label="Search the shelf"
                   autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            <button type="button" class="field-clear-btn" data-shelf-action="clear"
                    aria-label="Clear search" hidden>
              <i data-icon="x" class="w-4 h-4"></i>
            </button>
          </div>
          <div data-shelf-tabs>${this._renderTabs()}</div>
          <div class="bgb-sheet__list" role="listbox" aria-multiselectable="true"
               aria-label="Games you've never played" data-shelf-list>${this._renderList()}</div>
          <div data-shelf-note>${this._renderNote()}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Done</button>
        </div>
      `;
    }

    _renderNote() {
      return this._truncated
        ? `<p class="shelf-sheet__note">Showing the first 300 — mark a few off and the rest will follow.</p>`
        : "";
    }

    _sub() {
      if (this._loading) return "Counting the boxes you haven't opened…";
      if (this._error) return "";
      const n = this._games.filter((g) => !g.played_before).length;
      return `${n} owned ${n === 1 ? "game has" : "games have"} never hit the table`;
    }

    // ── Open / close ────────────────────────────────────────────────────────

    /** @param {ShelfSheetOpts} opts */
    open(opts) {
      // A shallow copy per row: the sheet flips `played_before` optimistically
      // and the opener patches its own payload from onToggle, so the two must
      // not be the same objects.
      this._games = (Array.isArray(opts.games) ? opts.games : []).map((g) => ({ ...g }));
      this._truncated = !!opts.truncated;
      this._loading = !!opts.loading;
      this._error = null;
      this._onToggle = opts.onToggle || null;
      this._query = "";
      this._tab = "unplayed";
      this._seq = {};
      this._pinned = new Set();

      this._sheet.open({
        html: this._renderPanel(),
        label: "Games you've never played",
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest('[data-shelf-action="clear"]')) { this._clear(); return; }
          const tab = e.target.closest("[data-shelf-tab]");
          if (tab) { this._setTab(tab.dataset.shelfTab); return; }
          const row = e.target.closest("[data-shelf-game-id]");
          if (row) this._toggle(row.dataset.shelfGameId);
        },
        // Layered, as the game picker: the first Escape backs out of the
        // search, the next closes the sheet.
        onEscape: () => {
          if (!this._query) return false;
          this._clear();
          return true;
        },
        onOpen: (root) => {
          const input = /** @type {HTMLInputElement|null} */ (root.querySelector(".game-finder__input"));
          if (input) input.addEventListener("input", () => this._setQuery(input.value));
          // Pin the list at the height it opened with, so the panel doesn't
          // walk up and down the screen on every keystroke that narrows the
          // results. A custom property, never an inline min-height — the
          // stylesheet has to be able to drop the pin when the keyboard
          // shrinks the sheet, and an inline style would out-specify it.
          const list = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
          if (list) list.style.setProperty("--bgb-sheet-list-min", list.clientHeight + "px");
          // Focus the first row, not the search box: this is a sheet you open
          // to read a list of 63 games, and throwing a software keyboard over
          // it is the wrong default. Tapping the field is the opt-in. Nothing
          // to focus while the rows are still loading — setGames does it then.
          this._focusFirstRow(root);
        },
        onClose: () => {
          this._games = [];
          this._onToggle = null;
          this._query = "";
          this._seq = {};
          this._pinned = new Set();
          this._loading = false;
          this._error = null;
        },
      });
    }

    close() {
      this._sheet.close();
    }

    get isOpen() {
      return this._sheet.isOpen;
    }

    /**
     * Hand the sheet its rows after an async load. Repaints the sub line, the
     * tab strip and the list; the search field is left alone in case the user
     * started typing into it while the rows were in flight.
     *
     * @param {ShelfGame[]} games
     */
    setGames(games, { truncated = false } = {}) {
      this._games = (Array.isArray(games) ? games : []).map((g) => ({ ...g }));
      this._truncated = !!truncated;
      this._loading = false;
      this._error = null;
      const root = this._sheet.el;
      if (!root) return;
      this._patchHead(root);
      this._patchList(root, { keepScroll: false });
      this._patchNote(root);
      // The rows arrived after the sheet did, so nothing inside it has been
      // focusable until now: focus is still on the trigger behind the sheet, or
      // on <body>. Either way it belongs in here. Anything already inside the
      // sheet — the search field the user tapped while waiting — is left alone.
      if (!root.contains(document.activeElement)) this._focusFirstRow(root);
    }

    /** @param {string} message */
    setError(message) {
      this._loading = false;
      this._error = message || "Couldn't load your shelf.";
      const root = this._sheet.el;
      if (!root) return;
      this._patchHead(root);
      this._patchList(root, { keepScroll: false });
    }

    /** @param {HTMLElement} root */
    _focusFirstRow(root) {
      const first = /** @type {HTMLElement|null} */ (root.querySelector(".shelf-sheet__row"));
      if (first) first.focus();
    }

    // ── Filtering ───────────────────────────────────────────────────────────

    /** @param {string} value */
    _setQuery(value) {
      this._query = value || "";
      const root = this._sheet.el;
      if (!root) return;
      // The list alone — re-rendering the panel would blow away the input the
      // user is typing into, along with its focus and caret.
      this._patchList(root, { keepScroll: false });
      const clear = /** @type {HTMLElement|null} */ (root.querySelector('[data-shelf-action="clear"]'));
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

    /** @param {string} tab */
    _setTab(tab) {
      if (tab !== "unplayed" && tab !== "marked") return;
      if (this._tab === tab) return;
      this._tab = tab;
      const root = this._sheet.el;
      if (!root) return;
      this._patchTabs(root);
      this._patchList(root, { keepScroll: false });
    }

    // ── Repaint ─────────────────────────────────────────────────────────────

    /** Sub line + tab strip — everything above the list that reports counts. */
    /** @param {HTMLElement} root */
    _patchHead(root) {
      const sub = root.querySelector("[data-shelf-sub]");
      if (sub) sub.textContent = this._sub();
      this._patchTabs(root);
    }

    /** @param {HTMLElement} root */
    _patchNote(root) {
      const host = root.querySelector("[data-shelf-note]");
      if (host) host.innerHTML = this._renderNote();
    }

    /** @param {HTMLElement} root */
    _patchTabs(root) {
      const host = /** @type {HTMLElement|null} */ (root.querySelector(TABS_SEL));
      if (!host) return;
      host.innerHTML = this._renderTabs();
      window.BgbIcons.render(host);
    }

    /** @param {HTMLElement} root */
    _patchList(root, { keepScroll = true } = {}) {
      const host = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
      if (!host) return;
      const top = host.scrollTop;
      host.innerHTML = this._renderList();
      // A tick must not scroll the list out from under the thumb; a filter
      // change must start at the top.
      host.scrollTop = keepScroll ? top : 0;
      window.BgbIcons.render(host);
    }

    // ── Toggle ──────────────────────────────────────────────────────────────

    /** @param {string} gameId */
    _toggle(gameId) {
      const game = this._games.find((g) => g.game_id === gameId);
      if (!game) return;
      const next = !game.played_before;
      // Pin into the tab being looked at BEFORE the state flips, so the row
      // stays where the user's thumb is rather than jumping to the other tab.
      this._pinned.add(this._pinKey(gameId));
      const seq = (this._seq[gameId] = (this._seq[gameId] || 0) + 1);

      this._apply(game, next, { busy: true });

      window.Collection.setPlayedBefore(gameId, next)
        .then(() => {
          if (seq !== this._seq[gameId]) return;
          this._apply(game, next, { busy: false });
        })
        .catch((e) => {
          if (seq !== this._seq[gameId]) return;
          this._apply(game, !next, { busy: false });
          if (window.showToast) {
            window.showToast(
              (e && e.offline)
                ? "You're offline — that mark didn't save."
                : "Couldn't save that. Try again.",
              "error",
            );
          }
        });
    }

    /**
     * Set a row to a known state and tell the opener, rather than flipping it.
     * The optimistic paint and the rollback both come through here, and they
     * can race; a toggle-shaped version would undo the wrong one.
     *
     * Repaints the one row, not the list: _toggle pinned it INTO the visible
     * tab before flipping it, so its membership here cannot have changed, and
     * rebuilding the list would destroy the element under the user's finger
     * before :active could apply (.claude/rules/overlays.md §6).
     *
     * @param {ShelfGame} game
     * @param {boolean} playedBefore
     */
    _apply(game, playedBefore, { busy = false } = {}) {
      const changed = game.played_before !== playedBefore;
      game.played_before = playedBefore;
      const root = this._sheet.el;
      if (root) {
        this._patchRow(root, game, busy);
        // Counts only — the strip reports true state, which every toggle moves.
        this._patchTabs(root);
      }
      if (changed && this._onToggle) this._onToggle(game.game_id, playedBefore);
    }

    /**
     * @param {HTMLElement} root
     * @param {ShelfGame} game
     * @param {boolean} busy
     */
    _patchRow(root, game, busy) {
      const sel = `[data-shelf-game-id="${cssEscape(game.game_id)}"]`;
      const el = root.querySelector(sel);
      if (!el) return;
      // Captured before the swap: outerHTML destroys the node, so afterwards
      // there is no way to tell a keyboard user who was ON this row from a
      // thumb that never focused it. Only the former gets focus back — the
      // rule is to recover focus that fell through, never to steal it.
      const hadFocus = document.activeElement === el;
      el.outerHTML = this._row(game);
      const next = /** @type {HTMLElement|null} */ (root.querySelector(sel));
      if (!next) return;
      // Busy is not disabled — a second tap should still register and win.
      // This only says the app heard the first one.
      if (busy) next.setAttribute("data-busy", "1");
      if (hadFocus) next.focus();
      window.BgbIcons.render(next);
    }
  }

  window.ShelfOfShameSheet = new ShelfOfShameSheet();
})();
