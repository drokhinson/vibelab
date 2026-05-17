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
      await this._loadReports();
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
      `;
      if (window.lucide) window.lucide.createIcons();
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
