// views/settings-view.js — account settings & integrations.
//
// Admin tools, Appearance, Connections, Pending uploads, Data management,
// Logout and BGG attribution, in the warm-cream card aesthetic. Admin tools
// surfaces a live "open chapter reports" badge count.
//
// The identity/"Edit profile" account card moved to the Profile hub
// (views/profile-self-view.js). What is left under "Account" here is the
// admin-key escalation block, shown only to non-admins.

(function () {
  class SettingsView extends window.View {
    constructor() {
      super("settings");
      this._adminFormOpen = false;
      this._adminPromoting = false;
      this._adminError = null;

      // Admin queue counts live in the store (domain/admin-review.js), not on
      // this view: the gear's dot needs them too, and it is painted by
      // init.js while Settings is not even mounted.

      this._bgg = null;
      this._bggLoading = false;
      this._bggError = null;
      this._bggLinkOpen = false;

      // True between the confirm and the sign-out that follows a successful
      // delete. Unlike everything else in this app, this one write IS waited
      // on and says so: a user who has just asked for something permanent
      // must not be left unsure whether it happened.
      this._deleting = false;

      // The comparison, both syncs and everything they narrate live in
      // domain/bgg-sync-flow.js now — they outlive this screen, which is what
      // lets a sync keep running once the user closes the flow. This card
      // reads the flow's snapshot and shows one row (see _renderBggSyncStrip).

      // True while a manual outbox flush is in flight — drives the Upload now
      // button's disabled/"Uploading…" state.

      // Past imports (migration 007). null = not loaded yet, so the section is
      // absent rather than flashing an empty card on the first paint.
      this._imports = null;
      this._deletingImport = null;
    }

    async onMount() {
      this.listen("user", () => this.render());
      // A background flush (boot, `online`, tab focus) can drain the queue
      // while this screen is open; connectivity returning also swaps the
      // section's copy and reveals the Upload now button.
      this.listen("outboxCount", () => this.render());
      this.listen("offline", () => this.render());
      // Auto mode can flip while this screen is open (the OS appearance changed
      // in Settings, or the sunset switch landed) — the Appearance card's
      // "currently light/dark" subtext has to follow. See domain/theme.js.
      this.listen("theme", () => this.render());
      // The BGG flow's progress strip. The flow owns its own polling and
      // outlives this view, so all this screen does is repaint on its ticks.
      this.listen("bggSync", () => this.render());
      // Its poll skips ticks while the tab is hidden; fire one catch-up when
      // it comes back. Auto-removed on unmount via listenDom.
      this.listenDom("visibilitychange", () => {
        if (!document.hidden && window.BggSyncFlow) window.BggSyncFlow.catchUp();
      });
      this.render();
      await this._loadBggStatus();
      // Not awaited before the first paint — the section appears when it lands,
      // and Settings is fully usable without it.
      this._loadImports();
      // Repaint whenever a notification count moves, so resolving a report on
      // the reports spoke leaves this card's badge already correct on the way
      // back. Listens to every slot rather than naming the admin three by hand
      // and forgetting the fourth — same as profile-self-view.
      for (const slot of window.BgbNotifications.slots()) {
        this.listen(slot, () => this.render());
      }
      // Not awaited: no-ops for non-admins, and the badges appear when it
      // lands. AdminReview publishes into the store, which the listen above
      // turns into a repaint.
      window.AdminReview.load();
      // Re-arm whatever was still running when the user last left. Idempotent
      // and cheap when there is nothing to resume.
      if (window.BggSyncFlow) window.BggSyncFlow.resume();
    }

    async _loadBggStatus() {
      this._bggLoading = true;
      try {
        // One call: the card needs the linked handle and the last-synced line,
        // and the push readout moved to the flow, which fetches its own.
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

      this.container.innerHTML = `
        ${this._renderHead()}
        ${me.is_admin ? `
          <div class="set-card-label">Admin tools</div>
          ${this._renderAdminCard()}
        ` : `
          <div class="set-card-label">Account</div>
          <div class="set-card">${this._renderBecomeAdminBlock()}</div>
        `}
        <div class="set-card-label">Appearance</div>
        ${this._renderAppearanceCard()}
        <div class="set-card-label">Connections</div>
        ${this._renderBggCard()}
        <div class="set-card-label">Import</div>
        ${this._renderImportCard()}
        ${this._renderPastImportsSection()}
        ${this._renderPendingUploadsSection()}
        <div class="set-card-label">Data management</div>
        ${this._renderExportCard()}
        ${this._renderCacheCard()}
        ${this._renderAccountActions()}
        ${this._renderBggAttribution()}
        <div style="height: 1rem"></div>
      `;
      this.refreshIcons();

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

    // Settings is reachable from the gear in the global header, i.e. from any
    // screen — so it dismisses rather than navigating. A close button calling
    // router.back() returns the user to wherever they opened it from; the old
    // back arrow hardcoded profile-self and stranded anyone who arrived from
    // the feed, a game page or a session. profile-self is only the fallback
    // for a cold /settings deep link, where there is no previous screen and
    // the bottom nav already highlights the Profile tab.
    _renderHead() {
      return `
        <header class="spoke-head">
          <h2 class="spoke-head__title font-display">Settings</h2>
          <button class="spoke-head__close" onclick="window.router.back('profile-self')" aria-label="Close settings">
            <i data-icon="x" class="w-4 h-4"></i>
          </button>
        </header>
      `;
    }

    _renderBecomeAdminBlock() {
      if (!this._adminFormOpen) {
        return `
          <div class="set-card__acct-edit-form">
            <button class="btn btn-ghost btn-xs" onclick="window.settingsView._openAdminForm()">
              <i data-icon="key-round" class="w-3.5 h-3.5"></i> Have an admin key?
            </button>
          </div>
        `;
      }
      return `
        <form class="set-card__acct-edit-form" onsubmit="window.settingsView._becomeAdmin(event)">
          <input id="settings-admin-key" type="password"
                 class="input input-bordered input-sm w-full"
                 placeholder="Admin key" autocomplete="off" required />
          ${this._adminError ? `<div class="text-error text-xs basis-full">${escapeHtml(this._adminError)}</div>` : ""}
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
    // ── Appearance ────────────────────────────────────────────────────────────
    // A three-way segmented control rather than a sun/moon switch: "Auto" is a
    // real state (follow the OS) and a two-position toggle can't express it.
    _renderAppearanceCard() {
      const auto = window.BgbTheme.isAuto();
      const mode = window.BgbTheme.current();
      const seg = (value, label) => {
        const on = value === "auto" ? auto : (!auto && mode === value);
        return `
          <button class="theme-seg__opt${on ? " is-on" : ""}"
                  aria-pressed="${on ? "true" : "false"}"
                  onclick="window.settingsView._setTheme('${value}')">${label}</button>`;
      };
      return `
        <div class="set-card">
          <div class="set-card__row set-card__row--static">
            <span class="set-card__row-icon"><i data-icon="sun-moon" class="w-4 h-4"></i></span>
            <span class="set-card__row-body">
              <span class="set-card__row-title">Theme</span>
              <span class="set-card__row-sub">
                ${auto ? `Following your device — currently ${mode}.` : `Always ${mode}.`}
              </span>
            </span>
          </div>
          <div class="theme-seg" role="group" aria-label="Theme">
            ${seg("auto", "Auto")}${seg("light", "Light")}${seg("dark", "Dark")}
          </div>
        </div>
      `;
    }

    /** @param {"auto"|"light"|"dark"} value */
    _setTheme(value) {
      if (value === "auto") window.BgbTheme.clear();
      else window.BgbTheme.set(value);
      this.render();
    }

    // One row per admin tool, each its own spoke. Previously all three tools
    // lived on one /admin screen behind a row labelled "Chapter reports" — so
    // the two catalog backfills were unreachable by name, and the single badge
    // could only ever count one of the three queues.
    //
    // `tool` keys into domain/notifications.js, which owns the count and how
    // to say it; this table owns only how the row looks.
    _adminTools() {
      return [
        {
          route: "admin-reports",
          tool: "reports",
          icon: "flag",
          title: "Chapter reports",
          sub: "Moderate community-reported reference-guide chapters.",
        },
        {
          route: "admin-images",
          tool: "images",
          icon: "image-off",
          title: "Missing images",
          sub: "Re-host box art and thumbnails from BoardGameGeek.",
        },
        {
          route: "admin-descriptions",
          tool: "descriptions",
          icon: "scroll-text",
          title: "Missing descriptions",
          sub: "Backfill game descriptions from BoardGameGeek.",
        },
      ];
    }

    _renderAdminCard() {
      return `
        <div class="set-card">
          ${this._adminTools().map((t) => this._renderAdminRow(t)).join("")}
        </div>
      `;
    }

    _renderAdminRow(t) {
      const { total, parts } = window.BgbNotifications.forAdminTool(t.tool);
      // The badge is decorative — the count is already in the row's
      // aria-label, so a screen reader hearing "3" twice learns nothing.
      const badge = total > 0
        ? `<span class="set-card__badge" aria-hidden="true">${total}</span>`
        : "";
      const label = parts.length
        ? `${t.title} — ${window.BgbNotifications.phrase(parts)} waiting`
        : t.title;
      return `
        <button class="set-card__row" aria-label="${escapeAttr(label)}"
                onclick="window.router.go('${t.route}')">
          <span class="set-card__row-icon"><i data-icon="${t.icon}" class="w-4 h-4"></i></span>
          <span class="set-card__row-body">
            <span class="set-card__row-title">${escapeHtml(t.title)}</span>
            <span class="set-card__row-sub">${escapeHtml(t.sub)}</span>
          </span>
          ${badge}
          <span class="set-card__row-chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
        </button>
      `;
    }

    // ── BGG card ──────────────────────────────────────────────────────────────
    _renderBggCard() {
      const state = (this._bgg && this._bgg.auth_state) || "unlinked";
      const username = (this._bgg && this._bgg.bgg_username) || null;
      const pending = (this._bgg && this._bgg.pending_count) || 0;
      const errored = (this._bgg && this._bgg.errored_count) || 0;
      const lastDone = (this._bgg && this._bgg.last_completed_at) || null;


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
              <i data-icon="link" class="w-4 h-4"></i> Link BoardGameGeek
            </button>
            ${this._bggLinkOpen ? this._renderBggLinkForm() : ""}
          </div>
        `;
      } else if (state === "relink_required") {
        body = `
          <div class="set-card__bgg-body" style="flex-direction: column; align-items: stretch;">
            <div class="flex items-start justify-between gap-2">
              <div>
                <div class="set-card__bgg-handle">@${escapeHtml(username || "")}</div>
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
        // Disabled only while something is actually running. A finished
        // comparison does NOT block a fresh one: re-checking is how you
        // recover from a plan that went stale while you were reading it.
        const busy = !!(window.BggSyncFlow && window.BggSyncFlow.isBusy());
        body = `
          <div class="set-card__bgg-body">
            <div class="set-card__bgg-info">
              <div class="set-card__bgg-handle">@${escapeHtml(username || "")}</div>
              <div class="set-card__bgg-status">
                <span class="set-card__bgg-status-dot"></span>
                ${lastDone ? `Last synced ${formatRelative(lastDone)}` : "Not yet synced"}
                ${pending > 0 ? ` · ${pending} pending` : ""}
                ${errored > 0 ? ` · ${errored} errored` : ""}
              </div>
            </div>
            <button class="btn btn-ghost btn-xs" onclick="window.settingsView._unlinkBgg()">Unlink</button>
          </div>
          <div class="set-card__bgg-actions">
            <button class="btn btn-ghost btn-sm set-card__bgg-check"
                    ${busy ? "disabled" : ""}
                    onclick="window.settingsView._startBggCheck()">
              <i data-icon="shuffle" class="w-4 h-4"></i>
              Check status
            </button>
          </div>
          ${this._renderBggSyncStrip()}
        `;
      }

      return `
        <div class="set-card">
          <div class="set-card__bgg-top">
            <span class="set-card__bgg-mark">BoardGameGeek</span>
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
          ${this._bggError ? `<div class="text-error text-xs">${escapeHtml(this._bggError)}</div>` : ""}
          <div class="flex gap-2 justify-end">
            <button type="button" class="btn btn-ghost btn-xs" onclick="window.settingsView._closeBggLink()">Cancel</button>
            <button type="submit" class="btn btn-primary btn-xs">Link</button>
          </div>
        </form>
      `;
    }

    // ── Local cache buckets ───────────────────────────────────────────────────
    // Maps each cache namespace to a human-readable bucket. Anything not
    // listed here falls into "Other" so the total still adds up.
    static _CACHE_BUCKETS = {
      "game.bundle": "games",
      "collection": "games",
      "feed":       "plays",
      "buddy":      "buddies",
    };

    /**
     * Plays recorded offline that haven't reached the server yet.
     *
     * The whole section is absent when the queue is empty — an always-present
     * "0 pending uploads" row would train people to ignore the one place that
     * tells them a play is still only on this phone.
     *
     * That reasoning got STRONGER when the header's upload button was deleted.
     * It used to be the always-present affordance, greying out at zero, which
     * is what made this section safe to hide; now the always-present thing is
     * the gear's DOT, fed by the `outboxCount` row in domain/notifications.js.
     * A dot only lights when there is something here, so arriving to find
     * nothing is no longer reachable — you are sent by the signal or not at
     * all.
     *
     * The list, the upload action and the per-entry retry/remove all live in
     * widgets/outbox-modal.js, which the global header opens too. Settings had
     * its own parallel rendering of the same queue before that consolidation
     * — see .claude/rules/ui-object-design.md §4.
     */
    _renderPendingUploadsSection() {
      const n = window.Outbox ? window.Outbox.count() : 0;
      if (!n) return "";
      const offline = !!(window.BgbNet && window.BgbNet.isOffline());
      return `
        <div class="set-card-label">Pending uploads</div>
        <div class="set-card">
          <button class="set-card__row" onclick="window.OutboxModal.open()">
            <span class="set-card__row-icon"><i data-icon="cloud-upload" class="w-4 h-4"></i></span>
            <span class="set-card__row-body">
              <span class="set-card__row-title">
                ${n} ${n === 1 ? "play" : "plays"} waiting to upload
              </span>
              <span class="set-card__row-sub">
                ${offline
                  ? "Saved on this device — they'll go up when you're back online."
                  : "Saved on this device until the server confirms them."}
              </span>
            </span>
            <span class="set-card__row-chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
          </button>
        </div>
      `;
    }

    /**
     * The play importer's front door (views/import-plays-view.js).
     *
     * Its own section rather than a row under Connections: BGG sync links an
     * account and keeps two libraries in step, and this reads a block of text
     * once. Filing them together would suggest the importer needs an account
     * somewhere, which is the whole point of it not doing.
     */
    _renderImportCard() {
      return `
        <div class="set-card">
          <button class="set-card__row" onclick="window.router.go('import-plays')">
            <span class="set-card__row-icon"><i data-icon="upload" class="w-4 h-4"></i></span>
            <span class="set-card__row-body">
              <span class="set-card__row-title">Import plays from notes</span>
              <span class="set-card__row-sub">
                Paste a list or a page of tally marks — you review every play
                before anything is saved.
              </span>
            </span>
            <span class="set-card__row-chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
          </button>
        </div>
      `;
    }

    /**
     * Past imports, each undoable.
     *
     * Absent entirely when there are none, like the pending-uploads section
     * above: a permanent "0 imports" row would be chrome that never says
     * anything. Loaded on mount rather than behind a tap, because the whole
     * point is that somebody who regrets an import finds the undo without
     * knowing to look for it.
     */
    _renderPastImportsSection() {
      const rows = this._imports;
      if (!rows || !rows.length) return "";
      return `
        <div class="set-card">
          ${rows.map((imp) => {
            const n = imp.play_count || 0;
            const names = imp.game_names || [];
            const games = names.join(", ") + ((imp.game_count || 0) > names.length ? "…" : "");
            const busy = this._deletingImport === imp.batch_id;
            return `
              <div class="set-card__row set-card__row--static">
                <span class="set-card__row-icon"><i data-icon="history" class="w-4 h-4"></i></span>
                <span class="set-card__row-body">
                  <span class="set-card__row-title">
                    ${n} play${n === 1 ? "" : "s"}${games ? ` · ${escapeHtml(games)}` : ""}
                  </span>
                  <span class="set-card__row-sub">
                    Imported ${escapeHtml(formatDate(imp.imported_at))}
                  </span>
                </span>
                <button class="set-card__row-del" ${busy ? "disabled" : ""}
                        aria-label="Delete this import"
                        onclick="${escapeAttr(`window.settingsView._deleteImport('${jsStr(imp.batch_id)}')`)}">
                  <i data-icon="trash-2" class="w-4 h-4"></i>
                </button>
              </div>
            `;
          }).join("")}
        </div>
      `;
    }

    async _loadImports() {
      try {
        this._imports = await window.Play.listImports();
      } catch (_) {
        // Non-fatal: the section stays absent. An import you cannot list is no
        // worse off than one you could not have deleted anyway.
        this._imports = [];
      }
      this.render();
    }

    /** @param {string} batchId */
    async _deleteImport(batchId) {
      const imp = (this._imports || []).find((i) => i.batch_id === batchId);
      if (!imp || this._deletingImport) return;
      const n = imp.play_count || 0;
      const ok = await window.PolaroidPopup.confirm({
        title: "Delete this import?",
        body: `All ${n} play${n === 1 ? "" : "s"} it added will be removed from your history and your stats. This can't be undone — you'd have to import the note again.`,
        confirmLabel: "Delete",
        cancelLabel: "Keep them",
        destructive: true,
      });
      if (!ok) return;
      this._deletingImport = batchId;
      this.render();
      let deleted = 0;
      try {
        const res = await window.Play.deleteImportBatch(batchId);
        deleted = (res && res.deleted) || 0;
      } catch (e) {
        this._deletingImport = null;
        this.render();
        showToast((e && e.message) || "Couldn't delete that import", "error");
        return;
      }
      this._deletingImport = null;
      this._imports = (this._imports || []).filter((i) => i.batch_id !== batchId);
      this.render();
      showToast(`Deleted ${deleted} play${deleted === 1 ? "" : "s"}`, "success");
    }

    /**
     * The one row a running or finished BGG flow leaves behind on this card.
     *
     * The flow itself lives on its own screen (views/bgg-sync-view.js), and
     * closing that screen must not end a sync — so the run keeps going in
     * domain/bgg-sync-flow.js and this row is how the user knows. Tapping it
     * goes back to whichever face of the flow is current.
     *
     * Built on .set-card__row, the same shape the play importer's entry uses,
     * plus the log family's bar. Nothing renders while the flow is idle.
     */
    _renderBggSyncStrip() {
      const flow = window.BggSyncFlow;
      const snap = flow ? flow.snapshot() : null;
      if (!snap || snap.screen === "idle") return "";

      const st = snap.status || {};
      const settled = (st.session_done || 0) + (st.session_errored || 0);
      const total = st.session_total || 0;
      const diff = snap.diff || {};
      const differences = Math.max(diff.push_total || 0, diff.pull_total || 0);

      let icon = "loader-2";
      let spin = true;
      let title = "Working…";
      let sub = "Tap to watch";
      let pct = null;

      switch (snap.screen) {
        case "checking": {
          const step = (snap.progress && snap.progress.steps || [])
            .find((x) => x.state === "active");
          title = "Comparing with BoardGameGeek…";
          sub = step && step.total
            ? `${step.done || 0} of ${step.total} · tap to watch`
            : "Tap to watch";
          if (step && step.total) pct = Math.round(((step.done || 0) / step.total) * 100);
          break;
        }
        case "review":
          icon = "shuffle"; spin = false;
          title = differences
            ? `${differences} ${differences === 1 ? "difference" : "differences"} found`
            : "Everything matches";
          sub = "Tap to review";
          break;
        case "confirm":
          icon = "shuffle"; spin = false;
          title = `Review ${differences} ${differences === 1 ? "change" : "changes"}`;
          sub = "Not started yet · tap to finish";
          break;
        case "running":
          title = snap.direction === "push"
            ? (total ? `Pushing ${settled} of ${total}…` : "Pushing to BoardGameGeek…")
            : (total ? `Importing ${settled} of ${total}…` : "Importing from BoardGameGeek…");
          if (total) pct = Math.round((settled / total) * 100);
          break;
        case "done":
          icon = "check"; spin = false;
          title = "Sync complete";
          sub = "Tap for the details";
          break;
        case "error":
          icon = "alert-triangle"; spin = false;
          title = "That didn\u2019t finish";
          sub = "Tap to try again";
          break;
        default:
          return "";
      }

      // The bar's width is data — the one inline style the rules allow.
      const bar = pct === null ? "" : `
        <div class="bgg-log__bar set-card__row-bar">
          <div class="bgg-log__bar-fill" style="width:${pct}%"></div>
        </div>`;

      return `
        <button class="set-card__row set-card__row--progress"
                onclick="window.settingsView._openBggSync()">
          <span class="set-card__row-icon">
            <i data-icon="${icon}" class="w-4 h-4 ${spin ? "animate-spin" : ""}"></i>
          </span>
          <span class="set-card__row-body">
            <span class="set-card__row-title">${escapeHtml(title)}</span>
            <span class="set-card__row-sub">${escapeHtml(sub)}</span>
            ${bar}
          </span>
          <span class="set-card__row-chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
        </button>
      `;
    }

    /**
     * The strip: go to whichever face of the flow is current, changing nothing.
     */
    _openBggSync() {
      window.router.go("bgg-sync");
    }

    /**
     * The button: always a NEW comparison, then the flow's screen to watch it.
     *
     * Starting here rather than letting the view's onMount decide is what makes
     * the button mean what it says. A flow left sitting on a finished
     * comparison is not idle, so an onMount that only started when idle would
     * take "Check status" to a comparison from ten minutes ago.
     */
    _startBggCheck() {
      if (window.BggSyncFlow) window.BggSyncFlow.start();
      window.router.go("bgg-sync");
    }

    // ── Data management ───────────────────────────────────────────────────────
    // Two cards under one label, and they are opposites on purpose: the export
    // is about getting data OUT of the account, the cache card below is about
    // the copy of it this device happens to be holding. The label used to read
    // "Local cache", which is a heading nobody would think to look under for
    // "how do I get my plays out of this thing".

    /**
     * The way out of the app, one tap from a screen anybody can find.
     *
     * A row rather than a button with a spinner, because the choosing happens
     * in widgets/export-data-sheet.js: what to include is a real decision (a
     * decade of plays is not the same download as a profile row) and the
     * counts that make it answerable have to be fetched, which is a sheet's
     * job rather than this screen's.
     */
    _renderExportCard() {
      return `
        <div class="set-card">
          <button class="set-card__row"
                  onclick="window.ExportDataSheet.open({ returnFocus: this })">
            <span class="set-card__row-icon"><i data-icon="download" class="w-4 h-4"></i></span>
            <span class="set-card__row-body">
              <span class="set-card__row-title">Export your data</span>
              <span class="set-card__row-sub">
                Download your collection, plays, buddies and more as a zip of
                CSV files.
              </span>
            </span>
            <span class="set-card__row-chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
          </button>
        </div>
      `;
    }

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
              <i data-icon="refresh-cw" class="w-4 h-4 ${busy ? "animate-spin" : ""}"></i>
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

    // Two account actions, and the whole point of this block is that they do
    // not look alike. Logging out is reversible — you sign back in and
    // everything is where you left it — so it reads as a neutral control.
    // Deleting is not, so it is separated by a rule, inked in --rust, carries
    // the bin glyph, and says underneath exactly what goes with it. Before
    // this, logout was itself a filled red button "so it gets the same visual
    // weight as a delete affordance", which left the app's one genuinely
    // irreversible action with nowhere louder to stand.
    _renderAccountActions() {
      return `
        <div class="settings-account">
          <button class="btn btn-sm settings-account__logout"
                  ${this._deleting ? "disabled" : ""} onclick="window.handleLogout()">
            <i data-icon="log-out" class="w-4 h-4"></i> Log out
          </button>
          <div class="settings-account__danger">
            <button class="btn btn-sm settings-account__delete"
                    ${this._deleting ? "disabled" : ""}
                    onclick="window.settingsView._confirmDeleteAccount()">
              <i data-icon="trash-2" class="w-4 h-4"></i>
              ${this._deleting ? "Deleting…" : "Delete account"}
            </button>
            <p class="settings-account__note">
              Permanently removes your profile, plays, collection and buddies.
              This can't be undone.
            </p>
          </div>
        </div>
      `;
    }

    // ── Delete account ────────────────────────────────────────────────────────
    // One confirm, through the project's single destructive surface
    // (.claude/rules/ui-object-design.md §3c) with the same words the native
    // app uses, so the two platforms describe the same act identically.
    async _confirmDeleteAccount() {
      if (this._deleting) return;
      const ok = await window.PolaroidPopup.confirm({
        title: "Delete your account?",
        body: "This permanently deletes your profile, plays, collection, buddies "
            + "and chapters. This cannot be undone.",
        confirmLabel: "Delete forever",
        cancelLabel: "Keep my account",
        destructive: true,
      });
      if (!ok) return;

      this._deleting = true;
      this.render();
      try {
        await window.User.deleteAccount();
      } catch (e) {
        this._deleting = false;
        this.render();
        // An alert, not a toast: the user just asked for something permanent
        // and has to know it did not happen, even if they navigate away.
        await window.PolaroidPopup.alert({
          title: "Couldn't delete your account",
          body: (e && e.message) ? String(e.message) : "Please try again.",
        });
        return;
      }
      // The row is gone but this device still holds a token that looks valid
      // and a cache full of the account's data. handleLogout is what clears
      // both and returns to /auth — deleting without it would leave the app
      // signed in to nothing.
      await window.handleLogout();
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

    // ── The comparison, and the two syncs it gates ──────────────────────────
    //
    // Neither sync button is rendered until a comparison exists, so no sync can
    // be started against a state the user has not seen — and a finished sync
    // clears the comparison that authorised it, so they disappear again rather
    // than sitting there one tap from a re-run against a stale plan.
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
