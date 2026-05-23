// views/settings-view.js — account settings & integrations.
//
// Same five sections as before (Account, Admin tools, Connections, Logout,
// BGG attribution) re-skinned into the warm-cream card aesthetic. Admin
// tools now surfaces a live "open chapter reports" badge count.

(function () {
  class SettingsView extends window.View {
    constructor() {
      super("settings");
      this._adminFormOpen = false;
      this._adminPromoting = false;
      this._adminError = null;

      // Live count of open chapter reports — fetched only for admins.
      this._adminReportsCount = null;

      this._bgg = null;
      this._bggLoading = false;
      this._bggError = null;
      this._bggLinkOpen = false;
      this._bggSyncing = false;
      this._bggSyncResult = null;
      this._bggSummary = null;
      this._bggPollHandle = null;
    }

    async onMount() {
      this.listen("user", () => this.render());
      this.render();
      await this._loadBggStatus();
      const me = window.store.get("user");
      if (me && me.is_admin) {
        // Don't block the first paint on this — render once on resolve.
        this._loadAdminReportsCount();
      }
      if (this._needsPoll()) this._startBggPoll();
    }

    async onUnmount() {
      this._stopBggPoll();
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

    async _loadAdminReportsCount() {
      try {
        const reports = await window.api.get("/admin/chapter-reports?status=open");
        this._adminReportsCount = Array.isArray(reports) ? reports.length : 0;
      } catch (_) {
        // Non-fatal — admin tools row just renders without the badge.
        this._adminReportsCount = null;
      }
      this.render();
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

      this.container.innerHTML = `
        ${this._renderHead()}
        <div class="set-card-label">Account</div>
        ${this._renderAccountCard(me)}
        ${me.is_admin ? `
          <div class="set-card-label">Admin tools</div>
          ${this._renderAdminCard()}
        ` : ""}
        <div class="set-card-label">Connections</div>
        ${this._renderBggCard()}
        ${this._renderLogout()}
        ${this._renderBggAttribution()}
        <div style="height: 1rem"></div>
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

    _renderHead() {
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" onclick="window.router.go('profile-self')" aria-label="Back to profile">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">Settings</h2>
          <span></span>
        </header>
      `;
    }

    // ── Account card ──────────────────────────────────────────────────────────
    _renderAccountCard(me) {
      const badge = window.BgbBadge.render({
        avatar: me.avatar,
        displayName: me.display_name,
        size: "md",
        isMe: true,
        extraClass: "set-card__acct-avatar",
      });
      return `
        <div class="set-card">
          <div class="set-card__acct">
            ${badge}
            <div class="set-card__acct-body">
              <div class="set-card__acct-name">${escape(me.display_name || "")}</div>
              ${me.username ? `
                <div class="set-card__acct-handle" title="Your username never changes. Buddies can find you with it.">
                  <i data-lucide="at-sign" class="w-3.5 h-3.5"></i>
                  ${escape(me.username)}
                </div>` : ""}
            </div>
            <button class="set-card__avatar-btn" type="button"
                    title="Edit your profile" aria-label="Edit your profile"
                    onclick="window.settingsView._openEditProfile()">
              <i data-lucide="palette" class="w-4 h-4"></i>
              Edit profile
            </button>
          </div>
          ${me.is_admin ? "" : this._renderBecomeAdminBlock()}
        </div>
      `;
    }

    async _openEditProfile() {
      const me = window.store.get("user");
      if (!me) return;
      const picked = await window.PolaroidPopup.avatarCustomizer({
        headerTitle: "Edit your profile",
        includeNameField: true,
        saveLabel: "Save",
        current: me.avatar || null,
        displayName: me.display_name,
      });
      if (!picked) return;
      try {
        const body = {
          avatar: { icon: picked.icon, iconColor: picked.iconColor, bgColor: picked.bgColor },
        };
        if (picked.displayName && picked.displayName !== me.display_name) {
          body.display_name = picked.displayName;
        }
        const updated = await window.api.post("/profile", body);
        // Carry the new fields onto the in-memory user so the rest of the
        // app re-renders against them. Store.set() fires listeners → render().
        const next = new window.User({ ...me, ...updated });
        window.store.set("user", next);
      } catch (e) {
        window.PolaroidPopup.alert({
          title: "Couldn't save profile",
          body: e && e.message ? String(e.message) : "Please try again.",
        });
      }
    }

    _renderBecomeAdminBlock() {
      if (!this._adminFormOpen) {
        return `
          <div class="set-card__acct-edit-form" style="padding-top: 0;">
            <button class="btn btn-ghost btn-xs" onclick="window.settingsView._openAdminForm()">
              <i data-lucide="key-round" class="w-3.5 h-3.5"></i> Have an admin key?
            </button>
          </div>
        `;
      }
      return `
        <form class="set-card__acct-edit-form" onsubmit="window.settingsView._becomeAdmin(event)">
          <input id="settings-admin-key" type="password"
                 class="input input-bordered input-sm w-full"
                 placeholder="Admin key" autocomplete="off" required />
          ${this._adminError ? `<div class="text-error text-xs basis-full">${escape(this._adminError)}</div>` : ""}
          <div class="flex gap-2 justify-end basis-full">
            <button type="button" class="btn btn-ghost btn-xs" onclick="window.settingsView._closeAdminForm()">Cancel</button>
            <button type="submit" class="btn btn-primary btn-xs" ${this._adminPromoting ? "disabled" : ""}>
              ${this._adminPromoting ? "…" : "Become admin"}
            </button>
          </div>
        </form>
      `;
    }

    // ── Admin tools card ──────────────────────────────────────────────────────
    _renderAdminCard() {
      const n = this._adminReportsCount;
      const badge = (n && n > 0) ? `<span class="set-card__badge">${n}</span>` : "";
      return `
        <div class="set-card">
          <button class="set-card__row" onclick="window.router.go('admin')">
            <span class="set-card__row-icon"><i data-lucide="flag" class="w-4 h-4"></i></span>
            <span class="set-card__row-body">
              <span class="set-card__row-title">Chapter reports</span>
              <span class="set-card__row-sub">Moderate community-reported reference-guide chapters.</span>
            </span>
            ${badge}
            <span class="set-card__row-chev"><i data-lucide="chevron-right" class="w-4 h-4"></i></span>
          </button>
        </div>
      `;
    }

    // ── BGG card ──────────────────────────────────────────────────────────────
    _renderBggCard() {
      const state = (this._bgg && this._bgg.auth_state) || "unlinked";
      const username = (this._bgg && this._bgg.bgg_username) || null;
      const pending = (this._bgg && this._bgg.pending_count) || 0;
      const errored = (this._bgg && this._bgg.errored_count) || 0;
      const lastDone = (this._bgg && this._bgg.last_completed_at) || null;

      const syncBtn = (state === "linked" && username) ? `
        <button class="btn btn-ghost btn-sm" title="Sync from BoardGameGeek"
                ${this._bggSyncing ? "disabled" : ""}
                onclick="window.settingsView._syncBgg()">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5 ${this._bggSyncing ? "animate-spin" : ""}"></i>
          ${this._bggSyncing ? "Syncing…" : "Sync"}
        </button>` : "";

      let body;
      if (this._bggLoading && !this._bgg) {
        body = `<div class="set-card__bgg-body">${window.buddyLoader({ size: 56, padded: false })}</div>`;
      } else if (state === "unlinked") {
        body = `
          <div class="set-card__bgg-body" style="flex-direction: column; align-items: stretch;">
            <p class="text-sm opacity-80">
              Link your BoardGameGeek account to import your owned collection,
              wishlist, and play history. We use your BGG password once to mint
              a session cookie, then store it encrypted so future syncs run
              silently in the background.
            </p>
            <button class="btn btn-primary btn-sm" onclick="window.settingsView._openBggLink()">
              <i data-lucide="link" class="w-4 h-4"></i> Link BoardGameGeek
            </button>
            ${this._bggLinkOpen ? this._renderBggLinkForm() : ""}
          </div>
        `;
      } else if (state === "relink_required") {
        body = `
          <div class="set-card__bgg-body" style="flex-direction: column; align-items: stretch;">
            <div class="flex items-start justify-between gap-2">
              <div>
                <div class="set-card__bgg-handle">@${escape(username || "")}</div>
                <div class="set-card__bgg-status set-card__bgg-status--warn">
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
          <div class="set-card__bgg-body">
            <div class="set-card__bgg-info">
              <div class="set-card__bgg-handle">@${escape(username || "")}</div>
              <div class="set-card__bgg-status">
                <span class="set-card__bgg-status-dot"></span>
                ${lastDone ? `Last synced ${formatRelative(lastDone)}` : "Not yet synced"}
                ${pending > 0 ? ` · ${pending} pending` : ""}
                ${errored > 0 ? ` · ${errored} errored` : ""}
              </div>
            </div>
            <button class="btn btn-ghost btn-xs" onclick="window.settingsView._unlinkBgg()">Unlink</button>
          </div>
          ${this._renderBggProgress()}
        `;
      }

      return `
        <div class="set-card">
          <div class="set-card__bgg-top">
            <span class="set-card__bgg-mark">BoardGameGeek</span>
            ${syncBtn}
          </div>
          ${body}
        </div>
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

    _renderLogout() {
      return `
        <div class="settings-logout">
          <button class="btn btn-sm settings-logout__btn" onclick="window.handleLogout()">
            <i data-lucide="log-out" class="w-4 h-4"></i> Log out
          </button>
        </div>
      `;
    }

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

    // ── Become admin ──────────────────────────────────────────────────────────
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
        window.store.set("user", new window.User(updated));
        this._adminFormOpen = false;
        // Newly promoted — surface the badge count.
        this._loadAdminReportsCount();
      } catch (e) {
        this._adminError = e.message || "Invalid admin key";
      } finally {
        this._adminPromoting = false;
        this.render();
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
      this._bggSyncing = true;
      this._bggSyncResult = null;
      this._bggSummary = null;
      this._stopBggPoll();
      this.render();
      let summary;
      try {
        summary = await window.Bgg.sync();
      } catch (e) {
        this._bggSyncing = false;
        this._bggSyncResult = e.message || "Sync failed";
        await this._loadBggStatus();
        return;
      }
      this._bggSummary = summary;
      if (summary && summary.warm_up_retry_pending) {
        this._bggSyncing = false;
        this._bggSyncResult = "BoardGameGeek is still preparing your collection — try again in a minute.";
        await this._loadBggStatus();
        return;
      }
      await this._loadBggStatus();
      const needsImport = summary && summary.unique_games_to_import > 0;
      if (needsImport && this._needsPoll()) {
        this._startBggPoll();
        return;
      }
      this._bggSyncing = false;
      this._bggSyncResult = this._buildFinalSummaryMessage();
      window.Collection.invalidateMyStatusMap();
      window.store.invalidate("feed");
      this.render();
    }

    _needsPoll() {
      const b = this._bgg;
      if (!b || !b.session_total) return false;
      return (b.session_done + b.session_errored) < b.session_total;
    }

    _startBggPoll() {
      if (this._bggPollHandle) return;
      this._bggPollHandle = setInterval(() => this._pollBggStatus(), 2000);
    }

    _stopBggPoll() {
      if (this._bggPollHandle) {
        clearInterval(this._bggPollHandle);
        this._bggPollHandle = null;
      }
    }

    async _pollBggStatus() {
      try {
        this._bgg = await window.Bgg.status();
      } catch (_) {
        return;
      }
      if (!this._needsPoll()) {
        this._stopBggPoll();
        this._bggSyncing = false;
        this._bggSyncResult = this._buildFinalSummaryMessage();
        window.Collection.invalidateMyStatusMap();
        window.store.invalidate("feed");
      }
      this.render();
    }

    _renderBggProgress() {
      const syncing = this._bggSyncing;
      const summary = this._bggSummary;
      const b = this._bgg || {};
      const total = b.session_total || 0;
      const done = b.session_done || 0;
      const errored = b.session_errored || 0;
      const settled = done + errored;
      const pct = total > 0 ? Math.min(100, Math.round((settled / total) * 100)) : 0;

      if (syncing) {
        const direct = summary
          ? `<div class="bgg-progress__direct">
               Added <strong>${summary.collection_imported || 0}</strong> games to your collection
               · <strong>${summary.plays_imported || 0}</strong> plays
             </div>` : "";
        if (total > 0) {
          return `
            <div class="bgg-progress" style="margin: 0 0.9rem 0.9rem;">
              ${direct}
              <div class="bgg-progress__label">
                Importing <strong>${done}</strong> of <strong>${total}</strong> new game${total === 1 ? "" : "s"} from BoardGameGeek…
                ${errored > 0 ? ` · <span class="text-warning">${errored} errored</span>` : ""}
              </div>
              <div class="bgg-progress__bar"><div class="bgg-progress__bar-fill" style="width:${pct}%"></div></div>
            </div>
          `;
        }
        return `
          <div class="bgg-progress" style="margin: 0 0.9rem 0.9rem;">
            ${direct}
            <div class="bgg-progress__label">Fetching from BoardGameGeek…</div>
            <div class="bgg-progress__bar bgg-progress__bar--indeterminate"><div class="bgg-progress__bar-fill"></div></div>
          </div>
        `;
      }
      if (this._bggSyncResult) {
        return `<div class="bgg-progress bgg-progress--done" style="margin: 0 0.9rem 0.9rem;">${escape(this._bggSyncResult)}</div>`;
      }
      return "";
    }

    _buildFinalSummaryMessage() {
      const s = this._bggSummary;
      const b = this._bgg || {};
      if (!s) return "Sync complete.";
      const total = b.session_total || 0;
      const done = b.session_done || 0;
      const errored = b.session_errored || 0;
      const parts = [];
      if (s.collection_imported) parts.push(`${s.collection_imported} collection`);
      if (s.plays_imported)      parts.push(`${s.plays_imported} plays`);
      if (total > 0) {
        parts.push(`${done} of ${total} new game${total === 1 ? "" : "s"} imported`);
      }
      let msg = parts.length ? `Synced ${parts.join(", ")}.` : "Sync complete.";
      if (errored > 0) msg += ` ${errored} import${errored === 1 ? "" : "s"} failed.`;
      return msg;
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
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
