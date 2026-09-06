// ui/buddy-suggestion-rail.js — the canonical buddy-suggestion tile, and the
// "Buddies you may know" rail built out of it.
//
// One tile, rendered identically wherever a suggested person appears. Three
// surfaces use it today:
//   • the Feed, as a `suggested_buddies` card the backend interleaves into
//     the page (rail, Add button)
//   • the Buddies screen, as a standalone section between the Buddies and
//     Played-with lists, fed by GET /buddies/suggested (rail, Add button)
//   • the "Add buddies" card — first-run setup's step two and the Buddies
//     screen's Add button — as a wrapping grid of tiles the user ticks before
//     sending one batch of requests (widgets/add-buddies-modal.js, fed by
//     GET /buddies/suggested/onboarding and, once the user searches,
//     GET /profiles/search)
//
// Per .claude/rules/ui-object-design.md §2 the surface-specific bits — which
// view owns the Add button, and whether a tile commits on tap or toggles a
// selection — are `opts` fields on ONE tile, not a second copy of the markup.
//
// An "add" tile also carries a dismiss ×: "stop suggesting this person"
// (migration `013_buddy_suggestion_dismissals`). It is the answer to the one
// thing this rail could not do —
// a suggestion the viewer had already decided against came back every single
// visit, which is the failure ui/ghost-claim-suggestions.js argues against and
// the reason "Not me" exists on the list beside it. The × is deliberately NOT
// offered on a "select" tile: that tile IS a <button>, so a second button
// inside it is invalid markup, and a grid the user is ticking through has no
// room for a second meaning per tap.

(function () {
  // Why this person is being suggested, not how much.
  //
  // A Feed/Buddies candidate is here for a shared play or a shared buddy;
  // when it's both, the shared play is the one worth saying — it's also what
  // ranked them (migration 057). Those candidates carry no `source`, so the
  // counts are the whole story.
  //
  // The onboarding list adds a second tier (migration 063) whose candidates
  // are neither: people who are simply active in the app, with both counts at
  // zero. Reading the counts alone would label them "Mutual buddy", which is
  // false, so the backend sends the tier and it wins when present.
  //
  // Migration 072 adds a third kind: someone reached through a request the
  // viewer SENT and nobody has answered. "Mutual buddy" would be false about
  // them too — the link is one-sided until it is accepted — so they name the
  // person they came through instead. That name is another user's display
  // name, so it is escaped here; it is the only branch below that touches
  // user-supplied text.
  function suggestionReason(s) {
    // A tile being re-rendered in place carries its already-computed line, so
    // the reason survives a patch that has no backend row behind it. It is
    // also how a person with no ranking signal at all names themselves — a
    // /profiles/search hit reads "@username", which "Mutual buddy" would be a
    // flat lie about. Escaped here, because this is the one branch whose
    // value can come from a caller rather than from this file.
    if (s.reason) return escapeHtml(s.reason);
    // Counts first: a real shared play or a real accepted mutual outranks a
    // request nobody has answered, exactly as the RPC's ORDER BY does.
    if ((s.play_count || 0) > 0) return "Played with";
    if ((s.mutual_count || 0) > 0) return "Mutual buddy";
    if (s.source === "network" || (s.pending_mutual_count || 0) > 0) {
      return s.via_display_name
        ? `Buddy of ${escapeHtml(s.via_display_name)}`
        : "Buddy of someone you added";
    }
    if (s.source === "active") return "Active recently";
    return "Mutual buddy";
  }

  /**
   * @typedef {Object} SuggestedBuddy
   * @property {string} user_id
   * @property {string} display_name
   * @property {Object|null} [avatar]
   * @property {number} [mutual_count]
   * @property {number} [play_count]
   * @property {number} [pending_mutual_count]  via a request the viewer sent
   * @property {string|null} [via_user_id]      who explains this suggestion
   * @property {string|null} [via_display_name] their name, for the reason line
   * @property {"graph"|"active"|"network"|null} [source]
   * @property {string|null} [username]  present on a /profiles/search hit
   * @property {string} [reason]         overrides the derived reason line
   */

  /**
   * One suggestion tile.
   *
   * @param {SuggestedBuddy} s
   * @param {Object} [opts]
   * @param {"add"|"select"} [opts.mode="add"]
   *   "add"    — a per-tile Add button that sends one request on tap, and the
   *              avatar routes to the person's profile.
   *   "select" — the whole tile is a toggle in a multi-select; nothing is
   *              sent until the host's own confirm button. No profile
   *              navigation: the tile IS the control, so a tap on any part of
   *              it must do the one thing.
   * @param {string} [opts.addHandler]  mode "add": global expression called as
   *   `(userId, buttonEl)`, e.g. "window.feedView._addBuddy".
   * @param {boolean} [opts.selected]   mode "select": current tick state.
   * @param {boolean} [opts.disabled]   mode "select": this person cannot be
   *   ticked — the viewer already shares an edge with them, and `s.reason`
   *   says which. A real `disabled` attribute rather than aria-disabled, so no
   *   click can reach the host's delegated toggle at all. The cost is that the
   *   tile leaves the tab order; accepted here because the label IS the whole
   *   message and a screen reader's virtual cursor still reaches it, whereas a
   *   focusable-but-inert tile makes every host guard the toggle by hand.
   * @param {"none"|"sending"|"sent"|"buddies"} [opts.state="none"]
   *   mode "add": what the action button shows. The tile does NOT leave its
   *   list when a request is sent — it flips here instead. Removing it would
   *   reflow the rail in the tap's own frame, and the next tap would land on
   *   whoever slid into that slot.
   * @param {string|null} [opts.requestId]  state "sent": the pending edge id,
   *   which is what Cancel addresses. Absent → the button reads a dead "Sent",
   *   because there is nothing to cancel yet.
   * @param {string} [opts.cancelHandler]   state "sent": global expression
   *   called as `(requestId, userId, buttonEl)`.
   * @param {string} [opts.dismissHandler] mode "add": global expression called
   *   as `(userId, buttonEl)` when the tile's × is tapped. Omit and no × is
   *   drawn, which is what a host that cannot remove a tile should do.
   *   Rendered only while the tile is in state "none": once a request is out,
   *   the tile's own button is Cancel and "stop suggesting them" is a sentence
   *   about somebody the viewer has just asked to be buddies with.
   * @returns {string} HTML
   */
  function renderBuddySuggestionTile(s, opts) {
    const o = opts || {};
    const select = o.mode === "select";
    const badge = window.BgbBadge.render({
      avatar: s.avatar,
      displayName: s.display_name,
      size: "md",
      extraClass: "buddy-tile__avatar",
    });
    const name = escapeHtml(s.display_name);
    const reason = suggestionReason(s);

    if (select) {
      // A real <button aria-pressed> rather than a div with a click handler:
      // the tick state has to reach a screen reader, and the tile has to be
      // reachable by keyboard — this grid is the only control on the screen.
      return `
        <button type="button"
                class="buddy-tile buddy-tile--select${o.selected ? " is-selected" : ""}"
                data-user-id="${escapeAttr(s.user_id)}"
                aria-pressed="${o.selected ? "true" : "false"}"${o.disabled ? " disabled" : ""}>
          <span class="buddy-tile__check" aria-hidden="true">
            <i data-icon="check" class="w-3 h-3"></i>
          </span>
          <span class="buddy-tile__avatar-wrap">${badge}</span>
          <span class="buddy-tile__name">${name}</span>
          <span class="buddy-tile__reason">${reason}</span>
        </button>
      `;
    }

    const addHandler = o.addHandler || "window.feedView._addBuddy";
    const uid = escapeAttr(s.user_id);
    return `
      <div class="buddy-tile" data-user-id="${uid}">
        ${renderTileDismiss(s, o)}
        <div class="buddy-tile__avatar-wrap"
             onclick="window.router.go('profile-other',{userId:'${s.user_id}'})">
          ${badge}
        </div>
        <div class="buddy-tile__name">${name}</div>
        <div class="buddy-tile__reason">${reason}</div>
        ${renderTileAction(s, o, addHandler)}
      </div>
    `;
  }

  // The × in the tile's corner. Separate from renderTileAction because it is
  // the one control that does not change with the send lifecycle — it is drawn
  // in state "none" and in no other, rather than showing a different face per
  // state.
  //
  // The label names the person, not the button: a screen reader running the
  // rail hits a dozen of these, and "Dismiss" twelve times says nothing about
  // which one is about to go. `title` carries the same sentence for a pointer.
  function renderTileDismiss(s, o) {
    if (!o.dismissHandler) return "";
    if ((o.state || "none") !== "none") return "";
    const label = escapeAttr(`Stop suggesting ${s.display_name}`);
    return `
      <button type="button" class="buddy-tile__dismiss"
              aria-label="${label}" title="${label}"
              onclick="${o.dismissHandler}('${escapeAttr(s.user_id)}', this)">
        <i data-icon="x" class="w-3 h-3"></i>
      </button>
    `;
  }

  // The action button for an "add" tile. Split out because it is the only part
  // that changes when a request is sent, and both the Feed and the Buddies
  // screen re-render just this — see patchBuddySuggestionTile.
  function renderTileAction(s, o, addHandler) {
    const state = o.state || "none";
    const uid = s.user_id;
    if (state === "sending") {
      // aria-disabled, NOT the disabled attribute. A disabled button cannot
      // hold focus, so the browser drops the keyboard user onto <body> the
      // moment this transient state paints — and the next patch has no focus
      // left to restore. The re-entrancy guard lives in the caller's in-flight
      // set, so a tap that gets through here is already a no-op.
      return `<button class="btn btn-xs btn-ghost btn-disabled mt-1"
                      aria-disabled="true">Sending…</button>`;
    }
    if (state === "buddies") {
      // Auto-accepted: they had already asked us, so the send made us buddies.
      return `<button class="btn btn-xs btn-ghost mt-1" disabled>Buddies</button>`;
    }
    if (state === "sent") {
      const cancel = o.cancelHandler;
      if (!o.requestId || !cancel) {
        return `<button class="btn btn-xs btn-ghost mt-1" disabled>Sent</button>`;
      }
      return `<button class="btn btn-xs btn-ghost mt-1" title="Withdraw your buddy request"
                      onclick="${cancel}('${o.requestId}', '${uid}', this)">Cancel</button>`;
    }
    return `<button class="btn btn-xs btn-primary mt-1"
                    onclick="${addHandler}('${uid}', this)">Add</button>`;
  }

  /**
   * @param {SuggestedBuddy[]} suggestions
   * @param {{ addHandler: string, flush?: boolean, cancelHandler?: string,
   *           dismissHandler?: string,
   *           stateFor?: (userId: string) => {state?: string, requestId?: string} }} opts
   *   addHandler — a global expression called as `(userId, buttonEl)` when
   *     the tile's Add button is tapped, e.g. "window.feedView._addBuddy".
   *   flush — drop the rail's own 1rem gutter, for hosts that already pad
   *     their own content (the Buddies screen's <main> carries px-4).
   *   cancelHandler — a global expression called as
   *     `(requestId, userId, buttonEl)` for a tile already in the "sent" state.
   *   dismissHandler — a global expression called as `(userId, buttonEl)` when
   *     the tile's × is tapped. Omit and the rail draws no ×.
   *   stateFor — lets the host restore per-tile action state across its own
   *     repaints. The rail's markup is rebuilt from backend rows, which know
   *     nothing about what this session has already sent, so without this a
   *     "Cancel" tile silently reverts to "Add" on the next paint.
   * @returns {string} HTML, or "" when there is nothing to suggest.
   */
  function renderSuggestedBuddiesRail(suggestions, opts) {
    const list = suggestions || [];
    if (list.length === 0) return "";
    const flush = opts && opts.flush;
    const stateFor = (opts && opts.stateFor) || null;
    const tiles = list.map((s) => {
      const st = stateFor ? (stateFor(s.user_id) || {}) : {};
      return renderBuddySuggestionTile(s, {
        mode: "add",
        addHandler: (opts && opts.addHandler) || "window.feedView._addBuddy",
        cancelHandler: opts && opts.cancelHandler,
        dismissHandler: opts && opts.dismissHandler,
        state: st.state,
        requestId: st.requestId,
      });
    }).join("");
    return `
      <section class="feed-rail${flush ? " feed-rail--flush" : ""}">
        <header class="feed-rail__header">
          <h3><i data-icon="user-plus" class="w-4 h-4"></i> Buddies you may know</h3>
        </header>
        <div class="feed-rail__scroll">${tiles}</div>
      </section>
    `;
  }

  /**
   * Repaint one "add" tile in place, without touching its neighbours.
   *
   * The lifecycle is what gets shared here, not just the look
   * (.claude/rules/ui-object-design.md §4): both rails need "swap this one
   * tile's markup and re-hydrate its icons", and hand-poking textContent /
   * classList / onclick at each call site is how a component grows a second
   * and third private copy of what a Sent tile looks like.
   *
   * @param {Element|Document} root  where to look for the tile
   * @param {SuggestedBuddy} s
   * @param {Object} opts  same shape renderBuddySuggestionTile takes
   * @returns {boolean} whether a tile was found and replaced
   */
  function patchBuddySuggestionTile(root, s, opts) {
    const scope = root || document;
    const el = scope.querySelector(tileSelector(s.user_id));
    if (!el) return false;
    const holder = document.createElement("div");
    holder.innerHTML = renderBuddySuggestionTile(s, opts);
    const next = holder.firstElementChild;
    if (!next) return false;

    // Replacing the node the user just tapped costs two things, and both of
    // them move content under their finger — which is the whole reason this
    // function exists instead of removing the tile.
    //
    //   * The rail is a horizontal scroller. Swapping out the focused button
    //     makes the browser scroll it back into view, and it lands 46px off
    //     on a 390px viewport — measured, not theorised. Save and restore.
    //   * Focus falls to <body>, so a keyboard user is dropped out of the rail
    //     mid-interaction. Move it onto the replacement, preventScroll so the
    //     restore above isn't immediately undone.
    const scroller = el.closest(".feed-rail__scroll") || scrollParentOf(el);
    const left = scroller ? scroller.scrollLeft : 0;
    const top = scroller ? scroller.scrollTop : 0;
    const hadFocus = !!(document.activeElement && el.contains(document.activeElement));

    el.replaceWith(next);
    window.BgbIcons.render(next);

    if (scroller) { scroller.scrollLeft = left; scroller.scrollTop = top; }
    if (hadFocus) {
      const btn = next.querySelector("button:not([disabled])") || next.querySelector("button");
      if (btn) { try { btn.focus({ preventScroll: true }); } catch (_) { btn.focus(); } }
    }
    return true;
  }

  /**
   * Take one tile out of the rail for good, and the rail with it if that was
   * the last one.
   *
   * The counter-argument to removing a tile is written out at
   * renderBuddySuggestionTile's `state` and again inside
   * patchBuddySuggestionTile: pulling a tile out of a horizontal rail slides
   * every tile to its right into a new slot, and the next tap lands on
   * whoever moved under the finger. That argument holds for a SEND, where
   * leaving is a side effect nobody asked for. Here leaving is the whole
   * request — so the answer is not to refuse it but to make it legible: the
   * tile collapses over ~220ms instead of vanishing between two frames, which
   * is long enough to read as "that one went away" and to move a finger.
   *
   * The rail's own gap is eaten by a negative margin as the basis goes to 0;
   * without it the row keeps a 0.6rem hole where the tile used to be.
   *
   * @param {Element|Document} root  where to look for the tile
   * @param {string} userId
   * @returns {Promise<void>} resolves once the node is actually gone
   */
  function removeBuddySuggestionTile(root, userId) {
    const scope = root || document;
    const el = scope.querySelector(tileSelector(userId));
    if (!el) return Promise.resolve();

    // Focus would otherwise fall to <body> the moment the node goes, dropping
    // a keyboard user out of the rail entirely. Hand it to a neighbour's first
    // live control, preventScroll so the rail does not jump to it. When this
    // was the last tile the rail is going too, so there is nothing inside it
    // left to hold focus and <body> is the honest answer.
    if (document.activeElement && el.contains(document.activeElement)) {
      const sibling = el.nextElementSibling || el.previousElementSibling;
      const next = sibling && sibling.querySelector("button:not([disabled])");
      if (next) { try { next.focus({ preventScroll: true }); } catch (_) { next.focus(); } }
    }

    // Fixed width first: flex-basis is 130px, but `auto`-ish computed values
    // and the select variant's `flex: 1 1 auto` do not animate from a keyword.
    el.style.flexBasis = `${el.offsetWidth}px`;
    // Force a reflow so the browser has a start value to interpolate from —
    // setting the basis and the class in one frame animates from nothing.
    void el.offsetWidth;
    el.classList.add("buddy-tile--leaving");
    el.style.flexBasis = "0px";

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const rail = el.closest(".feed-rail");
        el.remove();
        // Nothing left to suggest — drop the heading too, rather than leaving
        // "Buddies you may know" standing over an empty strip.
        if (rail && !rail.querySelector(".buddy-tile")) rail.remove();
        resolve();
      };
      // No transition to wait for, so waiting would just be a 300ms stall
      // with nothing happening in it.
      if (prefersReducedMotion()) { finish(); return; }
      el.addEventListener("transitionend", (e) => {
        if (e.target === el && e.propertyName === "flex-basis") finish();
      });
      // Belt and braces: a backgrounded tab fires no transitionend at all.
      setTimeout(finish, 300);
    });
  }

  // The selector both patch and remove locate a tile with. Ids are UUIDs, so
  // the escape is belt-and-braces — but a selector built from data is a
  // selector that data can break, and one copy of that decision is enough.
  // Read off `window.CSS` rather than the bare global: the two are the same
  // object in every browser, and only the property lookup survives being run
  // somewhere the global is not declared.
  function tileSelector(userId) {
    const id = (window.CSS && window.CSS.escape)
      ? window.CSS.escape(String(userId))
      : String(userId);
    return `.buddy-tile[data-user-id="${id}"]`;
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // Nearest ancestor that actually scrolls on either axis.
  function scrollParentOf(el) {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowX + st.overflowY)) return n;
      n = n.parentElement;
    }
    return null;
  }

  window.renderBuddySuggestionTile = renderBuddySuggestionTile;
  window.renderSuggestedBuddiesRail = renderSuggestedBuddiesRail;
  window.patchBuddySuggestionTile = patchBuddySuggestionTile;
  window.removeBuddySuggestionTile = removeBuddySuggestionTile;
})();
