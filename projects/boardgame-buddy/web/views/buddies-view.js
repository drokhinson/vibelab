// views/buddies-view.js — accepted buddies, pending requests, profile search,
// suggested buddies, played-with discovery, and ghost-player → account linking.

(function () {
  // Rows per page for the two long lists (Buddies, Played with). Both lists
  // grow without bound as the user logs plays, and the screen is a phone —
  // six rows is what fits above the fold beside the section that follows.
  const PER_PAGE = 6;

  class BuddiesView extends window.View {
    constructor() {
      super("buddies");
      this._buddies = [];
      this._requests = { incoming: [], outgoing: [] };
      this._search = [];
      this._q = "";
      this._loading = false;
      this._suggested = [];   // SuggestedBuddy[] — the "may know" rail

      // 1-based page for each paginated list. Clamped in render() so a list
      // that shrank under the user (unfriend, ghost link) can't strand them
      // on an empty page.
      this._buddiesPage = 1;
      this._playedWithPage = 1;

      // Played-with state
      this._playedWith = [];   // PlayedWithUser[]
      this._ghosts = [];       // GhostPlayer[]

      // Ghost-linking state: which display_name is currently being linked,
      // plus the live profile-search results for that picker.
      this._linkingGhost = null;
      this._linkQuery = "";
      this._linkResults = [];
      // Debounce timer + monotonic token for the link-panel profile search
      // — see _linkSearchInput.
      this._linkSearchTimer = null;
      this._linkSearchSeq = 0;
    }

    async onMount() {
      // Singleton view — a prior visit's page position must not survive into
      // the next mount (see .claude/rules/web-frontend.md, "Reset transient
      // state on every mount of a reused view").
      this._buddiesPage = 1;
      this._playedWithPage = 1;
      await this._load();
    }

    _renderTopbar() {
      return `
        <header class="search-topbar search-topbar--flush">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('profile-self')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-lg">Buddies</h2>
          <span></span>
        </header>
      `;
    }

    async _load() {
      this._loading = true;
      this.render();
      // Requests aren't part of the cached bundle — always fetch fresh, in
      // parallel with the bundle, and fold in below without blocking the
      // first paint on the round-trip.
      const requestsPromise = window.Buddy.requests()
        .catch(() => ({ incoming: [], outgoing: [] }));
      // Same for the "may know" rail — a separate RPC, deliberately uncached
      // (see Buddy.suggested), so it rides alongside instead of gating paint.
      const suggestedPromise = window.Buddy.suggested()
        .then((r) => (r && r.suggestions) || [])
        .catch(() => []);
      try {
        // Buddies + ghosts + played-with come from the SWR-cached aggregate
        // (seeded by /bootstrap as 'buddy:all'): usually resolves straight
        // from cache and re-fetches in the background when stale, so the
        // view paints immediately instead of firing three uncached calls.
        const combined = await window.Buddy.allBuddies()
          .catch(() => ({ accounts: [], ghosts: [], recent: [] }));
        this._buddies = combined.accounts || [];
        this._ghosts = combined.ghosts || [];
        this._playedWith = combined.recent || [];
      } finally {
        this._loading = false;
        this.render();
      }
      const [requests, suggested] = await Promise.all([requestsPromise, suggestedPromise]);
      this._requests = requests || { incoming: [], outgoing: [] };
      this._suggested = suggested || [];
      this.render();
    }

    render() {
      // Capture focus + caret so a re-render mid-typing doesn't yank the
      // user out of an input (the live profile-search and ghost-link
      // pickers both keystroke-refresh).
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;

      // Cold load — show the bgb logo loader instead of flashing every
      // empty section. We're loading AND nothing is on screen yet.
      if (this._loading
          && this._buddies.length === 0
          && this._requests.incoming.length === 0
          && this._requests.outgoing.length === 0
          && (this._playedWith || []).length === 0
          && (this._ghosts || []).length === 0
          && !this._q) {
        this.container.innerHTML = `
          ${this._renderTopbar()}
          <div class="profile-loading">
            ${window.buddyLoader({ size: 96, label: "Gathering buddies…" })}
          </div>
        `;
        this.refreshIcons();
        return;
      }

      // Map played-with rows by user_id so the accepted-buddy section can
      // surface a shared-play count without a second backend trip.
      const playCountByUser = {};
      for (const p of this._playedWith || []) {
        playCountByUser[p.user_id] = p.play_count;
      }

      // Clamp before slicing: an unfriend or a ghost link can shrink either
      // list out from under the page the user is on.
      const buddiesPages = totalPages(this._buddies.length);
      this._buddiesPage = Math.min(this._buddiesPage, buddiesPages);
      const buddiesSlice = pageSlice(this._buddies, this._buddiesPage);

      this.container.innerHTML = `
        ${this._renderTopbar()}

        <section class="buddies-search">
          ${window.BgbSearchField.render({
            id: "buddies-search-input",
            value: this._q,
            placeholder: "Search for buddies",
            // This field searches on blur / Enter, not per keystroke, so the ×
            // has to commit the empty query itself — hence the oninput, which
            // is also the event BgbSearchField dispatches when it clears.
            oninput: "if(!this.value)window.buddiesView._searchInput('');",
            onblur: "window.buddiesView._searchInput(this.value)",
            onkeydown: "if(event.key==='Enter'){event.preventDefault();window.buddiesView._searchInput(this.value);}",
          })}
          ${this._q
            ? `<ul class="search-list">${this._search.map((u) => `
                <li class="search-hit" onclick="window.router.go('profile-other',{userId:'${u.id}'})">
                  <div class="search-hit__placeholder"><i data-icon="user"></i></div>
                  <div class="search-hit__body">
                    <div class="search-hit__name">${escapeHtml(u.display_name)}</div>
                    ${u.username ? `<div class="search-hit__meta">@${escapeHtml(u.username)}</div>` : ""}
                  </div>
                  <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();window.buddiesView._request('${u.id}', this)">Add</button>
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
                  ${window.BgbBadge.render({ avatar: r.other_avatar, displayName: r.other_display_name, size: "sm", extraClass: "buddies-row__avatar" })}
                  <div class="buddies-row__body">
                    <div class="buddies-row__name">${escapeHtml(r.other_display_name)}</div>
                    <div class="buddies-row__when">Requested ${formatDate(r.created_at)}</div>
                  </div>
                  <button class="btn btn-primary btn-xs" onclick="window.buddiesView._accept('${r.id}')">Accept</button>
                  <button class="btn btn-ghost btn-xs" onclick="window.buddiesView._reject('${r.id}')">Decline</button>
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
                  ${window.BgbBadge.render({ avatar: r.other_avatar, displayName: r.other_display_name, size: "sm", extraClass: "buddies-row__avatar" })}
                  <div class="buddies-row__body">
                    <div class="buddies-row__name">${escapeHtml(r.other_display_name)}</div>
                    <div class="buddies-row__when">Awaiting reply</div>
                  </div>
                </li>
              `).join("")}
            </ul>
          </section>
        ` : ""}

        <section class="buddies-section">
          <h3>Buddies (${this._buddies.length})</h3>
          ${this._buddies.length === 0
            ? `<p class="text-sm opacity-60 p-3">No buddies yet — search above to add some.</p>`
            : `<ul class="buddies-list">${buddiesSlice.map((b) => {
                const plays = playCountByUser[b.other_user_id] || 0;
                const sub = [
                  plays ? `${plays} ${plays === 1 ? "play" : "plays"} together` : null,
                  b.accepted_at ? "buddies since " + formatDate(b.accepted_at) : null,
                ].filter(Boolean).join(" · ");
                return `
                <li class="buddies-row" onclick="window.router.go('profile-other',{userId:'${b.other_user_id}'})">
                  ${window.BgbBadge.render({ avatar: b.other_avatar, displayName: b.other_display_name, size: "sm", extraClass: "buddies-row__avatar" })}
                  <div class="buddies-row__body">
                    <div class="buddies-row__name">${escapeHtml(b.other_display_name)}</div>
                    <div class="buddies-row__when">${sub}</div>
                  </div>
                  <button class="btn btn-ghost btn-xs bgb-destructive-icon-btn"
                          aria-label="Remove buddy"
                          title="Remove buddy"
                          onclick="event.stopPropagation();window.buddiesView._unfriend('${b.id}')">
                    <i data-icon="x" class="w-4 h-4"></i>
                  </button>
                </li>
              `;}).join("")}</ul>`}
          ${this._renderPager(this._buddiesPage, buddiesPages, "_goBuddiesPage", "Buddies pagination")}
        </section>

        ${window.renderSuggestedBuddiesRail(this._suggested, {
          addHandler: "window.buddiesView._request",
          flush: true,
        })}

        ${this._renderPlayedWithSection()}
      `;
      this.refreshIcons();

      // Restore focus + caret for the input that was active before re-render.
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

    // The Played-with sequence, as one list of tagged rows: real-account rows
    // first (sorted by play count desc, already done server-side), then ghost
    // rows. Paged as one sequence so a page always holds PER_PAGE rows rather
    // than however many of each kind happen to fall in the window — which
    // also means the pager and the slice must count it identically, hence the
    // single source of truth here.
    _playedWithRows() {
      const me = window.store.get("user");
      const myName = (me && me.display_name) ? me.display_name.toLowerCase() : null;

      // People who've played with the viewer but aren't already buddies —
      // existing buddies stay in the Buddies section above, to avoid the
      // duplication you'd get if we showed everyone.
      const accounts = (this._playedWith || []).filter((p) => !p.is_buddy);

      // Drop ghost rows that match the viewer's own display name — those are
      // self-references we shouldn't offer to "link to an account".
      const ghosts = (this._ghosts || []).filter(
        (g) => !myName || (g.display_name || "").toLowerCase() !== myName
      );

      return accounts
        .map((item) => ({ kind: "account", item }))
        .concat(ghosts.map((item) => ({ kind: "ghost", item })));
    }

    _renderPlayedWithSection() {
      // Each row carries a type chip so the user can tell accounts from
      // customs at a glance.
      const rows = this._playedWithRows();
      if (rows.length === 0) return "";

      const pages = totalPages(rows.length);
      this._playedWithPage = Math.min(this._playedWithPage, pages);
      const slice = pageSlice(rows, this._playedWithPage);

      const rowHtml = slice
        .map((r) => (r.kind === "account"
          ? this._renderAccountRow(r.item)
          : this._renderGhostRow(r.item)))
        .join("");

      // The hint is about the Link button, so only show it when a ghost row
      // is actually on screen.
      const ghostsOnPage = slice.some((r) => r.kind === "ghost");

      return `
        <section class="buddies-section">
          <h3>Played with (${rows.length})</h3>
          <ul class="buddies-list">
            ${rowHtml}
          </ul>
          ${this._renderPager(this._playedWithPage, pages, "_goPlayedWithPage", "Played-with pagination")}
          ${ghostsOnPage
            ? `<p class="text-xs opacity-60 px-1 mt-1">Tap “Link” on a custom player to point them at a real account — past plays update too.</p>`
            : ""}
        </section>
      `;
    }

    // Shared prev / next strip for both paginated lists. `handler` is the
    // method name on this view that takes the target page.
    _renderPager(page, pages, handler, label) {
      if (pages <= 1) return "";
      return `
        <nav class="buddies-pager" aria-label="${label}">
          <button class="btn btn-ghost btn-sm" ${page <= 1 ? "disabled" : ""}
                  aria-label="Previous page"
                  onclick="window.buddiesView.${handler}(${page - 1})">
            <i data-icon="chevron-left" class="w-4 h-4"></i> Prev
          </button>
          <span class="buddies-pager__page">Page ${page} of ${pages}</span>
          <button class="btn btn-ghost btn-sm" ${page >= pages ? "disabled" : ""}
                  aria-label="Next page"
                  onclick="window.buddiesView.${handler}(${page + 1})">
            Next <i data-icon="chevron-right" class="w-4 h-4"></i>
          </button>
        </nav>
      `;
    }

    _goBuddiesPage(n) {
      const next = clampPage(n, this._buddies.length);
      if (next === this._buddiesPage) return;
      this._buddiesPage = next;
      this.render();
    }

    _goPlayedWithPage(n) {
      const next = clampPage(n, this._playedWithRows().length);
      if (next === this._playedWithPage) return;
      this._playedWithPage = next;
      // The open ghost-link panel belongs to a row that is about to scroll
      // off the page — close it rather than leave invisible state behind.
      this._linkingGhost = null;
      this._linkQuery = "";
      this._linkResults = [];
      this.render();
    }

    _renderAccountRow(p) {
      let action;
      if (p.has_pending_request) {
        action = p.pending_request_direction === "incoming"
          ? `<button class="btn btn-primary btn-xs" onclick="event.stopPropagation();window.buddiesView._acceptIncoming('${p.user_id}', this)">Accept</button>`
          : `<button class="btn btn-ghost btn-xs" disabled>Sent</button>`;
      } else {
        action = `<button class="btn btn-primary btn-xs" onclick="event.stopPropagation();window.buddiesView._request('${p.user_id}', this)">Buddy up</button>`;
      }
      return `
        <li class="buddies-row" onclick="window.router.go('profile-other',{userId:'${p.user_id}'})">
          ${window.BgbBadge.render({ avatar: p.avatar, displayName: p.display_name, size: "sm", extraClass: "buddies-row__avatar" })}
          <div class="buddies-row__body">
            <div class="buddies-row__name">
              ${escapeHtml(p.display_name)}
              <span class="player-type-chip player-type-chip--account">Account</span>
            </div>
            <div class="buddies-row__when">${p.play_count} ${p.play_count === 1 ? "play" : "plays"} together</div>
          </div>
          ${action}
        </li>
      `;
    }

    _renderGhostRow(g) {
      const isOpen = this._linkingGhost === g.display_name;
      return `
        <li class="buddies-row buddies-row--ghost ${isOpen ? "is-expanded" : ""}">
          ${window.BgbBadge.render({ avatar: null, displayName: g.display_name, size: "sm", isGhost: true, extraClass: "buddies-row__avatar buddies-row__avatar--ghost" })}
          <div class="buddies-row__body">
            <div class="buddies-row__name">
              ${escapeHtml(g.display_name)}
              <span class="player-type-chip player-type-chip--custom">Custom</span>
            </div>
            <div class="buddies-row__when">${g.play_count} ${g.play_count === 1 ? "play" : "plays"}${g.last_played_at ? " · last " + formatDate(g.last_played_at) : ""}</div>
          </div>
          <button class="btn btn-ghost btn-xs" onclick="window.buddiesView._toggleLinkPanel('${jsStr(g.display_name)}')">
            ${isOpen ? "Cancel" : "Link"}
          </button>
          ${isOpen ? this._renderLinkPanel(g.display_name) : ""}
        </li>
      `;
    }

    _renderLinkPanel(displayName) {
      const q = (this._linkQuery || "").trim().toLowerCase();
      // Ghosts the viewer has logged that match the query, excluding the
      // ghost currently being linked. Rendered after accounts so real
      // buddies take priority in the picker.
      const ghostMatches = q
        ? (this._ghosts || []).filter((g) => {
            const name = (g.display_name || "").toLowerCase();
            if (name === displayName.toLowerCase()) return false;
            return name.includes(q);
          })
        : [];
      const hasAccounts = this._linkResults.length > 0;
      const hasGhosts = ghostMatches.length > 0;
      return `
        <div class="buddies-link-panel" onclick="event.stopPropagation()">
          ${window.BgbSearchField.render({
            id: "ghost-link-input",
            value: this._linkQuery,
            placeholder: `Search buddies or ghosts to link “${displayName}”`,
            inputCls: "input-sm",
            oninput: "window.buddiesView._linkSearchInput(this.value)",
          })}
          ${this._linkQuery && (hasAccounts || hasGhosts) ? `
            <ul class="buddies-link-results">
              ${this._linkResults.map((u) => `
                <li onclick="window.buddiesView._confirmLink('${jsStr(displayName)}', '${u.id}')">
                  ${window.BgbBadge.render({ avatar: u.avatar, displayName: u.display_name, size: "xs" })}
                  <span class="buddies-link-results__name">${escapeHtml(u.display_name)}</span>
                  <span class="buddies-link-results__chip">Account</span>
                </li>
              `).join("")}
              ${ghostMatches.map((g) => `
                <li onclick="window.buddiesView._confirmMerge('${jsStr(displayName)}', '${jsStr(g.display_name)}')">
                  ${window.BgbBadge.render({ avatar: null, displayName: g.display_name, size: "xs", isGhost: true })}
                  <span class="buddies-link-results__name">${escapeHtml(g.display_name)}</span>
                  <span class="buddies-link-results__email">${g.play_count} ${g.play_count === 1 ? "play" : "plays"}</span>
                  <span class="buddies-link-results__chip buddies-link-results__chip--ghost">Ghost</span>
                </li>
              `).join("")}
            </ul>
          ` : (this._linkQuery
              ? `<div class="buddies-link-results__empty">No matching buddies or ghosts.</div>`
              : "")}
        </div>
      `;
    }

    // ── Profile search (header) ─────────────────────────────────────────────
    async _searchInput(q) {
      this._q = q;
      if (!q) {
        this._search = [];
        this.render();
        return;
      }
      try {
        this._search = await window.Buddy.searchProfiles(q);
      } catch (_) {
        this._search = [];
      }
      this.render();
    }

    async _request(userId, btn) {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        await window.Buddy.sendRequest(userId);
        btn.textContent = "Sent";
        // The pending-request flag lives on the cached played-with rows —
        // drop the bundle so _load refetches instead of serving stale chips.
        window.Buddy.invalidate();
        await this._load();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Try again";
      }
    }

    async _acceptIncoming(userId, btn) {
      btn.disabled = true;
      try {
        const inc = (this._requests.incoming || []).find((r) => r.other_user_id === userId);
        if (inc) await window.Buddy.accept(inc.id);
      } catch (_) {}
      window.Buddy.invalidate();
      await this._load();
    }

    async _accept(id)  {
      try { await window.Buddy.accept(id); }
      finally { window.Buddy.invalidate(); await this._load(); }
    }
    async _reject(id)  { try { await window.Buddy.reject(id); } finally { await this._load(); } }
    async _unfriend(id) {
      if (!confirm("Remove this buddy?")) return;
      try { await window.Buddy.unfriend(id); }
      finally { window.Buddy.invalidate(); await this._load(); }
    }

    // ── Ghost → account linking ─────────────────────────────────────────────
    _toggleLinkPanel(displayName) {
      if (this._linkingGhost === displayName) {
        this._closeLinkPanel();
      } else {
        this._linkingGhost = displayName;
        this._linkQuery = "";
        this._linkResults = [];
        this.render();
        // Focus the link search input once the row is expanded.
        const el = document.getElementById("ghost-link-input");
        if (el) el.focus();
      }
    }

    _closeLinkPanel() {
      this._linkingGhost = null;
      this._linkQuery = "";
      this._linkResults = [];
      this.render();
    }

    async _linkSearchInput(q) {
      this._linkQuery = q;
      clearTimeout(this._linkSearchTimer);
      if (!q) {
        this._linkResults = [];
        this.render();
        return;
      }
      // Debounce keystrokes (mirrors collection-view's search input) and
      // stamp each request with a monotonic token captured before the await
      // so an out-of-order response can't clobber newer results.
      this._linkSearchTimer = setTimeout(async () => {
        const seq = ++this._linkSearchSeq;
        let results;
        try {
          results = await window.Buddy.searchProfiles(q);
        } catch (_) {
          results = [];
        }
        if (seq !== this._linkSearchSeq) return; // stale — a newer search owns state
        this._linkResults = results || [];
        this.render();
      }, 300);
    }

    async _confirmLink(displayName, targetUserId) {
      try {
        const res = await window.Buddy.linkGhost(displayName, targetUserId);
        const n = (res && res.rows_updated) || 0;
        // Don't block on a toast — close the panel and refresh.
        if (n === 0) {
          console.warn("No matching ghost rows found to link.");
        }
      } catch (e) {
        alert(e.message || "Failed to link");
        return;
      } finally {
        this._closeLinkPanel();
      }
      // Reload so the ghost disappears and the played-with people list
      // picks the linked account up. The bundle cache still holds the old
      // ghost row — invalidate first so _load refetches.
      if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
      await this._load();
    }

    async _confirmMerge(sourceDisplayName, targetDisplayName) {
      try {
        const res = await window.Buddy.mergeGhosts(sourceDisplayName, targetDisplayName);
        const n = (res && res.rows_updated) || 0;
        if (n === 0) {
          console.warn("No matching ghost rows found to merge.");
        }
      } catch (e) {
        alert(e.message || "Failed to merge");
        return;
      } finally {
        this._closeLinkPanel();
      }
      // Buddy.allBuddies() caches the ghost list for the play-flow picker
      // — invalidate so the renamed/merged ghost shows up there too.
      if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
      await this._load();
    }
  }

  function totalPages(count) {
    return Math.max(1, Math.ceil(count / PER_PAGE));
  }
  function pageSlice(list, page) {
    const start = (page - 1) * PER_PAGE;
    return list.slice(start, start + PER_PAGE);
  }
  function clampPage(n, count) {
    return Math.min(Math.max(1, n), totalPages(count));
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

  window.BuddiesView = BuddiesView;
})();
