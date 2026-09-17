// views/admin-release-notices-view.js — writing the what's-new popup.
//
// The fifth admin spoke off Settings → Admin tools, and the only one that
// AUTHORS rather than moderates: the other four work a queue somebody else
// filled. So it carries no badge — a draft nobody has published is not work
// waiting, and domain/notifications.js is explicitly for transient signals with
// a dot to hang on.
//
// Split view/widget the way admin-backfill-view splits from its panel, but
// along a different seam: there are three backfill spokes and one of this, so
// the split here is the ~300-line cap plus the onboarding-deck seam — this file
// owns the SCREEN (route, gate, list, filter, refresh) and
// widgets/release-notice-editor.js owns ONE NOTICE (the form, the live preview,
// the route picker). The editor is inline rather than a modal on purpose; its
// header says why.

(function () {
  class AdminReleaseNoticesView extends window.View {
    constructor() {
      super("admin-release-notices");
      this._resetState();
    }

    // Centralised so the constructor and every mount agree. A singleton view
    // survives logout→login and back-stack pops, so a previous session's open
    // editor would otherwise paint under the next mount
    // (.claude/rules/web-frontend.md, "Reset transient state on every mount").
    _resetState() {
      this._notices = [];
      this._loading = false;
      this._loadFailed = false;
      this._status = "all"; // "all" | "draft" | "published"
      this._editing = null; // a notice object, {} for a new one, or null
      this._saving = false;
    }

    async onMount() {
      this._resetState();
      if (!window.AdminGate.allowed()) return;
      await this._load();
    }

    onUnmount() {
      this._resetState();
    }

    async _load() {
      this._loading = true;
      this._loadFailed = false;
      this.render();
      try {
        this._notices = await window.ReleaseNotices.adminList(this._status);
      } catch (e) {
        // A failed first load is not an empty state: "No notices yet" next to a
        // dead network reads as permanent and offers no way to ask again.
        this._loadFailed = true;
        this._notices = [];
        showToast(e.message || "Couldn't load release notices", "error");
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      // Re-checked on every paint, not once in onMount: View#mount() renders
      // again after onMount, which would overwrite a one-shot refusal
      // (ui/admin-gate.js).
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head("Release notices")}
        <section class="admin-spoke__body">
          ${this._editing
            ? window.ReleaseNoticeEditor.render(this._editing)
            : this._renderList()}
        </section>
      `;
      this.refreshIcons();
      if (this._editing) window.ReleaseNoticeEditor.bind(this);
    }

    _renderList() {
      return `
        <div class="rel-admin__bar">
          <div class="rel-admin__filter">
            ${["all", "draft", "published"]
              .map(
                (s) => `
              <button class="btn btn-xs ${this._status === s ? "btn-primary" : "btn-ghost"}"
                      onclick="window.adminReleaseNoticesView._setStatus('${s}')">
                ${s === "all" ? "All" : s === "draft" ? "Drafts" : "Published"}
              </button>`,
              )
              .join("")}
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.adminReleaseNoticesView._new()">
            <i data-icon="plus" class="w-4 h-4"></i> New
          </button>
        </div>
        ${this._renderBody()}
      `;
    }

    _renderBody() {
      // Three states, three branches. The count is checked alongside the flags
      // so a reset that cleared the list before the request went out cannot
      // fall through to the empty state (web-frontend.md).
      if (this._loading || (!this._notices.length && this._loading)) {
        return window.buddyLoader({ size: 80 });
      }
      if (this._loadFailed) {
        return `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Couldn't load the notices.</p>
            <button class="btn btn-sm btn-primary"
                    onclick="window.adminReleaseNoticesView._load()">Try again</button>
          </div>`;
      }
      if (!this._notices.length) {
        return `<div class="text-sm opacity-60 p-6 text-center">
          ${this._status === "draft"
            ? "No drafts."
            : this._status === "published"
              ? "Nothing published yet."
              : "No release notices yet. Write one when something big ships."}
        </div>`;
      }
      return `<ul class="rel-admin__list">
        ${this._notices.map((n) => this._renderRow(n)).join("")}
      </ul>`;
    }

    _renderRow(n) {
      const live = !!n.published_at;
      return `
        <li class="rel-admin__row">
          <div class="rel-admin__rowhead">
            <span class="rel-admin__pill ${live ? "is-live" : ""}">
              ${live ? "Published" : "Draft"}
            </span>
            <span class="rel-admin__date">
              ${live ? escapeHtml(formatDate(n.published_at)) : escapeHtml(formatDate(n.created_at))}
            </span>
          </div>
          <div class="rel-admin__title">${escapeHtml(n.title)}</div>
          ${n.link_route
            ? `<div class="rel-admin__link">
                 <i data-icon="arrow-right" class="w-3.5 h-3.5"></i>
                 ${escapeHtml(n.link_label || "Take me there")} → ${escapeHtml(n.link_route)}
               </div>`
            : ""}
          <div class="rel-admin__actions">
            <button class="btn btn-ghost btn-xs"
                    onclick="window.adminReleaseNoticesView._edit('${escapeAttr(n.id)}')">Edit</button>
            <button class="btn btn-ghost btn-xs"
                    onclick="window.adminReleaseNoticesView._togglePublished('${escapeAttr(n.id)}')">
              ${live ? "Unpublish" : "Publish"}
            </button>
            <button class="btn btn-ghost btn-xs rel-admin__del"
                    onclick="window.adminReleaseNoticesView._delete('${escapeAttr(n.id)}')">
              <i data-icon="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </li>
      `;
    }

    async _setStatus(s) {
      if (this._status === s) return;
      this._status = s;
      await this._load();
    }

    _new() {
      this._editing = {};
      this.render();
    }

    _edit(id) {
      this._editing = this._notices.find((n) => n.id === id) || null;
      this.render();
    }

    _cancelEdit() {
      this._editing = null;
      this.render();
    }

    /** Delegator: the editor's inline handlers name this view, not the widget. */
    _pickRoute() {
      window.ReleaseNoticeEditor.pickRoute(this);
    }

    async _saveEdit() {
      if (this._saving) return;
      const payload = window.ReleaseNoticeEditor.collect();
      if (!payload) return;
      const editing = this._editing || {};
      this._saving = true;
      try {
        if (editing.id) {
          // clear_link distinguishes "leave the link alone" from "remove it" —
          // null is also the absent value, so without the flag a link could be
          // set and never unset.
          await window.ReleaseNotices.adminUpdate(editing.id, {
            ...payload,
            clear_link: !payload.link_route,
          });
        } else {
          await window.ReleaseNotices.adminCreate(payload);
        }
        this._editing = null;
        showToast(editing.id ? "Saved" : "Draft saved", "success");
        await this._load();
      } catch (e) {
        showToast(e.message || "Couldn't save that", "error");
      } finally {
        this._saving = false;
      }
    }

    async _togglePublished(id) {
      const n = this._notices.find((x) => x.id === id);
      if (!n) return;
      const live = !!n.published_at;

      // Publishing confirms too, even though unpublish exists — because
      // unpublish is weaker than it looks and the confirm is the only place
      // that says so before the fact.
      const ok = await window.PolaroidPopup.confirm(
        live
          ? {
              title: "Pull this back to a draft?",
              body: "It stops reaching anyone who hasn't seen it. Anyone who already has keeps having seen it — there's no way to un-show a notice.",
              confirmLabel: "Unpublish",
              cancelLabel: "Leave it live",
            }
          : {
              title: `Publish "${n.title}"?`,
              body: "Everyone sees it once, next time they open the app. You can pull it back, but not from anyone who's already read it.",
              confirmLabel: "Publish",
              cancelLabel: "Not yet",
            },
      );
      if (!ok) return;

      try {
        if (live) await window.ReleaseNotices.adminUnpublish(id);
        else await window.ReleaseNotices.adminPublish(id);
        showToast(live ? "Back to a draft" : "Published", "success");
        await this._load();
      } catch (e) {
        showToast(e.message || "That didn't go through", "error");
      }
    }

    async _delete(id) {
      const n = this._notices.find((x) => x.id === id);
      if (!n) return;
      const ok = await window.PolaroidPopup.confirm({
        title: "Delete this notice?",
        body: n.published_at
          ? "It's gone from the archive for good. Anyone who already saw it keeps having seen it."
          : "This draft is gone for good.",
        confirmLabel: "Delete",
        cancelLabel: "Keep it",
        destructive: true,
      });
      if (!ok) return;
      try {
        await window.ReleaseNotices.adminDelete(id);
        showToast("Deleted", "success");
        await this._load();
      } catch (e) {
        showToast(e.message || "Couldn't delete it", "error");
      }
    }
  }

  window.AdminReleaseNoticesView = AdminReleaseNoticesView;
})();
