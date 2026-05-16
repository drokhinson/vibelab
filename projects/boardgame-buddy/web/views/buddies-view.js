// views/buddies-view.js — accepted buddies, pending requests, profile search.

(function () {
  class BuddiesView extends window.View {
    constructor() {
      super("buddies");
      this._buddies = [];
      this._requests = { incoming: [], outgoing: [] };
      this._search = [];
      this._q = "";
      this._loading = false;
    }

    async onMount() { await this._load(); }

    async _load() {
      this._loading = true;
      this.render();
      try {
        const [buddies, requests] = await Promise.all([
          window.Buddy.list(),
          window.Buddy.requests(),
        ]);
        this._buddies = buddies || [];
        this._requests = requests || { incoming: [], outgoing: [] };
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      this.container.innerHTML = `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="history.back()">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-lg">Buddies</h2>
          <span></span>
        </header>

        <section class="buddies-search">
          <input class="input input-bordered w-full" placeholder="Find people by display name"
                 oninput="window.buddiesView._searchInput(this.value)" value="${escapeAttr(this._q)}" />
          ${this._q
            ? `<ul class="search-list">${this._search.map((u) => `
                <li class="search-hit" onclick="window.router.go('profile-other',{userId:'${u.id}'})">
                  <div class="search-hit__placeholder"><i data-lucide="user"></i></div>
                  <div class="search-hit__body">
                    <div class="search-hit__name">${escape(u.display_name)}</div>
                    ${u.email ? `<div class="search-hit__meta">${escape(u.email)}</div>` : ""}
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
                  <div class="buddies-row__avatar avatar-bubble">${initials(r.other_display_name)}</div>
                  <div class="buddies-row__body">
                    <div class="buddies-row__name">${escape(r.other_display_name)}</div>
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

        <section class="buddies-section">
          <h3>Accepted (${this._buddies.length})</h3>
          ${this._buddies.length === 0
            ? `<p class="text-sm opacity-60 p-3">No buddies yet — search above to add some.</p>`
            : `<ul class="buddies-list">${this._buddies.map((b) => `
                <li class="buddies-row" onclick="window.router.go('profile-other',{userId:'${b.other_user_id}'})">
                  <div class="buddies-row__avatar avatar-bubble">${initials(b.other_display_name)}</div>
                  <div class="buddies-row__body">
                    <div class="buddies-row__name">${escape(b.other_display_name)}</div>
                    <div class="buddies-row__when">${b.accepted_at ? "Buddies since " + formatDate(b.accepted_at) : ""}</div>
                  </div>
                  <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();window.buddiesView._unfriend('${b.id}')">
                    <i data-lucide="user-x" class="w-3.5 h-3.5"></i>
                  </button>
                </li>
              `).join("")}</ul>`}
        </section>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

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
        await this._load();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Try again";
      }
    }

    async _accept(id)  { try { await window.Buddy.accept(id); } finally { await this._load(); } }
    async _reject(id)  { try { await window.Buddy.reject(id); } finally { await this._load(); } }
    async _unfriend(id) {
      if (!confirm("Remove this buddy?")) return;
      try { await window.Buddy.unfriend(id); } finally { await this._load(); }
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
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
