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
     * DELETE /profile removes three things in a fixed order, and the server
     * owns all of it (api/routes/services/account_deletion_service.py): the
     * play photos out of both object stores, then the profile row — which
     * the schema cascades to collections, plays, buddy edges and the rest,
     * leaving community chapters authored by this account with created_by
     * NULL — and then THE IDENTITY PLATFORM ACCOUNT ITSELF.
     *
     * That last step is why this is not a client-side
     * `firebase.auth().currentUser.delete()`. The SDK refuses one on a
     * session older than a few minutes (`auth/requires-recent-login`), so
     * every deletion would have to detour through a re-authentication; the
     * server holds a service-account credential that has no such condition.
     * It also means the browser is never the thing that decides the account
     * is gone.
     *
     * There is no soft-delete and no undo — the caller MUST confirm first
     * (.claude/rules/web-frontend.md), and must sign out afterwards, because
     * the token in hand still verifies for up to an hour (it is checked
     * against Google's JWKS, not against the account existing) while pointing
     * at rows that are gone.
     *
     * ON FAILURE, STAY SIGNED IN. A 503 means nothing was deleted; a 500
     * means part of it was. Every step is idempotent, so the same call
     * retried finishes the job — but only while the caller still holds a
     * token, which signing out would throw away.
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
