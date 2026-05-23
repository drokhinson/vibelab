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
  window.playFlowView    = new window.PlayFlowView();
  window.joinSessionView = new window.JoinSessionView();
  window.gameDetailView  = new window.GameDetailView();
  window.referenceGuideAddView = new window.ReferenceGuideAddView();
  window.profileSelfView = new window.ProfileSelfView();
  window.profileOtherView = new window.ProfileOtherView();
  window.collectionView  = new window.CollectionView();
  window.wishlistView    = new window.WishlistView();
  window.playsView       = new window.PlaysView();
  window.sessionViewerView = new window.SessionViewerView();
  window.buddiesView     = new window.BuddiesView();
  window.settingsView    = new window.SettingsView();
  window.adminView       = new window.AdminView();

  window.router.register("splash",        window.splashView);
  window.router.register("auth",          window.authView);
  window.router.register("feed",          window.feedView);
  window.router.register("log-play",      window.logPlayView);
  window.router.register("play-flow",     window.playFlowView);
  window.router.register("join-session",  window.joinSessionView);
  window.router.register("game-detail",   window.gameDetailView);
  window.router.register("reference-guide-add", window.referenceGuideAddView);
  window.router.register("profile-self",  window.profileSelfView);
  window.router.register("profile-other", window.profileOtherView);
  window.router.register("collection",    window.collectionView);
  window.router.register("wishlist",      window.wishlistView);
  window.router.register("plays",         window.playsView);
  window.router.register("session-viewer", window.sessionViewerView);
  window.router.register("buddies",       window.buddiesView);
  window.router.register("settings",      window.settingsView);
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

  // Bottom nav: Feed | Play | Profile (floating bar + raised Create).
  function wireBottomNav() {
    document.querySelectorAll(".bgb-nav button[data-nav], .btm-nav button[data-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.nav;
        if (!window.store.get("user")) return;
        window.router.go(target);
      });
    });
  }

  // Keep the global header's avatar in sync with the current user's
  // customization. Lives at this level (not in a View) because the
  // header persists across every screen.
  function syncGlobalAvatar(user) {
    const el = document.getElementById("bgb-global-avatar");
    if (!el) return;
    if (!user) {
      el.textContent = "?";
      el.removeAttribute("style");
      el.className = "avatar-bubble avatar-bubble--me";
      return;
    }
    el.outerHTML = window.BgbBadge.render({
      avatar: user.avatar,
      displayName: user.display_name,
      size: "sm",
      isMe: true,
      extraClass: "bgb-global-header__badge",
    }).replace("<span ", '<span id="bgb-global-avatar" ');
  }
  window.store.subscribe("user", syncGlobalAvatar);

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
