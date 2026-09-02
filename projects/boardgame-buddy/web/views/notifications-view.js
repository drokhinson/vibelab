// views/notifications-view.js — "somebody put me in a play".
//
// Anyone can seat your account in a play they log. That write used to be
// silent AND one-sided: nothing told you, and getting out meant finding the
// play in your own feed and removing yourself from it one at a time. This
// screen is the telling, and the multi-select is the "at a time" part.
//
// A row is an ENTRY, not a play — one act of linking. The server groups a
// whole imported batch, a run of identical plays, or a single retroactive
// ghost-link into one row (see bgb_link_notifications), so a 214-play import
// is one line reading "Dana added you to 214 plays" with one tick box, rather
// than 214 lines the user has to select individually. That grouping is the
// difference between this screen being usable and being the same chore in a
// new place.
//
// Unlinking hands your seat back as a ghost carrying your name, owned by
// whoever logged the play: they keep their game night, you leave your own
// history. It is not reversible from here — the other person would have to
// link you again — so it goes through the app's one destructive confirm.

(function () {
  const PAGE = 20;
  const SENTINEL_ID = "linknotif-sentinel";

  class NotificationsView extends window.View {
    constructor() {
      super("notifications");
      this._resetState();
    }

    // Every transient field in one place, called from the constructor AND the
    // top of onMount. This view is a singleton that survives logout->login and
    // back-stack pops, so a previous session's selection would otherwise be
    // sitting under the next mount — attached, here, to a destructive button.
    _resetState() {
      this._items = [];
      this._cursor = null;
      this._hasMore = false;
      this._loading = false;
      this._loaded = false;
      this._error = null;
      this._selectMode = false;
      this._selected = new Set();   // entry_key
      this._busy = false;
      this._seq = 0;
    }

    async onMount() {
      this._resetState();
      this._io = this._io || new window.InfiniteScroll({
        onLoadMore: () => this._loadMore(),
      });
      // A failed first load offers Retry, but a user who walks back into signal
      // shouldn't have to find it.
      this.listen("offline", (off) => {
        if (!off && this._error && !this._items.length) this._load({ initial: true });
      });
      this.render();
      await this._load({ initial: true });
    }

    async onUnmount() {
      // A hidden view keeps its markup, so an unparked sentinel would keep
      // pulling pages nobody is looking at.
      if (this._io) this._io.disconnect();
    }

    renderLoading() {
      this.container.innerHTML = `${this._renderHead()}${this._renderLoader()}`;
      this.refreshIcons();
    }

    // ── Data ────────────────────────────────────────────────────────────────

    async _load({ initial = false } = {}) {
      const seq = ++this._seq;
      this._loading = true;
      if (initial) { this._error = null; this._cursor = null; }
      this.render();
      try {
        const data = await window.LinkNotifications.list({ limit: PAGE });
        if (seq !== this._seq) return;          // a newer load owns the screen
        this._items = data.items || [];
        this._cursor = data.next_cursor || null;
        this._hasMore = !!data.next_cursor;
        this._loaded = true;
        this._error = null;
        window.LinkNotifications.setUnread(data.unread || 0);
      } catch (e) {
        if (seq !== this._seq) return;
        // Its own branch, not an empty state: "nobody has added you to a play"
        // next to a dead network is a lie, and it looks permanent.
        this._error = (e && e.message) || "Couldn't load notifications.";
      } finally {
        if (seq === this._seq) {
          this._loading = false;
          this.render();
          // Only once the list is actually on screen: a failed load must not
          // clear the bell for notifications the user never saw.
          if (!this._error && this._items.length) this._markSeen();
        }
      }
    }

    async _loadMore() {
      if (this._loading || !this._hasMore || this._error) return;
      const seq = this._seq;
      this._loading = true;
      this.render();
      try {
        const data = await window.LinkNotifications.list({
          limit: PAGE, before: this._cursor,
        });
        if (seq !== this._seq) return;
        this._items = this._items.concat(data.items || []);
        this._cursor = data.next_cursor || null;
        this._hasMore = !!data.next_cursor;
      } catch (_) {
        if (seq !== this._seq) return;
        // Stop the sentinel rather than retrying the same failing request on
        // every scroll. The footer offers a manual retry.
        this._hasMore = false;
      } finally {
        if (seq === this._seq) { this._loading = false; this.render(); }
      }
    }

    // Send the newest linked_at we actually SHOWED, not "now": a link landing
    // between the list request and this call would otherwise be marked seen
    // without ever having been on screen. The server merges monotonically.
    _markSeen() {
      const newest = this._items.reduce(
        (max, it) => (!max || it.linked_at > max ? it.linked_at : max), null);
      window.LinkNotifications.markSeen(newest).catch(() => {});
    }

    // ── Render ──────────────────────────────────────────────────────────────

    render() {
      const n = this._items.length;
      let body;
      if (!n && (!this._loaded || this._loading)) body = this._renderLoader();
      else if (this._error && !n)                 body = this._renderLoadError();
      else if (!n)                                body = this._renderEmpty();
      else                                        body = this._renderList();

      this.container.innerHTML =
        `${this._renderHead()}${body}${this._renderBar()}`;
      this.refreshIcons();

      // Re-point every paint: the host's contents are replaced each time, so a
      // long-lived observation would end up watching a detached node.
      if (this._io) {
        this._io.observe(
          this._hasMore ? document.getElementById(SENTINEL_ID) : null);
      }
    }

    // A close x, not a back arrow: the bell is in the global header, so this
    // screen is reachable from every other one. router.back() returns the user
    // wherever they opened it from; feed is only the cold-deep-link fallback.
    _renderHead() {
      const n = this._items.length;
      const canSelect = n > 0 && !this._error;
      return `
        <header class="spoke-head">
          <h2 class="spoke-head__title font-display">Notifications</h2>
          ${canSelect ? `
            <button class="linknotif-select" type="button"
                    onclick="window.notificationsView._toggleSelectMode()">
              ${this._selectMode ? "Cancel" : "Select"}
            </button>` : ""}
          <button class="spoke-head__close" onclick="window.router.back('feed')"
                  aria-label="Close notifications">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </header>
      `;
    }

    _renderLoader() {
      return window.buddyLoader({ size: 96, label: "Loading notifications…" });
    }

    _renderLoadError() {
      return `
        <div class="linknotif-state" role="alert">
          <p class="linknotif-state__title">Couldn't load notifications.</p>
          <p class="linknotif-state__sub">${escapeHtml(this._error || "")}</p>
          <button class="btn btn-primary btn-sm"
                  onclick="window.notificationsView._retry()">Try again</button>
        </div>
      `;
    }

    _renderEmpty() {
      return `
        <div class="linknotif-state">
          <img class="linknotif-state__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <p class="linknotif-state__title">Nobody has added you to a play.</p>
          <p class="linknotif-state__sub">
            When someone logs a game and puts you at the table, it shows up here —
            and you can take yourself back out.
          </p>
        </div>
      `;
    }

    _renderList() {
      const rows = this._items.map((it, i) => this._renderRow(it, i)).join("");
      return `
        <div class="linknotif-list" role="${this._selectMode ? "group" : "list"}"
             aria-label="Plays you were added to">
          ${rows}
        </div>
        ${window.InfiniteScroll.renderFooter({
          id: SENTINEL_ID,
          hasMore: this._hasMore,
          loading: this._loading,
          error: null,
          onRetry: "window.notificationsView._loadMore()",
          endLabel: "",
        })}
      `;
    }

    /**
     * One entry. The whole row is the tap target in both modes — it selects in
     * select mode and opens the play otherwise — with the unlink button as a
     * sibling rather than a nested button, the same shape the Add Games rows
     * use so the two taps can't fight over one target.
     */
    _renderRow(it, i) {
      const picked = this._selected.has(it.entry_key);
      const many = (it.group_count || 1) > 1;
      const who = it.owner_display_name || "Someone";
      const game = it.game_name || "a game";

      // A run says how big it is and over how many games; a single play names
      // the game and when it was played. Both are one sentence, because the
      // question the row answers is "what happened and who did it".
      const title = many
        ? `<strong>${escapeHtml(who)}</strong> added you to ${it.group_count} plays`
        : `<strong>${escapeHtml(who)}</strong> added you to ${escapeHtml(game)}`;
      const sub = many
        ? `${it.game_count > 1 ? `${it.game_count} games · ` : `${escapeHtml(game)} · `}${this._span(it)}`
        : this._span(it);

      const art = it.game_thumbnail_url
        ? `<img class="linknotif-row__art" src="${escapeAttr(it.game_thumbnail_url)}"
                alt="" loading="lazy" />`
        : `<span class="linknotif-row__art linknotif-row__art--none" aria-hidden="true">
             <i data-icon="dices" class="w-4 h-4"></i>
           </span>`;

      const badge = window.BgbBadge.render({
        size: "sm",
        displayName: who,
        avatar: it.owner_avatar,
        extraClass: "linknotif-row__who",
      });

      return `
        <div class="linknotif-row ${it.is_unread ? "is-unread" : ""} ${picked ? "is-selected" : ""}"
             style="--i:${i}">
          <button class="linknotif-row__main" type="button"
                  ${this._selectMode ? `role="checkbox" aria-checked="${picked}"` : ""}
                  onclick="window.notificationsView.${this._selectMode
                    ? `_toggle('${jsStr(it.entry_key)}')`
                    : `_open('${jsStr(it.play_id)}')`}">
            <span class="linknotif-row__tick" aria-hidden="true">
              ${this._selectMode && picked ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}
            </span>
            ${badge}
            ${art}
            <span class="linknotif-row__body">
              <span class="linknotif-row__title">${title}</span>
              <span class="linknotif-row__sub">${sub}</span>
            </span>
            ${many ? `<span class="linknotif-row__count">${it.group_count}</span>` : ""}
          </button>
          ${this._selectMode ? "" : `
            <button class="linknotif-row__unlink" type="button"
                    ${this._busy ? "disabled" : ""}
                    aria-label="Remove me from ${escapeAttr(many ? `these ${it.group_count} plays` : game)}"
                    onclick="window.notificationsView._unlinkOne('${jsStr(it.entry_key)}')">
              <i data-icon="ghost" class="w-4 h-4"></i>
            </button>`}
        </div>
      `;
    }

    /** "12 Aug 2019" for one play, "Mar 2019 – Aug 2024" for a run that spans. */
    _span(it) {
      const from = it.played_from, to = it.played_to;
      if (!from && !to) return "date unknown";
      if (!from || !to || from === to) return formatDate(from || to);
      return `${formatDate(from)} – ${formatDate(to)}`;
    }

    _renderBar() {
      if (!this._selectMode) return "";
      const n = this._selected.size;
      const all = this._selected.size === this._items.length && this._items.length > 0;
      return `
        <div class="linknotif-bar">
          <button class="linknotif-bar__all" type="button"
                  onclick="window.notificationsView._selectAll(${all ? "false" : "true"})">
            ${all ? "Clear" : "Select all"}
          </button>
          <button class="linknotif-bar__go" type="button" ${n && !this._busy ? "" : "disabled"}
                  onclick="window.notificationsView._unlinkSelected()">
            ${this._busy ? "Removing…" : n
              ? `Remove me from ${this._playCount()}`
              : "Select some plays"}
          </button>
        </div>
      `;
    }

    /** Plays, not rows: one ticked import is 214 plays and must say so. */
    _playCount() {
      const n = this._items
        .filter((it) => this._selected.has(it.entry_key))
        .reduce((sum, it) => sum + (it.group_count || 1), 0);
      return `${n} ${n === 1 ? "play" : "plays"}`;
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    _retry() { this._load({ initial: true }); }

    _open(playId) { window.PlayDetailPopup.show(playId); }

    _toggleSelectMode() {
      this._selectMode = !this._selectMode;
      this._selected.clear();
      this.render();
    }

    _toggle(key) {
      if (this._selected.has(key)) this._selected.delete(key);
      else this._selected.add(key);
      this.render();
    }

    _selectAll(on) {
      this._selected.clear();
      if (on) this._items.forEach((it) => this._selected.add(it.entry_key));
      this.render();
    }

    async _unlinkOne(key) {
      const it = this._items.find((x) => x.entry_key === key);
      if (it) await this._unlink([it]);
    }

    async _unlinkSelected() {
      const picked = this._items.filter((it) => this._selected.has(it.entry_key));
      if (picked.length) await this._unlink(picked);
    }

    /**
     * The one write this screen performs.
     *
     * A batch entry rides as its `import_batch_id` rather than as its expanded
     * play ids: the server resolves it under the same ownership scoping either
     * way, and one field beats a request body carrying 214 UUIDs.
     */
    async _unlink(entries) {
      if (this._busy) return;
      const plays = entries.reduce((s, it) => s + (it.group_count || 1), 0);
      const me = window.store.get("user");
      const name = (me && me.display_name) || "your name";

      const ok = await window.PolaroidPopup.confirm({
        title: plays === 1 ? "Remove yourself from this play?"
                           : `Remove yourself from ${plays} plays?`,
        body: `You'll show up as a ghost called "${name}" on them instead, and they'll `
            + `stop counting towards your stats. Whoever logged them keeps the games. `
            + `You can't undo this here — they'd have to add you back.`,
        confirmLabel: "Remove me",
        cancelLabel: "Keep them",
        destructive: true,
      });
      if (!ok) return;

      this._busy = true;
      this.render();

      const sel = { playIds: [], groupIds: [], batchIds: [] };
      for (const it of entries) {
        if (it.kind === "batch" && it.import_batch_id) sel.batchIds.push(it.import_batch_id);
        else sel.playIds.push(...(it.play_ids || [it.play_id]));
      }

      try {
        await window.LinkNotifications.unlink(sel);
        showToast(plays === 1 ? "Removed you from the play"
                              : `Removed you from ${plays} plays`, "success");
        this._selected.clear();
        this._selectMode = false;
        // Reload from the top rather than splicing: the rows below just moved
        // up under a cursor that no longer points at what it did, and the
        // unread count has to come back from the server anyway.
        await this._load({ initial: true });
      } catch (e) {
        await window.PolaroidPopup.alert({
          title: "Couldn't remove you",
          body: (e && e.message) || "Something went wrong. Try again in a moment.",
        });
      } finally {
        this._busy = false;
        this.render();
      }
    }
  }

  window.NotificationsView = NotificationsView;
})();
