// widgets/add-buddies-modal.js — the "Add buddies" card, shared by two callers.
//
// Both of them put the same question to the user — who do you want to add? —
// so they get the same screen rather than two that drift:
//   • first-run setup, as step 2 of 3: the user has just saved a display name
//     and a badge in PolaroidPopup.avatarCustomizer, and this offers a grid of
//     people they may know before the BoardGameGeek step closes the sequence
//     (widgets/onboarding-bgg-modal.js).
//   • the Buddies screen's Add button, which replaced the profile-search bar
//     that used to sit at the top of that page (views/buddies-view.js).
//
// Tiles multi-select; one button sends every tick as a single batch
// (POST /buddies/requests/bulk), the other backs out. The search field above
// the grid reaches past the ranked suggestions to anyone in the app, by display
// name or username (GET /profiles/search).
//
// What the two callers do NOT share is the dismiss wording — see dismissLabel.
// "Skip" is honest inside a sequence and wrong outside one.
//
// Why a modal and not a router view: it began as step 2 of 3 in a sequence that
// starts in a modal, it has no URL worth deep-linking, and a real view would
// need a back-stack entry that means nothing once setup is done. It borrows
// the .polaroid-popup__* chrome so the three steps read as one flow — the same
// thing widgets/onboarding-bgg-modal.js does.
//
// The tiles are NOT bespoke markup: they are the canonical buddy-suggestion
// tile in its "select" mode (ui/buddy-suggestion-rail.js), which is what the
// Feed and Buddies rails render in "add" mode. One object, one component —
// .claude/rules/ui-object-design.md §2.

(function () {
  const BACKDROP_ID = "bgb-add-buddies";
  // Must match the .is-closing animation duration in styles.css.
  const CLOSE_MS = 200;
  // The same 300ms the ghost-link picker on the Buddies screen uses. Both are
  // typing straight at /profiles/search, and a shared feel matters more than
  // shaving 80ms off one of them.
  const SEARCH_DEBOUNCE_MS = 300;
  const SEARCH_INPUT_ID = "add-buddies-search";

  // What a person the viewer ALREADY shares an edge with reads as. All three
  // are untickable, and each for its own reason (see tileFor).
  const RELATION_LABEL = {
    buddies:  "Already buddies",
    outgoing: "Request sent",
    incoming: "Wants to buddy up",
  };

  let _closeTimer = null;

  function teardown() {
    if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    const stale = document.getElementById(BACKDROP_ID);
    if (stale) stale.remove();
    // First-run runs three of these polaroid cards back to back, and a
    // teardown fires 200ms after its own card resolved — by which time the
    // NEXT card may already have locked the scroll. Only the last overlay out
    // restores it, or the closing card silently unlocks the page behind the
    // one that replaced it. The same guard covers the QR sheet, which carries
    // .polaroid-popup__backdrop too, and covers teardown()'s other caller —
    // the top of open(), which would otherwise unlock on the way IN.
    if (!document.querySelector(".polaroid-popup__backdrop")) {
      document.body.style.overflow = "";
    }
  }

  // A /profiles/search hit wearing the suggestion tile's shape. `id` becomes
  // `user_id` and that is nearly the whole of it — the search endpoint carries
  // no ranking signal, so `username` is what the tile has to name them by.
  function toSuggestion(p) {
    return {
      user_id: p.id,
      display_name: p.display_name,
      avatar: p.avatar || null,
      username: p.username || null,
    };
  }

  /**
   * @typedef {Object} AddBuddiesResult
   * @property {"sent"|"skipped"} action  "skipped" means closed without
   *   sending, whichever label the dismiss button happened to carry.
   * @property {string[]} sent          user ids that now have a pending edge
   * @property {{user_id:string, detail:string}[]} failed
   */

  /**
   * Open the card. Resolves once the user sends or backs out — never rejects,
   * so the boot path can `await` it without a try/catch around the whole of
   * first-time setup.
   *
   * `suggestions` may be empty. It used to be the caller's job to prevent that,
   * on the grounds that a screen with nothing to add is worse than no screen;
   * the search field retired that argument, because there is now always
   * something to do here. init.js keeps a guard of its own for a DIFFERENT
   * reason — see the note there.
   *
   * @param {Object} opts
   * @param {import("../ui/buddy-suggestion-rail.js").SuggestedBuddy[]} [opts.suggestions]
   * @param {(userId: string) => ("buddies"|"outgoing"|"incoming"|null)} [opts.relationFor]
   *   What edge the viewer already shares with this person, so a search hit for
   *   someone they are connected to is labelled rather than hidden or silently
   *   rejected by the batch. Omitted during first-run setup, where the account
   *   is ninety seconds old and the suggestion RPC has already excluded every
   *   edge there could be.
   * @param {string} [opts.dismissLabel="Skip"]  the ghost button's text.
   *   "Skip" is honest inside first-run setup, where there is a next step to
   *   skip TO. Opened from the Buddies screen there is no sequence and the same
   *   button is just backing out, so that caller passes "Cancel".
   * @param {string} [opts.dismissAriaLabel="Skip for now"]  the ×'s name.
   * @param {Object} [opts.network]  the preloaded second hop from
   *   GET /buddies/suggested/onboarding (migration 072). Ticking someone
   *   appends the people THEY know to the bottom of the grid, in the same
   *   frame, with no request. Omitted by the Buddies-screen caller, which has
   *   no such payload — the card then behaves exactly as it did before.
   * @returns {Promise<AddBuddiesResult>}
   */
  function open(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      teardown();

      // `let`, not `const`: promotions append to it, so a full repaint (the
      // search query being cleared) reproduces the grid the user built.
      let list = o.suggestions || [];
      const relationFor = o.relationFor || function () { return null; };
      // Empty index when the caller passed no network — every call below is
      // then a no-op, which is how the Buddies-screen caller opts out.
      const network = window.BuddyNetwork
        ? window.BuddyNetwork.from(o.network ? { network: o.network } : null)
        : null;
      const dismissLabel = o.dismissLabel || "Skip";
      const dismissAriaLabel = o.dismissAriaLabel || "Skip for now";

      /** @type {Set<string>} — every tick, whichever list it was made from. */
      const selected = new Set();
      /**
       * Every person the user has ticked, in tick order, keyed by id. Tick
       * order because it is the user's own order (.claude/rules/overlays.md).
       * This is what lets a tick made in a search result stay VISIBLE after the
       * query is cleared — without it the footer would count someone the grid
       * no longer shows.
       * @type {Map<string, Object>}
       */
      const picked = new Map();

      let sending = false;
      let settled = false;

      // ── Search state ────────────────────────────────────────────────────
      let query = "";        // the committed query the grid is painted from
      let results = [];      // adapted hits for `query`
      let searching = false;
      let searchTimer = null;
      let searchSeq = 0;

      const root = document.createElement("div");
      root.id = BACKDROP_ID;
      root.className = "polaroid-popup__backdrop polaroid-popup__backdrop--confirm";
      root.innerHTML = `
        <div class="polaroid-popup__card polaroid-popup__card--confirm add-buddies"
             role="dialog" aria-modal="true" aria-label="Add buddies" tabindex="-1">
          <button class="polaroid-popup__close" aria-label="${escapeAttr(dismissAriaLabel)}" data-act="skip">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
          <div class="add-buddies__body">
            <div class="polaroid-popup__title">Add buddies</div>
            <p class="polaroid-popup__body">
              Pick anyone you know. They'll get a request, and once they accept
              their plays show up in your feed.
            </p>
            ${window.BgbSearchField.render({
              id: SEARCH_INPUT_ID,
              placeholder: "Search by name or username",
              ariaLabel: "Search for someone to add",
              icon: true,
              cls: "add-buddies__search",
              // The DaisyUI .input.input-bordered this emits paints from the
              // app GROUND, and this card is paper in both themes
              // (.claude/rules/theming.md §6) — so it would render as a dark
              // box on cream. .polaroid-field__input is the paper-surface field
              // the avatar customizer and the BGG step already use, and it
              // carries the iOS 16px focus-zoom floor with it.
              inputCls: "polaroid-field__input",
            })}
            <div class="add-buddies__grid" role="group" aria-label="People to add"></div>
            <div class="add-buddies__error" role="alert" hidden></div>
            <div class="polaroid-popup__actions add-buddies__actions">
              <button class="btn btn-ghost btn-sm add-buddies__skip" data-act="skip">${escapeHtml(dismissLabel)}</button>
              <button class="btn btn-primary btn-sm add-buddies__send" data-act="send" disabled>
                Send requests
              </button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(root);
      // The grid can outrun the viewport; stop the page behind it scrolling
      // with it. teardown() releases it, but only once no other polaroid
      // backdrop is left — see the note there.
      document.body.style.overflow = "hidden";
      window.BgbIcons.render(root);

      const grid = root.querySelector(".add-buddies__grid");
      const sendBtn = root.querySelector(".add-buddies__send");
      const skipBtn = root.querySelector(".add-buddies__skip");
      const errorEl = root.querySelector(".add-buddies__error");
      const searchInput = root.querySelector("#" + SEARCH_INPUT_ID);

      function finish(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        // A pending debounce would otherwise fire 300ms from now against a
        // detached grid, and its response 400ms after that.
        clearTimeout(searchTimer);
        searchSeq++;
        root.classList.add("is-closing");
        _closeTimer = setTimeout(teardown, CLOSE_MS);
        resolve(result);
      }

      // ── Rendering ───────────────────────────────────────────────────────

      /** One tile, in whichever of its three guises this person is in. */
      function tileFor(s) {
        const label = RELATION_LABEL[relationFor(s.user_id)] || null;
        // A search hit has no ranking signal to name — it was looked up, not
        // suggested — so it reads "@handle". A suggestion has one and derives
        // its own line, so it is left alone.
        const reason = label || (s.username ? "@" + s.username : null);
        return window.renderBuddySuggestionTile(
          reason ? Object.assign({}, s, { reason: reason }) : s,
          {
            mode: "select",
            selected: selected.has(s.user_id),
            // All three relation states are untickable, each for its own
            // reason (buddy_service.send_request): an accepted edge is a 409;
            // an outgoing pending is an idempotent no-op, so ticking it would
            // do nothing visible; and an incoming pending would AUTO-ACCEPT,
            // which a button reading "Send requests" must not do quietly.
            disabled: !!label,
          },
        );
      }

      /**
       * The empty-query grid: anyone ticked out of a search result, pinned
       * above the suggestions. Pruned here at PAINT time rather than on
       * untick, so a tile is never destroyed under the finger that just
       * tapped it (.claude/rules/mobile-web.md §5).
       */
      function pinnedThenSuggestions() {
        const extras = [];
        picked.forEach(function (p, id) {
          if (selected.has(id) && !list.some((s) => s.user_id === id)) extras.push(p);
        });
        return extras.concat(list);
      }

      // The grid host ONLY. Repainting the card — or __body, which holds it —
      // would destroy the input the user is typing into, along with its focus
      // and its caret (.claude/rules/overlays.md §6). The host's own box is a
      // fixed three rows, so nothing outside it moves either.
      function paintGrid() {
        // Anything promoted while the grid was showing search results is
        // already in `list`; this paint is where it becomes visible.
        const rows = query ? results : pinnedThenSuggestions();
        // `searching` is checked before the zero-results branch, or an
        // in-flight search renders "No one matches" for 300ms
        // (.claude/rules/web-frontend.md, loading vs empty).
        const message = query
          ? (searching
              ? "Searching…"
              : (rows.length ? null : `No one matches “${escapeHtml(query)}”.`))
          : (rows.length
              ? null
              : "No suggestions right now — search for someone by name or username.");

        grid.innerHTML = message
          ? `<p class="add-buddies__empty">${message}</p>`
          : rows.map(tileFor).join("");
        // Re-hydrate after every innerHTML patch, or the tick glyph in each new
        // tile stays an empty <i> — blank on iOS (.claude/rules/mobile-web.md §4).
        window.BgbIcons.render(grid);
        grid.classList.toggle("is-message", !!message);
        // A scroll cue that costs no layout, so it cannot reintroduce the
        // resizing the fixed height exists to remove.
        grid.classList.toggle("is-scrollable", grid.scrollHeight > grid.clientHeight + 1);
      }

      /**
       * Everyone currently rendered or pinned — what a promotion must not
       * duplicate.
       */
      function onScreenIds() {
        const ids = new Set(list.map((s) => s.user_id));
        picked.forEach((_p, id) => ids.add(id));
        results.forEach((r) => ids.add(r.user_id));
        return ids;
      }

      /**
       * Ticking someone introduces the people they know (migration 072).
       *
       * APPENDS. It never re-renders the grid and never touches a tile that
       * is already there: `insertAdjacentHTML("beforeend", …)` adds nodes
       * below the last one, so the tile under the user's finger survives, the
       * scroll position is untouched, and nothing above the insertion point
       * moves (.claude/rules/overlays.md §6). That is also why an untick takes
       * nothing back — see domain/buddy-network.js.
       *
       * Deferred, not skipped, while a query is showing (the grid is painted
       * from search results, where a suggestion tile does not belong) or
       * while the batch is sending (the grid is frozen under a "Sending…"
       * footer). The next full paint flushes them.
       */
      function promoteFrom(userId) {
        if (!network || network.isEmpty) return;
        const rows = network.promote(userId, onScreenIds());
        if (!rows.length) return;
        list = list.concat(rows);
        // Nothing more to do while a query is showing (the grid is painted
        // from search results) or mid-send (it is frozen under "Sending…").
        // The rows are in `list`, so the next full paint renders them.
        if (query || sending) return;
        // A message is occupying the host — "No suggestions right now" — so
        // there is nothing to append to. Paint instead; the rows are in
        // `list` already.
        if (grid.classList.contains("is-message")) { paintGrid(); return; }
        grid.insertAdjacentHTML("beforeend", rows.map(tileFor).join(""));
        // Re-hydrate ONLY what was added: BgbIcons.render over the whole grid
        // would walk every tile including the one being pressed.
        window.BgbIcons.render(grid);
        grid.classList.toggle("is-scrollable", grid.scrollHeight > grid.clientHeight + 1);
      }

      function syncFooter() {
        const n = selected.size;
        sendBtn.disabled = sending || n === 0;
        sendBtn.textContent = sending
          ? "Sending…"
          : n === 0
            ? "Send requests"
            : `Send ${n} request${n === 1 ? "" : "s"}`;
      }

      // ── Selection ─────────────────────────────────────────────────────────
      // Toggling repaints the one tile and the footer label, never the grid:
      // rebuilding it would destroy the tile under the user's finger before
      // :active could apply (.claude/rules/mobile-web.md §5) and would lose
      // scroll position on a list that scrolls.
      function personFor(id) {
        return results.find((p) => p.user_id === id)
            || list.find((p) => p.user_id === id)
            || picked.get(id)
            || null;
      }

      function toggle(tile) {
        // A disabled <button> dispatches no click anywhere, so this is belt
        // and braces — but the delegated handler's contract should not depend
        // on that.
        if (tile.disabled) return;
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
        // After the tile and the footer have settled, so the tap's own frame
        // does the smallest possible amount of work.
        if (nowOn) promoteFrom(id);
      }

      // ── Search ────────────────────────────────────────────────────────────
      function onQueryInput(raw) {
        // A leading @ is invited by the placeholder and would match nothing:
        // the column stores the handle without one.
        const q = (raw || "").trim().replace(/^@+/, "");
        clearTimeout(searchTimer);
        query = q;

        if (!q) {
          // Orphan anything in flight: a response for the query they just
          // deleted must not repaint the suggestion grid out from under them.
          searchSeq++;
          searching = false;
          results = [];
          paintGrid();
          return;
        }

        searching = true;
        paintGrid();                       // the in-flight state lands in this frame
        searchTimer = setTimeout(async () => {
          // The token is captured AFTER the timer fires, not at keystroke
          // time. Stamping per keystroke would bump it for keystrokes that
          // never reached the network, and every response would look stale.
          const seq = ++searchSeq;
          let hits;
          try { hits = await window.Buddy.searchProfiles(q); }
          catch (_) { hits = []; }
          if (seq !== searchSeq || settled) return;  // a newer search owns state
          results = (hits || []).map(toSuggestion);
          searching = false;
          paintGrid();
        }, SEARCH_DEBOUNCE_MS);
        // Deliberately NO `if (q === query) return` early-out above: typing
        // "ab", deleting to "a" and retyping "ab" inside one debounce window
        // would return after clearTimeout had already killed the pending
        // timer, and no request would ever be scheduled.
      }

      // ── Send ──────────────────────────────────────────────────────────────
      async function send() {
        if (sending || selected.size === 0) return;
        sending = true;
        errorEl.hidden = true;
        skipBtn.disabled = true;
        // A search landing mid-send would repaint the grid under a "Sending…"
        // footer, offering tiles that are already on their way out.
        searchInput.disabled = true;
        syncFooter();
        const ids = Array.from(selected);
        try {
          const res = await window.Buddy.sendRequests(ids);
          // The cached buddies bundle carries a pending-request flag per row,
          // so a stale copy would show an Add button for a request that has
          // just gone out.
          if (window.Buddy.invalidate) window.Buddy.invalidate();
          finish({
            action: "sent",
            sent: (res && res.sent) || [],
            failed: (res && res.failed) || [],
          });
        } catch (e) {
          // A throw here is the transport failing, not a rejected target —
          // per-target rejections come back inside a 200. Nothing was sent, so
          // keep the screen up with the ticks intact and let them try again.
          sending = false;
          skipBtn.disabled = false;
          searchInput.disabled = false;
          syncFooter();
          errorEl.textContent = (e && e.message)
            ? `Couldn't send: ${e.message}`
            : "Couldn't send those requests. Check your connection and try again.";
          errorEl.hidden = false;
        }
      }

      function skip() {
        if (sending) return; // A send is in flight; don't strand the requests.
        finish({ action: "skipped", sent: [], failed: [] });
      }

      // ── Wiring ────────────────────────────────────────────────────────────
      root.addEventListener("click", (ev) => {
        const act = ev.target.closest("[data-act]");
        if (act) {
          if (act.getAttribute("data-act") === "send") send();
          else skip();
          return;
        }
        const tile = ev.target.closest(".buddy-tile--select");
        if (tile && grid.contains(tile)) { toggle(tile); return; }
        // Backdrop tap. Backing out is non-destructive and every suggestion is
        // still one tap away on the Buddies screen, so this needs no confirm.
        if (ev.target === root) skip();
      });

      // Delegated on root rather than bound to the input, and rather than an
      // inline oninput: this widget is a closure with no global to address.
      // It costs nothing either way, because BgbSearchField's × does not call
      // us — it dispatches a REAL bubbling `input` event (ui/search-field.js),
      // which lands here with no extra wiring. That dispatch is the whole
      // reason no screen needs a clear path of its own.
      root.addEventListener("input", (ev) => {
        const t = ev.target;
        if (t && t.id === SEARCH_INPUT_ID) onQueryInput(t.value);
      });

      function onKeydown(ev) {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        ev.preventDefault();
        // Layered Escape (.claude/rules/overlays.md §5): the first backs out of
        // the search, the second out of the card. It does NOT unwind ticks —
        // the dismiss button is what that is for.
        if (query) { window.BgbSearchField.clearInput(searchInput); return; }
        skip();
      }
      document.addEventListener("keydown", onKeydown, true);

      paintGrid();
      syncFooter();

      // Move focus into the dialog so a screen reader lands on its label and
      // Tab walks the grid rather than the page behind it. NOT sendBtn: it
      // starts disabled, and a disabled button cannot take focus, so focus
      // would have stayed on whatever opened the modal. NOT the search field
      // either: throwing a keyboard up on open buries the grid, which is the
      // thing the screen is offering, and the field is one tap away.
      root.querySelector(".add-buddies").focus();
    });
  }

  window.AddBuddiesModal = { open };
})();
