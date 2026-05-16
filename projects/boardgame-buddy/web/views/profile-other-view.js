// views/profile-other-view.js — public view of another user's profile.

(function () {
  class ProfileOtherView extends window.View {
    constructor() {
      super("profile-other");
      this._profile = null;
      this._stats = null;
      this._error = null;
    }

    async onMount() { await this._load(); }

    async onParamsChange() { await this._load(); }

    async _load() {
      const userId = this.params && this.params.userId;
      if (!userId) {
        this._error = "No user specified";
        this.render();
        return;
      }
      try {
        const [profile, stats] = await Promise.all([
          window.User.fetch(userId),
          window.Stats.for(userId),
        ]);
        this._profile = profile;
        this._stats = stats;
      } catch (e) {
        this._error = e.message || "Failed to load profile";
      } finally {
        this.render();
      }
    }

    render() {
      if (this._error) {
        this.container.innerHTML = `
          <div class="p-6">
            <button class="btn btn-ghost btn-sm mb-3" onclick="history.back()">
              <i data-lucide="arrow-left" class="w-4 h-4"></i> Back
            </button>
            <div class="alert alert-error">${escape(this._error)}</div>
          </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      if (!this._profile) {
        this.container.innerHTML = `<div class="p-6 text-center opacity-60">Loading…</div>`;
        return;
      }
      const p = this._profile;
      const s = this._stats ? window.Stats.format(this._stats) : null;
      this.container.innerHTML = `
        <header class="profile-other__top">
          <button class="btn btn-ghost btn-sm" onclick="history.back()">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
        </header>
        <section class="profile-header">
          <div class="profile-header__avatar avatar-bubble avatar-bubble--lg">${new window.User(p).initials()}</div>
          <h2 class="profile-header__name font-display">${escape(p.display_name)}</h2>
          <p class="profile-header__since">Buddy since ${formatDate(p.created_at)}</p>
          <div class="profile-header__actions">
            ${this._renderRelationButton(p)}
          </div>
        </section>
        <section class="profile-stats">
          ${s ? `
            <div class="profile-stats__grid">
              <div class="profile-stat"><div class="profile-stat__value">${s.plays}</div><div class="profile-stat__label">Plays</div></div>
              <div class="profile-stat"><div class="profile-stat__value">${s.games}</div><div class="profile-stat__label">Games</div></div>
              <div class="profile-stat"><div class="profile-stat__value">${s.wins}</div><div class="profile-stat__label">Wins</div></div>
              <div class="profile-stat"><div class="profile-stat__value">${s.hours}</div><div class="profile-stat__label">Hours</div></div>
            </div>` : "<div class='text-sm opacity-60'>Loading…</div>"}
        </section>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    _renderRelationButton(p) {
      if (p.is_buddy) {
        return `<button class="btn btn-sm btn-ghost" disabled><i data-lucide="check" class="w-4 h-4"></i> Buddies</button>`;
      }
      if (p.has_pending_request) {
        if (p.pending_request_direction === "incoming") {
          return `<button class="btn btn-sm btn-primary" onclick="window.profileOtherView._accept('${p.id}')"><i data-lucide="user-check" class="w-4 h-4"></i> Accept request</button>`;
        }
        return `<button class="btn btn-sm btn-ghost" disabled><i data-lucide="clock" class="w-4 h-4"></i> Request sent</button>`;
      }
      return `<button class="btn btn-sm btn-primary" onclick="window.profileOtherView._addBuddy('${p.id}')"><i data-lucide="user-plus" class="w-4 h-4"></i> Add buddy</button>`;
    }

    async _addBuddy(userId) {
      try { await window.Buddy.sendRequest(userId); } catch (_) {}
      await this._load();
    }

    async _accept(otherUserId) {
      try {
        const requests = await window.Buddy.requests();
        const inc = (requests.incoming || []).find((r) => r.other_user_id === otherUserId);
        if (inc) await window.Buddy.accept(inc.id);
      } catch (_) {}
      await this._load();
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  window.ProfileOtherView = ProfileOtherView;
})();
