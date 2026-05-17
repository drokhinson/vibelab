// ui/buddies-panel.js — shared rendering + actions for the buddies surface.
//
// Used by both the legacy /buddies route (BuddiesView) and the Buddies tab
// inside ProfileSelfView. Owns its own data (buddies, requests, played-with,
// ghosts) and the linking flow. The host view supplies a container element
// and is responsible for rendering its own chrome (back button, page title).
//
// Hosts hold a single panel instance via `new BuddiesPanel(hostId)`. On
// mount, call `panel.mount(containerEl)`; on unmount, call `panel.unmount()`.

(function () {
  const PAGE_SIZE = 5;

  class BuddiesPanel {
    constructor(hostId) {
      // hostId namespaces the inline onclick handlers so we can have multiple
      // panel instances on the page without colliding.
      this.hostId = hostId;
      this._container = null;
      this._buddies = [];
      this._requests = { incoming: [], outgoing: [] };
      this._playedWith = [];
      this._ghosts = [];
      this._search = [];
      this._q = "";
      this._linkingGhost = null;
      this._linkQuery = "";
      this._linkResults = [];
      // Pagination cursors — survive re-renders but reset on _load() since
      // the underlying lists may have changed shape after a mutation.
      this._buddiesPage = 0;
      this._playedWithPage = 0;
      // Initial-load flag — only true during the very first `_load()` so the
      // bouncing-buddy loader appears once. After that the data is cached on
      // the panel; tab re-entries render the cached lists immediately, and
      // refreshes happen out-of-band via the manual button.
      this._initialLoading = true;
      this._refreshing = false;
      this._loaded = false;
      window[hostId] = this; // for inline onclick lookup
    }

    async mount(container) {
      this._container = container;
      if (this._loaded) {
        // Data was pre-fetched (e.g. parent view kicked off `_load()` during
        // its own onMount) or cached from a previous mount — just paint.
        this.render();
        return;
      }
      this._initialLoading = true;
      this.render();
      await this._load();
    }

    unmount() {
      this._container = null;
    }

    async _load() {
      try {
        const [buddies, requests, playedWith, ghosts] = await Promise.all([
          window.Buddy.list().catch(() => []),
          window.Buddy.requests().catch(() => ({ incoming: [], outgoing: [] })),
          window.Buddy.playedWith().catch(() => []),
          window.Buddy.ghostPlayers().catch(() => []),
        ]);
        this._buddies = buddies || [];
        this._requests = requests || { incoming: [], outgoing: [] };
        this._playedWith = playedWith || [];
        this._ghosts = ghosts || [];
        // Reset both pagers after any reload — list lengths can shrink
        // (unfriend / link ghost), which would otherwise leave us on an
        // empty trailing page.
        this._buddiesPage = 0;
        this._playedWithPage = 0;
        this._loaded = true;
      } finally {
        this._initialLoading = false;
        this._refreshing = false;
        this.render();
      }
    }

    async _refresh() {
      // Manual refresh — keeps the cached lists visible while the refetch
      // runs in the background and spins the header button's icon.
      if (this._refreshing) return;
      this._refreshing = true;
      this.render();
      await this._load();
    }

    _paginate(items, page) {
      const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      const cur = Math.min(Math.max(0, page), totalPages - 1);
      const start = cur * PAGE_SIZE;
      return {
        page: cur,
        totalPages,
        pageItems: items.slice(start, start + PAGE_SIZE),
        hasPrev: cur > 0,
        hasNext: cur < totalPages - 1,
      };
    }

    _renderPager(kind, info) {
      if (info.totalPages <= 1) return "";
      const hostRef = `window.${this.hostId}`;
      return `
        <div class="buddies-pager">
          <button class="btn btn-ghost btn-xs" ${info.hasPrev ? "" : "disabled"}
                  onclick="${hostRef}._setPage('${kind}', ${info.page - 1})">
            <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i> Prev
          </button>
          <span class="buddies-pager__label">${info.page + 1} / ${info.totalPages}</span>
          <button class="btn btn-ghost btn-xs" ${info.hasNext ? "" : "disabled"}
                  onclick="${hostRef}._setPage('${kind}', ${info.page + 1})">
            Next <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      `;
    }

    _setPage(kind, page) {
      if (kind === "buddies") this._buddiesPage = page;
      else if (kind === "played") this._playedWithPage = page;
      this.render();
    }

    render() {
      if (!this._container) return;
      if (this._initialLoading) {
        // Match the splash / feed loader placement so the buddies tab opens
        // with the same centered bouncing-buddy artwork the rest of the app
        // uses for first-paint waits.
        this._container.innerHTML = `
          <div class="flex flex-col items-center justify-center min-h-[60vh]">
            ${window.buddyLoader({ size: 176, padded: false, label: "Gathering buddies…" })}
          </div>
        `;
        return;
      }
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;
      const hostRef = `window.${this.hostId}`;

      const playCountByUser = {};
      for (const p of this._playedWith || []) playCountByUser[p.user_id] = p.play_count;
      const playedWithNonBuddies = (this._playedWith || []).filter((p) => !p.is_buddy);

      this._container.innerHTML = `
        <section class="buddies-search">
          <input id="${this.hostId}-search-input" class="input input-bordered w-full"
                 placeholder="Find people by display name"
                 autocomplete="off"
                 oninput="${hostRef}._searchInput(this.value)"
                 value="${escapeAttr(this._q)}" />
          ${this._q
            ? `<ul class="search-list">${this._search.map((u) => `
                <li class="search-hit" onclick="window.router.go('profile-other',{userId:'${u.id}'})">
                  <div class="search-hit__placeholder"><i data-lucide="user"></i></div>
                  <div class="search-hit__body">
                    <div class="search-hit__name">${escape(u.display_name)}</div>
                    ${u.username ? `<div class="search-hit__meta">@${escape(u.username)}</div>` : ""}
                  </div>
                  <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();${hostRef}._request('${u.id}', this)">Add</button>
                </li>
              `).join("")}</ul>`
            : ""}
        </section>

        ${this._requests.incoming.length > 0 ? `
          <section class="buddies-section">
            <h3>Incoming requests</h3>
            <ul class="buddies-list">
              ${this._requests.incoming.map((r) => `
                <li class="buddies-row">
                  <div class="buddies-row__avatar avatar-bubble">${initials(r.other_display_name)}</div>
                  <div class="buddies-row__body">
                    <div class="buddies-row__name">${escape(r.other_display_name)}</div>
                    <div class="buddies-row__when">Requested ${formatDate(r.created_at)}</div>
                  </div>
                  <button class="btn btn-primary btn-xs" onclick="${hostRef}._accept('${r.id}')">Accept</button>
                  <button class="btn btn-ghost btn-xs" onclick="${hostRef}._reject('${r.id}')">Decline</button>
                </li>
              `).join("")}
            </ul>
          </section>
        ` : ""}

        ${this._requests.outgoing.length > 0 ? `
          <section class="buddies-section">
            <h3>Sent</h3>
            <ul class="buddies-list">
              ${this._requests.outgoing.map((r) => `
                <li class="buddies-row">
                  <div class="buddies-row__avatar avatar-bubble">${initials(r.other_display_name)}</div>
                  <div class="buddies-row__body">
                    <div class="buddies-row__name">${escape(r.other_display_name)}</div>
                    <div class="buddies-row__when">Awaiting reply</div>
                  </div>
                </li>
              `).join("")}
            </ul>
          </section>
        ` : ""}

        ${this._renderBuddiesSection(playCountByUser, hostRef)}

        ${this._renderPlayedWithSection(playedWithNonBuddies, hostRef)}
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

    _renderBuddiesSection(playCountByUser, hostRef) {
      const total = this._buddies.length;
      // Section header carries a manual refresh button — buddies data is
      // loaded once (on first mount or preloaded by the parent view) and
      // only refetched when the user explicitly asks via this button or
      // takes an action that mutates the list (add / accept / unfriend).
      const head = `
        <header class="buddies-section__head">
          <h3>Buddies (${total})</h3>
          <button class="btn btn-ghost btn-xs buddies-section__refresh"
                  aria-label="Refresh buddies"
                  title="Refresh buddies"
                  ${this._refreshing ? "disabled" : ""}
                  onclick="${hostRef}._refresh()">
            <i data-lucide="refresh-cw" class="w-3.5 h-3.5 ${this._refreshing ? "animate-spin" : ""}"></i>
          </button>
        </header>
      `;
      if (total === 0) {
        return `
          <section class="buddies-section">
            ${head}
            <p class="text-sm opacity-60 p-3">No buddies yet — search above to add some.</p>
          </section>
        `;
      }
      const info = this._paginate(this._buddies, this._buddiesPage);
      const rows = info.pageItems.map((b) => {
        const plays = playCountByUser[b.other_user_id] || 0;
        const sub = [
          plays ? `${plays} ${plays === 1 ? "play" : "plays"} together` : null,
          b.accepted_at ? "buddies since " + formatDate(b.accepted_at) : null,
        ].filter(Boolean).join(" · ");
        return `
          <li class="buddies-row" onclick="window.router.go('profile-other',{userId:'${b.other_user_id}'})">
            <div class="buddies-row__avatar avatar-bubble">${initials(b.other_display_name)}</div>
            <div class="buddies-row__body">
              <div class="buddies-row__name">${escape(b.other_display_name)}</div>
              <div class="buddies-row__when">${sub}</div>
            </div>
            <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();${hostRef}._unfriend('${b.id}')">
              <i data-lucide="user-x" class="w-3.5 h-3.5"></i>
            </button>
          </li>`;
      }).join("");
      return `
        <section class="buddies-section">
          ${head}
          <ul class="buddies-list">${rows}</ul>
          ${this._renderPager("buddies", info)}
        </section>
      `;
    }

    _renderPlayedWithSection(playedWithNonBuddies, hostRef) {
      const me = window.store.get("user");
      const myName = (me && me.display_name) ? me.display_name.toLowerCase() : null;
      const ghosts = (this._ghosts || []).filter(
        (g) => !myName || (g.display_name || "").toLowerCase() !== myName
      );
      if (playedWithNonBuddies.length === 0 && ghosts.length === 0) return "";

      // Single ordered list — accounts first (so "buddy up" surfaces stay
      // near the top), then ghosts. Tag with _kind so the pager slice can
      // route each row to the right renderer.
      const combined = [
        ...playedWithNonBuddies.map((p) => ({ _kind: "account", item: p })),
        ...ghosts.map((g) => ({ _kind: "ghost", item: g })),
      ];
      const info = this._paginate(combined, this._playedWithPage);
      const rows = info.pageItems.map((row) => row._kind === "account"
        ? this._renderAccountRow(row.item, hostRef)
        : this._renderGhostRow(row.item, hostRef)
      ).join("");
      // Show the ghost hint only when the current page actually contains
      // a ghost row — keeps it from popping up under the accounts-only page.
      const pageHasGhost = info.pageItems.some((r) => r._kind === "ghost");

      return `
        <section class="buddies-section">
          <h3>Played with (${combined.length})</h3>
          <ul class="buddies-list">${rows}</ul>
          ${this._renderPager("played", info)}
          ${pageHasGhost
            ? `<p class="text-xs opacity-60 px-1 mt-1">Tap "Link" on a custom player to point them at a real account — past plays update too.</p>`
            : ""}
        </section>
      `;
    }

    _renderAccountRow(p, hostRef) {
      let action;
      if (p.has_pending_request) {
        action = p.pending_request_direction === "incoming"
          ? `<button class="btn btn-primary btn-xs" onclick="event.stopPropagation();${hostRef}._acceptIncoming('${p.user_id}', this)">Accept</button>`
          : `<button class="btn btn-ghost btn-xs" disabled>Sent</button>`;
      } else {
        action = `<button class="btn btn-primary btn-xs" onclick="event.stopPropagation();${hostRef}._request('${p.user_id}', this)">Buddy up</button>`;
      }
      return `
        <li class="buddies-row" onclick="window.router.go('profile-other',{userId:'${p.user_id}'})">
          <div class="buddies-row__avatar avatar-bubble">${p.avatar_url ? `<img src="${escapeAttr(p.avatar_url)}" alt="" />` : initials(p.display_name)}</div>
          <div class="buddies-row__body">
            <div class="buddies-row__name">
              ${escape(p.display_name)}
              <span class="player-type-chip player-type-chip--account">Account</span>
            </div>
            <div class="buddies-row__when">${p.play_count} ${p.play_count === 1 ? "play" : "plays"} together</div>
          </div>
          ${action}
        </li>
      `;
    }

    _renderGhostRow(g, hostRef) {
      const isOpen = this._linkingGhost === g.display_name;
      return `
        <li class="buddies-row buddies-row--ghost ${isOpen ? "is-expanded" : ""}">
          <div class="buddies-row__avatar avatar-bubble buddies-row__avatar--ghost">${initials(g.display_name)}</div>
          <div class="buddies-row__body">
            <div class="buddies-row__name">
              ${escape(g.display_name)}
              <span class="player-type-chip player-type-chip--custom">Custom</span>
            </div>
            <div class="buddies-row__when">${g.play_count} ${g.play_count === 1 ? "play" : "plays"}${g.last_played_at ? " · last " + formatDate(g.last_played_at) : ""}</div>
          </div>
          <button class="btn btn-ghost btn-xs" onclick="${hostRef}._toggleLinkPanel('${jsStr(g.display_name)}')">
            ${isOpen ? "Cancel" : "Link"}
          </button>
          ${isOpen ? this._renderLinkPanel(g.display_name, hostRef) : ""}
        </li>
      `;
    }

    _renderLinkPanel(displayName, hostRef) {
      return `
        <div class="buddies-link-panel" onclick="event.stopPropagation()">
          <input id="${this.hostId}-link-input"
                 class="input input-bordered input-sm w-full"
                 placeholder="Search accounts to link “${escape(displayName)}”"
                 autocomplete="off"
                 oninput="${hostRef}._linkSearchInput(this.value)"
                 value="${escapeAttr(this._linkQuery)}" />
          ${this._linkQuery && this._linkResults.length > 0 ? `
            <ul class="buddies-link-results">
              ${this._linkResults.map((u) => `
                <li onclick="${hostRef}._confirmLink('${jsStr(displayName)}', '${u.id}')">
                  <span class="avatar-bubble avatar-bubble--xs">${initials(u.display_name)}</span>
                  <span class="buddies-link-results__name">${escape(u.display_name)}</span>
                  ${u.email ? `<span class="buddies-link-results__email">${escape(u.email)}</span>` : ""}
                </li>
              `).join("")}
            </ul>
          ` : (this._linkQuery
              ? `<div class="text-xs opacity-60 px-1 pt-1">No matching accounts.</div>`
              : "")}
        </div>
      `;
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    async _searchInput(q) {
      this._q = q;
      if (!q) { this._search = []; this.render(); return; }
      try { this._search = await window.Buddy.searchProfiles(q); } catch (_) { this._search = []; }
      this.render();
    }

    async _request(userId, btn) {
      btn.disabled = true; btn.textContent = "…";
      try {
        await window.Buddy.sendRequest(userId);
        btn.textContent = "Sent";
        await this._load();
      } catch (e) {
        btn.disabled = false; btn.textContent = "Try again";
      }
    }

    async _acceptIncoming(userId, btn) {
      btn.disabled = true;
      try {
        const inc = (this._requests.incoming || []).find((r) => r.other_user_id === userId);
        if (inc) await window.Buddy.accept(inc.id);
      } catch (_) {}
      await this._load();
    }

    async _accept(id)   { try { await window.Buddy.accept(id); } finally { await this._load(); } }
    async _reject(id)   { try { await window.Buddy.reject(id); } finally { await this._load(); } }
    async _unfriend(id) {
      if (!confirm("Remove this buddy?")) return;
      try { await window.Buddy.unfriend(id); } finally { await this._load(); }
    }

    _toggleLinkPanel(displayName) {
      if (this._linkingGhost === displayName) {
        this._closeLinkPanel();
      } else {
        this._linkingGhost = displayName;
        this._linkQuery = "";
        this._linkResults = [];
        this.render();
        const el = document.getElementById(`${this.hostId}-link-input`);
        if (el) el.focus();
      }
    }
    _closeLinkPanel() {
      this._linkingGhost = null; this._linkQuery = ""; this._linkResults = [];
      this.render();
    }
    async _linkSearchInput(q) {
      this._linkQuery = q;
      if (!q) { this._linkResults = []; this.render(); return; }
      try { this._linkResults = await window.Buddy.searchProfiles(q); } catch (_) { this._linkResults = []; }
      this.render();
    }
    async _confirmLink(displayName, targetUserId) {
      try {
        await window.Buddy.linkGhost(displayName, targetUserId);
      } catch (e) {
        alert(e.message || "Failed to link");
        return;
      } finally {
        this._closeLinkPanel();
      }
      await this._load();
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function jsStr(s) {
    return String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n");
  }
  function initials(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }
  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  window.BuddiesPanel = BuddiesPanel;
})();
