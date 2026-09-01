// @ts-check
// domain/shelf-controller.js — the data half of a collection spoke.
//
// Collection and Wishlist were two screens with the same shelf machinery, and
// they carried byte-identical copies of the load / filter / page logic. That
// state moved here; the views owned only their markup. The two screens then
// became one — the Collection spoke, with a shelf dropdown — so this class now
// serves one view holding three modes rather than two views holding one each.
// It is written for N modes either way, which is what made that merge a
// one-word change at the construction site.
//
// The model: pull a whole shelf once via Collection.shelf() (cached, SWR),
// then derive the visible window, filter and search from it locally. The
// screens scroll rather than page: `limit` is how many rows are on show, and
// loadMore() grows it by one batch. On the local path that costs no I/O at
// all. Three rules callers must respect:
//
//   * Every shelf is presented alphabetically by game name — that is the one
//     order these screens have (ShelfFilter.sortShelf), applied after the
//     filters and before the window slice. The server's own recency ordering
//     is left for the Profile hub's preview strip, which reads the bundle
//     direct.
//   * A shelf past the endpoint's row cap comes back `truncated`. Narrowing
//     one of those locally would silently miss games, so those queries fall
//     back to the server-paginated grid — see serverFallback(). There the
//     window grows by fetching the next page and APPENDING it, so `page` is
//     the highest batch fetched rather than the one on screen.
//   * Anything that changes what the list contains — a search, a filter, a
//     reload — resets the window to the first batch via resetWindow(). Leaving
//     a deep window over a freshly narrowed list would dump the user into the
//     middle of results they never scrolled to.

(function () {
  /**
   * The collection statuses a shelf mode actually contains. "owned" is a SET,
   * not a single value: a prev_owned game (sold, gifted or donated) stays on
   * the Owned shelf in its alphabetical place, dimmed and stamped, and the
   * server widens the same way (bgb_collection_shelf, migration 069). Every
   * other mode is its own single-element set.
   *
   * It is NOT a set for counting: `parted` below is what the view subtracts so
   * the Owned count still means "games you own".
   * @param {string} mode
   * @returns {string[]}
   */
  function statusesFor(mode) {
    return mode === "owned" ? ["owned", "prev_owned"] : [mode];
  }

  class ShelfController {
    /**
     * @param {Object} opts
     * @param {string[]} opts.modes        Shelf statuses this spoke shows.
     * @param {number} opts.batchSize      Rows revealed per scroll batch.
     * @param {() => string} opts.target   Whose shelf — viewer id or route param.
     * @param {() => (string|null)} [opts.otherUserId] Non-null when viewing someone else.
     * @param {() => void} opts.onChange   Repaint hook; called after every state change.
     * @param {() => void} [opts.onNarrow] Fired after a search / filter change
     *   has reset the window and repainted — the view's cue to put the
     *   viewport back at the head of the list.
     */
    constructor({ modes, batchSize, target, otherUserId, onChange, onNarrow }) {
      this.modes = modes;
      this.batchSize = batchSize;
      this._target = target;
      this._otherUserId = otherUserId || (() => null);
      this._onChange = onChange;
      this._onNarrow = onNarrow || (() => {});
      this.reset();
    }

    reset() {
      const byMode = (v) => Object.fromEntries(this.modes.map((m) => [m, typeof v === "function" ? v() : v]));
      /** Whole shelves as returned by Collection.shelf(): {items,total,truncated}. */
      this.shelf = byMode(null);
      /** The rows on screen — the first `limit` of the derived list. */
      this.items = byMode(() => []);
      /** Filtered total, derived. Counts prev_owned rows — see `parted`. */
      this.total = byMode(0);
      /** How many of `total` are prev_owned, so a view can show a count that
          means "games you own" without changing what the grid draws. */
      this.parted = byMode(0);
      /** How many rows the derived list can yield right now — see hasMore. */
      this.available = byMode(0);
      /** Size of the visible window, grown one batch at a time by loadMore(). */
      this.limit = byMode(() => this.batchSize);
      /** Highest batch fetched on the server-fallback path; unused locally. */
      this.page = byMode(1);
      this.loading = byMode(false);
      /** A batch append is in flight. Distinct from `loading`, which dims the
          whole grid — appending must leave the rows already read alone. */
      this.loadingMore = byMode(false);
      this.error = byMode(null);
      /** A failed append. Kept off `error` so one bad batch can't replace the
          rows on screen with an error panel. */
      this.moreError = byMode(null);
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

    /** Recompute the visible window + filtered total for `mode`. */
    derive(mode) {
      if (this.serverFallback(mode)) return; // loadGridPage owns these fields
      const sh = this.shelf[mode];
      if (!sh) {
        this.items[mode] = [];
        this.total[mode] = 0;
        this.parted[mode] = 0;
        this.available[mode] = 0;
        return;
      }
      const filtered = window.ShelfFilter.sortShelf(
        window.ShelfFilter.filterShelf(sh.items, this.filterSpec()),
      );
      // `available` is what the window can actually draw from, and it is what
      // hasMore() compares against — NOT `total`, which under a partial seed
      // reports the whole shelf while only a first page is in hand. Comparing
      // against that would leave the sentinel asking forever for rows the
      // client hasn't got.
      this.available[mode] = filtered.length;
      // Clamp the window rather than trusting it to stay near the list. A
      // shelf that shrinks under a deep window (games removed, a filter
      // narrowed and cleared again) would otherwise keep a limit that
      // silently unrolls the whole thing the next time it grows.
      this.limit[mode] = Math.max(
        this.batchSize,
        Math.min(this.limit[mode], filtered.length + this.batchSize),
      );
      this.items[mode] = filtered.slice(0, this.limit[mode]);
      // A partial seed (profile bundle) knows the real shelf size but holds
      // only one page, so trust its total only while nothing is filtered.
      this.total[mode] = (sh.partial && !this.isNarrowing())
        ? (sh.total || filtered.length)
        : filtered.length;
      // Counted off the filtered list rather than carried from the response,
      // so it tracks a search or filter the same way `total` does. The partial
      // seed is the one case that can't: it holds one page of a shelf whose
      // size it only knows in aggregate, so trust its own figure there — the
      // same trade `total` makes one line up.
      this.parted[mode] = (sh.partial && !this.isNarrowing())
        ? (sh.parted_total || 0)
        : filtered.filter((it) => it && it.status === "prev_owned").length;
    }

    /** Is there another batch behind the rows on screen? */
    hasMore(mode) {
      const shown = (this.items[mode] || []).length;
      const ceiling = this.serverFallback(mode) ? this.total[mode] : this.available[mode];
      return shown < (ceiling || 0);
    }

    /** Back to the first batch — see the header's third rule. */
    resetWindow(mode) {
      this.limit[mode] = this.batchSize;
      this.page[mode] = 1;
      this.moreError[mode] = null;
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
     * Seed from the profile bundle's first page — enough to paint, not to
     * scroll. The bundle's page is the server's recency order, so once derive()
     * sorts it this is the alphabetical arrangement of a recent slice, not the
     * real alphabetical head of the shelf. It is a first-frame stand-in for a
     * cache miss and load() overwrites it with the whole shelf; hydrate() from
     * a cached shelf is tried first and is exact.
     *
     * `total` and `parted` are the whole shelf's figures even though `items`
     * is one page of it, which is what derive() keys its `partial` branch off.
     */
    seedPartial(mode, items, total, parted) {
      if (!Array.isArray(items) || !items.length) return false;
      this.shelf[mode] = {
        items,
        total: total || items.length,
        parted_total: parted || 0,
        truncated: false,
        partial: true,
      };
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
          // Re-fetching every batch the user had already scrolled through
          // would be several round trips to rebuild a list they are about to
          // be handed fresh anyway, so a refresh of a fallback shelf starts
          // the window over at the first batch.
          this.resetWindow(mode);
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
     *
     * `append` is what makes it scroll: the batch is added to the rows already
     * on screen rather than replacing them, and it reports through
     * `loadingMore` so the grid isn't dimmed out from under a reader.
     * @param {string} mode @param {{append?: boolean}} [opts]
     */
    async loadGridPage(mode, { append = false } = {}) {
      const seq = ++this._seq[mode];
      if (append) this.loadingMore[mode] = true;
      else this.loading[mode] = true;
      this.error[mode] = null;
      this.moreError[mode] = null;
      this._onChange();
      try {
        const qs = new URLSearchParams({
          status: mode,
          page: String(this.page[mode]),
          per_page: String(this.batchSize),
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
        const rows = (data && data.items) || [];
        this.items[mode] = append ? (this.items[mode] || []).concat(rows) : rows;
        this.total[mode] = (data && data.total) || 0;
        // Whole-shelf figure, not this batch's — the endpoint counts it over
        // the filtered shelf, which is what the displayed count is about.
        this.parted[mode] = (data && data.parted_total) || 0;
      } catch (e) {
        if (seq !== this._seq[mode]) return;
        if (append) {
          // Keep the rows already read and step the cursor back, so Retry asks
          // for the batch that failed instead of skipping past it.
          this.page[mode] = Math.max(1, this.page[mode] - 1);
          this.moreError[mode] = e.message || "Couldn't load more";
        } else {
          this.error[mode] = e.message || "Failed to load";
          this.items[mode] = [];
          this.total[mode] = 0;
          this.parted[mode] = 0;
        }
      } finally {
        if (seq === this._seq[mode]) {
          this.loading[mode] = false;
          this.loadingMore[mode] = false;
          this._onChange();
        }
      }
    }

    // ── Mutations from the UI ───────────────────────────────────────────────
    /**
     * Reconcile one game's shelf membership with a status change from anywhere
     * in the app, so its tile settles in the same frame as the tap. Adding
     * can't be done optimistically (the full row isn't in hand), so that waits
     * for the refetch the mutation kicks off.
     *
     * Two outcomes, because owned ⇄ prev_owned is a move WITHIN a shelf rather
     * than off it: a game that no longer belongs is dropped, and one that still
     * belongs has its row's `status` patched so the view repaints it dimmed (or
     * un-dimmed) without waiting for the network.
     */
    spliceGame(gameId, status) {
      for (const mode of this.modes) {
        const sh = this.shelf[mode];
        if (!sh || !Array.isArray(sh.items)) continue;
        // Any collection row at all disqualifies a game from "played, not owned".
        const gone = mode === "played"
          ? status != null
          : !statusesFor(mode).includes(status);
        if (gone) {
          const next = sh.items.filter((it) => it.game_id !== gameId);
          if (next.length !== sh.items.length) {
            this.shelf[mode] = { ...sh, items: next, total: Math.max(0, (sh.total || 0) - 1) };
          }
          continue;
        }
        // Still on this shelf, but possibly on the other side of it. Rebuild
        // the array rather than mutating in place: derive() slices from it and
        // the view compares identities to decide what to repaint.
        const idx = sh.items.findIndex((it) => it.game_id === gameId);
        if (idx === -1 || sh.items[idx].status === status) continue;
        const next = sh.items.slice();
        next[idx] = { ...next[idx], status };
        this.shelf[mode] = { ...sh, items: next };
      }
    }

    /** Search/filter change: back to the first batch on every shelf, then re-derive. */
    applyQueryChange(activeMode) {
      for (const m of this.modes) this.resetWindow(m);
      if (this.serverFallback(activeMode)) {
        this.loadGridPage(activeMode);
        this._onNarrow();
        return;
      }
      this.deriveAll();
      this._onChange();
      // After the repaint, not before: the view measures the grid it has just
      // rewritten. Resetting the window without this leaves a viewport that
      // was deep in the old list sitting on the new sentinel, which unrolls
      // the results the user just narrowed.
      this._onNarrow();
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
     * Grow the window by one batch — the scroll sentinel's one entry point.
     *
     * Returns true when it resolved locally, in which case the caller repaints
     * in the same frame; false when nothing was due or when it handed off to
     * the server fallback, which repaints through onChange. The busy guards
     * matter because the sentinel re-arms on every paint and so can fire again
     * while a batch is still in the air.
     */
    loadMore(mode) {
      if (!this.hasMore(mode)) return false;
      if (this.loading[mode] || this.loadingMore[mode] || this.moreError[mode]) return false;
      if (this.serverFallback(mode)) {
        this.page[mode] += 1;
        this.loadGridPage(mode, { append: true });
        return false;
      }
      this.limit[mode] += this.batchSize;
      this.derive(mode);
      return true;
    }

    /** Manual retry after a failed batch — clears the block loadMore() honours. */
    retryMore(mode) {
      this.moreError[mode] = null;
      return this.loadMore(mode);
    }
  }

  ShelfController.statusesFor = statusesFor;
  window.ShelfController = ShelfController;
})();
