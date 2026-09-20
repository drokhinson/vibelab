// views/admin-rulebooks-view.js — the rulebook-link approval spoke (052).
//
// A sibling of admin-reports-view.js, and deliberately not a tab on it. A
// report is somebody objecting to prose AFTER it was published; a rulebook link
// is an outbound destination looked at on the way IN. Two queues, two
// questions, two badges — and one screen stacking both could only ever carry
// one count, which is the bug that split the admin tools into spokes in the
// first place.
//
// What an admin is deciding here is one thing: does this URL go where it says
// it goes. So the row leads with the host, carries the full URL underneath it
// as a real link, and says who submitted it and how many buddies can already
// follow it — because a pending link is not dormant, it is live for the
// author's accepted buddies the whole time it waits.

(function () {
  class AdminRulebooksView extends window.View {
    constructor() {
      super("admin-rulebooks");
      this._links = [];
      this._loading = false;
      this._status = "pending"; // "pending" | "approved" | "denied"
      // Which chapter ids have a decision in flight. A set rather than one
      // flag: an admin works down a queue and a second tap while the first is
      // in the air must disable only the row it belongs to.
      this._busy = new Set();
    }

    async onMount() {
      if (!window.AdminGate.allowed()) return;
      await this._load();
    }

    async _load() {
      this._loading = true;
      this.render();
      try {
        this._links = await window.Chapter.adminRulebookLinks(this._status) || [];
      } catch (e) {
        showToast(e.message || "Failed to load rulebook links", "error");
        this._links = [];
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      // Re-checked on every paint, not once in onMount: View#mount() renders
      // again after onMount, which would overwrite a one-shot refusal.
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head("Rulebook links")}
        <section class="admin-spoke__body">
          <div class="admin-reports__header">
            <div class="admin-reports__filter">
              ${this._tab("pending", "Pending")}
              ${this._tab("approved", "Approved")}
              ${this._tab("denied", "Denied")}
            </div>
          </div>
          ${this._renderBody()}
        </section>
      `;
      this.refreshIcons();
    }

    _tab(status, label) {
      return `
        <button class="btn btn-xs ${this._status === status ? "btn-primary" : "btn-ghost"}"
                onclick="window.adminRulebooksView._setStatus('${status}')">${label}</button>
      `;
    }

    _renderBody() {
      if (this._loading) return window.buddyLoader({ size: 80 });
      if (this._links.length === 0) {
        return `<div class="text-sm opacity-60 p-6 text-center">
          ${this._status === "pending"
            ? "Nothing waiting — every rulebook link has been decided."
            : `No ${this._status} rulebook links.`}
        </div>`;
      }
      return `
        <ul class="admin-reports__list">
          ${this._links.map((l) => this._renderLink(l)).join("")}
        </ul>
      `;
    }

    _renderLink(l) {
      const busy = this._busy.has(l.chapter_id);
      const pending = l.moderation_status === "pending";
      const author = l.created_by_name
        // A backfilled link (migration 052 lifted these out of the old catalog
        // column) has no author at all, and the queue says so rather than
        // inventing one.
        ? `Submitted by ${escapeHtml(l.created_by_name)}`
        : "Curated — no submitter";
      // The number that makes a pending row urgent rather than merely
      // outstanding: how many people can already follow this link because they
      // are buddies with whoever posted it.
      const reach = pending && l.buddy_reach
        ? `<span class="admin-rulebooks__reach" title="Buddies of the submitter can already open this link">
             <i data-icon="users" class="w-3.5 h-3.5"></i>
             ${l.buddy_reach} ${l.buddy_reach === 1 ? "buddy" : "buddies"} can already see it
           </span>`
        : "";
      return `
        <li class="admin-reports__row">
          <div class="admin-reports__meta">
            <span class="admin-reports__game">${escapeHtml(l.game_name)}</span>
            <span class="admin-reports__date" title="${escapeHtml(l.created_at)}">${formatDate(l.created_at)}</span>
          </div>
          <!-- The host, big: it is what the decision is actually about, and it
               is the part of a URL that a lookalike domain hides at the end of.
               The full address is the link below it, opened in a new tab with
               rel="noopener" — an admin has to be able to follow it to judge
               it, and this is the one screen in the app that deliberately
               visits an unreviewed destination. -->
          <div class="admin-reports__title">${escapeHtml(l.link_host)}</div>
          <a class="admin-rulebooks__url" href="${escapeAttr(l.link_url)}"
             target="_blank" rel="noopener nofollow">
            ${escapeHtml(l.link_url)}
            <i data-icon="external-link" class="w-3.5 h-3.5"></i>
          </a>
          <div class="admin-reports__footer">
            <span class="admin-reports__reporter">${author}${reach ? " · " : ""}${reach}</span>
            <div class="admin-reports__actions">
              ${l.moderation_status !== "approved" ? `
                <button class="btn btn-ghost btn-xs" ${busy ? "disabled" : ""}
                        onclick="window.adminRulebooksView._decide('${l.chapter_id}', 'approve')">
                  <i data-icon="check" class="w-3.5 h-3.5"></i> Approve
                </button>` : ""}
              ${l.moderation_status !== "denied" ? `
                <button class="btn btn-error btn-xs" ${busy ? "disabled" : ""}
                        onclick="window.adminRulebooksView._decide('${l.chapter_id}', 'deny')">
                  <i data-icon="x" class="w-3.5 h-3.5"></i> Deny
                </button>` : ""}
            </div>
          </div>
        </li>
      `;
    }

    async _setStatus(s) {
      if (this._status === s) return;
      this._status = s;
      await this._load();
    }

    /**
     * Approve or deny, from any tab.
     *
     * Both directions are available on an already-decided link, which is what
     * makes a denial undoable: the row stays in the table (a denial is not a
     * delete — see migration 052) and the Denied tab is where it is found
     * again.
     *
     * A denial gets the project's one confirm surface, an approval does not:
     * approving is the reversible half and confirming both would train the
     * habit of tapping through the dialog that matters.
     */
    async _decide(chapterId, decision) {
      if (this._busy.has(chapterId)) return;
      if (decision === "deny") {
        const ok = await window.PolaroidPopup.confirm({
          title: "Deny this rulebook link?",
          body: "It disappears for everyone except whoever submitted it — their buddies included. They can edit it and submit a different URL.",
          confirmLabel: "Deny", cancelLabel: "Keep looking", destructive: true,
        });
        if (!ok) return;
      }
      this._busy.add(chapterId);
      this.render();
      try {
        const res = decision === "approve"
          ? await window.Chapter.adminApproveRulebook(chapterId)
          : await window.Chapter.adminDenyRulebook(chapterId);
        showToast((res && res.message) || "Done", "success");
        await this._load();
        // The gear's dot counts PENDING links, so a decision has to move it —
        // otherwise the admin clears the queue and the dot stays lit. Same
        // reason admin-reports-view refreshes after a resolve.
        window.AdminReview.refresh();
      } catch (e) {
        showToast(e.message || "Couldn't record that decision", "error");
      } finally {
        this._busy.delete(chapterId);
        this.render();
      }
    }
  }

  window.AdminRulebooksView = AdminRulebooksView;
})();
