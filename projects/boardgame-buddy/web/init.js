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
        // The bootstrap call's get_current_user dependency handles first-time
        // profile auto-create AND returns the full user row in the response —
        // we don't need a separate /profile fetch first. We do need a uid
        // before bindUser; sess.user.id from Supabase matches the profile id.
        const supaUid = sess.user && sess.user.id;
        if (window.bgbCache && supaUid) {
          window.bgbCache.bindUser(supaUid);
        }
        let me = null;
        let bootstrapped = false;
        if (window.Bootstrap) {
          try {
            const payload = await window.Bootstrap.load();
            bootstrapped = true;
            // Bootstrap._seedStore set window.store('user') to a User instance.
            me = window.store.get("user");
            if (!me && payload && payload.current_user) {
              me = new window.User(payload.current_user);
              window.store.set("user", me);
            }
          } catch (e) {
            console.warn("Bootstrap failed, falling back to /profile:", e);
          }
        }
        if (!bootstrapped) {
          try {
            me = await window.User.current();
          } catch (e) {
            console.error("Failed to load profile:", e);
            window.router.go("auth");
            return;
          }
        }
        // Land where the user requested (deep link) or feed by default.
        // pendingRoute is stashed on boot from window.location.pathname so a
        // hard refresh on /play/{code}, /game/{id}, etc. resumes there
        // instead of dropping back to the feed.
        const currentView = window.store.get("currentView");
        if (currentView === "splash" || currentView === "auth") {
          const pending = window.store.get("pendingRoute");
          window.store.set("pendingRoute", null);
          if (pending && pending.name && pending.name !== "auth" && pending.name !== "splash") {
            window.router.go(pending.name, pending.params || {});
          } else {
            window.router.go("feed");
          }
        }
        // First-time onboarding: a brand-new profile carries needs_setup=true
        // (migration 030, set by the dependency-side auto-create). Prompt the
        // user to pick their display name + badge before they start using the
        // app. Dismissing without saving leaves the flag set so the modal
        // returns on next load.
        if (me && me.needs_setup) {
          maybePromptFirstTimeSetup(me);
        }
      } else {
        window.store.set("user", null);
        window.router.go("auth");
      }
    });
  }

  async function maybePromptFirstTimeSetup(me) {
    // The auto-created display name is the email local-part — usable but not
    // personal. Seed the input with it so the user can keep it or rewrite.
    const picked = await window.PolaroidPopup.avatarCustomizer({
      headerTitle: "Create your profile",
      includeNameField: true,
      saveLabel: "Get started",
      current: me.avatar || null,
      displayName: me.display_name,
    });
    if (!picked) return; // Dismissed; modal returns next load (needs_setup still true).
    try {
      const updated = await window.api.post("/profile", {
        display_name: picked.displayName,
        avatar: {
          icon: picked.icon,
          iconColor: picked.iconColor,
          bgColor: picked.bgColor,
        },
      });
      window.store.set("user", new window.User({ ...me, ...updated }));
    } catch (e) {
      window.PolaroidPopup.alert({
        title: "Couldn't save your profile",
        body: (e && e.message) ? String(e.message) : "Please try again from Settings.",
      });
    }
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
    // Single render path: always BgbBadge. Signed-out / logged-out state uses
    // the default brown+gold badge with "?" initials; signed-in uses the user's
    // chosen avatar with isMe=true so the gold rim appears on the header.
    const html = window.BgbBadge.render({
      avatar: user ? user.avatar : null,
      displayName: user ? user.display_name : "",
      initials: user ? null : "?",
      size: "sm",
      isMe: !!user,
      extraClass: "bgb-global-header__badge",
    }).replace("<span ", '<span id="bgb-global-avatar" ');
    el.outerHTML = html;
  }
  window.store.subscribe("user", syncGlobalAvatar);

  // Logout helper — referenced by ProfileSelfView.
  window.handleLogout = async function () {
    if (window.supabaseClient) {
      try { await window.supabaseClient.auth.signOut(); } catch (_) {}
    }
    window.session = null;
    // Wipe persisted cache for this user BEFORE store.reset() so the unbind
    // sees the still-bound uid.
    if (window.bgbCache) window.bgbCache.unbindUser();
    window.store.reset();
    window.router.go("auth");
  };

  // Chunked refresh on tab focus: when the user returns to the tab after a
  // gap, fire a lightweight SWR-aware refresh of the data most likely to be
  // stale (feed / stats / collection). swr() no-ops if entries are still
  // inside their fresh window so this is cheap to call freely. Debounced so
  // OS focus-flapping doesn't fan out into a refresh storm.
  let _lastFocusRefresh = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!window.store.get("user")) return;
    const now = Date.now();
    if (now - _lastFocusRefresh < 5000) return;
    _lastFocusRefresh = now;
    if (window.Bootstrap && window.Bootstrap.warmRefresh) {
      window.Bootstrap.warmRefresh().catch(() => {});
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    // Restore a previously-active play session, if any.
    const ps = window.PlaySession.load();
    if (ps && ps.isActive()) {
      window.store.set("activePlay", ps);
    }

    // Resolve the initial URL → route so a deep-link / refresh on
    // /play/{code}, /game/{id}, /profile/collection, etc. resumes there
    // after auth. Querystring values are merged onto params by the route
    // table; we also pull anything not consumed by the path template here.
    const initialMatch = window.router.matchPath(window.location.pathname);
    if (initialMatch) {
      try {
        const qs = new URLSearchParams(window.location.search);
        for (const [k, v] of qs.entries()) {
          if (initialMatch.params[k] == null) initialMatch.params[k] = v;
        }
      } catch (_) {}
      window.store.set("pendingRoute", initialMatch);
    }

    // First paint = splash. initSupabase() flips us forward to either
    // the pending deep-link route or the feed. skipPush keeps the original
    // URL in the bar (and out of the back-stack) until auth resolves.
    window.router.go("splash", {}, { skipPush: true });
    wireBottomNav();
    initSupabase();

    if (window.api) window.api.trackEvent("page_view");
  });
})();
