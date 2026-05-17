// ui/status-tag.js — one badge component for every boardgame tile.
//
// Renders:
//   - owned / wishlist / played → coloured pill with icon + label
//   - none → "+" button that opens a small popover ("Owned" or "Wishlist")
//
// The popover is a single body-level element shared across all tiles. After a
// pick, Collection.add() runs and a `status-changed` CustomEvent fires on
// `document` so any view rendering the tag can patch its local status map and
// re-render without a full reload.

(function () {
  const ICON = {
    owned: "library-big",
    wishlist: "star",
    played: "history",
  };
  const LABEL = {
    owned: "Owned",
    wishlist: "Wishlist",
    played: "Played",
  };

  // The escaping helpers live local to this file. The gameId is a UUID we put
  // into an inline onclick, so just JS-escape it; jsStr handles both that and
  // the rare apostrophe-in-name case for any future label.
  function jsStr(s) {
    return String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  /**
   * Build the HTML for a tile's status tag.
   * @param {string} gameId
   * @param {("owned"|"wishlist"|"played"|null|undefined)} status
   * @param {{ size?: "sm"|"xs" }} [opts]
   */
  /**
   * Tiny chip surfaced bottom-right on a game tile to call out how many
   * expansions are associated with it. The semantics depend on caller
   * context (passed in via `opts.context`):
   *   - "owned"  → "N expansion(s) owned" (collection views, profile)
   *   - "total"  → "N expansion(s) in BoardgameBuddy" (browse/search)
   * Same git-fork icon either way so the chip is recognisable across
   * the app — the tooltip clarifies which sense applies.
   */
  function renderExpansionBadge(count, opts = {}) {
    if (!count || count < 1) return "";
    const noun = `expansion${count === 1 ? "" : "s"}`;
    const tip = opts.context === "total"
      ? `${count} ${noun} in BoardgameBuddy`
      : `${count} ${noun} owned`;
    return `
      <span class="expansion-count-badge" title="${tip}">
        <i data-lucide="git-fork" class="w-3 h-3"></i> ${count}
      </span>
    `;
  }

  function renderStatusTag(gameId, status, opts = {}) {
    const sizeCls =
      opts.size === "xs" ? " status-tag--xs" :
      opts.size === "lg" ? " status-tag--lg" :
      "";
    // Compact mode is the icon-only chip rendered as a corner banner on a
    // boardgame image. Picker still opens on tap, so users can flip the
    // shelf-state from any context — no label, just colour + icon.
    const compactCls = opts.compact ? " status-tag--compact" : "";
    const isStatus = status === "owned" || status === "wishlist" || status === "played";
    if (isStatus) {
      const label = opts.compact ? "" : LABEL[status];
      return `
        <button class="status-tag status-tag--${status}${sizeCls}${compactCls}"
                title="${LABEL[status]} — change status"
                aria-label="${LABEL[status]} — change status"
                onclick="event.stopPropagation();window.statusPicker.openFor(event,'${jsStr(gameId)}','${status}')">
          <i data-lucide="${ICON[status]}" class="w-3 h-3"></i>
          ${label}
        </button>
      `;
    }
    // No collection relationship — render the + that opens the picker.
    // Callers can pass opts.addLabel to inline a text label next to the
    // plus (e.g. "Add to collection" on the game-detail action row). The
    // compact variant suppresses the label so the chip is a pure icon button.
    const addLabel = opts.addLabel && !opts.compact
      ? `<span class="status-tag__label">${String(opts.addLabel).replace(/[&<>"']/g, (c) => ({
          "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]))}</span>`
      : "";
    return `
      <button class="status-tag status-tag--add${sizeCls}${compactCls}"
              title="Add to collection"
              aria-label="Add to collection"
              onclick="event.stopPropagation();window.statusPicker.openFor(event,'${jsStr(gameId)}','')">
        <i data-lucide="plus" class="w-3.5 h-3.5"></i>
        ${addLabel}
      </button>
    `;
  }

  class StatusPicker {
    constructor() {
      this._el = null;
      this._gameId = null;
      this._currentStatus = null;
      this._outsideHandler = (e) => {
        if (this._el && !this._el.contains(e.target)) this.close();
      };
    }

    _ensureEl() {
      if (this._el) return;
      this._el = document.createElement("div");
      this._el.className = "status-picker hidden";
      // Body listener is bound once; option HTML is re-rendered each open.
      this._el.addEventListener("click", (e) => {
        const removeBtn = e.target.closest('[data-action="remove"]');
        if (removeBtn) { this._remove(); return; }
        const setBtn = e.target.closest("[data-status]");
        if (setBtn) this._choose(setBtn.dataset.status);
      });
      document.body.appendChild(this._el);
    }

    _populateOptions() {
      if (!this._el) return;
      const cur = this._currentStatus;
      const parts = [];
      // "Played" is derived (no DB row), so it's never a target to set —
      // only Owned and Wishlist appear as set-targets.
      for (const s of ["owned", "wishlist"]) {
        if (s === cur) continue;
        parts.push(`
          <button class="status-picker__opt" data-status="${s}">
            <i data-lucide="${ICON[s]}" class="w-3.5 h-3.5"></i> ${LABEL[s]}
          </button>`);
      }
      // Remove is only meaningful when a real collection row exists.
      // Played-only games have no row to delete — clearing it would mean
      // deleting plays, which isn't what this control does.
      if (cur === "owned" || cur === "wishlist") {
        parts.push(`
          <button class="status-picker__opt status-picker__opt--danger" data-action="remove">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Remove
          </button>`);
      }
      this._el.innerHTML = parts.join("");
      if (window.lucide) window.lucide.createIcons({ nodes: [this._el] });
    }

    openFor(event, gameId, currentStatus) {
      event.stopPropagation();
      this._ensureEl();
      this._gameId = gameId;
      this._currentStatus = currentStatus || null;
      this._populateOptions();
      const rect = event.currentTarget.getBoundingClientRect();
      // Pin the popover under the tag, nudging it inside the viewport so
      // it never spills off the right edge on phones.
      const top = rect.bottom + window.scrollY + 4;
      let left = rect.left + window.scrollX;
      const maxLeft = window.scrollX + window.innerWidth - 160;
      if (left > maxLeft) left = maxLeft;
      this._el.style.top = `${top}px`;
      this._el.style.left = `${left}px`;
      this._el.classList.remove("hidden");
      // Defer adding the outside-click handler so the originating click
      // doesn't immediately close the popover.
      setTimeout(() => document.addEventListener("click", this._outsideHandler, true), 0);
    }

    close() {
      if (this._el) this._el.classList.add("hidden");
      this._gameId = null;
      this._currentStatus = null;
      document.removeEventListener("click", this._outsideHandler, true);
    }

    async _choose(status) {
      const gameId = this._gameId;
      this.close();
      if (!gameId || (status !== "owned" && status !== "wishlist")) return;
      try {
        await window.Collection.add(gameId, status);
      } catch (e) {
        alert(e.message || "Failed to add");
        return;
      }
      // Patch the cached map so any reader (play cards, recent-plays thumbs,
      // anything pulling `window.store.get('myCollectionMap')` synchronously)
      // sees the new state without waiting for the next refetch.
      const cur = (window.store && window.store.get && window.store.get("myCollectionMap")) || {};
      window.store.set("myCollectionMap", { ...cur, [gameId]: status });
      document.dispatchEvent(new CustomEvent("status-changed", {
        detail: { gameId, status },
      }));
    }

    async _remove() {
      const gameId = this._gameId;
      this.close();
      if (!gameId) return;
      try {
        await window.Collection.removeByGame(gameId);
      } catch (e) {
        alert(e.message || "Failed to remove");
        return;
      }
      const cur = (window.store && window.store.get && window.store.get("myCollectionMap")) || {};
      const next = { ...cur };
      delete next[gameId];
      window.store.set("myCollectionMap", next);
      // null status flags "no relationship" — listeners delete the entry
      // from their local status map so the tile flips back to the + button.
      document.dispatchEvent(new CustomEvent("status-changed", {
        detail: { gameId, status: null },
      }));
    }
  }

  window.renderStatusTag = renderStatusTag;
  window.renderExpansionBadge = renderExpansionBadge;
  window.StatusPicker = StatusPicker;
  window.statusPicker = new StatusPicker();
})();
