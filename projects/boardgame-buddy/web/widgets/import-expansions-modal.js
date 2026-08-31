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
// The server returns the list ordered by BGG owner count, descending, with
// unknown counts alphabetical at the tail — candidates are by definition
// absent from BgB's catalog, so there is no local popularity signal to rank
// them on. Never re-sort client-side: _renderRows filters, which preserves
// order, and the owners chip is what makes that order legible.
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
   * @property {number|null} [bgg_owned] BGG owners — the sort key. Null when
   *   BGG's stats lookup failed, in which case the row shows no chip.
   * @property {string} [bgg_url]
   */

  /**
   * @typedef {Object} ImportExpansionsModalOpts
   * @property {string} gameId     Base game UUID.
   * @property {string} [gameName] Shown in the subtitle.
   * @property {(expansion: any) => void} [onImported] Fires after each
   *   successful import with the new ExpansionListItem.
   */

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

  /** Paint into the card body and re-hydrate icons over just that subtree. */
  function _setBody(html) {
    const host = _body();
    if (!host) return;
    host.innerHTML = html;
    window.BgbIcons.render(host);
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
          <p class="import-exp-modal__state-text">${escapeHtml(msg)}</p>
          <button type="button" class="btn btn-sm import-exp-modal__retry"
                  data-exp-action="retry">Retry</button>
        </div>`,
      empty: (text) => `
        <div class="import-exp-modal__state">
          <p class="import-exp-modal__state-text">${escapeHtml(text)}</p>
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
    if (!q) return escapeHtml(raw);
    const i = raw.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escapeHtml(raw);
    return escapeHtml(raw.slice(0, i))
      + `<mark class="import-exp-row__hl">${escapeHtml(raw.slice(i, i + q.length))}</mark>`
      + escapeHtml(raw.slice(i + q.length));
  }

  /** 12345 -> "12.3k". The chip sits inline in a 44px row, so five digits
   * don't fit; the full number rides along in the title attribute. */
  function _ownersLabel(n) {
    if (n >= 10000) return Math.round(n / 1000) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  /** @param {ExpansionCandidate[]} list */
  function _renderList(list) {
    return `
      <ul class="import-exp-list">
        ${list.map((e) => `
          <li class="import-exp-row" data-exp-row="${e.bgg_id}">
            <span class="import-exp-row__body">
              <span class="import-exp-row__name" title="${escapeHtml(e.full_name || e.name)}">${_highlight(e.name, _query)}</span>
              <span class="import-exp-row__error" hidden></span>
            </span>
            ${e.bgg_owned >= 1 ? `
              <span class="import-exp-row__owners"
                    title="${e.bgg_owned.toLocaleString()} BoardGameGeek users own this">
                <i data-icon="users" class="w-3 h-3"></i>${_ownersLabel(e.bgg_owned)}
              </span>` : ""}
            <button type="button" class="import-exp-row__add"
                    data-exp-action="import" data-exp-bgg-id="${e.bgg_id}"
                    aria-label="Import ${escapeHtml(e.name)}">
              <i data-icon="plus" class="w-4 h-4"></i>
            </button>
          </li>
        `).join("")}
      </ul>
      <p class="import-exp-modal__note">
        Imported expansions join the BoardgameBuddy catalog. Your collection isn't changed.
      </p>`;
  }

  /**
   * Show or hide the filter field itself — there is nothing to filter until
   * the candidates land. Its × keeps itself in sync (ui/search-field.js).
   */
  function _syncSearchChrome() {
    const root = _root();
    if (!root) return;
    const host = root.querySelector(".import-exp-search");
    if (host) host.hidden = _candidates.length === 0;
    // _load() empties the field directly rather than through a keystroke, so
    // the × has to be re-derived here — nothing dispatched an `input` event
    // for the shared listener to act on.
    window.BgbSearchField.sync(host || root);
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
      btnEl.innerHTML = `<i data-icon="rotate-ccw" class="w-4 h-4"></i>`;
      window.BgbIcons.render(btnEl);
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
          <i data-icon="x" class="w-4 h-4"></i>
        </button>
        <div class="polaroid-popup__title">Import expansions</div>
        <p class="polaroid-popup__body import-exp-modal__hint">
          ${opts.gameName
            ? `Expansions BoardGameGeek lists for <strong>${escapeHtml(opts.gameName)}</strong>.`
            : "Expansions BoardGameGeek lists for this game."}
        </p>
        <div class="game-finder import-exp-search" data-search-host hidden>
          <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
          <input type="text" id="import-exp-filter-input"
                 class="input input-bordered game-finder__input import-exp-search__input"
                 placeholder="Filter expansions…" aria-label="Filter expansions by name"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
          ${window.BgbSearchField.clearButton({ label: "Clear filter" })}
        </div>
        <div class="import-exp-modal__body"></div>
      </div>
    `;
    root.addEventListener("click", (ev) => {
      if (ev.target === root) dismiss();
    });
    document.body.appendChild(root);
    window.BgbIcons.render(root);

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
        // Same path the × takes — BgbSearchField empties the box and
        // dispatches the `input` event _setQuery already listens for.
        window.BgbSearchField.clearInput(el);
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
