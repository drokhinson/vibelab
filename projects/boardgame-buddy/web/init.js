// init.js — boot the new OOP shell.
//
// Loads ahead of anything else once the DOM is ready:
//   1. Construct singleton views and register them with the router.
//   2. Initialize Supabase and route to splash / auth / feed based on
//      session state.
//   3. Wire bottom-nav clicks.
//   4. Restore an in-progress PlaySession from localStorage.

(function () {
  // Hoist instances onto window so view onclick handlers can find them.
  window.splashView      = new window.SplashView();
  window.authView        = new window.AuthView();
  window.feedView        = new window.FeedView();
  window.logPlayView     = new window.LogPlayView();
  window.gameSearchView  = new window.GameSearchView();
  window.gameDetailView  = new window.GameDetailView();
  window.profileSelfView = new window.ProfileSelfView();
  window.profileOtherView = new window.ProfileOtherView();
  window.buddiesView     = new window.BuddiesView();
  window.adminView       = new window.AdminView();

  window.router.register("splash",        window.splashView);
  window.router.register("auth",          window.authView);
  window.router.register("feed",          window.feedView);
  window.router.register("log-play",      window.logPlayView);
  window.router.register("game-search",   window.gameSearchView);
  window.router.register("game-detail",   window.gameDetailView);
  window.router.register("profile-self",  window.profileSelfView);
  window.router.register("profile-other", window.profileOtherView);
  window.router.register("buddies",       window.buddiesView);
  window.router.register("admin",         window.adminView);

  // Supabase boot. We model this as a global helper (used by views directly)
  // because Supabase's auth state listener fires async outside the view
  // lifecycle.
  function initSupabase() {
    const cfg = window.APP_CONFIG;
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      console.error("Supabase config missing");
      window.router.go("auth");
      return;
    }
    window.supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    window.supabaseClient.auth.onAuthStateChange(async (event, sess) => {
      window.session = sess;
      window.store.set("session", sess);
      if (sess) {
        try {
          await window.User.current();
        } catch (e) {
          console.error("Failed to load profile:", e);
          window.router.go("auth");
          return;
        }
        // Land on the feed after sign-in
        if (window.store.get("currentView") === "splash" ||
            window.store.get("currentView") === "auth") {
          window.router.go("feed");
        }
      } else {
        window.store.set("user", null);
        window.router.go("auth");
      }
    });
  }

  // Bottom nav: Feed | Log | Profile.
  function wireBottomNav() {
    document.querySelectorAll(".btm-nav button[data-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.nav;
        if (!window.store.get("user")) return;
        window.router.go(target);
      });
    });
  }

  // Logout helper — referenced by ProfileSelfView.
  window.handleLogout = async function () {
    if (window.supabaseClient) {
      try { await window.supabaseClient.auth.signOut(); } catch (_) {}
    }
    window.session = null;
    window.store.reset();
    window.router.go("auth");
  };

  document.addEventListener("DOMContentLoaded", () => {
    // Restore a previously-active play session, if any.
    const ps = window.PlaySession.load();
    if (ps && ps.isActive()) {
      window.store.set("activePlay", ps);
    }

    // First paint = splash. initSupabase() flips us forward.
    window.router.go("splash");
    wireBottomNav();
    initSupabase();

    if (window.api) window.api.trackEvent("page_view");
  });
})();
