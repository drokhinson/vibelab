// views/admin-view.js — admin tooling.
//
// Houses the chapter-reports moderation panel. Resolve closes a report
// without touching the chapter; Delete chapter removes the chapter from
// the pool (and cascades the report).

(function () {
  class AdminView extends window.View {
    constructor() {
      super("admin");
      this._reports = [];
      this._loading = false;
      this._status = "open"; // "open" | "resolved"
      // Missing-images panel. _refreshingOne tracks the currently-refreshing
      // single-game id so we can disable that row's button. _bulkRefreshing
      // does the same for the "Refresh all" button.
      this._missingImages = [];
      this._missingImagesLoading = false;
      this._refreshingOne = null;
      this._bulkRefreshing = false;
    }

    async onMount() {
      const me = window.store.get("user");
      if (!me || !me.is_admin) {
        this.container.innerHTML = `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Admin access required.</p>
            <button class="btn btn-primary" onclick="window.router.go('feed')">Back to feed</button>
          </div>
        `;
        return;
      }
      // Fan both panels' fetches out in parallel — they're independent.
      await Promise.all([
        this._loadReports(),
        this._loadMissingImages(),
      ]);
    }

    async _loadReports() {
      this._loading = true;
      this.render();
      try {
        this._reports = await window.Chapter.adminReports(this._status) || [];
      } catch (e) {
        showToast(e.message || "Failed to load reports", "error");
        this._reports = [];
      } finally {
        this._loading = false;
        this.render();
      }
    }

    async _loadMissingImages() {
      this._missingImagesLoading = true;
      this.render();
      try {
        const rows = await window.Game.adminMissingImages();
        this._missingImages = Array.isArray(rows) ? rows : [];
      } catch (e) {
        showToast(e.message || "Failed to load games with missing images", "error");
        this._missingImages = [];
      } finally {
        this._missingImagesLoading = false;
        this.render();
      }
    }

    async _refreshOneImage(gameId) {
      this._refreshingOne = gameId;
      this.render();
      try {
        await window.Game.adminRefreshOneImage(gameId);
        showToast("Image refreshed", "success");
        // Drop the row optimistically so the user sees progress without
        // waiting for the missing-images query to round-trip again.
        this._missingImages = this._missingImages.filter((g) => g.id !== gameId);
        this.render();
      } catch (e) {
        showToast(e.message || "Refresh failed", "error");
      } finally {
        this._refreshingOne = null;
        this.render();
      }
    }

    async _refreshAllImages() {
      const count = this._missingImages.length;
      const proceed = window.confirm(
        count > 0
          ? `Re-host BGG images for ${count} game${count === 1 ? "" : "s"}? This calls BGG once per game and is throttled — may take a minute or two.`
          : "Re-host images for every game with a missing or BGG-hosted URL? This calls BGG once per game and is throttled.",
      );
      if (!proceed) return;
      this._bulkRefreshing = true;
      this.render();
      try {
        const result = await window.Game.adminRefreshAllImages();
        const updated = (result && result.updated) || 0;
        showToast(`Refreshed ${updated} game${updated === 1 ? "" : "s"}`, "success");
        await this._loadMissingImages();
      } catch (e) {
        showToast(e.message || "Bulk refresh failed", "error");
      } finally {
        this._bulkRefreshing = false;
        this.render();
      }
    }

    render() {
      this.container.innerHTML = `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('settings')">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-lg">Admin tools</h2>
          <span></span>
        </header>
        <section class="p-3">
          <div class="admin-reports__header">
            <h3 class="font-semibold flex items-center gap-2">
              <i data-lucide="flag" class="w-4 h-4"></i> Chapter reports
            </h3>
            <div class="admin-reports__filter">
              <button class="btn btn-xs ${this._status === "open" ? "btn-primary" : "btn-ghost"}"
                      onclick="window.adminView._setStatus('open')">Open</button>
              <button class="btn btn-xs ${this._status === "resolved" ? "btn-primary" : "btn-ghost"}"
                      onclick="window.adminView._setStatus('resolved')">Resolved</button>
            </div>
          </div>
          ${this._renderBody()}
        </section>

        <section class="p-3">
          ${this._renderMissingImagesPanel()}
        </section>
      `;
      this.refreshIcons();
    }

    _renderMissingImagesPanel() {
      const count = this._missingImages.length;
      const bulkDisabled = this._bulkRefreshing || this._missingImagesLoading;
      return `
        <div class="admin-reports__header">
          <h3 class="font-semibold flex items-center gap-2">
            <i data-lucide="image-off" class="w-4 h-4"></i>
            Games missing images
            ${this._missingImagesLoading ? "" : `<span class="opacity-60 font-normal text-sm">(${count})</span>`}
          </h3>
          <button class="btn btn-xs ${bulkDisabled ? "btn-ghost" : "btn-primary"}"
                  ${bulkDisabled ? "disabled" : ""}
                  onclick="window.adminView._refreshAllImages()">
            ${this._bulkRefreshing
              ? `<span class="loading loading-spinner loading-xs"></span> Refreshing…`
              : `<i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Refresh all`}
          </button>
        </div>
        ${this._renderMissingImagesBody()}
      `;
    }

    _renderMissingImagesBody() {
      if (this._missingImagesLoading && this._missingImages.length === 0) {
        return window.buddyLoader({ size: 64 });
      }
      if (this._missingImages.length === 0) {
        return `<div class="text-sm opacity-60 p-6 text-center">All catalog games have images.</div>`;
      }
      return `
        <ul class="admin-reports__list">
          ${this._missingImages.map((g) => this._renderMissingImageRow(g)).join("")}
        </ul>
      `;
    }

    _renderMissingImageRow(g) {
      const refreshing = this._refreshingOne === g.id;
      const disabled = refreshing || !g.bgg_id || this._bulkRefreshing;
      const missingParts = [];
      if (!g.thumbnail_url) missingParts.push("thumb");
      if (!g.image_url) missingParts.push("image");
      const label = missingParts.length ? `Missing: ${missingParts.join(", ")}` : "OK";
      return `
        <li class="admin-reports__row">
          <div class="admin-reports__meta">
            <span class="admin-reports__game">${escape(g.name)}</span>
            ${g.bgg_id ? `<span class="admin-reports__type">BGG ${g.bgg_id}</span>` : `<span class="admin-reports__type">no bgg_id</span>`}
            ${g.year_published ? `<span class="admin-reports__date">${g.year_published}</span>` : ""}
          </div>
          <div class="admin-reports__preview">${escape(label)}</div>
          <div class="admin-reports__footer">
            <span class="admin-reports__reporter">${g.bgg_id ? "" : "No BGG id — refresh disabled."}</span>
            <div class="admin-reports__actions">
              <button class="btn btn-xs ${disabled ? "btn-ghost" : "btn-primary"}"
                      ${disabled ? "disabled" : ""}
                      onclick="window.adminView._refreshOneImage('${g.id}')">
                ${refreshing
                  ? `<span class="loading loading-spinner loading-xs"></span> Refreshing…`
                  : `<i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Refresh`}
              </button>
            </div>
          </div>
        </li>
      `;
    }

    _renderBody() {
      if (this._loading) return window.buddyLoader({ size: 80 });
      if (this._reports.length === 0) {
        return `<div class="text-sm opacity-60 p-6 text-center">
          No ${this._status} reports.
        </div>`;
      }
      return `
        <ul class="admin-reports__list">
          ${this._reports.map((r) => this._renderReport(r)).join("")}
        </ul>
      `;
    }

    _renderReport(r) {
      const open = r.status === "open";
      return `
        <li class="admin-reports__row">
          <div class="admin-reports__meta">
            <span class="admin-reports__game">${escape(r.game_name)}</span>
            <span class="admin-reports__type">${escape(r.chapter_type_label || r.chapter_type)}</span>
            <span class="admin-reports__date" title="${escape(r.created_at)}">${formatDate(r.created_at)}</span>
          </div>
          <div class="admin-reports__title">${escape(r.chapter_title)}</div>
          <div class="admin-reports__preview">${escape(r.chapter_content_preview)}</div>
          ${r.reason ? `<div class="admin-reports__reason"><strong>Reason:</strong> ${escape(r.reason)}</div>` : ""}
          <div class="admin-reports__footer">
            <span class="admin-reports__reporter">
              Reported by ${escape(r.reporter_name || "(unknown)")}
            </span>
            ${open ? `
              <div class="admin-reports__actions">
                <button class="btn btn-ghost btn-xs"
                        onclick="window.adminView._resolve('${r.id}')">
                  Resolve
                </button>
                <button class="btn btn-error btn-xs"
                        onclick="window.adminView._deleteChapter('${r.chapter_id}', '${r.id}')">
                  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Delete chapter
                </button>
              </div>
            ` : `
              <span class="admin-reports__resolved">
                Resolved${r.resolved_at ? ` ${formatDate(r.resolved_at)}` : ""}
              </span>
            `}
          </div>
        </li>
      `;
    }

    async _setStatus(s) {
      if (this._status === s) return;
      this._status = s;
      await this._loadReports();
    }

    async _resolve(reportId) {
      try {
        await window.Chapter.adminResolveReport(reportId);
        showToast("Report resolved", "success");
        await this._loadReports();
      } catch (e) {
        showToast(e.message || "Failed to resolve report", "error");
      }
    }

    async _deleteChapter(chapterId, reportId) {
      if (!window.confirm("Delete this chapter? This removes it from the pool and from every user's guide. The report will be cleared.")) {
        return;
      }
      try {
        await window.Chapter.delete(chapterId);
        showToast("Chapter deleted", "success");
        await this._loadReports();
      } catch (e) {
        showToast(e.message || "Failed to delete chapter", "error");
      }
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  window.AdminView = AdminView;
})();
