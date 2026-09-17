// views/import-detail-view.js — one import, and what it wrote.
//
// The drill-down of the imports spoke (views/imports-view.js). It answers the
// question the old Settings row could not: before you undo a 214-play paste,
// what is actually in it?
//
// THERE IS NO IMPORT OBJECT TO EDIT. A batch is a GROUP BY over
// boardgamebuddy_plays.import_batch_id — no table, no name, no note of its own
// — so "editing an import" can only ever mean editing the plays inside it.
// That is why this screen has no rename field and never will; it has the app's
// existing three affordances instead, one per grain:
//
//   • a one-off play     → widgets/play-detail-popup.js (which already edits)
//   • a run of identical → widgets/play-run-sheet.js (which already deletes)
//   • the whole import   → the footer, through Play.deleteImportBatch
//
// A RUN ROW OPENS SOMETHING HERE, AND DOES NOT ON THE PLAYS LOG. That is not
// an inconsistency: bgb_plays_page returns no import_group_id, so the log has
// nothing to hand the run sheet and deliberately opens nothing rather than
// presenting an arbitrary member of 58 identical plays as "the" play. This
// screen's endpoint does return it, so the row can act on what it represents.

(function () {
  class ImportDetailView extends window.View {
    constructor() {
      super("import-detail");
      this._reset();
    }

    _reset() {
      this._batch = null;
      this._runs = [];
      this._loading = false;
      this._loaded = false;
      this._failed = false;
      this._deleting = false;
    }

    /** The batch this screen is about. Route params, never a stale field. */
    get _batchId() {
      return (this.params && this.params.batchId) || "";
    }

    async onMount() {
      this._reset();
      // The run sheet's delete. It has had no listener anywhere in the app
      // until now, which is why deleting a run from the feed left every other
      // surface showing it until the next fetch.
      this.listenDom("plays-changed", (e) => this._onRunDeleted(e.detail || {}));
      // The popup's edit and delete, for the one-off rows.
      this.listenDom("play-changed", (e) => this._onPlayChanged(e.detail || {}));
      await this._load();
    }

    onParamsChange() {
      // Only reachable by routing to this screen while already on it; the
      // ordinary path unmounts on the way out. Cheap, and it means a second
      // batch can never paint under the first one's header.
      this._reset();
      return this._load();
    }

    onUnmount() {
      this._reset();
    }

    async _load() {
      this._loading = true;
      this._failed = false;
      this.render();
      try {
        const detail = await window.Play.importDetail(this._batchId);
        this._batch = (detail && detail.batch) || null;
        this._runs = (detail && detail.runs) || [];
        this._loaded = true;
      } catch (_) {
        if (!this._loaded) this._failed = true;
      } finally {
        this._loading = false;
        this.render();
      }
    }

    renderLoading() {
      this.render();
    }

    render() {
      const n = (this._batch && this._batch.play_count) || 0;
      this.container.innerHTML = `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to imported plays"
                  onclick="window.router.up('imports')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">
            <span class="spoke-head__title-text">Import</span>
          </h2>
          ${this._loaded && n
            ? `<span class="spoke-head__count">${n} play${n === 1 ? "" : "s"}</span>`
            : ""}
        </header>
        <section class="admin-spoke__body import-detail">${this._renderBody()}</section>
      `;
      this.refreshIcons();
    }

    _renderBody() {
      if (!this._loaded && this._loading) {
        return window.buddyLoader({ size: 88, label: "Opening…" });
      }
      if (this._failed || !this._batch) {
        return `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Couldn't load this import just now.</p>
            <button class="btn btn-sm btn-primary"
                    onclick="window.importDetailView._load()">Try again</button>
          </div>`;
      }
      return `
        ${this._renderFacts()}
        <ul class="plays-list">${this._runs.map((r) => this._renderRun(r)).join("")}</ul>
        ${this._renderFooter()}
      `;
    }

    _renderFacts() {
      const b = this._batch;
      const names = b.game_names || [];
      const games = names.join(", ") + ((b.game_count || 0) > names.length ? "…" : "");
      const span = b.first_played_at === b.last_played_at
        ? formatDate(b.first_played_at)
        : `${formatDate(b.first_played_at)} – ${formatDate(b.last_played_at)}`;
      const fact = (icon, title, sub) => `
        <div class="set-card__row set-card__row--static">
          <span class="set-card__row-icon"><i data-icon="${icon}" class="w-4 h-4"></i></span>
          <span class="set-card__row-body">
            <span class="set-card__row-title">${escapeHtml(title)}</span>
            <span class="set-card__row-sub">${escapeHtml(sub)}</span>
          </span>
        </div>`;
      const plays = b.play_count || 0;
      const gameCount = b.game_count || 0;
      return `
        <div class="set-card">
          ${fact("history", `Imported ${formatDate(b.imported_at)}`,
                 `${plays} play${plays === 1 ? "" : "s"} across ` +
                 `${gameCount} game${gameCount === 1 ? "" : "s"}`)}
          ${games ? fact("dice-6", games, `Played ${span}`) : ""}
        </div>
      `;
    }

    _renderRun(run) {
      const isRun = (run.group_count || 1) > 1;
      const players = run.players || [];
      const winners = players.filter((p) => p.is_winner)
        .map((w) => escapeHtml(window.Buddy.nameFor(w.user_id, w.name))).join(", ");
      const sub = [];
      // The count leads: it is the one thing that makes a run row different
      // from the row above it.
      if (isRun) sub.push(`<span class="plays-list__run">${run.group_count} plays</span>`);
      if (winners) {
        sub.push(`<span class="plays-list__winner">
          <i data-icon="trophy" class="w-3 h-3"></i> ${winners}</span>`);
      }
      if (players.length) {
        sub.push(`${players.length} ${players.length === 1 ? "player" : "players"}`);
      }
      const open = isRun
        ? `window.importDetailView._openRun('${jsStr(run.import_group_id || "")}')`
        : `window.PlayDetailPopup.show('${jsStr(run.play_id)}')`;
      return `
        <li class="plays-list__row${isRun ? " plays-list__row--run" : ""}"
            data-play-id="${escapeAttr(run.play_id)}"
            onclick="${escapeAttr(open)}">
          <div class="plays-list__thumb">
            ${run.game_thumbnail
              ? `<img src="${escapeAttr(run.game_thumbnail)}" alt="" />`
              : `<div class="plays-list__placeholder"><i data-icon="dice-6"></i></div>`}
          </div>
          <div class="plays-list__body">
            <div class="plays-list__top">
              <div class="plays-list__game">${escapeHtml(run.game_name)}</div>
              <div class="plays-list__date">${escapeHtml(formatDate(run.played_at))}</div>
            </div>
            ${sub.length ? `<div class="plays-list__sub">${sub.join(" · ")}</div>` : ""}
          </div>
        </li>
      `;
    }

    _renderFooter() {
      const n = (this._batch && this._batch.play_count) || 0;
      return `
        <button class="import-detail__delete" type="button" ${this._deleting ? "disabled" : ""}
                onclick="window.importDetailView._deleteBatch()">
          <i data-icon="trash-2" class="w-4 h-4"></i>
          <span>Delete this import${n ? ` — ${n} play${n === 1 ? "" : "s"}` : ""}</span>
        </button>
      `;
    }

    /**
     * Hand the run sheet a feed-card-shaped object.
     *
     * Two of these fields are load-bearing in a way that fails silently.
     * `game` is read as `card.game.name`, not `game_name`; and `isOwn(card)`
     * tests `card.user.id`, so omitting `user` renders the sheet's NON-OWNER
     * face — the one that says only the person who imported these can remove
     * them, with no delete button on it. Every import on this screen is the
     * viewer's own, by construction: the endpoint is owner-scoped.
     *
     * `players` is passed non-empty so the sheet's own roster fetch no-ops —
     * every play in a run is indistinguishable, so the representative's roster
     * IS the run's roster.
     */
    _openRun(groupId) {
      const run = this._runs.find((r) => r.import_group_id === groupId);
      if (!run) return;
      const me = window.store.get("user");
      const winner = (run.players || []).find((p) => p.is_winner);
      window.PlayRunSheet.open({
        play_id: run.play_id,
        import_group_id: run.import_group_id,
        group_count: run.group_count,
        played_at: run.played_at,
        notes: run.notes,
        game: { name: run.game_name },
        user: me ? { id: me.id, display_name: me.display_name } : null,
        players: run.players || [],
        winner_display_name: winner ? winner.name : null,
      });
    }

    /** The run sheet deleted a run — drop its row rather than refetching. */
    _onRunDeleted(detail) {
      const groupId = detail.importGroupId;
      if (!groupId || !this._runs.some((r) => r.import_group_id === groupId)) return;
      this._runs = this._runs.filter((r) => r.import_group_id !== groupId);
      this._shrink(detail.deleted || 0);
    }

    /**
     * The popup edited or removed one play.
     *
     * Matched on playId, not on a group: the echo carries a PlayResponse, which
     * has no import_group_id on it. A delete can only ever hit a one-off row —
     * a run opens the sheet, not the popup — so dropping the whole row is
     * right, and the count falls by one.
     */
    _onPlayChanged(detail) {
      const run = this._runs.find((r) => r.play_id === detail.playId);
      if (!run) return;
      if (detail.kind === "delete" || detail.kind === "leave") {
        this._runs = this._runs.filter((r) => r !== run);
        this._shrink(run.group_count || 1);
        return;
      }
      // An edit can move the play's game, date or roster, which are three of
      // the four things the row paints. Re-read rather than guess.
      this._load();
    }

    /** Fewer plays than a moment ago — and maybe none, which ends the batch. */
    _shrink(deleted) {
      if (this._batch) {
        this._batch.play_count = Math.max(0, (this._batch.play_count || 0) - deleted);
      }
      // Nothing left means the import no longer exists. Staying would leave the
      // user on a header with no body and a delete button for nothing.
      if (!this._runs.length) {
        window.router.up("imports");
        return;
      }
      this.render();
    }

    async _deleteBatch() {
      if (this._deleting || !this._batch) return;
      const n = this._batch.play_count || 0;
      const ok = await window.PolaroidPopup.confirm({
        title: "Delete this import?",
        body: `All ${n} play${n === 1 ? "" : "s"} it added will be removed from your history and your stats. This can't be undone — you'd have to import the note again.`,
        confirmLabel: "Delete",
        cancelLabel: "Keep them",
        destructive: true,
      });
      if (!ok) return;
      this._deleting = true;
      this.render();
      let deleted = 0;
      try {
        const res = await window.Play.deleteImportBatch(this._batchId);
        deleted = (res && res.deleted) || 0;
      } catch (e) {
        this._deleting = false;
        this.render();
        showToast((e && e.message) || "Couldn't delete that import", "error");
        return;
      }
      this._deleting = false;
      showToast(`Deleted ${deleted} play${deleted === 1 ? "" : "s"}`, "success");
      window.router.up("imports");
    }
  }

  window.ImportDetailView = ImportDetailView;
})();
