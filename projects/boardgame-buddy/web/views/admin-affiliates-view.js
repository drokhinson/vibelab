// views/admin-affiliates-view.js — switching retailer partners on, and off.
//
// The spoke behind Settings → Admin tools → Affiliate partners. Four fixed
// rows (migration 046 seeds them; there is no New and no Delete — a retailer
// is a program you joined, not a note you wrote), each with an Edit that opens
// widgets/affiliate-partner-editor.js inline and an Enable/Disable that is
// THE switch: nothing on any game page shows a pill until one of these is
// live. Like release notices this AUTHORS rather than moderates, so it carries
// no badge and no row in domain/notifications.js.
//
// Enable confirms, because it is the one tap on this card that changes what
// every reader sees. Disable confirms too, but reads differently: it is the
// instant off switch, and the copy says so.

(function () {
  class AdminAffiliatesView extends window.View {
    constructor() {
      super("admin-affiliates");
      this._resetState();
    }

    _resetState() {
      this._partners = [];
      this._clicks = null;      // AffiliateClickSummary or null
      this._loading = false;
      this._loadFailed = false;
      this._editing = null;     // a partner object or null
      this._preview = null;     // the editor's saved-link preview
      this._saving = false;
      this._busy = new Set();   // partner ids with a switch in flight
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
        const [partners, clicks] = await Promise.all([
          window.Affiliate.adminList(),
          window.Affiliate.adminClicks(30).catch(() => null),
        ]);
        this._partners = partners;
        this._clicks = clicks;
      } catch (e) {
        this._loadFailed = true;
        this._partners = [];
        showToast(e.message || "Couldn't load the partners", "error");
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head("Affiliate partners")}
        <section class="admin-spoke__body">
          ${this._editing
            ? window.AffiliatePartnerEditor.render(this._editing, this._preview)
            : this._renderList()}
        </section>
      `;
      this.refreshIcons();
    }

    _renderList() {
      const anyLive = this._partners.some((p) => p.live);
      return `
        <p class="aff-admin__lede">
          ${anyLive
            ? "Readers see a <strong>Where to buy</strong> section under every game for each live partner."
            : "<strong>Nothing is showing to readers.</strong> A partner goes live only once it holds a tracking tag or wrapper link <em>and</em> you enable it here."}
          Setup for each program is in <code>Docs/AFFILIATE_LINKS.md</code>.
        </p>
        ${this._renderBody()}
      `;
    }

    _renderBody() {
      if (this._loading) return window.buddyLoader({ size: 80 });
      if (this._loadFailed) {
        return `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">Couldn't load the partners.</p>
            <button class="btn btn-sm btn-primary" onclick="window.adminAffiliatesView._load()">Try again</button>
          </div>`;
      }
      if (!this._partners.length) {
        return `<div class="text-sm opacity-60 p-6 text-center">No partners seeded. Run migration 046.</div>`;
      }
      return `<ul class="rel-admin__list">${this._partners.map((p) => this._renderRow(p)).join("")}</ul>`;
    }

    _clicksFor(id) {
      const rows = (this._clicks && this._clicks.by_partner) || [];
      const hit = rows.find((r) => r.partner_id === id);
      return hit ? hit.clicks : 0;
    }

    _renderRow(p) {
      const pill = p.live
        ? `<span class="rel-admin__pill is-live">Live</span>`
        : p.enabled
          ? `<span class="rel-admin__pill">Enabled · no credential</span>`
          : `<span class="rel-admin__pill">Off</span>`;
      const cred = p.tracking_tag
        ? `tag <code>${escapeHtml(p.tracking_tag)}</code>`
        : p.wrapper_template
          ? "wrapper link set"
          : "no credential yet";
      const busy = this._busy.has(p.id);
      const clicks = this._clicksFor(p.id);
      return `
        <li class="rel-admin__row" data-partner="${escapeAttr(p.id)}">
          <div class="rel-admin__rowhead">
            ${pill}
            <span class="rel-admin__date">${p.live ? `${clicks} tap${clicks === 1 ? "" : "s"} in 30 days` : ""}</span>
          </div>
          <div class="rel-admin__title">${escapeHtml(p.label)}</div>
          <div class="rel-admin__link">${cred}</div>
          <div class="rel-admin__actions">
            <button class="btn btn-ghost btn-xs" ${busy ? "disabled" : ""}
                    onclick="window.adminAffiliatesView._edit('${escapeAttr(p.id)}')">Edit</button>
            <button class="btn btn-xs ${p.enabled ? "btn-ghost" : "btn-primary"}" ${busy || (!p.enabled && !p.has_credential) ? "disabled" : ""}
                    title="${!p.enabled && !p.has_credential ? "Add a tracking tag or wrapper link first" : ""}"
                    onclick="window.adminAffiliatesView._toggle('${escapeAttr(p.id)}')">
              ${p.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        </li>
      `;
    }

    async _edit(id) {
      const p = this._partners.find((x) => x.id === id);
      if (!p) return;
      this._editing = p;
      this._preview = null;
      this.render();
      try {
        const pv = await window.Affiliate.adminPreview(id);
        if (this._editing && this._editing.id === id) {
          this._preview = pv;
          window.AffiliatePartnerEditor.paintPreview(pv);
        }
      } catch (_) {
        // The preview is a convenience; the form stands without it.
      }
    }

    _cancelEdit() {
      this._editing = null;
      this._preview = null;
      this.render();
    }

    async _saveEdit() {
      if (this._saving || !this._editing) return;
      const patch = window.AffiliatePartnerEditor.collect(this._editing);
      if (!patch) return;
      const id = this._editing.id;
      this._saving = true;
      try {
        const saved = await window.Affiliate.adminUpdate(id, patch);
        this._partners = this._partners.map((p) => (p.id === id ? saved : p));
        this._editing = saved;
        showToast("Saved", "success");
        // The preview is the SAVED row's link — refresh it in place so the
        // form, its focus and its caret stay where they are.
        try {
          this._preview = await window.Affiliate.adminPreview(id);
          window.AffiliatePartnerEditor.paintPreview(this._preview);
        } catch (_) { /* the save already landed */ }
      } catch (e) {
        showToast(e.message || "Couldn't save that", "error");
      } finally {
        this._saving = false;
      }
    }

    async _toggle(id) {
      const p = this._partners.find((x) => x.id === id);
      if (!p || this._busy.has(id)) return;
      const turningOn = !p.enabled;
      const ok = await window.PolaroidPopup.confirm(
        turningOn
          ? {
              title: `Turn ${p.label} on?`,
              body: "Every game page gets a Where to buy pill for it from the next open, with the affiliate disclosure beside it. You can switch it off here at any time.",
              confirmLabel: "Enable",
              cancelLabel: "Not yet",
            }
          : {
              title: `Turn ${p.label} off?`,
              body: "Its pill disappears from every game page on the next open. Your tag and links stay saved, so turning it back on is one tap.",
              confirmLabel: "Disable",
              cancelLabel: "Leave it on",
            },
      );
      if (!ok) return;
      this._busy.add(id);
      this.render();
      try {
        const saved = turningOn
          ? await window.Affiliate.adminEnable(id)
          : await window.Affiliate.adminDisable(id);
        this._partners = this._partners.map((x) => (x.id === id ? saved : x));
        showToast(turningOn ? `${p.label} is live` : `${p.label} is off`, "success");
      } catch (e) {
        showToast(e.message || "That didn't go through", "error");
      } finally {
        this._busy.delete(id);
        this.render();
      }
    }
  }

  window.AdminAffiliatesView = AdminAffiliatesView;
})();
