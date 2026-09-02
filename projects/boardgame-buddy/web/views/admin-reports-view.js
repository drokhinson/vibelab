// views/admin-reports-view.js — the chapter-reports moderation spoke.
//
// One of three admin spokes off Settings → Admin tools. Resolve closes a
// report without touching the chapter; Delete chapter removes the chapter from
// the pool (and cascades the report).
//
// Split out of the old combined admin-view.js when each tool got its own row
// and its own badge: a single screen stacking all three could only ever have
// one notification count, so an admin with a report waiting and a clean
// backfill queue had no way to tell that from the reverse.

(function () {
  class AdminReportsView extends window.View {
    constructor() {
      super("admin-reports");
      this._reports = [];
      this._loading = false;
      this._status = "open"; // "open" | "resolved"
    }

    async onMount() {
      if (!window.AdminGate.allowed()) return;
      await this._load();
    }

    async _load() {
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
      // Re-checked on every paint, not once in onMount: View#mount()
      // renders again after onMount, which would overwrite a one-shot refusal.
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head("Chapter reports")}
        <section class="admin-spoke__body">
          <div class="admin-reports__header">
            <div class="admin-reports__filter">
              <button class="btn btn-xs ${this._status === "open" ? "btn-primary" : "btn-ghost"}"
                      onclick="window.adminReportsView._setStatus('open')">Open</button>
              <button class="btn btn-xs ${this._status === "resolved" ? "btn-primary" : "btn-ghost"}"
                      onclick="window.adminReportsView._setStatus('resolved')">Resolved</button>
            </div>
          </div>
          ${this._renderBody()}
        </section>
      `;
      this.refreshIcons();
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
            <span class="admin-reports__game">${escapeHtml(r.game_name)}</span>
            <span class="admin-reports__type">${escapeHtml(r.chapter_type_label || r.chapter_type)}</span>
            <span class="admin-reports__date" title="${escapeHtml(r.created_at)}">${formatDate(r.created_at)}</span>
          </div>
          <div class="admin-reports__title">${escapeHtml(r.chapter_title)}</div>
          <div class="admin-reports__preview">${escapeHtml(r.chapter_content_preview)}</div>
          ${r.reason ? `<div class="admin-reports__reason"><strong>Reason:</strong> ${escapeHtml(r.reason)}</div>` : ""}
          <div class="admin-reports__footer">
            <span class="admin-reports__reporter">
              Reported by ${escapeHtml(r.reporter_name || "(unknown)")}
            </span>
            ${open ? `
              <div class="admin-reports__actions">
                <button class="btn btn-ghost btn-xs"
                        onclick="window.adminReportsView._resolve('${r.id}')">
                  Resolve
                </button>
                <button class="btn btn-error btn-xs"
                        onclick="window.adminReportsView._deleteChapter('${r.chapter_id}', '${r.id}')">
                  <i data-icon="trash-2" class="w-3.5 h-3.5"></i> Delete chapter
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
      await this._load();
    }

    async _resolve(reportId) {
      try {
        await window.Chapter.adminResolveReport(reportId);
        showToast("Report resolved", "success");
        await this._load();
        // The gear's dot counts OPEN reports, so resolving one has to move it
        // — otherwise the admin clears the queue and the dot stays lit.
        window.AdminReview.refresh();
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
        await this._load();
        window.AdminReview.refresh();
      } catch (e) {
        showToast(e.message || "Failed to delete chapter", "error");
      }
    }
  }

  window.AdminReportsView = AdminReportsView;
})();
