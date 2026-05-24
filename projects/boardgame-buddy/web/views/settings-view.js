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
        <div class="set-card-label">Local cache</div>
        ${this._renderCacheCard()}
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

    // ── Local cache card ──────────────────────────────────────────────────────
    // Maps each cache namespace to a human-readable bucket. Anything not
    // listed here falls into "Other" so the total still adds up.
    static _CACHE_BUCKETS = {
      "game.bundle": "games",
      "collection": "games",
      "feed":       "plays",
      "buddy":      "buddies",
    };

    _renderCacheCard() {
      const stats = (window.bgbCache && window.bgbCache.stats) ? window.bgbCache.stats() : null;
      const busy = !!this._cacheRefreshing;

      let totalBytes = 0;
      const buckets = { games: { entries: 0, bytes: 0 }, plays: { entries: 0, bytes: 0 }, buddies: { entries: 0, bytes: 0 }, other: { entries: 0, bytes: 0 } };
      if (stats) {
        for (const ns of Object.keys(stats)) {
          if (ns.startsWith("_")) continue;
          const e = (stats[ns] && stats[ns].entries) || 0;
          const b = (stats[ns] && stats[ns].bytes) || 0;
          totalBytes += b;
          const bucket = SettingsView._CACHE_BUCKETS[ns] || "other";
          buckets[bucket].entries += e;
          buckets[bucket].bytes += b;
        }
      }
      const empty = totalBytes === 0;

      const fmt = (bytes) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };

      const row = (label, b) => `
        <div class="set-card__cache-row">
          <span class="set-card__cache-row-label">${label}</span>
          <span class="set-card__cache-row-meta">${b.entries} ${b.entries === 1 ? "entry" : "entries"} · ${fmt(b.bytes)}</span>
        </div>
      `;

      const breakdown = empty ? `<div class="text-xs opacity-60">Nothing cached yet.</div>` : `
        <div class="set-card__cache-total">
          <span>Total</span><span>${fmt(totalBytes)}</span>
        </div>
        <div class="set-card__cache-breakdown">
          ${row("Games", buckets.games)}
          ${row("Plays", buckets.plays)}
          ${row("Buddies", buckets.buddies)}
          ${buckets.other.bytes > 0 ? row("Other", buckets.other) : ""}
        </div>
      `;

      return `
        <div class="set-card">
          <div class="set-card__bgg-body" style="flex-direction: column; align-items: stretch;">
            <p class="text-sm opacity-80">
              Your collection, buddies, and recent feed are kept locally so the
              app loads instantly. Refresh if something looks out of date.
            </p>
            ${breakdown}
            <button class="btn btn-primary btn-sm" ${busy ? "disabled" : ""}
                    onclick="window.settingsView._refreshLocalCache()">
              <i data-lucide="refresh-cw" class="w-4 h-4 ${busy ? "animate-spin" : ""}"></i>
              ${busy ? "Refreshing…" : "Refresh local cache"}
            </button>
          </div>
        </div>
      `;
    }

    async _refreshLocalCache() {
      if (this._cacheRefreshing) return;
      const ok = await window.PolaroidPopup.confirm({
        title: "Refresh local cache?",
        body: "We'll re-download your collection, buddies, and feed. Anything you've typed but not submitted is unaffected.",
        confirmLabel: "Refresh",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      const me = window.store.get("user");
      const uid = me && me.id;
      if (!uid) return;
      this._cacheRefreshing = true;
      this.render();
      try {
        // Drop everything for this user (in-memory + localStorage), then
        // re-bind and re-run bootstrap so every namespace re-seeds in one
        // round trip.
        window.bgbCache.unbindUser();
        window.bgbCache.bindUser(uid);
        if (window.Bootstrap) await window.Bootstrap.load();
        // Re-notify subscribed views so anything currently mounted re-renders
        // against the freshly-seeded data.
        window.store.invalidate("user");
        window.store.invalidate("feed");
        window.store.invalidate("myCollectionMap");
        if (typeof showToast === "function") showToast("Cache refreshed", "success");
      } catch (e) {
        if (typeof showToast === "function") showToast(e.message || "Couldn't refresh — check your connection.", "error");
      } finally {
        this._cacheRefreshing = false;
        this.render();
      }
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
      // The step log derives the final summary from _bggSummary + _bgg
      // directly; no separate result string needed for the happy path.
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
        // Step log derives the final summary from _bggSummary + _bgg.
        window.Collection.invalidateMyStatusMap();
        window.store.invalidate("feed");
      }
      this.render();
    }

    _renderBggProgress() {
      const syncing = this._bggSyncing;
      const summary = this._bggSummary;
      const b = this._bgg || {};
      const result = this._bggSyncResult;

      // Surface warm-up / unrecoverable errors as a standalone notice —
      // they short-circuit the normal step log.
      if (!syncing && result && !summary) {
        return `<div class="bgg-log" style="margin: 0 0.9rem 0.9rem;">${escape(result)}</div>`;
      }
      if (!syncing && !summary) return "";

      const total = b.session_total || 0;
      const done = b.session_done || 0;
      const errored = b.session_errored || 0;
      // True once polling shows every queued game has resolved (or there
      // was nothing to queue in the first place).
      const importsResolved = !summary
        ? false
        : (summary.unique_games_to_import || 0) === 0
          || (total > 0 && (done + errored) >= total);
      const finished = !syncing && importsResolved;

      const collectionImmediate = summary ? (summary.collection_imported || 0) : 0;
      const playsImmediate = summary ? (summary.plays_imported || 0) : 0;
      const missingCount = summary ? (summary.unique_games_to_import || 0) : 0;
      const newGames = summary
        ? collectionImmediate + (summary.collection_pending || 0)
        : 0;
      const newPlays = summary
        ? playsImmediate + (summary.plays_pending || 0)
        : 0;

      const step = (state, body) => {
        const icon = state === "done"
          ? `<i data-lucide="check" class="bgg-log__icon"></i>`
          : state === "active"
            ? `<i data-lucide="loader-2" class="bgg-log__icon bgg-log__icon--spin"></i>`
            : `<span class="bgg-log__icon bgg-log__icon--idle"></span>`;
        return `<li class="bgg-log__step bgg-log__step--${state}">${icon}<span class="bgg-log__body">${body}</span></li>`;
      };

      // Step 1 — request is in flight or already returned a summary.
      const step1 = step(summary || finished ? "done" : "active",
        "Importing data from BoardGameGeek");

      // Step 2 — immediate writes (games already in our catalog).
      const step2 = summary
        ? step("done",
            `<strong>${collectionImmediate}</strong> game${collectionImmediate === 1 ? "" : "s"} and ` +
            `<strong>${playsImmediate}</strong> play${playsImmediate === 1 ? "" : "s"} imported`)
        : "";

      // Step 3 — missing games that the worker has to fetch from BGG.
      // Bullet list streams in via session_game_names as each title lands.
      let step3 = "";
      if (summary && missingCount > 0) {
        const names = (b.session_game_names || []).slice(0, 20);
        const remaining = Math.max(0, missingCount - names.length - errored);
        const bullets = names.map((n) => `<li>${escape(n)}</li>`).join("");
        const pendingTail = remaining > 0 && !finished
          ? `<li class="bgg-log__sublist-pending">…${remaining} more queued</li>`
          : "";
        const erroredTail = errored > 0
          ? `<li class="bgg-log__sublist-error">${errored} couldn't be imported</li>`
          : "";
        const sublist = (bullets || pendingTail || erroredTail)
          ? `<ul class="bgg-log__sublist">${bullets}${pendingTail}${erroredTail}</ul>`
          : "";
        step3 = step(
          importsResolved ? "done" : "active",
          `<strong>${missingCount}</strong> missing in Boardgame Buddy${sublist}`
        );
      }

      // Steps 4 + 5 only appear once the worker has drained the queue.
      // They restate the final totals so the user can scan the whole sync
      // outcome at a glance.
      const step4 = finished
        ? step("done", `<strong>${newGames}</strong> new game${newGames === 1 ? "" : "s"} added to collection`)
        : "";
      const step5 = finished
        ? step("done", `<strong>${newPlays}</strong> new play${newPlays === 1 ? "" : "s"} logged`)
        : "";

      const footer = finished
        ? `<div class="bgg-log__footer">Sync complete</div>`
        : "";

      return `
        <div class="bgg-log" style="margin: 0 0.9rem 0.9rem;">
          <ol class="bgg-log__steps">
            ${step1}
            ${step2}
            ${step3}
            ${step4}
            ${step5}
          </ol>
          ${footer}
        </div>
      `;
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
