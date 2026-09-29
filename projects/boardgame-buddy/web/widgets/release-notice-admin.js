// widgets/release-notice-admin.js — the admin half of the What's new spoke.
//
// One screen serves both audiences: a reader sees the published archive, an
// admin sees every notice (drafts too) with a filter, a New button and
// Edit / Publish / Delete on each row. views/whats-new-view.js owns the screen
// (route, load, list, expansion); this file owns what only an admin gets, so
// the reader's path never carries it. Every function takes the view as its
// host, and the inline handlers name window.whatsNewView — the same
// host-callback contract widgets/release-notice-editor.js uses.
//
// The server gates every write (get_current_admin); AdminGate.allowed() only
// decides what to draw.

(function () {
  const HOST = "window.whatsNewView";
  const FILTERS = [
    ["all", "All"],
    ["draft", "Drafts"],
    ["published", "Published"],
  ];

  function renderBar(view) {
    return `
      <div class="rel-admin__bar">
        <div class="rel-admin__filter">
          ${FILTERS.map(([s, label]) => `
            <button class="btn btn-xs ${view._status === s ? "btn-primary" : "btn-ghost"}"
                    onclick="${HOST}._setStatus('${s}')">${label}</button>`).join("")}
        </div>
        <button class="btn btn-primary btn-sm" onclick="${HOST}._new()">
          <i data-icon="plus" class="w-4 h-4"></i> New
        </button>
      </div>
    `;
  }

  function renderPill(n) {
    const live = !!n.published_at;
    return `<span class="rel-admin__pill ${live ? "is-live" : ""}">${live ? "Published" : "Draft"}</span>`;
  }

  function renderActions(n) {
    const id = escapeAttr(n.id);
    return `
      <div class="rel-admin__actions whats-new__admin">
        <button class="btn btn-ghost btn-xs" onclick="${HOST}._edit('${id}')">Edit</button>
        <button class="btn btn-ghost btn-xs" onclick="${HOST}._togglePublished('${id}')">
          ${n.published_at ? "Unpublish" : "Publish"}
        </button>
        <button class="btn btn-ghost btn-xs rel-admin__del" aria-label="Delete"
                onclick="${HOST}._delete('${id}')">
          <i data-icon="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `;
  }

  function emptyText(status) {
    if (status === "draft") return "No drafts.";
    if (status === "published") return "Nothing published yet.";
    return "No release notices yet. Write one when something big ships.";
  }

  async function save(view) {
    if (view._saving) return;
    const payload = window.ReleaseNoticeEditor.collect();
    if (!payload) return;
    const editing = view._editing || {};
    view._saving = true;
    try {
      if (editing.id) {
        // clear_link distinguishes "leave the link alone" from "remove it":
        // null is also the absent value, so without the flag a link could be
        // set and never unset.
        await window.ReleaseNotices.adminUpdate(editing.id, {
          ...payload,
          clear_link: !payload.link_route,
        });
      } else {
        await window.ReleaseNotices.adminCreate(payload);
      }
      view._editing = null;
      showToast(editing.id ? "Saved" : "Draft saved", "success");
      await view._load();
    } catch (e) {
      showToast(e.message || "Couldn't save that", "error");
    } finally {
      view._saving = false;
    }
  }

  async function togglePublished(view, id) {
    const n = view._notices.find((x) => x.id === id);
    if (!n) return;
    const live = !!n.published_at;

    // Publishing confirms too, even though unpublish exists: unpublish is
    // weaker than it looks and the confirm is the only place that says so
    // before the fact.
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
      await view._load();
    } catch (e) {
      showToast(e.message || "That didn't go through", "error");
    }
  }

  async function remove(view, id) {
    const n = view._notices.find((x) => x.id === id);
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
      await view._load();
    } catch (e) {
      showToast(e.message || "Couldn't delete it", "error");
    }
  }

  window.ReleaseNoticeAdmin = {
    renderBar,
    renderPill,
    renderActions,
    emptyText,
    save,
    togglePublished,
    remove,
  };
})();
