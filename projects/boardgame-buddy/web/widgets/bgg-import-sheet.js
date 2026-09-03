// @ts-check
// widgets/bgg-import-sheet.js — "Import from BoardGameGeek", as a bottom sheet.
//
// Replaces widgets/add-game-modal.js, which was a centred polaroid card
// hosting a GameFinder. Three things were wrong with that, and this file is
// the answer to each:
//
//   1. IT WAS A DROPDOWN INSIDE A CARD. The finder's results were a
//      position:absolute list under an input on a vertically-centred card, so
//      they were capped at min(38vh, 300px) by a rule written to stop them
//      running off the screen. Half a phone, most of it card chrome, for the
//      one screen whose entire content is a list of search results.
//      .claude/rules/overlays.md: a list that needs a fit pass wants to be a
//      sheet. The sheet is bottom-anchored and sized off the VISIBLE viewport,
//      so the keyboard shrinks it correctly and the list is the only growable
//      child.
//
//   2. SEARCHING LEFT THE KEYBOARD UP. The finder searches as you type, so the
//      keyboard never goes away on its own and results arrive into the ~40% of
//      the screen it is not covering. Here the search is an explicit act — a
//      Search button, or Enter on the field — and committing it blurs the
//      field. The keyboard collapses, `.bgb-kb-open` drops, and the panel
//      takes nearly the whole visible viewport (see the --tall class below).
//      The list grows into the space the keyboard just gave back.
//
//   3. IMPORTING SHELVED THE GAME. AddGameModal's onPick ran Collection.add()
//      the instant an import returned, so looking up whether BgB had a game at
//      all put it in your collection. Import and shelve are two acts and this
//      sheet makes them two taps: the row's button imports into the shared
//      catalog, and only then does a second, differently-labelled button offer
//      your shelf. domain/bgg-import.js holds that line.
//
// The box takes a title, a BGG id, or a pasted boardgamegeek.com link. The id
// path is the backend's (services/search_service.py#_bgg_hits): BGG's own
// search matches names, so a number is a guaranteed miss there and goes to
// /thing instead. What this file does about it is print each row's #id beside
// its year, which is what makes a numeric search legible — search "1830" and
// the game with that id comes back next to the game with that name.
//
// The import itself is NOT this file's — it lives in domain/bgg-import.js and
// keeps running when the sheet closes, announcing itself through
// ui/bgg-import-toast.js. What this file owns is the search, the rows, and the
// rows' animation while a job it can see is in flight.
//
// Panel chrome is the shared .bgb-sheet__* family; the shell is
// ui/bottom-sheet.js.

(function () {
  const LIST_ID = "bgg-import-results";
  const INPUT_ID = "bgg-import-query";

  const SHELF_LABEL = { owned: "collection", wishlist: "wishlist" };

  /** Row state → the glyph in its leading mark. `importing` is deliberately
   *  not a tick: the row is breathing this icon while the request is out, and
   *  a tick mid-flight claims a result the app does not have yet. */
  const MARK_ICON = {
    new: "dice-6",
    importing: "download",
    library: "check",
    failed: "alert-triangle",
  };

  class BggImportSheet {
    constructor() {
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-bgg-import-sheet",
        className: "bgg-import-sheet",
        label: "Import from BoardGameGeek",
      });
      // Search state survives a close: an import started here goes on running
      // without the sheet, so re-opening has to be able to show what happened
      // to it rather than an empty box.
      this._query = "";
      this._hits = /** @type {any[]} */ ([]);
      this._phase = /** @type {"idle"|"searching"|"results"|"empty"|"error"} */ ("idle");
      this._error = "";
      this._shelf = /** @type {"owned"|"wishlist"} */ ("owned");
      // Monotonic: a slow search resolving after a newer one must not paint.
      this._seq = 0;
      this._unsub = /** @type {null | (() => void)} */ (null);
      // bggId → the signature its row was last painted from, so a job tick
      // patches only the rows that actually changed (.claude/rules/overlays.md
      // §6 — never repaint the panel, and here not even the whole list: a
      // wholesale patch would restart the sweep animation on every OTHER row
      // still importing).
      this._rowSig = new Map();
    }

    get isOpen() { return this._sheet.isOpen; }

    /**
     * `shelf` only picks which shelf the SECOND step offers — nothing here
     * writes to it. There is no result callback on purpose: an import outlives
     * this sheet, so anything that wants to know listens for the queue's
     * `bgg-imported` event instead (views/add-games-view.js does).
     *
     * `query` is the search the opening screen already has in hand. Reaching
     * this sheet means the catalog came up empty on it, so it is prefilled AND
     * run: the user typed "munchkin", was told it is not here, and pressed a
     * button that says "Not here? Import from BoardGameGeek" — landing them on
     * an empty box to type it a second time is the app forgetting what they
     * just did. It is a search they were about to run anyway, so it costs no
     * call they were not going to make.
     *
     * @param {{ shelf?: "owned"|"wishlist", query?: string,
     *           returnFocus?: Element|null }} [opts]
     */
    open(opts) {
      const o = opts || {};
      this._shelf = o.shelf === "wishlist" ? "wishlist" : "owned";

      // Not re-run when it is the search this sheet is already showing results
      // for — reopening on an unchanged query keeps what is on screen rather
      // than spending a BGG round trip to redraw it. A previous `empty` or
      // `error` DOES re-run: that one is a retry.
      const seed = typeof o.query === "string" ? o.query.trim() : "";
      const rerun = !!seed && !(seed === this._query && this._phase === "results");
      if (rerun) {
        // Set before the panel is built, so it opens already tall and already
        // showing the loader — no flash of the "type a title" prompt in front
        // of a search that is on its way.
        this._query = seed;
        this._hits = [];
        this._phase = "searching";
        this._rowSig.clear();
      }

      this._sheet.open({
        label: "Import from BoardGameGeek",
        returnFocus: o.returnFocus || null,
        html: this._panel(),
        onClick: (e) => this._onClick(e),
        onEscape: () => {
          // First Escape clears the box, second closes — the layered contract
          // in .claude/rules/overlays.md §5. Read from the FIELD, not from
          // this._query: the query is only committed on Search, so a typed-
          // but-unsearched box would otherwise close the sheet on the first
          // press with the user's text still in it.
          const box = this._input();
          if (!box || !box.value) return false;
          this._clearQuery();
          return true;
        },
        onOpen: (root) => {
          this._onOpen(root);
          // After onOpen, so the form and the queue subscription are wired
          // before anything can resolve against them.
          if (rerun) this._runSearch();
        },
        onClose: () => {
          if (this._unsub) { this._unsub(); this._unsub = null; }
          // Nothing is aborted here on purpose: an import in flight is the
          // queue's, not the sheet's, and closing must not cancel it.
          this._seq++;
        },
      });
    }

    close() { this._sheet.close(); }

    // ── Markup ───────────────────────────────────────────────────────────────

    _panel() {
      return `
        <div class="bgb-sheet__panel bgg-import-sheet__panel${this._phase === "idle" ? "" : " bgg-import-sheet__panel--tall"}"
             tabindex="-1">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Import from BoardGameGeek</h3>
          <p class="bgb-sheet__sub">
            For a game BoardgameBuddy doesn't have yet. Importing adds it to the
            shared library — putting it on your shelf is a separate step.
          </p>

          <form class="bgg-import-sheet__search" data-bgg-form autocomplete="off">
            ${window.BgbSearchField.render({
              id: INPUT_ID,
              value: this._query,
              // Names the third input this box takes. An id or a pasted link
              // resolves to the one game it names (see the backend's
              // _parse_bgg_id) — worth saying, because nothing else on screen
              // suggests a number would work.
              placeholder: "Name, BGG ID, or link",
              icon: true,
              cls: "bgg-import-sheet__field",
            })}
            <button type="submit" class="bgg-import-sheet__go">Search</button>
          </form>

          <ul class="bgb-sheet__list bgg-import-sheet__list" id="${LIST_ID}" role="list">
            ${this._renderBody()}
          </ul>

          <button class="bgb-sheet__cancel" type="button" data-action="close">Close</button>
        </div>
      `;
    }

    _renderBody() {
      switch (this._phase) {
        case "idle":
          return `<li class="bgg-import-sheet__prompt">
              <i data-icon="search" class="w-5 h-5" aria-hidden="true"></i>
              <span>Type a title and hit Search — or paste a BoardGameGeek ID
                    or link to go straight to one game. Results come from
                    BoardGameGeek.</span>
            </li>`;
        case "searching":
          return `<li class="bgg-import-sheet__loading">
              ${buddyLoader({ size: 76, label: "Searching BoardGameGeek…" })}
            </li>`;
        case "error":
          return `<li class="bgb-sheet__empty">
              ${escapeHtml(this._error || "BoardGameGeek search failed.")}
              <button type="button" class="bgg-import-sheet__retry" data-bgg-action="research">
                Try again
              </button>
            </li>`;
        case "empty":
          return `<li class="bgb-sheet__empty">
              No BoardGameGeek matches for “${escapeHtml(this._query)}”.
            </li>`;
        default:
          return this._hits.map((hit) => this._renderRow(hit)).join("");
      }
    }

    /**
     * One result row. Everything about its state comes from the queue, so a
     * row re-entered after the sheet was closed and re-opened shows where its
     * import actually got to.
     * @param {any} hit  A /search bgg_results row.
     */
    _renderRow(hit) {
      const job = window.BggImport.get(hit.bgg_id);
      const state = this._rowState(hit, job);
      return `
        <li class="bgg-import-row" data-bgg-row="${escapeAttr(String(hit.bgg_id))}"
            data-state="${escapeAttr(state)}">
          ${this._renderRowInner(hit, job, state)}
        </li>
      `;
    }

    /**
     * The row's second line: the year, the BGG id, and wherever the game has
     * got to.
     *
     * The id is on every row, not only the ones a numeric query matched. It is
     * this row's identity on BoardGameGeek, it is what somebody looking a game
     * up by id is holding, and printing it is what makes a search for "1830"
     * legible — the id hit and the same-named title come back together, and
     * the number beside each is the only thing that says which is which.
     *
     * `bad` covers a failed import AND a failed shelf write — the second one
     * leaves the row in the `library` state with an error on the job, so
     * keying the colour off data-state alone would swallow it.
     * @returns {{ text: string, bad: boolean }}
     */
    _metaFor(hit, job, state) {
      const shelf = (job && job.shelf) || null;
      const err = (job && job.error) || "";
      const bad = state === "failed" || (!!err && state !== "importing");
      const status =
        state === "importing" ? "Importing…"
          : bad ? (err || "Import failed")
          : shelf ? `In your ${SHELF_LABEL[shelf]}`
          : state === "library" ? "In the library"
          : null;
      return {
        text: [hit.year_published || null, `#${hit.bgg_id}`, status]
          .filter(Boolean).join(" · "),
        bad,
      };
    }

    /** Split from _renderRow so a job tick can patch a row without rebuilding
     *  the <li> — replacing the element itself would restart its animation. */
    _renderRowInner(hit, job, state) {
      const meta = this._metaFor(hit, job, state);
      return `
        <span class="bgg-import-row__mark" aria-hidden="true">
          <i data-icon="${MARK_ICON[state] || "dice-6"}" class="w-4 h-4"></i>
        </span>
        <span class="bgg-import-row__body">
          <span class="bgg-import-row__name">${escapeHtml(hit.name || "")}</span>
          <span class="bgg-import-row__meta${meta.bad ? " bgg-import-row__meta--bad" : ""}"
                >${escapeHtml(meta.text)}</span>
        </span>
        ${this._renderRowAction(hit, job, state)}
        <span class="bgg-import-row__bar" aria-hidden="true"></span>
      `;
    }

    _renderRowAction(hit, job, state) {
      const id = escapeAttr(String(hit.bgg_id));
      if (state === "importing") {
        return `<span class="bgg-import-row__btn bgg-import-row__btn--busy">
                  <span class="game-finder-spinner" aria-hidden="true"></span>
                  <span>Importing</span>
                </span>`;
      }
      if (state === "failed") {
        return `<button type="button" class="bgg-import-row__btn"
                        data-bgg-action="import" data-bgg-id="${id}">Retry</button>`;
      }
      if (state === "new") {
        return `<button type="button" class="bgg-import-row__btn bgg-import-row__btn--primary"
                        data-bgg-action="import" data-bgg-id="${id}">
                  <i data-icon="download" class="w-4 h-4" aria-hidden="true"></i>
                  <span>Import</span>
                </button>`;
      }
      // In the library, one way or another — step two. A game already on the
      // user's shelf still reads as "Add to …" until they press it: BGG's row
      // carries no BgB game id, so there is nothing to look up in the status
      // map, and POST /collection upserts on (user, game) — so the worst case
      // is a no-op write, not a duplicate.
      if (job && job.shelf) {
        return `<span class="bgg-import-row__btn bgg-import-row__btn--done">
                  <i data-icon="check-circle" class="w-4 h-4" aria-hidden="true"></i>
                  <span>Added</span>
                </span>`;
      }
      const label = SHELF_LABEL[this._shelf];
      return `<button type="button" class="bgg-import-row__btn"
                      data-bgg-action="shelf" data-bgg-id="${id}"
                      ${job && job.shelving ? "disabled" : ""}>
                ${job && job.shelving
                  ? `<span class="game-finder-spinner" aria-hidden="true"></span><span>Adding</span>`
                  : `<i data-icon="plus" class="w-4 h-4" aria-hidden="true"></i>
                     <span>Add to ${escapeHtml(label)}</span>`}
              </button>`;
    }

    /**
     * @returns {"new"|"importing"|"failed"|"library"} What the row offers.
     *   `library` covers both "BGG told us it was already here" and "we just
     *   imported it" — from the row's point of view they are the same state,
     *   and both lead to step two.
     */
    _rowState(hit, job) {
      if (job) {
        if (job.state === "importing") return "importing";
        if (job.state === "error") return "failed";
        if (job.state === "done") return "library";
      }
      return hit.already_in_db ? "library" : "new";
    }

    /** What a row's paint depends on — cheap enough to compare every tick. */
    _sigFor(hit) {
      const job = window.BggImport.get(hit.bgg_id);
      return [
        this._rowState(hit, job),
        (job && job.shelf) || "",
        job && job.shelving ? "1" : "",
        (job && job.error) || "",
      ].join("|");
    }

    // ── Wiring ───────────────────────────────────────────────────────────────

    _onOpen(root) {
      // The panel was just built from current job state; record what each row
      // was painted from so _syncRows can tell a real change from a repeat.
      // Matters on a RE-open: jobs move on while the sheet is closed, and
      // signatures left over from the previous open would mask the difference.
      this._seedSigs();
      const form = root.querySelector("[data-bgg-form]");
      if (form) {
        form.addEventListener("submit", (ev) => {
          ev.preventDefault();
          this._runSearch();
        });
      }
      // Live rows follow the queue, so an import finishing while the sheet is
      // open lands on its row the same way it lands in the notification.
      this._unsub = window.BggImport.subscribe(() => this._syncRows());
      // The panel, never the field: an overlay that focuses a text input
      // raises the keyboard over the list it just offered
      // (.claude/rules/overlays.md §5). Tapping the box is the opt-in — and
      // here the box is also the first thing Tab reaches from the panel.
      const panel = /** @type {HTMLElement|null} */ (root.querySelector(".bgb-sheet__panel"));
      if (panel) panel.focus();
    }

    _onClick(e) {
      const btn = e.target.closest("[data-bgg-action]");
      if (!btn) return;
      e.preventDefault();
      const action = btn.getAttribute("data-bgg-action");
      if (action === "research") { this._runSearch(); return; }
      const bggId = Number(btn.getAttribute("data-bgg-id"));
      const hit = this._hits.find((h) => Number(h.bgg_id) === bggId);
      if (!hit) return;
      if (action === "import") this._import(hit);
      else if (action === "shelf") this._shelve(hit);
    }

    _input() {
      return /** @type {HTMLInputElement|null} */ (document.getElementById(INPUT_ID));
    }

    _clearQuery() {
      this._query = "";
      window.BgbSearchField.clear(this._input());
    }

    // ── Search ───────────────────────────────────────────────────────────────

    /**
     * The one thing the Search button does, and the whole reason this is not a
     * search-as-you-type finder:
     *
     *   blur the field  ->  the software keyboard collapses
     *                   ->  ui/viewport-lock.js drops .bgb-kb-open and grows
     *                       --bgb-vv-h back to the full screen
     *   go tall         ->  the panel claims ~92% of it
     *
     * in that order, so the results paint into a list that is already the
     * height it is going to stay.
     */
    async _runSearch() {
      const input = this._input();
      this._query = ((input && input.value) || "").trim();
      if (input) input.blur();
      if (!this._query) {
        // Nothing to search: put the user back in the box rather than clearing
        // the list they can still see.
        const box = this._input();
        if (box) box.focus();
        return;
      }

      this._goTall();
      const seq = ++this._seq;
      this._phase = "searching";
      this._hits = [];
      this._paintList();

      let data;
      try {
        data = await window.Game.search(this._query, { includeBgg: true });
      } catch (err) {
        if (seq !== this._seq || !this._sheet.isOpen) return;
        this._phase = "error";
        this._error = (err && err.message) || "BoardGameGeek search failed.";
        this._paintList();
        return;
      }
      if (seq !== this._seq || !this._sheet.isOpen) return;

      this._hits = (data && data.bgg_results) || [];
      this._phase = this._hits.length ? "results" : "empty";
      this._paintList();
      // A fresh list starts at its head — a scroll position kept from the
      // previous search drops the user into rows they never scrolled to.
      const list = document.getElementById(LIST_ID);
      if (list) list.scrollTop = 0;
    }

    /** Grow the panel into the space the keyboard is giving back. */
    _goTall() {
      const el = this._sheet.el;
      const panel = el && el.querySelector(".bgb-sheet__panel");
      if (panel) panel.classList.add("bgg-import-sheet__panel--tall");
    }

    /** Patch the list host only — never the panel, which holds the field the
     *  user may be typing into (.claude/rules/overlays.md §6). */
    _paintList() {
      const list = document.getElementById(LIST_ID);
      if (!list) return;
      list.innerHTML = this._renderBody();
      window.BgbIcons.render(list);
      this._seedSigs();
    }

    _seedSigs() {
      this._rowSig.clear();
      for (const hit of this._hits) this._rowSig.set(Number(hit.bgg_id), this._sigFor(hit));
    }

    /** A queue tick: repaint only the rows whose state actually moved. */
    _syncRows() {
      if (!this._sheet.isOpen || this._phase !== "results") return;
      const list = document.getElementById(LIST_ID);
      if (!list) return;
      for (const hit of this._hits) {
        const id = Number(hit.bgg_id);
        const sig = this._sigFor(hit);
        if (this._rowSig.get(id) === sig) continue;
        this._rowSig.set(id, sig);
        const li = list.querySelector(`[data-bgg-row="${id}"]`);
        if (!li) continue;
        const job = window.BggImport.get(id);
        const state = this._rowState(hit, job);
        li.setAttribute("data-state", state);
        li.innerHTML = this._renderRowInner(hit, job, state);
        window.BgbIcons.render(/** @type {HTMLElement} */ (li));
      }
    }

    // ── The two steps ────────────────────────────────────────────────────────

    /** Step one. Fire-and-forget: the queue paints the row through the
     *  subscription and pops the notification whether or not this is still up.
     *  start() reports failure as a job state rather than a rejection, so the
     *  catch here only covers a malformed row. */
    _import(hit) {
      Promise.resolve(window.BggImport.start(hit, { shelf: this._shelf })).catch(() => {});
    }

    /**
     * Step two. For a row BGG reported as already in the catalog there is no
     * job yet and therefore no game id — resolve it first (a silent, idempotent
     * import that the server answers from its own table), then add.
     */
    async _shelve(hit) {
      let job = window.BggImport.get(hit.bgg_id);
      if (!job || !job.game) {
        try {
          job = await window.BggImport.start(hit, { shelf: this._shelf, silent: true });
        } catch (_) { return; }
      }
      if (!job || job.state !== "done") return;
      await window.BggImport.addToShelf(hit.bgg_id, this._shelf);
    }
  }

  window.BggImportSheet = new BggImportSheet();
})();
