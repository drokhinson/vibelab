// views/settings-view.js — account settings & integrations.
//
// Houses everything that used to live on the Profile chrome (display-name
// editor, admin shortcut, BoardGameGeek link/sync, logout). The Profile page
// now reads cleanly as "your data" (collection / plays / buddies); this page
// reads as "your account".

(function () {
  class SettingsView extends window.View {
    constructor() {
      super("settings");
      this._editingName = false;
      this._savingName = false;
      this._nameError = null;

      // Become-admin state: a one-shot key-exchange that flips
      // boardgamebuddy_profiles.is_admin. Form is only shown when the
      // signed-in user isn't already an admin.
      this._adminFormOpen = false;
      this._adminPromoting = false;
      this._adminError = null;

      this._bgg = null;
      this._bggLoading = false;
      this._bggError = null;
      this._bggLinkOpen = false;
      this._bggSyncing = false;
      this._bggSyncResult = null;
    }

    async onMount() {
      this.listen("user", () => this.render());
      this.render();
      await this._loadBggStatus();
    }

    async _loadBggStatus() {
      this._bggLoading = true;
      try {
        this._bgg = await window.Bgg.status();
      } catch (e) {
        this._bggError = e.message || "Failed to load BGG status";
      } finally {
        this._bggLoading = false;
        this.render();
      }
    }

    render() {
      const me = window.store.get("user");
      if (!me) {
        this.container.innerHTML = `<div class="p-6 text-center">Not signed in.</div>`;
        return;
      }
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;

      // Page chrome stays minimal — no header / back button. The global
      // app header above + the bottom nav are the user's escape hatches.
      this.container.innerHTML = `
        ${this._renderAccountSection(me)}
        ${me.is_admin ? this._renderAdminSection() : ""}
        ${this._renderBggSection()}
        ${this._renderLogoutSection()}
        ${this._renderBggAttribution()}
      `;
      if (window.lucide) window.lucide.createIcons();

      if (activeId) {
        const el = document.getElementById(activeId);
        if (el && el.focus) {
          el.focus();
          if (caret != null && el.setSelectionRange) {
            try { el.setSelectionRange(caret, caret); } catch (_) {}
          }
        }
      }
    }

    _renderAccountSection(me) {
      const nameBlock = this._editingName ? `
        <form class="profile-id__edit" onsubmit="window.settingsView._saveName(event)">
          <input id="settings-name-input"
                 class="input input-bordered input-sm"
                 value="${escapeAttr(me.display_name)}"
                 maxlength="40" autocomplete="off" />
          <button class="btn btn-primary btn-xs" ${this._savingName ? "disabled" : ""}>
            ${this._savingName ? "…" : "Save"}
          </button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="window.settingsView._cancelEditName()">Cancel</button>
        </form>
        ${this._nameError ? `<div class="text-error text-xs">${escape(this._nameError)}</div>` : ""}
      ` : `
        <div class="profile-id__name-row" onclick="window.settingsView._startEditName()">
          <h3 class="profile-id__name font-display">${escape(me.display_name)}</h3>
          <button class="btn btn-ghost btn-xs" title="Edit display name">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      `;
      return `
        <section class="settings-section">
          <h3 class="settings-section__title">Account Details</h3>
          <div class="profile-id">
            <div class="profile-id__avatar avatar-bubble avatar-bubble--md">${new window.User(me).initials()}</div>
            <div class="profile-id__text">
              ${nameBlock}
              ${me.username ? `
                <span class="profile-id__handle" title="Your username never changes. Buddies can find you with it.">
                  <i data-lucide="at-sign" class="w-3.5 h-3.5"></i>
                  <span class="profile-id__handle-value">${escape(me.username)}</span>
                </span>
              ` : ""}
            </div>
          </div>
          ${me.is_admin ? "" : this._renderBecomeAdminBlock()}
        </section>
      `;
    }

    // Non-admins keep the inline "Have an admin key?" promotion form here.
    // Once they're an admin, the standalone Admin tools section appears
    // instead — this block disappears completely.
    _renderBecomeAdminBlock() {
      if (!this._adminFormOpen) {
        return `
          <div class="settings-account-admin">
            <button class="btn btn-ghost btn-xs" onclick="window.settingsView._openAdminForm()">
              <i data-lucide="key-round" class="w-3.5 h-3.5"></i> Have an admin key?
            </button>
          </div>
        `;
      }
      return `
        <form class="settings-account-admin settings-admin-form"
              onsubmit="window.settingsView._becomeAdmin(event)">
          <input id="settings-admin-key" type="password"
                 class="input input-bordered input-sm w-full"
                 placeholder="Admin key" autocomplete="off" required />
          ${this._adminError ? `<div class="text-error text-xs">${escape(this._adminError)}</div>` : ""}
          <div class="flex gap-2 justify-end">
            <button type="button" class="btn btn-ghost btn-xs" onclick="window.settingsView._closeAdminForm()">Cancel</button>
            <button type="submit" class="btn btn-primary btn-xs" ${this._adminPromoting ? "disabled" : ""}>
              ${this._adminPromoting ? "…" : "Become admin"}
            </button>
          </div>
        </form>
      `;
    }

    // Admin-only section. Surfaces a single link to the Admin view, which
    // hosts the chapter-reports moderation panel.
    _renderAdminSection() {
      return `
        <section class="settings-section">
          <h3 class="settings-section__title">Admin tools</h3>
          <div class="admin-tool-list">
            <button class="admin-tool" onclick="window.router.go('admin')">
              <span class="admin-tool__icon"><i data-lucide="flag" class="w-4 h-4"></i></span>
              <span class="admin-tool__body">
                <span class="admin-tool__title">Chapter reports</span>
                <span class="admin-tool__blurb">Moderate community-reported reference-guide chapters.</span>
              </span>
              <i data-lucide="chevron-right" class="w-4 h-4 admin-tool__chev"></i>
            </button>
          </div>
        </section>
      `;
    }

    _openAdminForm()  { this._adminFormOpen = true; this._adminError = null; this.render();
      const el = document.getElementById("settings-admin-key"); if (el) el.focus(); }
    _closeAdminForm() { this._adminFormOpen = false; this._adminError = null; this.render(); }

    async _becomeAdmin(event) {
      event.preventDefault();
      const key = (document.getElementById("settings-admin-key") || {}).value || "";
      if (!key) { this._adminError = "Admin key required."; this.render(); return; }
      this._adminPromoting = true; this._adminError = null; this.render();
      try {
        const updated = await window.api.post("/profile/become-admin", { admin_key: key });
        // updated is a ProfileResponse — refresh the store so the Account
        // Details block flips to the "Admin tools" link without a reload.
        window.store.set("user", new window.User(updated));
        this._adminFormOpen = false;
      } catch (e) {
        this._adminError = e.message || "Invalid admin key";
      } finally {
        this._adminPromoting = false;
        this.render();
      }
    }

    _renderBggSection() {
      const state = (this._bgg && this._bgg.auth_state) || "unlinked";
      const username = (this._bgg && this._bgg.bgg_username) || null;
      const pending = (this._bgg && this._bgg.pending_count) || 0;
      const errored = (this._bgg && this._bgg.errored_count) || 0;
      const lastDone = (this._bgg && this._bgg.last_completed_at) || null;

      const headerSync = (state === "linked" && username) ? `
        <button class="btn btn-ghost btn-xs" title="Sync from BoardGameGeek"
                ${this._bggSyncing ? "disabled" : ""}
                onclick="window.settingsView._syncBgg()">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5 ${this._bggSyncing ? "animate-spin" : ""}"></i>
          ${this._bggSyncing ? "Syncing…" : "Sync"}
        </button>` : "";

      let body;
      if (this._bggLoading && !this._bgg) {
        body = window.buddyLoader({ size: 64 });
      } else if (state === "unlinked") {
        body = `
          <div class="bgg-card">
            <p class="text-sm opacity-80">
              Link your BoardGameGeek account to import your owned collection,
              wishlist, and play history. We use your BGG password once to
              mint a session cookie, then store it encrypted so future syncs
              run silently in the background.
            </p>
            <button class="btn btn-primary btn-sm mt-2" onclick="window.settingsView._openBggLink()">
              <i data-lucide="link" class="w-4 h-4"></i> Link BoardGameGeek
            </button>
            ${this._bggLinkOpen ? this._renderBggLinkForm() : ""}
          </div>
        `;
      } else if (state === "relink_required") {
        body = `
          <div class="bgg-card">
            <div class="bgg-card__row">
              <div>
                <div class="bgg-card__handle">@${escape(username || "")}</div>
                <div class="text-xs text-warning mt-1">
                  Re-link required — your stored credentials no longer work.
                </div>
              </div>
              <button class="btn btn-ghost btn-xs" onclick="window.settingsView._unlinkBgg()">Unlink</button>
            </div>
            <button class="btn btn-primary btn-sm mt-2" onclick="window.settingsView._openBggLink()">
              Re-link account
            </button>
            ${this._bggLinkOpen ? this._renderBggLinkForm() : ""}
          </div>
        `;
      } else {
        body = `
          <div class="bgg-card">
            <div class="bgg-card__row">
              <div>
                <div class="bgg-card__handle">@${escape(username || "")}</div>
                <div class="text-xs opacity-60 mt-1">
                  ${lastDone ? `Last synced ${formatRelative(lastDone)}` : "Not yet synced"}
                  ${pending > 0 ? ` · ${pending} pending` : ""}
                  ${errored > 0 ? ` · ${errored} errored` : ""}
                </div>
              </div>
              <button class="btn btn-ghost btn-xs" onclick="window.settingsView._unlinkBgg()">Unlink</button>
            </div>
            ${this._bggSyncResult ? `<div class="text-xs opacity-70 mt-2">${escape(this._bggSyncResult)}</div>` : ""}
          </div>
        `;
      }

      return `
        <section class="settings-section">
          <header class="settings-section__header">
            <h3 class="settings-section__title">BoardGameGeek</h3>
            ${headerSync}
          </header>
          ${body}
        </section>
      `;
    }

    _renderBggLinkForm() {
      return `
        <form class="bgg-link-form mt-3" onsubmit="window.settingsView._submitBggLink(event)">
          <input id="settings-bgg-username" class="input input-bordered input-sm w-full" placeholder="BGG username" autocomplete="username" required />
          <input id="settings-bgg-password" type="password" class="input input-bordered input-sm w-full" placeholder="BGG password" autocomplete="current-password" required />
          ${this._bggError ? `<div class="text-error text-xs">${escape(this._bggError)}</div>` : ""}
          <div class="flex gap-2 justify-end">
            <button type="button" class="btn btn-ghost btn-xs" onclick="window.settingsView._closeBggLink()">Cancel</button>
            <button type="submit" class="btn btn-primary btn-xs">Link</button>
          </div>
        </form>
      `;
    }

    // Log out gets its own footer row — centered, no section title — so it
    // reads as the "exit door" rather than a Settings setting.
    _renderLogoutSection() {
      return `
        <div class="settings-logout">
          <button class="btn btn-sm settings-logout__btn" onclick="window.handleLogout()">
            <i data-lucide="log-out" class="w-4 h-4"></i> Log out
          </button>
        </div>
      `;
    }

    // BGG attribution footer below the logout — required by BGG's API ToU
    // and a useful "what powers this app" cue for users wondering where
    // the box art comes from.
    _renderBggAttribution() {
      return `
        <div class="settings-bgg-credit">
          <img src="assets/credits/bgg-logo.svg" alt="BoardGameGeek" class="settings-bgg-credit__logo" />
          <p class="settings-bgg-credit__text">
            Game data, box art, and metadata are sourced from BoardGameGeek via the BGG XML API.
          </p>
        </div>
      `;
    }

    // ── Display-name edit ─────────────────────────────────────────────────────

    _startEditName() {
      this._editingName = true; this._nameError = null;
      this.render();
      const el = document.getElementById("settings-name-input");
      if (el) { el.focus(); el.select(); }
    }
    _cancelEditName() { this._editingName = false; this._nameError = null; this.render(); }
    async _saveName(event) {
      event.preventDefault();
      const el = document.getElementById("settings-name-input");
      const newName = (el && el.value || "").trim();
      if (!newName) { this._nameError = "Display name can't be empty."; this.render(); return; }
      this._savingName = true; this._nameError = null; this.render();
      try {
        const updated = await window.api.post("/profile", { display_name: newName });
        window.store.set("user", new window.User(updated));
        this._editingName = false;
      } catch (e) {
        this._nameError = e.message || "Failed to save";
      } finally {
        this._savingName = false; this.render();
      }
    }

    // ── BGG actions ───────────────────────────────────────────────────────────

    _openBggLink()  { this._bggLinkOpen = true; this._bggError = null; this.render();
      const el = document.getElementById("settings-bgg-username"); if (el) el.focus(); }
    _closeBggLink() { this._bggLinkOpen = false; this._bggError = null; this.render(); }

    async _submitBggLink(event) {
      event.preventDefault();
      const username = (document.getElementById("settings-bgg-username") || {}).value || "";
      const password = (document.getElementById("settings-bgg-password") || {}).value || "";
      if (!username || !password) {
        this._bggError = "Username and password required."; this.render(); return;
      }
      try {
        await window.Bgg.link(username.trim(), password);
        this._bggLinkOpen = false; this._bggError = null;
        await this._loadBggStatus();
      } catch (e) {
        this._bggError = e.message || "Link failed"; this.render();
      }
    }

    async _unlinkBgg() {
      if (!confirm("Unlink your BoardGameGeek account? Already-imported games stay in your collection.")) return;
      try { await window.Bgg.unlink(); } catch (_) {}
      this._bggSyncResult = null;
      await this._loadBggStatus();
    }

    async _syncBgg() {
      this._bggSyncing = true; this._bggSyncResult = null; this.render();
      try {
        const r = await window.Bgg.sync();
        const parts = [];
        if (r.collection_imported != null) parts.push(`${r.collection_imported} collection`);
        if (r.plays_imported != null) parts.push(`${r.plays_imported} plays`);
        if (r.collection_pending) parts.push(`${r.collection_pending} pending`);
        this._bggSyncResult = parts.length ? `Imported ${parts.join(", ")}.` : "Sync complete.";
      } catch (e) {
        this._bggSyncResult = e.message || "Sync failed";
      } finally {
        this._bggSyncing = false;
        // Bust the Profile view's caches: if the user navigates to Profile
        // next, it'll re-fetch fresh stats / collection / plays.
        window.store.invalidate("feed");
        await this._loadBggStatus();
      }
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function formatRelative(iso) {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const diff = Math.max(0, Date.now() - then);
    const min = Math.round(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  window.SettingsView = SettingsView;
})();
