// views/imports-view.js — every import this account has run.
//
// The index of the imports spoke; views/import-detail-view.js is its
// drill-down. Both used to be one static card in the middle of Settings: a row
// per batch, a play count, up to four game names and a trash can, and no way at
// all to see what the thing you were about to delete had written.
//
// It moved out for the same three reasons the What's new archive did
// (views/whats-new-view.js): settings-view.js is already past 1250 lines,
// Settings' whole vocabulary is the one-line .set-card__row, and a list that
// grows every time the user imports something wants its own windowed surface
// rather than a slot between two settings cards
// (.claude/rules/ui-object-design.md §3d).
//
// NO TRASH CAN HERE. Deleting a whole import is on the detail screen, which is
// the one that has actually shown the user its plays — a confirm has to say
// what will be lost (.claude/rules/web-frontend.md), and "12 plays" on a screen
// that never showed them is a worse gate than the one this replaces.

(function () {
  class ImportsView extends window.View {
    constructor() {
      super("imports");
      this._reset();
    }

    _reset() {
      this._imports = [];
      this._loading = false;
      this._loaded = false;
      this._failed = false;
    }

    async onMount() {
      // Singleton view: a previous account's list must not paint under this one
      // (.claude/rules/web-frontend.md § Async state).
      this._reset();
      // Both deletes live one screen down and neither routes back through a
      // fetch, so this list is how the index learns a batch shrank or went.
      // `plays-changed` is the run sheet's; `play-changed` covers a single play
      // deleted from its popup.
      this.listenDom("plays-changed", () => this._load());
      this.listenDom("play-changed", () => this._load());
      await this._load();
    }

    onUnmount() {
      this._reset();
    }

    async _load() {
      this._loading = true;
      this._failed = false;
      this.render();
      try {
        this._imports = await window.Play.listImports();
        this._loaded = true;
      } catch (_) {
        // Only a failure with nothing on screen is an error state; a failed
        // refresh over a list already painted leaves the list alone.
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
      const n = this._imports.length;
      this.container.innerHTML = `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to settings"
                  onclick="window.router.up('settings')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">
            <span class="spoke-head__title-text">Imported plays</span>
          </h2>
          ${this._loaded && n
            ? `<span class="spoke-head__count">${n} import${n === 1 ? "" : "s"}</span>`
            : ""}
        </header>
        <section class="admin-spoke__body">${this._renderBody()}</section>
      `;
      this.refreshIcons();
    }

    _renderBody() {
      // Gated on the count as well as both flags, so a refresh that cleared the
      // list before its request went out cannot fall through to the empty state.
      if (!this._imports.length && (!this._loaded || this._loading)) {
        return window.buddyLoader({ size: 88, label: "Opening…" });
      }
      if (this._failed) {
        return `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Couldn't load your imports just now.</p>
            <button class="btn btn-sm btn-primary"
                    onclick="window.importsView._load()">Try again</button>
          </div>`;
      }
      if (!this._imports.length) {
        return `
          <div class="profile-empty">You haven't imported any plays yet.</div>
          <div class="set-card">
            <button class="set-card__row" onclick="window.router.go('import-wizard')">
              <span class="set-card__row-icon"><i data-icon="upload" class="w-4 h-4"></i></span>
              <span class="set-card__row-body">
                <span class="set-card__row-title">Play importer</span>
                <span class="set-card__row-sub">
                  Read an evening off a photo or a note. You review every play
                  before anything is saved.
                </span>
              </span>
              <span class="set-card__row-chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
            </button>
          </div>`;
      }
      return `<div class="set-card">${this._imports.map((imp) => this._renderRow(imp)).join("")}</div>`;
    }

    _renderRow(imp) {
      const n = imp.play_count || 0;
      const names = imp.game_names || [];
      // The names are capped at four server-side; the ellipsis says so rather
      // than letting a fifteen-game paste read as a four-game one.
      const games = names.join(", ") + ((imp.game_count || 0) > names.length ? "…" : "");
      const go = `window.router.go('import-detail',{batchId:'${jsStr(imp.batch_id)}'})`;
      return `
        <button class="set-card__row" onclick="${escapeAttr(go)}">
          <span class="set-card__row-icon"><i data-icon="history" class="w-4 h-4"></i></span>
          <span class="set-card__row-body">
            <span class="set-card__row-title">
              ${n} play${n === 1 ? "" : "s"}${games ? ` · ${escapeHtml(games)}` : ""}
            </span>
            <span class="set-card__row-sub">
              Imported ${escapeHtml(formatDate(imp.imported_at))}
            </span>
          </span>
          <span class="set-card__row-chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
        </button>
      `;
    }
  }

  window.ImportsView = ImportsView;
})();
