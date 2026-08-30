// @ts-check
// domain/shelf-controller.js — the data half of a collection spoke.
//
// Collection and Wishlist are the same screen with different shelves, and
// before this they carried byte-identical copies of the load / filter / page
// logic. That state lives here now; the views own only their markup.
//
// The model: pull a whole shelf once via Collection.shelf() (cached, SWR),
// then derive every page, filter and search from it locally. A page turn does
// no I/O at all. Two rules callers must respect:
//
//   * Every shelf is presented alphabetically by game name — that is the one
//     order these screens have (ShelfFilter.sortShelf), applied after the
//     filters and before the page slice. The server's own recency ordering is
//     left for the Profile hub's preview strip, which reads the bundle direct.
//   * A shelf past the endpoint's row cap comes back `truncated`. Narrowing
//     one of those locally would silently miss games, so those queries fall
//     back to the server-paginated grid — see serverFallback().

(function () {
  class ShelfController {
    /**
     * @param {Object} opts
     * @param {string[]} opts.modes        Shelf statuses this spoke shows.
     * @param {number} opts.perPage
     * @param {() => string} opts.target   Whose shelf — viewer id or route param.
     * @param {() => (string|null)} [opts.otherUserId] Non-null when viewing someone else.
     * @param {() => void} opts.onChange   Repaint hook; called after every state change.
     */
    constructor({ modes, perPage, target, otherUserId, onChange }) {
      this.modes = modes;
      this.perPage = perPage;
      this._target = target;
      this._otherUserId = otherUserId || (() => null);
      this._onChange = onChange;
      this.reset();
    }

    reset() {
      const byMode = (v) => Object.fromEntries(this.modes.map((m) => [m, typeof v === "function" ? v() : v]));
      /** Whole shelves as returned by Collection.shelf(): {items,total,truncated}. */
      this.shelf = byMode(null);
      /** Current page's rows, derived. */
      this.items = byMode(() => []);
      /** Filtered total, derived. */
      this.total = byMode(0);
      this.page = byMode(1);
      this.loading = byMode(false);
      this.error = byMode(null);
      // Monotonic per mode: a fetch resolving after a newer one for the same
      // mode (tab flip, forced refresh) must not write its result back.
      this._seq = byMode(0);
      this.query = "";
      this.filters = { players: null, playtimeMin: null, playtimeMax: null, playMode: null };
      this._searchTimer = null;
    }

    // ── Derivation ──────────────────────────────────────────────────────────
    filterSpec() {
      const f = this.filters;
      return {
        search: this.query || null,
        players: f.players,
        playtimeMin: f.playtimeMin,
        playtimeMax: f.playtimeMax,
        playMode: f.playMode,
        excludeExpansions: true,
      };
    }

    activeFilterCount() {
      const f = this.filters;
      let n = 0;
      if (f.players) n++;
      if (f.playtimeMin != null || f.playtimeMax != null) n++;
      if (f.playMode) n++;
      return n;
    }

    isNarrowing() {
      return !!(this.query || this.activeFilterCount() > 0);
    }

    /** Shelf bigger than the row cap AND the user is narrowing it. */
    serverFallback(mode) {
      const sh = this.shelf[mode];
      return !!(sh && sh.truncated && this.isNarrowing());
    }

    /**
     * No data to paint yet, and no error explaining why — covers both "load
     * hasn't started" and "load in flight". Without the first case the view
     * flashes an empty state ("No owned games yet") in the frame between the
     * cache miss and the fetch starting.
     */
    isPending(mode) {
      return this.loading[mode] || (!this.shelf[mode] && !this.error[mode]);
    }

    /**
     * Nothing has loaded on ANY shelf, so the whole screen is a spinner. Once
     * one shelf has data the chrome stays up and only the body shows a loader
     * — switching to a not-yet-loaded tab must not blank out the toggle.
     */
    isColdLoad(mode) {
      return !this.error[mode] && this.modes.every((m) => !this.shelf[m]);
    }

    /** Recompute the visible page + filtered total for `mode`. */
    derive(mode) {
      if (this.serverFallback(mode)) return; // loadGridPage owns these fields
      const sh = this.shelf[mode];
      if (!sh) {
        this.items[mode] = [];
        this.total[mode] = 0;
        return;
      }
      const filtered = window.ShelfFilter.sortShelf(
        window.ShelfFilter.filterShelf(sh.items, this.filterSpec()),
      );
      const paged = window.ShelfFilter.pageOf(filtered, this.page[mode], this.perPage);
      this.page[mode] = paged.page;
      this.items[mode] = paged.rows;
      // A partial seed (profile bundle) knows the real shelf size but holds
      // only page 1, so trust its total only while nothing is filtered.
      this.total[mode] = (sh.partial && !this.isNarrowing())
        ? (sh.total || filtered.length)
        : paged.total;
    }

    deriveAll() {
      for (const m of this.modes) this.derive(m);
    }

    /**
     * Seed a shelf synchronously from an already-cached copy, so a view can
     * paint page 1 in its first frame. Returns true on a hit.
     */
    hydrate(mode) {
      const cached = window.Collection.cachedShelf(this._target(), mode);
      if (!cached) return false;
      this.shelf[mode] = cached;
      return true;
    }

    /**
     * Seed from the profile bundle's first page — enough to paint, not to page.
     * The bundle's page is the server's recency order, so once derive() sorts
     * it this is the alphabetical arrangement of a recent slice, not the real
     * alphabetical page 1. It is a first-frame stand-in for a cache miss and
     * load() overwrites it with the whole shelf; hydrate() from a cached shelf
     * is tried first and is exact.
     */
    seedPartial(mode, items, total) {
      if (!Array.isArray(items) || !items.length) return false;
      this.shelf[mode] = { items, total: total || items.length, truncated: false, partial: true };
      return true;
    }

    // ── Loading ─────────────────────────────────────────────────────────────
    async load(mode, { force = false } = {}) {
      const seq = ++this._seq[mode];
      this.loading[mode] = true;
      this.error[mode] = null;
      this._onChange();
      try {
        const sh = await window.Collection.shelf(this._target(), mode, { force });
        if (seq !== this._seq[mode]) return;
        this.shelf[mode] = sh;
        if (this.serverFallback(mode)) {
          await this.loadGridPage(mode);
          return;
        }
        // Derive here rather than leaning on the caller's repaint: items/total
        // must be correct the moment load() resolves, for any consumer.
        this.derive(mode);
      } catch (e) {
        if (seq !== this._seq[mode]) return;
        this.error[mode] = e.message || "Failed to load";
        this.shelf[mode] = { items: [], total: 0, truncated: false };
        this.derive(mode);
      } finally {
        if (seq === this._seq[mode]) {
          this.loading[mode] = false;
          this._onChange();
        }
      }
    }

    /**
     * Server-paginated fallback, only for shelves past the row cap. This is
     * the pre-existing /collection/grid path; everything else is local.
     */
    async loadGridPage(mode) {
      const seq = ++this._seq[mode];
      this.loading[mode] = true;
      this.error[mode] = null;
      this._onChange();
      try {
        const qs = new URLSearchParams({
          status: mode,
          page: String(this.page[mode]),
          per_page: String(this.perPage),
          exclude_expansions: "true",
          // Sort on the same axis as the local path above, so crossing the row
          // cap doesn't reshuffle the grid. The endpoint sorts on a plain
          // lowercased name, so it differs from the collator on the margins
          // (accents, "Catan 10" vs "Catan 2") — worth knowing, not worth
          // reimplementing Intl in Python for a 1000+ game shelf.
          sort: "alphabetical",
        });
        const other = this._otherUserId();
        if (other) qs.set("user_id", other);
        if (this.query) qs.set("search", this.query);
        const f = this.filters;
        if (f.players) qs.set("players", String(f.players));
        if (f.playtimeMin != null) qs.set("playtime_min", String(f.playtimeMin));
        if (f.playtimeMax != null) qs.set("playtime_max", String(f.playtimeMax));
        if (f.playMode) qs.set("play_mode", f.playMode);
        const data = await window.api.get("/collection/grid?" + qs.toString());
        if (seq !== this._seq[mode]) return;
        this.items[mode] = (data && data.items) || [];
        this.total[mode] = (data && data.total) || 0;
      } catch (e) {
        if (seq !== this._seq[mode]) return;
        this.error[mode] = e.message || "Failed to load";
        this.items[mode] = [];
        this.total[mode] = 0;
      } finally {
        if (seq === this._seq[mode]) {
          this.loading[mode] = false;
          this._onChange();
        }
      }
    }

    // ── Mutations from the UI ───────────────────────────────────────────────
    /**
     * Drop a game from any shelf it no longer belongs on, so its tile goes in
     * the same frame as the tap. Adding can't be done optimistically (the full
     * row isn't in hand), so that waits for the refetch the mutation kicks off.
     */
    spliceGame(gameId, status) {
      for (const mode of this.modes) {
        const sh = this.shelf[mode];
        if (!sh || !Array.isArray(sh.items)) continue;
        // Any collection row at all disqualifies a game from "played, not owned".
        const gone = mode === "played" ? status != null : status !== mode;
        if (!gone) continue;
        const next = sh.items.filter((it) => it.game_id !== gameId);
        if (next.length !== sh.items.length) {
          this.shelf[mode] = { ...sh, items: next, total: Math.max(0, (sh.total || 0) - 1) };
        }
      }
    }

    /** Search/filter change: back to page 1 on every shelf, then re-derive. */
    applyQueryChange(activeMode) {
      for (const m of this.modes) this.page[m] = 1;
      if (this.serverFallback(activeMode)) {
        this.loadGridPage(activeMode);
        return;
      }
      this.deriveAll();
      this._onChange();
    }

    /** Debounced only to coalesce keystrokes into one paint — no I/O behind it. */
    onSearchInput(value, activeMode) {
      this.query = value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.applyQueryChange(activeMode), 60);
    }

    setFilter(key, value, activeMode) {
      this.filters[key] = value;
      this.applyQueryChange(activeMode);
    }

    clearFilters(activeMode) {
      this.filters = { players: null, playtimeMin: null, playtimeMax: null, playMode: null };
      this.applyQueryChange(activeMode);
    }

    setPlaytimeBucket(id, activeMode) {
      const f = this.filters;
      const B = window.ShelfFilter.PLAYTIME_BUCKETS;
      const cur = B.find((b) => window.ShelfFilter.isActiveBucket(b, f));
      const next = (cur && cur.id === id) ? null : B.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this.applyQueryChange(activeMode);
    }

    /**
     * Page turn. Returns true when it resolved locally (caller repaints just
     * the grid + pager), false when it handed off to the server fallback.
     */
    goPage(n, mode) {
      this.page[mode] = n;
      if (this.serverFallback(mode)) {
        this.loadGridPage(mode);
        return false;
      }
      this.derive(mode);
      return true;
    }

    totalPages(mode) {
      return Math.max(1, Math.ceil(this.total[mode] / this.perPage));
    }
  }

  window.ShelfController = ShelfController;
})();
