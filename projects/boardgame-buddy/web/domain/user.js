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

    /**
     * Permanently delete the signed-in account.
     *
     * DELETE /profile removes the profile row; the schema cascades it to
     * collections, plays, buddy edges and chapters, and leaves community
     * chapters authored by this account with created_by NULL. There is no
     * soft-delete and no undo — the caller MUST confirm first
     * (.claude/rules/web-frontend.md), and must sign out afterwards, because
     * the token in hand still looks valid to the client while pointing at a
     * row that is gone.
     *
     * Same endpoint the native app calls (app/src/api/client.js#deleteAccount),
     * so the two platforms delete exactly the same way.
     */
    static deleteAccount() {
      return window.api.del("/profile");
    }

    static async fetch(userId) {
      const raw = await window.api.get(`/users/${userId}/profile`);
      return new User(raw);
    }

  }

  /**
   * Display-name ceiling, enforced by the two surfaces that let a person type
   * one (the profile editor's avatar customizer and the onboarding deck's
   * first slide). A UI rule only: the column is unbounded text and the API
   * takes any non-empty string, so accounts created before this limit keep
   * their longer names until they edit them, and every read path — badges,
   * scorecards, the feed — still renders whatever is stored.
   */
  User.DISPLAY_NAME_MAX = 12;

  window.User = User;
})();
