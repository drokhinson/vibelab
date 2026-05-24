// widgets/game-finder.js — Reusable game-picker combo (input + dropdown).
//
// Searches the BgB library via Game.search(), offers a BoardGameGeek
// fallback when no library hits, and imports a BGG result on tap via
// Game.importBgg(). Picking a result fires the caller-supplied onPick
// callback — the widget itself never mutates collection/session state.
// Used by:
//   - play-flow-view.js (Gather screen: pick game for an active session)
//   - widgets/add-game-modal.js (Add to collection / wishlist from spokes)
//
// Each instance owns a unique input + dropdown DOM id so two finders can
// coexist on the same page if needed.

// @ts-check

(function () {
  let _seq = 0;

  /**
   * @typedef {Object} GameFinderOpts
   * @property {(game: any, ctx: PickCtx) => (void|Promise<void|RefusalResult>)} onPick
   *   Caller-supplied handler. Return `{ refuse, reason }` to keep the
   *   dropdown open with the row showing `reason`; return undefined / a
   *   resolved void Promise to let the widget close the dropdown.
   * @property {(err: Error) => void} [onError]
   * @property {string} [placeholder]
   * @property {boolean} [includeRecentlyPlayed]  Default true.
   */

  /** @typedef {{ source: "library"|"bgg"|"recent", isExpansion: boolean, dropdownItemEl: Element|null }} PickCtx */
  /** @typedef {{ refuse?: boolean, reason?: string }} RefusalResult */

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  class GameFinder {
    /** @param {GameFinderOpts} opts */
    constructor(opts) {
      if (!opts || typeof opts.onPick !== "function") {
        throw new Error("GameFinder: onPick is required");
      }
      this._opts = opts;
      this._id = ++_seq;
      this.inputId = `game-finder-input-${this._id}`;
      this.dropdownId = `game-finder-dropdown-${this._id}`;
      this._container = null;
      this._recentGames = null;     // lazy-loaded seed list
      this._queryToken = 0;         // increments on every search; stale responses are dropped
      this._searchTimer = null;
      this._bggMode = false;
      this._gameById = new Map();   // gameId → game object (so _pickById has the row data)
      this._outsideHandler = this._onOutsideClick.bind(this);
      this._docHandlerBound = false;
    }

    mount(containerEl) {
      if (!containerEl) return;
      // Idempotent: if already mounted in this container, no-op so the
      // play-flow's 2s lobby-poll re-render doesn't tear-down/re-create.
      if (this._container === containerEl
          && containerEl.querySelector(`#${this.inputId}`)) {
        return;
      }
      this._container = containerEl;
      const placeholder = escapeAttr(this._opts.placeholder || "Search for a game…");
      containerEl.innerHTML = `
        <div class="game-finder">
          <i data-lucide="search" class="w-4 h-4 game-finder__icon"></i>
          <input id="${this.inputId}"
                 class="input input-bordered game-finder__input"
                 placeholder="${placeholder}"
                 autocomplete="off" autocapitalize="off" autocorrect="off" />
          <ul id="${this.dropdownId}" class="game-finder-dropdown hidden"
              onmousedown="event.preventDefault()"></ul>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();

      const input = document.getElementById(this.inputId);
      if (input) {
        input.addEventListener("input", (e) => {
          const target = /** @type {HTMLInputElement} */ (e.target);
          this._onInput(target.value);
        });
        input.addEventListener("focus", () => this._open());
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            this._close();
            input.blur();
          }
        });
      }
      if (!this._docHandlerBound) {
        document.addEventListener("click", this._outsideHandler, true);
        this._docHandlerBound = true;
      }
    }

    unmount() {
      clearTimeout(this._searchTimer);
      this._queryToken++; // invalidate any in-flight search
      if (this._docHandlerBound) {
        document.removeEventListener("click", this._outsideHandler, true);
        this._docHandlerBound = false;
      }
      if (this._container) {
        this._container.innerHTML = "";
        this._container = null;
      }
      this._gameById.clear();
    }

    focus() {
      const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
      if (input) input.focus();
    }

    reset() {
      this._bggMode = false;
      this._queryToken++;
      const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
      if (input) input.value = "";
      this._close();
    }

    // ── Internal ──────────────────────────────────────────────────────────

    _onInput(value) {
      clearTimeout(this._searchTimer);
      const q = (value || "").trim();
      if (!q) {
        this._bggMode = false;
        this._renderDropdown("");
        return;
      }
      // 180ms debounce so a fast typer doesn't fire one query per keystroke.
      this._searchTimer = setTimeout(() => {
        this._bggMode = false;
        this._renderDropdown(q);
      }, 180);
    }

    async _open() {
      if (this._opts.includeRecentlyPlayed !== false && this._recentGames === null) {
        try {
          this._recentGames = await window.Game.recentlyPlayed(6);
        } catch (_) {
          this._recentGames = [];
        }
      }
      const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
      const q = input ? (input.value || "").trim() : "";
      this._renderDropdown(q);
    }

    _close() {
      const dd = document.getElementById(this.dropdownId);
      if (dd) {
        dd.classList.add("hidden");
        dd.innerHTML = "";
      }
    }

    _onOutsideClick(e) {
      if (!this._container) return;
      if (this._container.contains(e.target)) return;
      this._close();
    }

    async _renderDropdown(query) {
      const dd = document.getElementById(this.dropdownId);
      if (!dd) return;
      const q = (query || "").trim();
      const token = ++this._queryToken;

      // Empty query → recently-played seed (or hint).
      if (!q) {
        const list = (this._opts.includeRecentlyPlayed !== false && this._recentGames) || [];
        this._gameById.clear();
        list.forEach((g) => this._gameById.set(g.id, g));
        if (list.length === 0) {
          dd.innerHTML = `<li class="game-finder-dropdown__hint">Type a game name to search.</li>`;
        } else {
          dd.innerHTML =
            `<li class="game-finder-dropdown__header">Recently played</li>` +
            list.map((g) => this._renderRow(g, "recent")).join("");
        }
        dd.classList.remove("hidden");
        this._wireRowClicks(dd);
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      dd.innerHTML = `<li class="game-finder-dropdown__hint">Searching…</li>`;
      dd.classList.remove("hidden");

      let data;
      try {
        data = await window.Game.search(q);
      } catch (e) {
        if (token !== this._queryToken) return;
        dd.innerHTML = `<li class="game-finder-dropdown__hint">Search failed. Try again.</li>`;
        if (this._opts.onError) this._opts.onError(e);
        return;
      }
      if (token !== this._queryToken) return;

      const hits = (data && data.results) || [];
      const bggRow = `
        <li class="game-finder-dropdown-item game-finder-dropdown-item--bgg"
            data-finder-action="run-bgg" data-finder-query="${escapeAttr(q)}">
          <i data-lucide="search" class="w-4 h-4"></i>
          <span>Search BoardGameGeek for "${escape(q)}"</span>
        </li>`;
      if (hits.length === 0) {
        dd.innerHTML = `<li class="game-finder-dropdown__hint">No matches in your library.</li>${bggRow}`;
        this._wireRowClicks(dd);
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      this._gameById.clear();
      hits.forEach((h) => { if (h && h.game) this._gameById.set(h.game.id, h.game); });
      dd.innerHTML = hits.map((h) => this._renderRow(h.game, "library")).join("") + bggRow;
      this._wireRowClicks(dd);
      if (window.lucide) window.lucide.createIcons();
    }

    _renderRow(game, source) {
      const meta = [
        game.year_published,
        game.min_players
          ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P`
          : null,
        game.playing_time ? `${game.playing_time}m` : null,
      ].filter(Boolean).join(" · ");
      return `
        <li class="game-finder-dropdown-item"
            data-finder-action="pick" data-finder-game-id="${escapeAttr(game.id)}"
            data-finder-source="${escapeAttr(source)}">
          ${game.thumbnail_url
            ? `<img class="game-finder-dropdown-item__thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" loading="lazy" />`
            : `<div class="game-finder-dropdown-item__thumb game-finder-dropdown-item__thumb--placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="game-finder-dropdown-item__body">
            <div class="game-finder-dropdown-item__name">${escape(game.name)}</div>
            ${meta ? `<div class="game-finder-dropdown-item__meta">${escape(meta)}</div>` : ""}
          </div>
        </li>
      `;
    }

    _wireRowClicks(dd) {
      // Single delegated listener per render — picks/imports/run-bgg all
      // come through data-finder-action so we never inline onclicks.
      dd.onclick = (e) => {
        const row = e.target.closest("[data-finder-action]");
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        const action = row.getAttribute("data-finder-action");
        if (action === "pick") {
          const id = row.getAttribute("data-finder-game-id");
          const source = /** @type {"library"|"recent"} */ (row.getAttribute("data-finder-source") || "library");
          this._pickById(id, source, row);
        } else if (action === "run-bgg") {
          const q = row.getAttribute("data-finder-query") || "";
          this._runBgg(q);
        } else if (action === "import-bgg") {
          const bggId = Number(row.getAttribute("data-finder-bgg-id"));
          const name = row.getAttribute("data-finder-bgg-name") || "";
          this._importBgg(bggId, name, row);
        }
      };
    }

    async _runBgg(q) {
      const dd = document.getElementById(this.dropdownId);
      if (!dd) return;
      this._bggMode = true;
      const token = ++this._queryToken;
      dd.innerHTML = `<li class="game-finder-dropdown__hint">Searching BoardGameGeek…</li>`;
      dd.classList.remove("hidden");

      let data;
      try {
        data = await window.Game.search(q, { includeBgg: true });
      } catch (e) {
        if (token !== this._queryToken) return;
        dd.innerHTML = `<li class="game-finder-dropdown__hint">BoardGameGeek search failed.</li>`;
        if (this._opts.onError) this._opts.onError(e);
        return;
      }
      if (token !== this._queryToken) return;

      const bgg = (data && data.bgg_results) || [];
      if (bgg.length === 0) {
        dd.innerHTML = `<li class="game-finder-dropdown__hint">No BoardGameGeek matches.</li>`;
        return;
      }
      dd.innerHTML =
        `<li class="game-finder-dropdown__header">From BoardGameGeek</li>` +
        bgg.map((hit) => `
          <li class="game-finder-dropdown-item game-finder-dropdown-item--bgg"
              data-finder-action="import-bgg"
              data-finder-bgg-id="${hit.bgg_id}"
              data-finder-bgg-name="${escapeAttr(hit.name)}"
              data-bgg-id="${hit.bgg_id}">
            <div class="game-finder-dropdown-item__thumb game-finder-dropdown-item__thumb--placeholder">
              <i data-lucide="dice-6"></i>
            </div>
            <div class="game-finder-dropdown-item__body">
              <div class="game-finder-dropdown-item__name">${escape(hit.name)}</div>
              <div class="game-finder-dropdown-item__meta">
                ${[hit.year_published, hit.is_expansion ? "Expansion" : null].filter(Boolean).join(" · ")}
                ${hit.already_in_db ? " · In library" : ""}
              </div>
            </div>
            <button class="btn btn-ghost btn-xs game-finder-dropdown-item__action">
              ${hit.already_in_db ? "Pick" : "Import"}
            </button>
          </li>
        `).join("");
      this._wireRowClicks(dd);
      if (window.lucide) window.lucide.createIcons();
    }

    async _importBgg(bggId, name, rowEl) {
      const dd = document.getElementById(this.dropdownId);
      if (!dd || !rowEl) return;
      const setMeta = (text) => {
        const body = rowEl.querySelector(".game-finder-dropdown-item__body");
        if (!body) return;
        body.innerHTML = `
          <div class="game-finder-dropdown-item__name">${escape(name)}</div>
          <div class="game-finder-dropdown-item__meta">${escape(text)}</div>
        `;
      };
      setMeta("Importing from BoardGameGeek…");
      const action = rowEl.querySelector(".game-finder-dropdown-item__action");
      if (action) { action.disabled = true; action.textContent = "…"; }

      try {
        const game = await window.Game.importBgg(bggId);
        if (!document.getElementById(this.inputId)) return; // unmounted mid-import
        this._handlePick(game, { source: "bgg", isExpansion: !!(game && game.is_expansion), dropdownItemEl: rowEl });
      } catch (e) {
        if (!document.getElementById(this.inputId)) return;
        setMeta("Import failed. Try again.");
        if (action) { action.disabled = false; action.textContent = "Retry"; }
        if (this._opts.onError) this._opts.onError(e);
      }
    }

    async _pickById(gameId, source, rowEl) {
      if (!gameId) return;
      let game = this._gameById.get(gameId);
      if (!game && Array.isArray(this._recentGames)) {
        game = this._recentGames.find((g) => g.id === gameId);
      }
      if (!game) {
        try {
          game = await window.api.get(`/games/${gameId}`);
        } catch (_) { return; }
      }
      this._handlePick(game, {
        source: source || "library",
        isExpansion: !!(game && game.is_expansion),
        dropdownItemEl: rowEl || null,
      });
    }

    async _handlePick(game, ctx) {
      if (!game || !game.id) return;
      let result;
      try {
        result = await this._opts.onPick(game, ctx);
      } catch (e) {
        if (this._opts.onError) this._opts.onError(e);
        return;
      }
      if (result && result.refuse) {
        // Caller refused the pick — leave dropdown open with the row in
        // an explanatory state.
        const row = ctx.dropdownItemEl;
        if (row) {
          const body = row.querySelector(".game-finder-dropdown-item__body");
          if (body) {
            body.innerHTML = `
              <div class="game-finder-dropdown-item__name">${escape(game.name)}</div>
              <div class="game-finder-dropdown-item__meta">${escape(result.reason || "Can't pick this game.")}</div>
            `;
          }
          const action = row.querySelector(".game-finder-dropdown-item__action");
          if (action) action.remove();
        }
        return;
      }
      // Default: close the dropdown — the caller now owns the next step.
      this._close();
    }
  }

  window.GameFinder = GameFinder;
})();
