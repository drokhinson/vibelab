// ui/status-tag.js — one badge component for every boardgame tile.
//
// Renders:
//   - owned / wishlist / played → coloured pill with icon + label
//   - none → "+" button that opens the picker ("Owned" or "Wishlist")
//
// EXCEPT on a corner-of-artwork slot (`corner: true`), where all three states
// collapse into one neutral chip. A tile's corner restates whatever the screen
// around it already said — twelve "Owned" pills on the Owned tab — so there it
// is a control, not a readout: same glyph, same colour, whatever the status.
// The state itself lives in the accessible name and in the sheet the chip
// opens. See the .status-tag--corner block in styles.css.
//
// The picker is a BOTTOM SHEET: a single body-level element shared across all
// tiles. Its shell — create, scroll lock, Escape, focus return, close
// animation — is ui/bottom-sheet.js, which also carries the polaroid modal
// chrome that keeps a sheet clear of the iOS keyboard and home indicator.
// This file owns only the panel's markup and the collection writes.
// It replaced a popover pinned under whichever chip was tapped — that put ~30px
// rows wherever the chip happened to sit, often near the top of the screen.
//
// A pick writes optimistically: the local status map is patched and a
// `status-changed` CustomEvent fires on `document` BEFORE the network call, so
// every surface rendering the tag repaints in the same frame. A failed write
// rolls the map back and surfaces the error through PolaroidPopup.alert.
//
// EVERY read and write here is about the VIEWER's collection, on every screen —
// another user's shelf included. You cannot edit someone else's collection, so
// a tag sitting on their tile still reads your relationship to that game and a
// pick still moves your shelf, not theirs. The sheet re-resolves its checked
// row from the viewer's own map (see viewerStatus) rather than trusting the
// status the call site passed, so a screen holding someone else's rows cannot
// mislabel it.

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
  // Sub-labels only the sheet shows — the pill is too small to carry them.
  const BLURB = {
    owned: "On your shelf",
    wishlist: "Games you want",
  };

  /**
   * The status the SHEET and the PILL must both show: the VIEWER's own
   * relationship to this game, never anybody else's.
   *
   * A tile can sit on someone else's shelf — Profile Other → Collection — and
   * the row backing it carries THAT user's status. A call site there could
   * hand us "owned" for a game the viewer has never touched, which would open
   * the sheet with Owned checked and offer "Remove from collection" for a row
   * that doesn't exist. So the viewer's own map wins whenever it has loaded;
   * `fallback` covers only the frame before it lands (null map = not loaded,
   * `{}` = loaded and the viewer owns nothing).
   *
   * The map is authoritative for all three states — bgb_collection_status_map
   * unions the collection rows with a derived `played` for every game the
   * viewer has a play on — so an absent entry means "no relationship", not
   * "unknown".
   */
  function viewerStatus(gameId, fallback) {
    const map = window.store && window.store.get && window.store.get("myCollectionMap");
    if (!map) return fallback || null;
    return map[gameId] || null;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /**
   * Tiny chip surfaced bottom-right on a game tile's ART to call out how many
   * expansions are associated with it. The semantics depend on caller
   * context (passed in via `opts.context`):
   *   - "owned"  → "N expansion(s) owned" (collection views, profile)
   *   - "total"  → "N expansion(s) in Boardgame Buddy" (browse/search)
   * Same git-fork icon either way so the chip is recognisable across
   * the app — the tooltip clarifies which sense applies.
   *
   * The chip positions itself absolutely, so it must be emitted INSIDE the
   * tile's art box (.collection-tile__art / .game-polaroid__photo) rather than
   * as a sibling of the whole tile — otherwise it anchors to the tile's
   * bottom-right, which is the title row, and lands on long game names.
   */
  function renderExpansionBadge(count, opts = {}) {
    if (!count || count < 1) return "";
    const noun = `expansion${count === 1 ? "" : "s"}`;
    const tip = opts.context === "total"
      ? `${count} ${noun} in Boardgame Buddy`
      : `${count} ${noun} owned`;
    return `
      <span class="expansion-count-badge" title="${tip}">
        <i data-icon="git-fork" class="w-3 h-3"></i> ${count}
      </span>
    `;
  }

  /**
   * Build the HTML for a tile's status tag.
   * @param {string} gameId
   * @param {("owned"|"wishlist"|"played"|null|undefined)} status
   * @param {Object} [opts]
   * @param {"sm-row"|"lg"} [opts.size] Size preset for the LABELLED pill.
   *   "sm-row" sits in a play card's meta row on the cream polaroid ground and
   *   takes its colours from .play-card__status-slot; "lg" is the game-detail
   *   hero. Ignored by `corner`, which is one fixed size everywhere.
   * @param {boolean} [opts.corner] This tag is a corner banner over box art —
   *   collection/wishlist tiles, polaroid photos, plays-list thumbs. Corner
   *   marks render as ONE neutral chip whatever the status: no colour, no
   *   word. Only the *visual* is status-free; title/aria-label still name the
   *   state, so nothing an assistive technology hears changes. Also suppresses
   *   `addLabel`, so the "+" is a pure icon button.
   * @param {boolean} [opts.pending] The viewer's collection map is still in
   *   flight — render nothing rather than guessing "not owned".
   * @param {string} [opts.addLabel] Inline text beside the "+" (suppressed by
   *   `corner`).
   * @param {string} [opts.gameName] Titles the picker sheet. Falls back to a
   *   generic heading when a call site doesn't have the name to hand.
   */
  function renderStatusTag(gameId, status, opts = {}) {
    const sizeCls =
      opts.size === "sm-row" ? " status-tag--sm-row" :
      opts.size === "lg" ? " status-tag--lg" :
      "";
    const cornerCls = opts.corner ? " status-tag--corner" : "";
    // Values land inside a single-quoted JS string inside an HTML attribute.
    // jsStr backslash-escapes the quote, esc then neutralises the HTML layer
    // (a bare " in a game name would otherwise close the onclick attribute).
    const gid = esc(jsStr(gameId));
    const name = esc(jsStr(opts.gameName || ""));
    const isStatus = status === "owned" || status === "wishlist" || status === "played";
    if (isStatus) {
      // title/aria-label are computed ONCE, above the branch, so the corner
      // chip cannot announce anything different from the pill it replaces.
      // That accessible name is now the only channel carrying the state to a
      // screen reader, and `title` the only one carrying it to a mouse user;
      // for touch, the answer is the sheet, which lands focus on the checked
      // row. Do not fold either into the `corner` branch.
      const label = LABEL[status];
      const body = opts.corner
        ? `<i data-icon="more-horizontal" class="w-3.5 h-3.5"></i>`
        : `<i data-icon="${ICON[status]}" class="w-3 h-3"></i>${label}`;
      // No status-tag--${status} on a corner chip: the colour IS the readout,
      // and dropping it is the point.
      const cls = opts.corner
        ? "status-tag status-tag--corner"
        : `status-tag status-tag--${status}${sizeCls}`;
      return `
        <button class="${cls}"
                title="${label} — change status"
                aria-label="${label} — change status"
                onclick="event.stopPropagation();window.statusPicker.openFor(event,'${gid}','${status}','${name}')">
          ${body}
        </button>
      `;
    }
    // The viewer's collection map hasn't landed yet, so "no relationship" is
    // a guess, not a fact. Render nothing instead of the "+", which reads as
    // "you don't own this" and nudges people to re-add a game they already
    // have. Callers set `pending` while their status map is in flight and
    // re-render once it resolves; every tile the tag sits in positions it
    // absolutely, so the empty string costs no layout.
    if (opts.pending) return "";
    // No collection relationship — render the + that opens the picker.
    // Callers can pass opts.addLabel to inline a text label next to the
    // plus (e.g. "Add to collection" on the game-detail action row). The
    // corner variant suppresses the label so the chip is a pure icon button.
    //
    // The "+" survives this change deliberately: it is not a status readout
    // but the add affordance, and on the feed rail and the explorer grid it is
    // the most useful control on the tile. So a corner slot reads "+" for no
    // relationship and the neutral chip for any relationship — one bit, which
    // is all a tile carries now.
    const addLabel = opts.addLabel && !opts.corner
      ? `<span class="status-tag__label">${esc(opts.addLabel)}</span>`
      : "";
    return `
      <button class="status-tag status-tag--add${sizeCls}${cornerCls}"
              title="Add to collection"
              aria-label="Add to collection"
              onclick="event.stopPropagation();window.statusPicker.openFor(event,'${gid}','','${name}')">
        <i data-icon="plus" class="w-3.5 h-3.5"></i>
        ${addLabel}
      </button>
    `;
  }

  class StatusPicker {
    constructor() {
      this._gameId = null;
      this._gameName = "";
      this._currentStatus = null;
      // The shell — create/scroll-lock/Escape/focus-return/close animation —
      // lives in ui/bottom-sheet.js and is shared with the Stats game picker.
      // This class only owns the panel markup and the writes.
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-status-sheet",
        className: "status-sheet",
        label: "Collection status",
      });
    }

    // ── Markup ──────────────────────────────────────────────────────────────

    _renderPanel() {
      const cur = this._currentStatus;
      const parts = [];

      // "Played" is derived from logged plays — there's no collection row to
      // set, so it can't be an option. Say so instead of silently omitting the
      // state the user is actually in.
      if (cur === "played") {
        parts.push(`
          <div class="status-sheet__note">
            <i data-icon="${ICON.played}" class="w-4 h-4"></i>
            Played — counted from your logged plays
          </div>`);
      }

      // Unlike the old popover, the CURRENT status is listed and checked —
      // that's what makes this a radio group rather than a menu of "the other
      // things you could be".
      for (const s of ["owned", "wishlist"]) {
        const on = s === cur;
        parts.push(`
          <button class="status-sheet__opt" type="button" role="radio"
                  aria-checked="${on ? "true" : "false"}" data-status="${s}">
            <i data-icon="${ICON[s]}" class="w-5 h-5"></i>
            <span class="status-sheet__opt-label">${LABEL[s]}<span class="status-sheet__opt-sub">${BLURB[s]}</span></span>
            <span class="status-sheet__radio" aria-hidden="true"></span>
          </button>`);
      }

      // Remove is only meaningful when a real collection row exists.
      // Played-only games have no row to delete — clearing it would mean
      // deleting plays, which isn't what this control does.
      if (cur === "owned" || cur === "wishlist") {
        parts.push(`<div class="status-sheet__rule"></div>`);
        parts.push(`
          <button class="status-sheet__opt status-sheet__opt--danger" type="button"
                  data-action="remove">
            <i data-icon="trash-2" class="w-5 h-5"></i>
            <span class="status-sheet__opt-label">Remove from collection</span>
          </button>`);
      }

      const heading = this._gameName ? esc(this._gameName) : "Collection status";
      return `
        <div class="status-sheet__panel" role="radiogroup" aria-label="Collection status">
          <div class="status-sheet__grip" aria-hidden="true"></div>
          <h3 class="status-sheet__title">${heading}</h3>
          <p class="status-sheet__sub">Where does this sit in your collection?</p>
          ${parts.join("")}
          <button class="status-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }

    // ── Open / close ────────────────────────────────────────────────────────

    /**
     * @param {Event} event      The originating tap (focus returns here on close).
     * @param {string} gameId
     * @param {string} currentStatus  "" when the viewer has no relationship.
     *   Only a fallback — the viewer's own map wins, see viewerStatus().
     * @param {string} [gameName]     Titles the sheet.
     */
    openFor(event, gameId, currentStatus, gameName) {
      event.stopPropagation();

      this._gameId = gameId;
      this._gameName = gameName || "";
      // Re-resolved rather than trusted: this sheet both reads and writes the
      // VIEWER's collection, on every screen, including one showing another
      // user's shelf. What it checks has to match what a pick would change.
      this._currentStatus = viewerStatus(gameId, currentStatus);

      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: (event && event.currentTarget) || null,
        onClick: (e) => {
          if (e.target.closest('[data-action="remove"]')) { this._remove(); return; }
          const setBtn = e.target.closest("[data-status]");
          if (setBtn) this._choose(setBtn.dataset.status);
        },
        // Land focus on the row the user is currently in, so a keyboard or
        // screen-reader user hears their state before the alternatives.
        onOpen: (root) => {
          const focusTarget = root.querySelector('[aria-checked="true"]')
            || root.querySelector(".status-sheet__opt");
          if (focusTarget) focusTarget.focus();
        },
      });
    }

    close() {
      this._gameId = null;
      this._gameName = "";
      this._currentStatus = null;
      this._sheet.close();
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    /**
     * Patch the cached map so any reader (play cards, recent-plays thumbs,
     * anything pulling `window.store.get('myCollectionMap')` synchronously)
     * sees the new state, then announce it. `null` flags "no relationship" —
     * listeners delete their local entry so the tile flips back to "+".
     * Called BEFORE the network write so the pill moves in the same frame as
     * the tap, and again with the old value if that write fails.
     */
    _applyLocal(gameId, status) {
      const cur = (window.store && window.store.get && window.store.get("myCollectionMap")) || {};
      const next = { ...cur };
      if (status == null) delete next[gameId];
      else next[gameId] = status;
      window.store.set("myCollectionMap", next);
      document.dispatchEvent(new CustomEvent("status-changed", {
        detail: { gameId, status: status == null ? null : status },
      }));
    }

    async _choose(status) {
      const gameId = this._gameId;
      const prev = this._currentStatus;
      this.close();
      if (!gameId || (status !== "owned" && status !== "wishlist")) return;
      if (status === prev) return;                 // re-picking the current row is a no-op
      this._applyLocal(gameId, status);
      try {
        await window.Collection.add(gameId, status);
      } catch (e) {
        this._applyLocal(gameId, prev);
        window.PolaroidPopup.alert({
          title: "Couldn't save that",
          body: (e && e.message) || `${LABEL[status]} didn't stick — check your connection and try again.`,
        });
      }
    }

    async _remove() {
      const gameId = this._gameId;
      const prev = this._currentStatus;
      this.close();
      if (!gameId) return;
      this._applyLocal(gameId, null);
      try {
        await window.Collection.removeByGame(gameId);
      } catch (e) {
        this._applyLocal(gameId, prev);
        window.PolaroidPopup.alert({
          title: "Couldn't remove that",
          body: (e && e.message) || "The game is still in your collection — check your connection and try again.",
        });
      }
    }
  }

  window.renderStatusTag = renderStatusTag;
  window.renderExpansionBadge = renderExpansionBadge;
  window.statusPicker = new StatusPicker();
})();
