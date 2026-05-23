// views/plays-view.js — Full recent-plays spoke with grouped headers.
//
// Renders the full play history grouped into "This week / Last week /
// Earlier" buckets computed client-side from played_at. No FAB — plays
// are logged from the bottom-nav Play CTA.

(function () {
  const PER_PAGE = 20;

  class PlaysView extends window.View {
    constructor() {
      super("plays");
      this._plays = [];
      this._total = 0;
      this._page = 1;
      this._loading = false;
      this._loaded = false;
      this._error = null;
      this._query = "";
      this._searchTimer = null;
      this._statusMap = {};
    }

    async onMount() {
      this.listen("user", () => this.render());
      const seed = window.store.get("profileBundle");
      if (seed) {
        this._plays = seed.recent_plays || [];
        this._total = seed.recent_plays_total || 0;
        this._statusMap = seed.status_map || {};
        this._loaded = true;
      } else {
        this._loading = true;
      }
      this.render();
      await this._load({ reset: true });
    }

    renderLoading() {
      this.container.innerHTML = `
        ${this._renderHead()}
        <div class="p-4 grid place-items-center">${window.buddyLoader({ size: 64 })}</div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    render() {
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;

      this.container.innerHTML = `
        ${this._renderHead()}
        ${this._renderSearch()}
        ${this._renderBody()}
        ${this._renderLoadMore()}
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
          <h2 class="spoke-head__title font-display">Recent plays</h2>
          <span class="spoke-head__count">${this._total} total</span>
        </header>
      `;
    }

    _renderSearch() {
      return `
        <div class="profile-panel__controls">
          <input id="plays-search-input"
                 class="input input-bordered input-sm flex-1 min-w-0"
                 placeholder="Search by game or player name"
                 autocomplete="off"
                 value="${escapeAttr(this._query)}"
                 oninput="window.playsView._onSearchInput(this.value)" />
          <button class="btn btn-ghost btn-sm" title="Refresh"
                  ${this._loading ? "disabled" : ""}
                  onclick="window.playsView._load({reset:true})">
            <i data-lucide="refresh-cw" class="w-4 h-4 ${this._loading ? "animate-spin" : ""}"></i>
          </button>
        </div>
      `;
    }

    _renderBody() {
      if (this._error) {
        return `<div class="text-error text-sm">${escape(this._error)}</div>`;
      }
      if (!this._loaded) {
        return window.buddyLoader({ size: 88 });
      }
      if (this._plays.length === 0) {
        return `<div class="profile-empty">${this._query ? "No matches." : "No plays logged yet."}</div>`;
      }
      const groups = groupPlays(this._plays);
      return groups.map((grp) => `
        <h3 class="plays-day-divider font-display">${escape(grp.label)}</h3>
        <ul class="plays-list">
          ${grp.items.map((p) => this._renderRow(p)).join("")}
        </ul>
      `).join("");
    }

    _renderRow(p) {
      const me = window.store.get("user");
      const winners = (p.players || []).filter((pl) => pl.is_winner);
      const winnerLabel = winners.map((w) => escape(w.name)).join(", ");
      const playerCount = (p.players || []).length;
      const youWon = winners.some((w) =>
        (w.user_id && me && w.user_id === me.id) ||
        (me && (w.name || "") === (me.display_name || ""))
      );
      const subParts = [];
      if (winnerLabel) subParts.push(`<span class="plays-list__winner"><i data-lucide="trophy" class="w-3 h-3"></i> ${winnerLabel}</span>`);
      if (playerCount > 0) subParts.push(`${playerCount} ${playerCount === 1 ? "player" : "players"}`);
      const gameNav = `event.stopPropagation();window.router.go('game-detail',{gameId:'${p.game_id}',gameName:'${jsStr(p.game_name || "")}'})`;
      const statusOverlay = p.game_id
        ? `<span class="plays-list__status">${window.renderStatusTag(p.game_id, (this._statusMap || {})[p.game_id] || null, { compact: true })}</span>`
        : "";
      return `
        <li class="plays-list__row" data-play-id="${p.id}"
            onclick="window.PlayDetailPopup.show('${p.id}')">
          <div class="plays-list__thumb">
            ${p.game_thumbnail
              ? `<img src="${escapeAttr(p.game_thumbnail)}" alt="" onclick="${gameNav}" />`
              : `<div class="plays-list__placeholder"><i data-lucide="dice-6"></i></div>`}
            ${statusOverlay}
          </div>
          <div class="plays-list__body">
            <div class="plays-list__top">
              <div class="plays-list__game">
                ${escape(p.game_name)}
                ${youWon ? `<span class="plays-list__won-tag"><i data-lucide="trophy" class="w-3 h-3"></i> Won</span>` : ""}
              </div>
              <div class="plays-list__date">${formatDate(p.played_at)}</div>
            </div>
            ${subParts.length ? `<div class="plays-list__sub">${subParts.join(" · ")}</div>` : ""}
          </div>
        </li>
      `;
    }

    _renderLoadMore() {
      const hasMore = this._plays.length < this._total;
      if (!hasMore) return "";
      return `
        <div class="text-center mt-3">
          <button class="btn btn-ghost btn-xs" ${this._loading ? "disabled" : ""}
                  onclick="window.playsView._loadMore()">
            ${this._loading ? "Loading…" : "Load more"}
          </button>
        </div>
      `;
    }

    async _load({ reset = false } = {}) {
      this._loading = true;
      this._error = null;
      if (reset) { this._page = 1; this._plays = []; }
      this.render();
      try {
        const data = await window.Play.list({
          page: this._page,
          perPage: PER_PAGE,
          search: this._query || null,
        });
        const fresh = (data && data.plays) || [];
        this._total = (data && data.total) || 0;
        this._plays = reset ? fresh : [...this._plays, ...fresh];
      } catch (e) {
        this._error = e.message || "Failed to load";
      } finally {
        this._loading = false;
        this._loaded = true;
        this.render();
      }
    }

    _loadMore() { this._page += 1; this._load({ reset: false }); }

    _onSearchInput(value) {
      this._query = value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._load({ reset: true }), 300);
    }
  }

  // Group plays into This week / Last week / Earlier based on played_at,
  // using Monday as the week boundary. Plays with no date land in Earlier.
  function groupPlays(plays) {
    const monday = mondayOf(new Date());
    const lastMonday = new Date(monday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const buckets = { thisWeek: [], lastWeek: [], earlier: [] };
    for (const p of plays) {
      const d = p.played_at ? new Date(p.played_at) : null;
      if (!d || Number.isNaN(d.getTime())) { buckets.earlier.push(p); continue; }
      if (d >= monday) buckets.thisWeek.push(p);
      else if (d >= lastMonday) buckets.lastWeek.push(p);
      else buckets.earlier.push(p);
    }
    const out = [];
    if (buckets.thisWeek.length) out.push({ label: "This week", items: buckets.thisWeek });
    if (buckets.lastWeek.length) out.push({ label: "Last week", items: buckets.lastWeek });
    if (buckets.earlier.length)  out.push({ label: "Earlier",   items: buckets.earlier });
    return out;
  }
  function mondayOf(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    const day = x.getDay();        // 0=Sun … 6=Sat
    const offset = (day + 6) % 7;  // Mon=0
    x.setDate(x.getDate() - offset);
    return x;
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.PlaysView = PlaysView;
})();
