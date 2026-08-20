// widgets/import-expansions-modal.js — "Import expansions" popup.
//
// Lists the expansions BoardGameGeek links to a base game that BgB hasn't
// imported yet (GET /games/{id}/expansions/available — already-imported rows
// are filtered server-side and each name has the base game's name stripped
// off the front). A + per row imports it into the catalog and links it to
// this base game; the row then leaves the list.
//
// The whole list arrives in one response, so the filter field is purely
// client-side — no debounce, no second request. It matches the displayed
// name and BGG's full name (so typing the base game's name still hits).
//
// Opened from the expansion section on both surfaces that own expansions:
//   - views/game-detail-view.js (boardgame page)
//   - views/play-flow-view.js   (host Gather screen)
//
// Since expansions are hidden from game search, this is the only path by
// which one enters the catalog. Import is catalog-only — it never touches
// the caller's collection.
//
// Reuses the polaroid-popup backdrop + card chrome for visual consistency
// (per .claude/rules/ui-object-design.md §3c) but owns its own
// .import-exp-modal* body classes, mirroring widgets/add-game-modal.js.

// @ts-check

(function () {
  const BACKDROP_ID = "bgb-import-expansions-modal";

  /**
   * @typedef {Object} ExpansionCandidate
   * @property {number} bgg_id
   * @property {string} name       Base-game prefix stripped.
   * @property {string} full_name  BGG's original string.
   * @property {string} [bgg_url]
   */

  /**
   * @typedef {Object} ImportExpansionsModalOpts
   * @property {string} gameId     Base game UUID.
   * @property {string} [gameName] Shown in the subtitle.
   * @property {(expansion: any) => void} [onImported] Fires after each
   *   successful import with the new ExpansionListItem.
   */

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  let _previousFocus = null;
  let _escHandler = null;
  let _opts = null;
  /** @type {ExpansionCandidate[]} Everything loaded, minus what's been imported. */
  let _candidates = [];
  let _query = "";

  function _root() {
    return document.getElementById(BACKDROP_ID);
  }

  function _body() {
    const root = _root();
    return root ? root.querySelector(".import-exp-modal__body") : null;
  }

  function _searchInput() {
    const root = _root();
    return /** @type {HTMLInputElement|null} */ (
      root ? root.querySelector(".import-exp-search__input") : null
    );
  }

  /** Paint into the card body and re-run Lucide over just that subtree. */
  function _setBody(html) {
    const host = _body();
    if (!host) return;
    host.innerHTML = html;
    if (window.lucide) window.lucide.createIcons({ root: host });
  }

  function _renderStates() {
    return {
      loading: `
        <ul class="import-exp-list" aria-busy="true">
          ${[0, 1, 2].map(() => `
            <li class="import-exp-row import-exp-row--skeleton">
              <span class="import-exp-row__name"></span>
            </li>
          `).join("")}
        </ul>`,
      error: (msg) => `
        <div class="import-exp-modal__state">
          <p class="import-exp-modal__state-text">${escape(msg)}</p>
          <button type="button" class="btn btn-sm import-exp-modal__retry"
                  data-exp-action="retry">Retry</button>
        </div>`,
      empty: (text) => `
        <div class="import-exp-modal__state">
          <p class="import-exp-modal__state-text">${escape(text)}</p>
        </div>`,
    };
  }

  /**
   * Substring match against the displayed name AND BGG's full name — the
   * base game's name is stripped from what's shown, so a user who types it
   * would otherwise get nothing.
   * @param {ExpansionCandidate} e
   */
  function _matches(e, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return String(e.name || "").toLowerCase().includes(needle)
      || String(e.full_name || "").toLowerCase().includes(needle);
  }

  /** Escape `text`, wrapping the first case-insensitive hit on `q` in a <mark>. */
  function _highlight(text, q) {
    const raw = String(text ?? "");
    if (!q) return escape(raw);
    const i = raw.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escape(raw);
    return escape(raw.slice(0, i))
      + `<mark class="import-exp-row__hl">${escape(raw.slice(i, i + q.length))}</mark>`
      + escape(raw.slice(i + q.length));
  }

  /** @param {ExpansionCandidate[]} list */
  function _renderList(list) {
    return `
      <ul class="import-exp-list">
        ${list.map((e) => `
          <li class="import-exp-row" data-exp-row="${e.bgg_id}">
            <span class="import-exp-row__body">
              <span class="import-exp-row__name" title="${escape(e.full_name || e.name)}">${_highlight(e.name, _query)}</span>
              <span class="import-exp-row__error" hidden></span>
            </span>
            <button type="button" class="import-exp-row__add"
                    data-exp-action="import" data-exp-bgg-id="${e.bgg_id}"
                    aria-label="Import ${escape(e.name)}">
              <i data-lucide="plus" class="w-4 h-4"></i>
            </button>
          </li>
        `).join("")}
      </ul>
      <p class="import-exp-modal__note">
        Imported expansions join the BoardgameBuddy catalog. Your collection isn't changed.
      </p>`;
  }

  /** Show/hide the filter field and keep its clear button in sync. */
  function _syncSearchChrome() {
    const root = _root();
    if (!root) return;
    const host = root.querySelector(".import-exp-search");
    if (host) host.hidden = _candidates.length === 0;
    const clear = root.querySelector(".import-exp-search .field-clear-btn");
    if (clear) clear.hidden = !_query;
  }

  /**
   * Paint the row list for the current query. Two different empties:
   * nothing left to import at all, vs nothing matching the filter — the
   * filter field stays up for the second so the user can back out of it.
   */
  function _renderRows() {
    _syncSearchChrome();
    if (_candidates.length === 0) {
      _setBody(_renderStates().empty("All caught up — every expansion is imported."));
      return;
    }
    const q = _query.trim();
    const visible = _candidates.filter((e) => _matches(e, q));
    if (visible.length === 0) {
      _setBody(_renderStates().empty(`No expansion matches “${q}”.`));
      return;
    }
    _setBody(_renderList(visible));
  }

  function _setQuery(value) {
    _query = value || "";
    _renderRows();
  }

  async function _load() {
    if (!_opts) return;
    const states = _renderStates();
    _candidates = [];
    _query = "";
    const input = _searchInput();
    if (input) input.value = "";
    _syncSearchChrome();
    _setBody(states.loading);
    let list;
    try {
      list = await window.api.get(`/games/${_opts.gameId}/expansions/available`);
    } catch (e) {
      if (!_root()) return; // dismissed mid-flight
      _setBody(states.error((e && e.message) || "Couldn't reach BoardGameGeek."));
      return;
    }
    if (!_root()) return;
    if (!Array.isArray(list) || list.length === 0) {
      // Two different nothings: everything's already here vs BGG lists none.
      // We can't tell them apart from an empty array alone, so say the thing
      // that's true either way without implying the game has no expansions.
      _setBody(states.empty(
        "No new expansions to import — BoardgameBuddy already has every expansion BoardGameGeek lists for this game."
      ));
      return;
    }
    _candidates = list;
    _renderRows();
  }

  async function _import(bggId, btnEl) {
    if (!_opts || !btnEl) return;
    const row = btnEl.closest("[data-exp-row]");
    const errEl = row ? row.querySelector(".import-exp-row__error") : null;
    if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
    if (row) row.classList.remove("import-exp-row--error");
    btnEl.disabled = true;
    btnEl.innerHTML = `<span class="game-finder-spinner" aria-hidden="true"></span>`;

    let expansion;
    try {
      expansion = await window.api.post(`/games/${_opts.gameId}/expansions/import/${bggId}`);
    } catch (e) {
      if (!_root()) return;
      // Fail this row only — the rest of the list stays usable.
      btnEl.disabled = false;
      btnEl.innerHTML = `<i data-lucide="rotate-ccw" class="w-4 h-4"></i>`;
      if (window.lucide) window.lucide.createIcons({ root: btnEl });
      if (row) row.classList.add("import-exp-row--error");
      if (errEl) {
        errEl.textContent = (e && e.message) || "Import failed — tap to retry.";
        errEl.hidden = false;
      }
      return;
    }

    // Any surface showing this game's expansions or a cached search result is
    // now stale.
    if (window.Game) {
      if (window.Game.invalidateBundle) window.Game.invalidateBundle(_opts.gameId);
      if (window.Game.invalidateSearch) window.Game.invalidateSearch();
    }
    if (typeof _opts.onImported === "function") {
      try { _opts.onImported(expansion); } catch (_) {}
    }

    if (!_root()) return;
    _candidates = _candidates.filter((c) => c.bgg_id !== bggId);
    // Drop just this row rather than re-rendering, so a sibling row that
    // failed keeps its inline error. Fall back to a full repaint once the
    // visible list empties out — _renderRows picks the right empty state
    // (nothing left at all vs nothing matching the filter).
    if (row && row.parentNode) row.parentNode.removeChild(row);
    const listEl = _body() && _body().querySelector(".import-exp-list");
    if (!listEl || !listEl.querySelector("[data-exp-row]")) _renderRows();
    else _syncSearchChrome();
  }

  /** @param {ImportExpansionsModalOpts} opts */
  function open(opts) {
    if (!opts || !opts.gameId) {
      throw new Error("ImportExpansionsModal.open: gameId is required");
    }
    dismiss(); // singleton — never stack two

    _opts = opts;
    _previousFocus = document.activeElement;

    const root = document.createElement("div");
    root.id = BACKDROP_ID;
    root.className = "polaroid-popup__backdrop";
    root.innerHTML = `
      <div class="polaroid-popup__card polaroid-popup__card--confirm import-exp-modal"
           role="dialog" aria-modal="true" aria-label="Import expansions">
        <button class="polaroid-popup__close" aria-label="Close">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
        <div class="polaroid-popup__title">Import expansions</div>
        <p class="polaroid-popup__body import-exp-modal__hint">
          ${opts.gameName
            ? `Expansions BoardGameGeek lists for <strong>${escape(opts.gameName)}</strong>.`
            : "Expansions BoardGameGeek lists for this game."}
        </p>
        <div class="game-finder import-exp-search" hidden>
          <i data-lucide="search" class="w-4 h-4 game-finder__icon"></i>
          <input type="text" class="input input-bordered game-finder__input import-exp-search__input"
                 placeholder="Filter expansions…" aria-label="Filter expansions by name"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
          <button type="button" class="field-clear-btn"
                  data-exp-action="clear-filter" aria-label="Clear filter" hidden>
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
        <div class="import-exp-modal__body"></div>
      </div>
    `;
    root.addEventListener("click", (ev) => {
      if (ev.target === root) dismiss();
    });
    document.body.appendChild(root);
    if (window.lucide) window.lucide.createIcons({ root });

    const closeBtn = root.querySelector(".polaroid-popup__close");
    if (closeBtn) closeBtn.addEventListener("click", () => dismiss());

    // One delegated listener on the card — rows are re-rendered repeatedly,
    // so per-row handlers would need re-binding on every paint.
    const card = root.querySelector(".import-exp-modal");
    if (card) {
      card.addEventListener("click", (ev) => {
        const target = /** @type {Element|null} */ (ev.target);
        const hit = target && target.closest("[data-exp-action]");
        if (!hit) return;
        ev.preventDefault();
        const action = hit.getAttribute("data-exp-action");
        if (action === "retry") {
          _load();
        } else if (action === "import") {
          _import(Number(hit.getAttribute("data-exp-bgg-id")), hit);
        } else if (action === "clear-filter") {
          const input = _searchInput();
          if (input) { input.value = ""; input.focus(); }
          _setQuery("");
        }
      });
    }

    // Filtering is local to the loaded list, so this runs straight off the
    // keystroke — no debounce, no request.
    const input = _searchInput();
    if (input) {
      input.addEventListener("input", (ev) => {
        _setQuery(/** @type {HTMLInputElement} */ (ev.target).value);
      });
    }

    _escHandler = (e) => {
      if (e.key !== "Escape") return;
      // Layered, mirroring the GameFinder/add-game-modal pairing: the first
      // Escape backs out of the filter, the next closes the popup.
      const el = _searchInput();
      if (el && el.value) {
        e.preventDefault();
        e.stopPropagation();
        el.value = "";
        _setQuery("");
        return;
      }
      dismiss();
    };
    document.addEventListener("keydown", _escHandler, true);

    _load();
  }

  function dismiss() {
    if (_escHandler) {
      document.removeEventListener("keydown", _escHandler, true);
      _escHandler = null;
    }
    const existing = _root();
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    _opts = null;
    _candidates = [];
    _query = "";
    if (_previousFocus && typeof _previousFocus.focus === "function") {
      try { _previousFocus.focus(); } catch (_) {}
    }
    _previousFocus = null;
  }

  window.ImportExpansionsModal = { open, dismiss };
})();
