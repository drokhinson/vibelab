// views/feedback-view.js — the Dev feedback board.
//
// Reached from one Settings row (Feedback & bugs) and open to every signed-in
// user, not just admins. Structurally this is the sibling of
// admin-reports-view.js — a spoke off Settings with a list under its header —
// with four differences worth naming up front:
//
//   1. IT IS NOT AN ADMIN SPOKE. It uses its own header, not AdminGate.head(),
//      and it never calls AdminGate.block(). AdminGate.allowed() is consulted
//      for exactly two things: whether the "Resolved" switch renders in the
//      header, and whether each row gets a Resolve button. A non-admin sees a
//      working screen, which is the whole point. The server is the actual gate
//      — it forces status=open for a non-admin whatever this screen sends.
//
//   2. THE BOARD IS GROUPED BY TOPIC, AND EVERY GROUP STARTS CLOSED. The server
//      returns one flat list ordered by likes; _groups() buckets it by topic and
//      renders one collapsible header per bucket that actually has rows. A topic
//      with nothing in it has no header — the headers describe what is on the
//      board, not what could be. There is no topic FILTER: the grouping is the
//      filter, and shipping both would be the same control twice.
//
//   3. THE BOARD IS ORDERED BY LIKES, AND LIKING DOES NOT RE-ORDER IT. The sort
//      happens in bgb_feedback_list, on load, and _groups() is a stable bucket
//      of that order. Re-sorting on a tap would move the row out from under the
//      finger that tapped it.
//
//   4. IT CAN OPEN WITH THE COMPOSE SHEET UP. `?compose=1` opens it empty,
//      `?compose=bug` opens it with the type preselected. Settings no longer
//      links that way — it has one row and that row lands on the board — but the
//      param stays a supported deep link, so a release notice or a support
//      reply can still point somebody straight at the form. It is stripped with
//      replaceUrl immediately, so a refresh or a back-then-forward lands on the
//      board rather than re-opening the sheet.
//
// The "Add" affordance is the shared .bgb-fab (styles.css, "The floating action
// button"), and it renders only when there is a board under it. On an empty
// board the empty state's own button is the one way in — two add buttons on a
// screen with nothing on it is one too many.

(function () {
  class FeedbackView extends window.View {
    constructor() {
      super("feedback");
      this._resetFormState();
    }

    /**
     * Every transient field in one place, called from the constructor, the top
     * of onMount and onUnmount. This view is a singleton that survives
     * logout → login and back-stack pops, so a previous session's filters,
     * expanded topics and items would otherwise render under the next account's
     * screen (.claude/rules/web-frontend.md, "Reset transient state on every
     * mount").
     */
    _resetFormState() {
      /** @type {any[]} */
      this._items = [];
      this._types = [];
      this._topics = [];
      this._status = "open";
      this._type = "";
      // Topic ids whose group is expanded. Empty is the default state of the
      // screen, not an accident: the board is a set of topics you open one at a
      // time, and a board that starts fully expanded is the flat list this
      // grouping replaced.
      this._openTopics = new Set();
      this._loading = false;
      this._loaded = false;
      this._error = "";
      // One entry per item currently mid-write. A Set rather than a single
      // flag: two rows can be liked in quick succession and neither should
      // block the other. Mirrors _ggBusy in feed-view.js.
      this._likeBusy = new Set();
    }

    async onMount() {
      this._resetFormState();
      // Retry the first load when the signal comes back, rather than leaving a
      // dead-zone failure sitting there until the user thinks to navigate away
      // and return. No-ops unless we are actually still empty.
      this.listen("offline", (offline) => { if (!offline) this._retryInitial(); });

      // Not awaited: the board is what the screen is for, and the compose
      // sheet's option lists can land a moment later.
      this._loadOptions();
      await this._load();
      this._maybeCompose();
    }

    onUnmount() {
      // A sheet left open over a screen the user has navigated away from would
      // outlive its own board.
      if (window.FeedbackComposeSheet.isOpen) window.FeedbackComposeSheet.close();
      this._resetFormState();
    }

    /** Re-entering the screen from another Settings row must re-read ?compose. */
    async onParamsChange() {
      this._maybeCompose();
    }

    renderLoading() {
      // Painted synchronously before onMount's fetch, so the tap lands on a
      // screen with its header already up rather than on a blank container.
      this.container.innerHTML = `
        ${this._renderHead()}
        <section class="feedback__body">${window.buddyLoader({ size: 80 })}</section>
      `;
      this.refreshIcons();
    }

    // ── data ─────────────────────────────────────────────────────────────────

    async _loadOptions() {
      try {
        const opts = await window.Feedback.options();
        this._types = opts.types;
        this._topics = opts.topics;
        // The type rail reads these, and _groups() uses them to put the topic
        // headers in the lookup table's display order rather than in like
        // order. Both only matter once something has loaded.
        if (this._loaded) this.render();
      } catch (e) {
        // Non-fatal: the board still reads, and the compose sheet re-asks. The
        // type rail simply does not appear, and the topic headers fall back to
        // the order the rows themselves arrived in.
      }
    }

    async _load() {
      // Set before the first paint, not after the await — otherwise the render
      // between here and the response has loading=false on an empty list and
      // falls straight through to the empty state
      // (.claude/rules/web-frontend.md, "Loading, empty and error states").
      this._loading = true;
      this._error = "";
      this.render();
      try {
        this._items = await window.Feedback.list({
          status: this._status,
          type: this._type,
        }) || [];
        this._loaded = true;
      } catch (e) {
        this._error = (e && e.message) || "Failed to load feedback";
        this._items = [];
      } finally {
        this._loading = false;
        this.render();
      }
    }

    _retryInitial() {
      if (this._loading || this._loaded) return;
      this._load();
    }

    // ── compose ──────────────────────────────────────────────────────────────

    /**
     * Open the compose sheet if the route asked for it.
     *
     * `?compose=1` means "empty"; `?compose=<type>` preselects that type. The
     * param is dropped from the URL the moment the sheet is up: it describes a
     * one-shot arrival, not a state the screen can be restored into, and leaving
     * it would re-open the sheet on every refresh and on every back-forward.
     */
    async _maybeCompose() {
      const want = (this.params && this.params.compose) || "";
      if (!want) return;
      window.router.replaceUrl("feedback");
      // The sheet cannot paint without its option sets, and on a cold deep link
      // they may still be in the air.
      await this._openCompose(want === "1" ? "" : want);
    }

    async _openCompose(preselectType, returnFocus) {
      if (!this._types.length || !this._topics.length) {
        try {
          const opts = await window.Feedback.options();
          this._types = opts.types;
          this._topics = opts.topics;
        } catch (e) {
          notifyRequestError(e, "open the feedback form");
          return;
        }
      }
      window.FeedbackComposeSheet.open({
        types: this._types,
        topics: this._topics,
        type: preselectType || "",
        returnFocus: returnFocus || null,
        onDone: (item) => this._onSubmitted(item),
      });
    }

    /** The floating button, and the empty state's. */
    _compose(el) {
      this._openCompose("", el || null);
    }

    /**
     * A new item, straight from the server so it is already rendered.
     *
     * Put on top of its topic rather than sorted into place: it is what the
     * person just wrote, and burying it under the popular items would read as
     * the submit having failed. The next load puts it where its like count
     * belongs. Its topic is expanded for the same reason — every group starts
     * closed, so an insert into a closed one is invisible. It is dropped
     * entirely when the current filter excludes it: pretending otherwise would
     * show a row that vanishes on the next refresh.
     */
    _onSubmitted(item) {
      if (!item) return;
      const shown = this._status === "open"
        && (!this._type || this._type === item.feedback_type);
      if (shown) {
        this._items = [item, ...this._items];
        this._openTopics.add(item.topic || "");
      }
      this._loaded = true;
      this.render();
    }

    // ── likes ────────────────────────────────────────────────────────────────

    /**
     * Toggle a like, painted before the request and rolled back if it fails.
     *
     * The shape is feed-view.js's "Good game" handler, for the same reasons: a
     * per-item guard captured before the await so a double-tap cannot interleave
     * two writes on one row, an optimistic paint so the tap registers in the
     * same frame, a rollback to the captured prior value, and a repaint of that
     * one row rather than the screen — a full render() here would rebuild every
     * row in the board, tearing down the button under the user's finger before
     * :active could apply, and would collapse nothing but cost the whole list.
     */
    async _toggleLike(id) {
      if (this._likeBusy.has(id)) return;
      const item = this._items.find((i) => i.id === id);
      if (!item) return;

      const was = { liked: !!item.viewer_liked, like_count: item.like_count || 0 };
      const next = !was.liked;
      this._likeBusy.add(id);
      window.Feedback.applyLike(item, {
        liked: next,
        like_count: Math.max(0, was.like_count + (next ? 1 : -1)),
      });
      this._patchRow(item);

      try {
        const settled = next
          ? await window.Feedback.like(id)
          : await window.Feedback.unlike(id);
        // Reconcile against what the server actually counted: somebody else may
        // have liked the same item while this request was in the air, and our
        // optimistic ±1 would leave the row one behind for the rest of the
        // session.
        window.Feedback.applyLike(item, settled);
        this._patchRow(item);
      } catch (e) {
        window.Feedback.applyLike(item, was);
        this._patchRow(item);
        // No toast, the same call feed-view makes: the control snapping back
        // says it, and the user can simply tap again.
      } finally {
        this._likeBusy.delete(id);
      }
    }

    // ── admin actions ────────────────────────────────────────────────────────

    async _setResolved(id, resolved) {
      const item = this._items.find((i) => i.id === id);
      if (!item) return;
      try {
        if (resolved) await window.Feedback.resolve(id);
        else await window.Feedback.reopen(id);
        // Not optimistic, unlike a like: the row leaves the list it is on
        // entirely, so there is no "patch one row" version of this — and the
        // rollback would have to put a removed row back in its sorted position.
        // The render keeps _openTopics, so the group it came out of stays open
        // under the thumb that resolved it.
        this._items = this._items.filter((i) => i.id !== id);
        this.render();
        showToast(resolved ? "Marked resolved" : "Reopened", "success");
      } catch (e) {
        notifyRequestError(e, resolved ? "resolve this" : "reopen this");
      }
    }

    // ── render ───────────────────────────────────────────────────────────────

    render() {
      const container = this.container;
      if (!container) return;
      const focus = captureFocus();
      container.innerHTML = `
        ${this._renderHead()}
        <section class="feedback__body">
          ${this._renderTypeChips()}
          ${this._renderList()}
        </section>
        ${this._renderFab()}
      `;
      this.refreshIcons();
      restoreFocus(focus);
    }

    /**
     * A back arrow, not a close ×: this screen is reachable only from Settings,
     * so back names a real destination (.claude/rules/web-frontend.md, "Close vs
     * back"). router.back("settings") still covers the cold deep link, where
     * there is no previous entry.
     *
     * The trailing slot is the admin's Resolved switch. It sits here rather than
     * over the list because it is not a filter over the board — it swaps the
     * board for the other half of it — and because the slot is free now that Add
     * floats. Non-admins get nothing there: the server only ever serves them
     * open items, so a control they could flip would be a lie.
     */
    _renderHead() {
      const admin = window.AdminGate.allowed();
      const resolved = this._status === "resolved";
      // The ground-palette switch, not --paper: a .bgb-spoke-screen is chrome
      // (.claude/rules/theming.md §6). The id is what lets helpers.js put focus
      // back on it after the repaint the flip causes.
      const toggle = admin ? window.BgbSwitch.render({
        id: "feedback-resolved-switch",
        on: resolved,
        label: "Resolved",
        ariaLabel: "Show resolved feedback",
        title: "Show resolved feedback instead of open",
        cls: "feedback__resolved-switch",
        onclick: "window.feedbackView._toggleResolved()",
      }) : "";

      return `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to settings"
                  onclick="window.router.back('settings')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">
            <span class="spoke-head__title-text">Dev feedback</span>
          </h2>
          ${toggle}
        </header>
      `;
    }

    /**
     * The floating Add, and the one rule about it: it renders only when there is
     * a board under it. An empty board already offers "Add feedback" in the
     * middle of the screen, and a screen whose only content is an empty state
     * does not need a second button floating over it.
     */
    _renderFab() {
      if (!this._items.length) return "";
      return `
        <button class="bgb-fab" type="button" id="feedback-add-fab"
                title="Add feedback"
                onclick="window.feedbackView._compose(this)">
          <i data-icon="plus" class="w-5 h-5"></i>
          <span>Add</span>
        </button>`;
    }

    /**
     * The type filter's chip rail, built from the lookup rows rather than a
     * hardcoded list — which is the point of the options living in the database.
     * Renders nothing until they land.
     *
     * There is exactly one rail. Topic used to have one too; it is the board's
     * grouping now, and a filter that hides every group but one is the same
     * control twice.
     */
    _renderTypeChips() {
      if (!this._types.length) return "";
      const active = this._type;
      const chip = (id, label, icon) => `
        <button class="chapter-add__chip ${active === id ? "chapter-add__chip--active" : ""}"
                type="button" role="tab" aria-selected="${active === id}"
                onclick="window.feedbackView._setType('${escapeAttr(id)}')">
          ${icon ? `<i data-icon="${escapeAttr(icon)}" class="w-3.5 h-3.5"></i>` : ""}
          ${escapeHtml(label)}
        </button>`;
      return `
        <div class="chapter-add__filter-chips" role="tablist" aria-label="Filter by type">
          ${chip("", "All types", "")}
          ${this._types.map((o) => chip(o.id, o.label, o.icon)).join("")}
        </div>`;
    }

    _renderList() {
      // Three branches, and the order matters. The loader wins whenever a fetch
      // is in flight OR nothing has ever loaded, so a filter change that clears
      // the list never flashes "no feedback yet" next to a spinner.
      if (!this._items.length && (this._loading || !this._loaded)) {
        if (this._error) return this._renderLoadError();
        return window.buddyLoader({ size: 80 });
      }
      if (this._error) return this._renderLoadError();
      if (!this._items.length) return this._renderEmpty();
      return `
        ${this._groups().map((g) => this._renderGroup(g)).join("")}
        <div class="bgb-fab-spacer"></div>`;
    }

    /** A failed first load is NOT an empty state — it gets a way to ask again. */
    _renderLoadError() {
      return `
        <div class="feedback__empty">
          <h3 class="text-lg font-semibold">Couldn't load the board</h3>
          <p class="text-sm opacity-70 mt-1">${escapeHtml(this._error)}</p>
          <button class="btn btn-primary btn-sm mt-3"
                  onclick="window.feedbackView._retryInitial()">Try again</button>
        </div>`;
    }

    _renderEmpty() {
      const filtered = !!this._type;
      if (this._status === "resolved") {
        return `<div class="feedback__empty">
          <p class="text-sm opacity-60">Nothing has been resolved yet.</p>
        </div>`;
      }
      return `
        <div class="feedback__empty">
          <img src="assets/illustrations/bgb-feedback-empty.svg" alt=""
               class="feedback__empty-art" />
          <h3 class="text-lg font-semibold mt-3">
            ${filtered ? "Nothing here yet" : "The board is empty"}
          </h3>
          <p class="text-sm opacity-70 mt-1">
            ${filtered
              ? "No feedback matches that filter."
              : "Tell us what's broken or what you'd like to see."}
          </p>
          <button class="btn btn-primary btn-sm mt-3" type="button"
                  onclick="window.feedbackView._compose(this)">Add feedback</button>
        </div>`;
    }

    // ── topic groups ─────────────────────────────────────────────────────────

    /**
     * The board, bucketed by topic, in the order the headers should read.
     *
     * Buckets are built from the ROWS, not from the topic lookup table, which is
     * what makes "only show the header if it has rows" fall out rather than
     * needing a guard: a topic nobody has filed under never gets a bucket. Every
     * row carries its own topic_label / topic_icon (bgb_feedback_list
     * denormalises them), so a header needs no join and paints correctly even
     * when the option fetch failed.
     *
     * Order is the lookup table's display_order where it is known, and
     * first-appearance — which is like order, since the server sorts by likes —
     * for anything it isn't. A topic retired from the lookup table still has
     * rows on the board, and they sort after the live topics rather than
     * vanishing or landing first.
     *
     * @returns {{id: string, key: string, label: string, icon: string,
     *            seen: number, items: any[]}[]}
     */
    _groups() {
      const order = new Map(this._topics.map((t, i) => [t.id, i]));
      /** @type {Map<string, any>} */
      const buckets = new Map();
      for (const item of this._items) {
        const id = item.topic || "";
        let g = buckets.get(id);
        if (!g) {
          g = {
            id,
            key: this._topicKey(id),
            label: item.topic_label || id || "Other",
            icon: item.topic_icon || "circle",
            seen: buckets.size,
            items: [],
          };
          buckets.set(id, g);
        }
        g.items.push(item);
      }
      const rank = (g) => (order.has(g.id) ? order.get(g.id) : order.size + g.seen);
      return [...buckets.values()].sort((a, b) => rank(a) - rank(b) || a.seen - b.seen);
    }

    /**
     * A topic id is a database slug and lands in a DOM id, so anything that is
     * not id-safe becomes a dash. Only used for the element id — the Set and the
     * click handler carry the real id.
     */
    _topicKey(id) {
      return String(id || "none").replace(/[^A-Za-z0-9_-]/g, "-");
    }

    /**
     * One collapsible topic. Same shape as whats-new-view.js's rows: a button
     * carrying aria-expanded and the chevron, and the body simply absent while
     * it is closed rather than hidden with CSS — a closed group renders no rows
     * at all, which is what keeps a hundred-item board cheap to paint.
     *
     * The head has an id because the toggle repaints the screen and helpers.js
     * restores focus by id; without one, a keyboard user is dropped to <body>
     * every time they open a group.
     */
    _renderGroup(g) {
      const open = this._openTopics.has(g.id);
      return `
        <section class="feedback-group ${open ? "is-open" : ""}">
          <button class="feedback-group__head" type="button"
                  id="feedback-topic-${escapeAttr(g.key)}"
                  aria-expanded="${open}"
                  onclick="window.feedbackView._toggleTopic('${escapeAttr(g.id)}')">
            <i data-icon="${escapeAttr(g.icon)}" class="w-4 h-4 feedback-group__icon"></i>
            <span class="feedback-group__label">${escapeHtml(g.label)}</span>
            <span class="feedback-group__count">${g.items.length}</span>
            <i data-icon="${open ? "chevron-up" : "chevron-down"}"
               class="w-4 h-4 feedback-group__chev"></i>
          </button>
          ${open ? `
            <ul class="feedback__list">
              ${g.items.map((item, i) => this._renderItem(item, i)).join("")}
            </ul>` : ""}
        </section>`;
    }

    _toggleTopic(id) {
      if (this._openTopics.has(id)) this._openTopics.delete(id);
      else this._openTopics.add(id);
      this.render();
    }

    // ── rows ─────────────────────────────────────────────────────────────────

    _renderItem(item, i) {
      const admin = window.AdminGate.allowed();
      const open = item.status === "open";
      const liked = !!item.viewer_liked;
      const n = item.like_count || 0;
      const likeLabel = `${liked ? "Remove your like" : "Like"} — ${n} so far`;

      // No topic tag: the row is inside its topic's group, and repeating the
      // header on every row under it is the second highlight the type tag's
      // comment in styles.css exists to avoid.
      return `
        <li class="feedback__item" data-feedback-id="${escapeAttr(item.id)}"
            style="--i: ${i}">
          <div class="feedback__marks">
            <span class="feedback__tag feedback__tag--${escapeAttr(item.feedback_type)}">
              <i data-icon="${escapeAttr(item.feedback_type_icon || "circle")}" class="w-3.5 h-3.5"></i>
              ${escapeHtml(item.feedback_type_label || item.feedback_type)}
            </span>
          </div>

          <p class="feedback__body-text">${escapeHtml(item.body)}</p>

          <div class="feedback__foot">
            <span class="feedback__meta">
              ${escapeHtml(item.author_name || "Someone")}
              <span aria-hidden="true">·</span>
              ${escapeHtml(formatDate(item.created_at))}
            </span>
            <div class="feedback__actions" data-feedback-actions>
              ${this._renderLike(item, likeLabel)}
              ${admin ? `
                <button class="btn btn-ghost btn-xs" type="button"
                        onclick="window.feedbackView._setResolved('${escapeAttr(item.id)}', ${open})">
                  <i data-icon="${open ? "check-circle" : "rotate-ccw"}" class="w-3.5 h-3.5"></i>
                  ${open ? "Resolve" : "Reopen"}
                </button>` : ""}
            </div>
          </div>
          ${!open && item.resolver_name ? `
            <div class="feedback__resolved">
              Resolved by ${escapeHtml(item.resolver_name)}${item.resolved_at
                ? ` · ${escapeHtml(formatDate(item.resolved_at))}` : ""}
            </div>` : ""}
        </li>`;
    }

    /** Its own function because _patchRow re-renders exactly this. */
    _renderLike(item, label) {
      const liked = !!item.viewer_liked;
      return `
        <button class="feedback__like ${liked ? "is-on" : ""}" type="button"
                aria-pressed="${liked}" aria-label="${escapeAttr(label)}"
                onclick="window.feedbackView._toggleLike('${escapeAttr(item.id)}')">
          <i data-icon="star" class="w-4 h-4"></i>
          <span class="feedback__like-count">${item.like_count || 0}</span>
        </button>`;
    }

    /**
     * Repaint one row's like button and nothing else.
     *
     * The row is found by its data-feedback-id rather than by index, because a
     * resolve can have removed a row above it — or a group above it can have
     * been collapsed — between the paint and the patch.
     */
    _patchRow(item) {
      const host = this.container;
      if (!host) return;
      const esc = (window.CSS && CSS.escape) ? CSS.escape(item.id) : item.id;
      const row = host.querySelector(`.feedback__item[data-feedback-id="${esc}"]`);
      if (!row) return;
      const btn = row.querySelector(".feedback__like");
      if (!btn) return;
      const liked = !!item.viewer_liked;
      const n = item.like_count || 0;
      btn.classList.toggle("is-on", liked);
      btn.setAttribute("aria-pressed", String(liked));
      btn.setAttribute("aria-label", `${liked ? "Remove your like" : "Like"} — ${n} so far`);
      const count = btn.querySelector(".feedback__like-count");
      if (count) count.textContent = String(n);
    }

    // ── filter handlers ──────────────────────────────────────────────────────

    /**
     * Swap the board for the other half of it. Admin-only by construction: the
     * switch that calls this only renders for an admin, and the server forces
     * `open` for everybody else regardless.
     *
     * _openTopics is deliberately NOT cleared. A topic somebody opened is what
     * they are reading; keeping it open across the flip — and across a type
     * filter — means the entry simply has nothing under it while the other half
     * is showing, and comes back when they flip again.
     */
    _toggleResolved() {
      this._status = this._status === "resolved" ? "open" : "resolved";
      // A status change is a different list entirely, so the loaded flag has to
      // drop or _renderList would show the old board's empty state.
      this._loaded = false;
      this._load();
    }

    _setType(value) {
      if (this._type === value) return;
      this._type = value;
      this._loaded = false;
      this._load();
    }
  }

  window.FeedbackView = FeedbackView;
})();
