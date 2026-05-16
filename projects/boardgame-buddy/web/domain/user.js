// domain/user.js — Self or other-user profile.
//
// User.current() — fetches /profile (auto-creates row on first login).
// User.fetch(id) — fetches /users/{id}/profile (public; surfaces buddy relation).

(function () {
  class User {
    constructor(raw) {
      Object.assign(this, raw || {});
    }

    static async current() {
      const raw = await window.api.get("/profile");
      const u = new User(raw);
      window.store.set("user", u);
      return u;
    }

    static async fetch(userId) {
      const raw = await window.api.get(`/users/${userId}/profile`);
      return new User(raw);
    }

    async refreshStats() {
      const path = this._isSelf() ? "/users/me/stats" : `/users/${this.id}/stats`;
      const stats = await window.api.get(path);
      this.stats = stats;
      return stats;
    }

    async fetchCollection() {
      // Self is the only path the existing /collection endpoint supports. For
      // "other" users we'd need a public-collection route — wired later.
      if (!this._isSelf()) {
        return { items: [], total: 0 };
      }
      return window.api.get("/collection", { per_page: 50, page: 1 });
    }

    _isSelf() {
      const me = window.store.get("user");
      return me && this.id === me.id;
    }

    initials() {
      const parts = (this.display_name || "").trim().split(/[\s.]+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      return (parts[0] || "?").slice(0, 2).toUpperCase();
    }
  }

  window.User = User;
})();
