// widgets/onboarding-buddies-slide.js — first-run slide 2, "Add your buddies".
//
// Split out of widgets/onboarding-deck-slides.js when it grew a search field:
// the other four slides are twenty lines of markup and a handler each, this one
// is a small application (a query, a debounce, a sequence guard, two lists and
// a promotion rule). Keeping it here is the ~300-line split CLAUDE.md asks for,
// along the seam that matters — one slide that has state versus four that do
// not.
//
// It is the same screen as widgets/add-buddies-modal.js, and deliberately so:
// both put one question to the user (who do you want to add?), both render the
// canonical select-mode tile from ui/buddy-suggestion-rail.js, both search
// through GET /profiles/search, and both promote the second hop through
// domain/buddy-network.js. What they do NOT share is the shell — a modal and a
// deck slide have different lifecycles, which is exactly the split
// .claude/rules/ui-object-design.md §4 says to make.
//
// TWO RULES CARRY OVER FROM THE DECK, and both are about not awaiting:
//   • Send and Skip queue the write through deck.queue() and call deck.next()
//     in the same frame. The outcome lands on the finale's ledger.
//   • A promotion APPENDS. Ticking someone inserts the people they know below
//     the grid rather than re-rendering it, so the tile under the thumb
//     survives (.claude/rules/overlays.md §6). An untick takes nothing back.

(function () {
  // The same 300ms the Add-buddies card and the ghost-link picker use. All
  // three type straight at /profiles/search, and a shared feel matters more
  // than shaving 80ms off one of them.
  const SEARCH_DEBOUNCE_MS = 300;
  const SEARCH_INPUT_ID = "ob-buddies-search";

  /**
   * A /profiles/search hit wearing the suggestion tile's shape. The search
   * endpoint carries no ranking signal, so `username` is what the tile has to
   * name them by. (It already excludes the viewer — profile_routes.py.)
   */
  function toSuggestion(p) {
    return {
      user_id: p.id,
      display_name: p.display_name,
      avatar: p.avatar || null,
      username: p.username || null,
    };
  }

  /**
   * @param {Object} deck  the shell's own API — queue(), next()
   * @returns {{el: Element, onEnter: Function, prefetch: Function}}
   */
  function build(deck) {
    const el = document.createElement("div");
    el.className = "ob-slide ob-slide--buddies";
    el.innerHTML = `
      <div class="ob-slide__scroll">
        <h2 class="ob-slide__title">Add your buddies</h2>
        ${window.BgbSearchField.render({
          id: SEARCH_INPUT_ID,
          placeholder: "Search by name or username",
          ariaLabel: "Search for someone to add",
          icon: true,
          cls: "ob-search",
          // The deck is CHROME, not paper (.claude/rules/theming.md §6), so the
          // field takes .polaroid-field__input for its shape and the deck's own
          // re-point (`.ob-deck .polaroid-field__input`) supplies the ground it
          // sits on. That class also carries the iOS 16px focus-zoom floor.
          inputCls: "polaroid-field__input",
        })}
        <div class="ob-tiles" data-tiles role="group" aria-label="People to add"></div>
      </div>
      <div class="ob-slide__actions">
        <button type="button" class="btn btn-ghost ob-btn ob-btn--skip">Skip</button>
        <button type="button" class="btn btn-primary ob-btn ob-btn--go">Send requests</button>
      </div>
    `;

    const grid = el.querySelector("[data-tiles]");
    const sendBtn = el.querySelector(".ob-btn--go");

    /** @type {Set<string>} every tick, whichever list it was made from. */
    const selected = new Set();
    /**
     * Everyone ticked, keyed by id, so a tick made inside a search result
     * stays VISIBLE once the query is cleared. Without it the footer would
     * count somebody the grid no longer shows.
     * @type {Map<string, Object>}
     */
    const picked = new Map();

    // `let`, not `const`: promotions append to it, so clearing the query
    // reproduces the grid the user built rather than the one they were served.
    let list = [];
    let network = null;
    let loaded = false;
    let left = false;

    // ── Search state ───────────────────────────────────────────────────────
    let query = "";      // the committed query the grid is painted from
    let results = [];    // adapted hits for `query`
    let searching = false;
    let searchTimer = null;
    let searchSeq = 0;

    // ── Rendering ──────────────────────────────────────────────────────────

    function tileHtml(s) {
      // A search hit was looked up rather than suggested, so it has no ranking
      // line of its own — it reads "@handle". A suggestion derives one and is
      // left alone.
      const row = (!s.reason && s.username)
        ? Object.assign({}, s, { reason: "@" + s.username })
        : s;
      return window.renderBuddySuggestionTile(row, {
        mode: "select",
        selected: selected.has(s.user_id),
      });
    }

    /**
     * The empty-query grid: anyone ticked out of a search result, pinned above
     * the suggestions. Pruned at PAINT time rather than on untick, so a tile is
     * never destroyed under the finger that just tapped it
     * (.claude/rules/mobile-web.md §5).
     */
    function pinnedThenSuggestions() {
      const extras = [];
      picked.forEach(function (p, id) {
        if (selected.has(id) && !list.some((s) => s.user_id === id)) extras.push(p);
      });
      return extras.concat(list);
    }

    /**
     * The GRID HOST only. Repainting the slide would destroy the input the
     * user is typing into, along with its focus and its caret
     * (.claude/rules/overlays.md §6).
     */
    function paint() {
      const rows = query ? results : pinnedThenSuggestions();
      // `searching` is asked before the zero-results branch, or an in-flight
      // search renders "No one matches" for 300ms. Same reason `loaded` gates
      // the suggestion side: an empty state while the fetch is in flight is
      // the bug .claude/rules/web-frontend.md names.
      const message = query
        ? (searching
            ? "Searching…"
            : (rows.length ? null : `No one matches “${escapeHtml(query)}”.`))
        : (!loaded
            ? "Finding people you may know…"
            : (rows.length
                ? null
                : "No suggestions yet — search for someone by name or username."));

      grid.innerHTML = message
        ? `<p class="ob-tiles__msg">${message}</p>`
        : rows.map(tileHtml).join("");
      // Re-hydrate after every innerHTML patch, or the tick glyph in each new
      // tile stays an empty <i> — blank on iOS (.claude/rules/mobile-web.md §4).
      window.BgbIcons.render(grid);
      grid.classList.toggle("is-message", !!message);
      syncFooter();
    }

    function syncFooter() {
      const n = selected.size;
      sendBtn.textContent = n === 0
        ? "Send requests"
        : `Send ${n} request${n === 1 ? "" : "s"}`;
    }

    // ── The second hop ─────────────────────────────────────────────────────

    /** Everyone rendered or pinned — what a promotion must not duplicate. */
    function onScreenIds() {
      const ids = new Set(list.map((s) => s.user_id));
      picked.forEach((_p, id) => ids.add(id));
      results.forEach((r) => ids.add(r.user_id));
      return ids;
    }

    /**
     * Ticking someone introduces the people they know (migration 072), out of
     * the payload that arrived with the suggestions — so this costs no request
     * and happens in the tap's own frame.
     *
     * APPENDS, and only appends: nothing already on screen is re-rendered or
     * moved, so the tile under the user's finger survives and the grid does not
     * scroll. Deferred, not skipped, while a query is showing — the grid is
     * painted from search results there, where a suggestion tile does not
     * belong, and the rows are in `list` for the next full paint.
     */
    function promoteFrom(userId) {
      if (!network || network.isEmpty) return;
      const rows = network.promote(userId, onScreenIds());
      if (!rows.length) return;
      list = list.concat(rows);
      if (query) return;
      // A message is occupying the host — there is nothing to append to.
      if (grid.classList.contains("is-message")) { paint(); return; }
      grid.insertAdjacentHTML("beforeend", rows.map(tileHtml).join(""));
      // Only what was added: a render over the whole grid would walk every
      // tile including the one being pressed.
      window.BgbIcons.render(grid);
    }

    // ── Selection ──────────────────────────────────────────────────────────

    function personFor(id) {
      return results.find((p) => p.user_id === id)
          || list.find((p) => p.user_id === id)
          || picked.get(id)
          || null;
    }

    grid.addEventListener("click", (ev) => {
      const tile = ev.target.closest ? ev.target.closest(".buddy-tile") : null;
      if (!tile || tile.disabled) return;
      const id = tile.getAttribute("data-user-id");
      if (!id) return;
      const nowOn = !selected.has(id);
      if (nowOn) {
        selected.add(id);
        const p = personFor(id);
        if (p) picked.set(id, p);
      } else {
        selected.delete(id);
      }
      tile.classList.toggle("is-selected", nowOn);
      tile.setAttribute("aria-pressed", nowOn ? "true" : "false");
      syncFooter();
      // After the tile and the footer have settled, so the tap's own frame does
      // the smallest possible amount of work.
      if (nowOn) promoteFrom(id);
    });

    // ── Search ─────────────────────────────────────────────────────────────

    function onQueryInput(raw) {
      // A leading @ is invited by the placeholder and would match nothing: the
      // column stores the handle without one.
      const q = (raw || "").trim().replace(/^@+/, "");
      clearTimeout(searchTimer);
      query = q;

      if (!q) {
        // Orphan anything in flight: a response for the query they just deleted
        // must not repaint the grid out from under them.
        searchSeq++;
        searching = false;
        results = [];
        paint();
        return;
      }

      searching = true;
      paint();                           // the in-flight state lands in this frame
      searchTimer = setTimeout(async () => {
        // The token is captured AFTER the timer fires, not at keystroke time.
        // Stamping per keystroke would bump it for keystrokes that never
        // reached the network, and every response would look stale.
        const seq = ++searchSeq;
        let hits;
        try { hits = await window.Buddy.searchProfiles(q); }
        catch (_) { hits = []; }
        if (seq !== searchSeq || left) return;   // a newer search owns state
        results = (hits || []).map(toSuggestion);
        searching = false;
        paint();
      }, SEARCH_DEBOUNCE_MS);
      // Deliberately NO `if (q === query) return` early-out above: typing "ab",
      // deleting to "a" and retyping "ab" inside one debounce window would
      // return after clearTimeout had already killed the pending timer, and no
      // request would ever be scheduled.
    }

    // Delegated rather than bound to the input: BgbSearchField's × dispatches a
    // REAL bubbling `input` event (ui/search-field.js), which lands here with
    // no extra wiring. That is why no screen needs a clear path of its own.
    el.addEventListener("input", (ev) => {
      const t = ev.target;
      if (t && t.id === SEARCH_INPUT_ID) onQueryInput(t.value);
    });

    // ── Leaving ────────────────────────────────────────────────────────────

    function leave(send) {
      if (left) return;
      left = true;
      // A pending debounce would otherwise fire 300ms from now against a slide
      // nobody is looking at, and its response 400ms after that.
      clearTimeout(searchTimer);
      searchSeq++;

      const ids = Array.from(selected);
      if (send && ids.length) {
        deck.queue(
          `${ids.length} buddy request${ids.length === 1 ? "" : "s"} sent`,
          () => window.Buddy.sendRequests(ids).then((res) => {
            // The graph moved, so anything cached off it is stale.
            if (window.Buddy.invalidate) window.Buddy.invalidate();
            return res;
          }),
          (res) => {
            const sent = (res && res.sent) || [];
            const failed = (res && res.failed) || [];
            // Says what actually happened rather than what was asked for — a
            // batch where two of five bounced is not "5 sent".
            return failed.length
              ? `${sent.length} sent, ${failed.length} didn't go through`
              : `All ${sent.length} delivered`;
          },
        );
      }
      deck.next();
    }
    el.querySelector(".ob-btn--go").addEventListener("click", () => leave(true));
    el.querySelector(".ob-btn--skip").addEventListener("click", () => leave(false));

    // ── Loading ────────────────────────────────────────────────────────────

    /**
     * The suggestions were asked for the moment first-run began — while the
     * user was still naming themselves on slide 1 — so by the time this slide
     * arrives the grid is usually already painted. When it is not, this slide
     * shows its loading line and fills in behind the user, who can carry on
     * regardless: Skip works on an empty grid, and the search field means there
     * is always something to do here even when the suggestions never land.
     */
    function load() {
      if (loaded) return;
      const pending = window.Buddy.takePrefetchedOnboarding
        ? window.Buddy.takePrefetchedOnboarding()
        : null;
      (pending || window.Buddy.onboardingSuggestions(12)).then(
        (res) => {
          network = window.BuddyNetwork.from(res);
          list = (res && res.suggestions) || [];
          loaded = true;
          paint();
        },
        (err) => {
          // Best-effort by design: a discovery step is not worth blocking a
          // signup on. The grid says so, the search field still works, and Skip
          // still works.
          console.warn("Buddy suggestions unavailable:", err);
          loaded = true;
          paint();
        },
      );
    }

    paint();
    return { el, onEnter: load, prefetch: load };
  }

  window.OnboardingBuddiesSlide = { build };
})();
