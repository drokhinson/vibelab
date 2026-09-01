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
  window.gameExplorerView = new window.GameExplorerView();
  window.addGamesView = new window.AddGamesView();
  window.gameDetailView  = new window.GameDetailView();
  window.referenceGuideAddView = new window.ReferenceGuideAddView();
  window.profileSelfView = new window.ProfileSelfView();
  window.profileOtherView = new window.ProfileOtherView();
  window.collectionView  = new window.CollectionView();
  window.playsView       = new window.PlaysView();
  window.sessionViewerView = new window.SessionViewerView();
  window.buddiesView     = new window.BuddiesView();
  window.statsView       = new window.StatsView();
  window.achievementsView = new window.AchievementsView();
  window.settingsView    = new window.SettingsView();
  window.adminView       = new window.AdminView();

  // Widget singleton — the Play tab's Join half. Hoisted here (rather than
  // owned by LogPlayView) so its inline onclick handlers resolve the same way
  // every view instance does.
  window.joinPanel       = new window.JoinPanel();

  window.router.register("splash",        window.splashView);
  window.router.register("auth",          window.authView);
  window.router.register("feed",          window.feedView);
  window.router.register("log-play",      window.logPlayView);
  window.router.register("play-flow",     window.playFlowView);
  window.router.register("game-explorer", window.gameExplorerView);
  window.router.register("add-games",     window.addGamesView);
  window.router.register("game-detail",   window.gameDetailView);
  window.router.register("reference-guide-add", window.referenceGuideAddView);
  window.router.register("profile-self",  window.profileSelfView);
  window.router.register("profile-other", window.profileOtherView);
  window.router.register("collection",    window.collectionView);
  window.router.register("plays",         window.playsView);
  window.router.register("session-viewer", window.sessionViewerView);
  window.router.register("buddies",       window.buddiesView);
  window.router.register("stats",         window.statsView);
  window.router.register("achievements",  window.achievementsView);
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

      // Only a real sign-out (or a genuinely absent session) sends the user to
      // the auth screen. We must NOT treat a transient null — e.g. a refresh
      // hiccup while the phone wakes — as a logout, or a mid-session host gets
      // bounced out.
      if (event === "SIGNED_OUT" || !sess) {
        // Offline, supabase-js can reach the same conclusion for the wrong
        // reason: it tries to refresh an expired access token, cannot reach
        // the auth server, and gives up. Bouncing to /auth there strands a
        // host mid-game on a screen they physically cannot complete, and
        // takes their draft's view with it. Hold the last known session
        // instead and let the offline banner explain the state; connectivity
        // returning re-runs this callback with a real answer either way.
        // Same rule as the 401 self-heal in domain/api.js — a blip is not a
        // state change (.claude/rules/web-frontend.md).
        if (_offlineWithKnownUser()) return;
        _bootRouted = false;
        _profileLoaded = false;
        window.store.set("user", null);
        window.router.go("auth");
        return;
      }

      const supaUid = sess.user && sess.user.id;
      if (window.bgbCache && supaUid) {
        // Synchronously rehydrates this user's persisted cache into memory.
        window.bgbCache.bindUser(supaUid);
      }

      // Optimistic boot. The cache we just rehydrated already holds the last
      // known profile, feed page, collection map and host-flow seeds — enough
      // to put the user on their screen with zero network wait. /bootstrap
      // still runs below and reconciles everything in the background.
      const cachedMe = (supaUid && window.bgbCache) ? window.bgbCache.get("me", supaUid) : null;
      if (!_bootRouted && cachedMe && window.User) {
        window.store.set("user", new window.User(cachedMe));
        routeAfterBoot();
      }

      // A plain background token refresh, once we've already landed AND have a
      // live profile, needs nothing beyond the updated token above — don't
      // re-bootstrap (a failed refetch here used to bounce an active session).
      // Gated on _profileLoaded rather than store.get('user'), which is now
      // set optimistically from cache and no longer proves we reached the
      // server this session.
      if (event === "TOKEN_REFRESHED" && _profileLoaded && _bootRouted) {
        return;
      }

      // Load the profile (bootstrap warms caches + returns the user row). On a
      // resume this is the first authed call after a reload; if it fails we
      // distinguish "auth is bad" from "network is flaky" so we never show a
      // login screen for a session that is actually valid.
      const profileLoad = loadProfileResilient();
      if (_bootRouted) {
        // Already painted from cache — reconcile without blocking anything.
        profileLoad
          .then(handleProfileOutcome)
          .catch((e) => console.warn("Background profile load failed:", e));
        return;
      }
      const me = await profileLoad;
      handleProfileOutcome(me);
      // A valid session must never be stranded on the splash, so we route
      // regardless of the profile outcome — the resumed view's own
      // (token-valid) calls work even while the profile catches up. The one
      // exception is a genuinely bad token, which handleProfileOutcome has
      // already redirected to /auth.
      if (me !== AUTH_FAILED) routeAfterBoot();
    });
  }

  // Whether a sign-out signal should be disbelieved: we're offline AND we have
  // a cached identity to keep painting from. Requires _bootRouted so this only
  // ever protects a session that already got somewhere — a cold boot with no
  // connectivity and no landed session still belongs on /auth, which at least
  // says why nothing works.
  //
  // Deliberately NOT applied to an explicit handleLogout(): that path clears
  // the cache and calls router.go("auth") itself rather than relying on the
  // SIGNED_OUT event, so a user tapping Log out offline still logs out.
  function _offlineWithKnownUser() {
    if (!_bootRouted) return false;
    if (!window.BgbNet || !window.BgbNet.isOffline()) return false;
    return !!window.store.get("user");
  }

  // How long the splash is allowed to be the whole app.
  //
  // Everything that moves us off it is asynchronous and off-device: Supabase
  // reading (and often refreshing) the stored session, then /bootstrap. Both
  // can stall rather than fail — the first launch of the installed PWA on iOS
  // is where this actually bites — and the splash has no bottom nav, so a
  // stall there leaves the user with a loader and nothing to tap. api.js now
  // puts a deadline on our own calls; this covers the leg we don't own
  // (supabase-js does its own fetching) and any future one.
  const BOOT_WATCHDOG_MS = 12000;

  // Fall forward off the splash rather than sit on it.
  //
  // With a session in hand we route exactly as a normal boot would: the
  // destination view paints its own skeleton, the nav is there, and the
  // still-in-flight /bootstrap reconciles whenever it lands. With nothing in
  // hand there is no honest answer but the auth screen — it is at least
  // interactive, it carries the offline banner, and it is not a dead end: this
  // path never sets _bootRouted, so an auth callback arriving late still
  // routes the user forward on its own.
  function bootWatchdog() {
    if (_bootRouted) return;
    if (window.store.get("currentView") !== "splash") return;
    if (window.session) {
      console.warn("Boot watchdog: session in hand but never routed — going anyway.");
      routeAfterBoot();
      return;
    }
    console.warn("Boot watchdog: auth never resolved — falling back to /auth.");
    window.router.go("auth");
  }

  // How long first-run setup waits for an add-by-QR flow to finish.
  //
  // Same posture as BOOT_WATCHDOG_MS above — fall forward rather than sit. The
  // QR flow can fail to START (a throw inside buddies-view's mount, a
  // load-order regression on BuddyQrSheet) and it can fail to END: router.go()
  // toggles `.hidden` on [data-view] containers and does NOT close a
  // body-level overlay, so tapping the bottom nav mid-scan orphans the sheet
  // over the Feed and its onClose never fires. Without an absolute deadline any
  // of those strands first-run setup for the whole launch. 45s is long enough
  // for a real scan — open the camera, aim, redeem, read the result — and short
  // enough that a stranded gate heals inside one session.
  const QR_HOLD_MS = 45000;

  // First-run setup yields to an add-by-QR arrival, because that exchange is
  // happening live between two people standing together and must not be
  // interrupted by a modal. The hold is STATE, not an event: on the optimistic
  // boot path routeAfterBoot() runs before handleProfileOutcome arrives (it is
  // behind a /bootstrap round trip), so a user who taps Done in four seconds
  // would fire an event into a document with no listener yet and lose setup for
  // the whole launch. A flag interrogated at call time cannot lose that race.
  let _qrHold = false;
  let _qrHoldTimer = null;
  let _pendingFirstRun = null;

  // Idempotent: safe from the sheet's onClose, the deadline, or both.
  function releaseQrHold() {
    if (!_qrHold) return;
    _qrHold = false;
    if (_qrHoldTimer) { clearTimeout(_qrHoldTimer); _qrHoldTimer = null; }
    const run = _pendingFirstRun;
    _pendingFirstRun = null;
    // Let the sheet's close animation finish before the modal lands on top of
    // it — the .is-closing node lingers for CLOSE_MS (ui/bottom-sheet.js).
    if (run) setTimeout(run, 250);
  }
  // Named global rather than a CustomEvent: this is a point-to-point handoff
  // between two known parties, not a broadcast, and it stays greppable.
  window.bgbQrFlowEnded = releaseQrHold;

  // Boot navigation happens exactly once per signed-in session. Supabase fires
  // onAuthStateChange more than once at boot (INITIAL_SESSION, then often
  // TOKEN_REFRESHED) and each invocation is an un-serialized async function, so
  // without this latch a second invocation resolves seconds later — after the
  // user has already tapped into the host flow — and yanks them back to the
  // feed mid-typing. Cleared on sign-out so the next login routes again.
  let _bootRouted = false;
  // Whether a /bootstrap has actually reached the server this session. Distinct
  // from _bootRouted, which can be true off nothing but the persisted cache.
  let _profileLoaded = false;

  // Land where the user requested (deep link) or the feed by default.
  // pendingRoute is stashed on boot from window.location.pathname so a hard
  // refresh on /play/{code}, /game/{id}, etc. resumes there instead of dropping
  // back to the feed.
  function routeAfterBoot() {
    if (_bootRouted) return;
    _bootRouted = true;
    const pending = window.store.get("pendingRoute");
    window.store.set("pendingRoute", null);
    if (pending && pending.name && pending.name !== "auth" && pending.name !== "splash") {
      window.router.go(pending.name, pending.params || {});
    } else {
      window.router.go("feed");
    }
    warmGameBundlesWhenIdle();
    warmOwnedShelfWhenIdle();
  }

  // The per-owned-game detail bundles are no longer part of /bootstrap (they're
  // an N+1 in SQL and nothing on the first screen reads them). Pull them once
  // the user is looking at something, so opening a game is still instant.
  function warmGameBundlesWhenIdle() {
    if (!window.Bootstrap || !window.Bootstrap.warmGameBundles) return;
    const kick = () => window.Bootstrap.warmGameBundles().catch(() => {});
    if (window.requestIdleCallback) window.requestIdleCallback(kick, { timeout: 3000 });
    else setTimeout(kick, 0);
  }

  // The Collection spoke pages entirely off one cached shelf, so warming it
  // here makes even the session's FIRST visit zero-network. Rides the same
  // idle slot as the game bundles; no-ops inside the cache's fresh window.
  function warmOwnedShelfWhenIdle() {
    if (!window.Collection || !window.Collection.shelf) return;
    const kick = () => {
      const me = window.store.get("user");
      if (!me || !me.id) return;
      window.Collection.shelf(me.id, "owned").catch(() => {});
    };
    if (window.requestIdleCallback) window.requestIdleCallback(kick, { timeout: 5000 });
    else setTimeout(kick, 0);
  }

  // Apply a loadProfileResilient() result. Runs either awaited (cold boot) or
  // off a .then() (optimistic boot), so it must not assume it's on the boot
  // path — routing is routeAfterBoot's job, not this function's.
  function handleProfileOutcome(me) {
    if (me === AUTH_FAILED) {
      _bootRouted = false;
      _profileLoaded = false;
      window.store.set("user", null);
      window.router.go("auth");
      return;
    }
    // Valid session but the profile couldn't load yet (flaky network on wake).
    // Recover it in the background so the header/profile fill in once
    // connectivity returns.
    if (me === LOAD_DEFERRED) {
      retryProfileInBackground();
      return;
    }
    _profileLoaded = true;
    // We have a live server AND a valid token — the only moment where a queued
    // offline play is certain to be pushable. Fire-and-forget: the user is
    // already on their screen and a drain must never gate it.
    if (window.Outbox) window.Outbox.flush();
    // First-time onboarding: a brand-new profile carries needs_setup=true
    // (migration 030, set by the dependency-side auto-create). Prompt the user
    // to pick their display name + badge before they start using the app.
    // Dismissing without saving leaves the flag set so the modal returns on
    // next load.
    if (me && me.needs_setup) {
      // Park it if a QR arrival owns the screen; releaseQrHold() runs it when
      // the sheet closes (or when the deadline gives up on it).
      const run = () => maybePromptFirstTimeSetup(me);
      if (_qrHold) _pendingFirstRun = run;
      else run();
    }
  }

  // Sentinels distinguishing the loadProfileResilient outcomes from a real User.
  const AUTH_FAILED = Symbol("auth-failed");   // token rejected — sign out
  const LOAD_DEFERRED = Symbol("load-deferred"); // transient — keep the session

  // Fetch the current user via bootstrap (fallback /profile), retrying a few
  // times on transient (network / 5xx) errors. Returns the User on success,
  // AUTH_FAILED on a 401/403 (the token is genuinely bad), or LOAD_DEFERRED when
  // we have a valid session but couldn't reach the server yet.
  async function loadProfileResilient() {
    const delays = [400, 1200];
    for (let attempt = 0; ; attempt++) {
      try {
        if (window.Bootstrap) {
          const payload = await window.Bootstrap.load();
          // Bootstrap._seedStore set window.store('user') to a User instance.
          let me = window.store.get("user");
          if (!me && payload && payload.current_user) {
            me = new window.User(payload.current_user);
            window.store.set("user", me);
          }
          return me || LOAD_DEFERRED;
        }
        const me = await window.User.current();
        window.store.set("user", me);
        return me;
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) return AUTH_FAILED;
        if (attempt >= delays.length) {
          console.warn("Profile load failed (transient); keeping session:", e);
          // A cached user may already be in the store from the optimistic
          // boot — leave it there. We still report DEFERRED, because what the
          // caller needs to know is that this attempt never reached the
          // server, so a background retry gets scheduled.
          return LOAD_DEFERRED;
        }
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  // Background profile recovery after a deferred load (valid session, server
  // unreachable on wake). Spaced retries that stop as soon as a live profile
  // lands and the screens bound to it repaint. The exit condition is
  // _profileLoaded, not store.get('user'): the optimistic boot
  // fills the store from cache, so a user being present proves nothing about
  // whether we've reached the server.
  let _profileRecovering = false;
  async function retryProfileInBackground() {
    if (_profileRecovering) return;
    _profileRecovering = true;
    try {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        if (_profileLoaded) return;
        const me = await loadProfileResilient();
        // LOAD_DEFERRED means "still unreachable" — keep looping. Anything
        // else is terminal, and handleProfileOutcome applies it. (It can't
        // recurse back into here: _profileRecovering is still true.)
        if (me !== LOAD_DEFERRED) {
          handleProfileOutcome(me);
          return;
        }
      }
    } finally {
      _profileRecovering = false;
    }
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
      // Setup didn't complete, so don't move them on to the later steps — the
      // whole modal returns on the next load (needs_setup is still true).
      return;
    }
    await promptAddBuddies();
    await promptLinkBgg();
  }

  // Step two of first-time setup: offer a few people to add, multi-select,
  // one batch of requests or skip. Runs only on this path — an established
  // account meets the same suggestions as the Feed and Buddies rails.
  //
  // Deliberately best-effort. Every failure mode here (no candidates, a dead
  // network, a rejected batch) ends with the user on their feed with a
  // finished profile, because a discovery step is not worth blocking a
  // completed signup on.
  async function promptAddBuddies() {
    if (!window.AddBuddiesModal) return;
    let suggestions = [];
    try {
      const res = await window.Buddy.onboardingSuggestions(12);
      suggestions = (res && res.suggestions) || [];
    } catch (e) {
      console.warn("Buddy suggestions unavailable; skipping the step:", e);
      return;
    }
    // The card itself tolerates an empty list — it has a search field, so
    // there is always something to do on it. This guard survives for a
    // different reason, particular to first-run: an account ninety seconds old
    // has nobody to search FOR. Interrupting someone's first minute with an
    // empty grid and a box they cannot fill reads as a broken feature; from
    // the Buddies screen, where the user asked for this card, it does not.
    if (suggestions.length === 0) return;

    let result;
    try {
      result = await window.AddBuddiesModal.open({ suggestions });
    } catch (e) {
      console.warn("Add-buddies step failed:", e);
      return;
    }
    if (!result || result.action !== "sent") return;

    // Partial failures are benign and self-evident — the ones that landed show
    // as pending on the Buddies screen and the rest simply don't. A batch
    // where NOTHING landed is not self-evident, though: the user ticked
    // several people, watched the screen close, and got nothing. Say so.
    if (result.sent.length === 0 && result.failed.length > 0) {
      const first = result.failed[0];
      window.PolaroidPopup.alert({
        title: "Couldn't send those requests",
        body: first && first.detail
          ? `${first.detail}. You can add buddies any time from the Buddies screen.`
          : "You can add buddies any time from the Buddies screen.",
      });
    }
  }

  // Step three of first-time setup: offer to link BoardGameGeek and, if they
  // do, watch the import land.
  //
  // Last of the three deliberately. The two steps before it are a tap and a
  // batch of taps — seconds each — whereas this one can legitimately sit on
  // screen for minutes while a large collection imports, and whatever is
  // behind the last card is the user's feed, which needs nobody's permission
  // to wait. Putting it second would have parked "Add buddies" behind an
  // import nobody asked to watch to the end.
  //
  // Best-effort in exactly the same way as step two: the modal never rejects,
  // an absent widget is a no-op, and every exit leaves the user on their feed
  // with a finished profile. Skipping costs nothing — the same link lives in
  // Settings → Connections.
  async function promptLinkBgg() {
    if (!window.OnboardingBggModal) return;
    try {
      await window.OnboardingBggModal.open();
    } catch (e) {
      console.warn("Link-BoardGameGeek step failed:", e);
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

  // Everything waiting behind the Profile tab → one dot on it. It sits at this
  // level for the same reason the offline banner does: the nav bar is app
  // chrome, it outlives every view, and something that lands while the user is
  // on the Feed has to be announced by a surface already on screen.
  //
  // Three sources today — pending buddy requests, unseen achievements, and
  // incoming ghost account claims — and deliberately ONE dot for all of them.
  // Three tabs of chrome is the wrong place to read a figure or to distinguish
  // kinds of news; the dot says "there is something here", and the hub's
  // cards, one tap away, carry the counts (profile-self-view.js#_countBadge).
  //
  // Reads the store rather than the subscriber's argument, because it fires
  // for either slot and needs both — and because store.reset() calls
  // subscribers with null after zeroing the data.
  function syncNavProfileDot() {
    const tab = document.querySelector('.bgb-nav__tab[data-nav="profile-self"]');
    const dot = tab && tab.querySelector(".bgb-nav__dot");
    if (!dot) return;
    const requests = Math.max(0, Number(window.store.get("buddyRequestCount")) || 0);
    const badges = Math.max(0, Number(window.store.get("achievementUnseenCount")) || 0);
    const claims = Math.max(0, Number(window.store.get("ghostClaimRequestCount")) || 0);
    dot.hidden = requests + badges + claims === 0;
    // The dot is aria-hidden, so the tab's own name is what has to change —
    // otherwise the one control that knows something is waiting announces
    // itself identically either way.
    const parts = [];
    if (requests) parts.push(`${requests} buddy request${requests === 1 ? "" : "s"} waiting`);
    if (badges) parts.push(`${badges} new achievement${badges === 1 ? "" : "s"}`);
    if (claims) parts.push(`${claims} link request${claims === 1 ? "" : "s"} waiting`);
    if (parts.length) tab.setAttribute("aria-label", `Profile — ${parts.join(", ")}`);
    else tab.removeAttribute("aria-label");
  }
  window.store.subscribe("buddyRequestCount", syncNavProfileDot);
  window.store.subscribe("achievementUnseenCount", syncNavProfileDot);
  window.store.subscribe("ghostClaimRequestCount", syncNavProfileDot);

  // Pending uploads live in the header. Two keys drive it: the count itself,
  // and connectivity (which changes what the dialog offers).
  function syncOutboxIndicator() {
    if (window.BgbOutboxIndicator) window.BgbOutboxIndicator.render();
  }
  window.store.subscribe("outboxCount", syncOutboxIndicator);
  window.store.subscribe("offline", syncOutboxIndicator);

  // Persistent offline banner under the global header. Lives at this level
  // rather than in a View because connectivity is app state, not screen state:
  // every view would otherwise have to remember to render it, and the one that
  // forgot would be the one the user was on when their signal died.
  function syncOfflineBanner(offline) {
    const el = document.getElementById("bgb-offline-banner");
    if (!el) return;
    if (!offline) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    const probing = !!(window.BgbNet && window.BgbNet.isProbing());
    el.innerHTML = `
      <i data-icon="cloud-off" class="w-4 h-4 bgb-offline-banner__icon"></i>
      <span class="bgb-offline-banner__text">
        No connection — plays save to this device.
      </span>
      <button class="bgb-offline-banner__action" ${probing ? "disabled" : ""}
              onclick="window.retryConnection()">
        ${probing ? "Checking…" : "Try again"}
      </button>
    `;
    el.classList.remove("hidden");
    window.BgbIcons.render(el);
  }
  window.store.subscribe("offline", syncOfflineBanner);

  /**
   * The banner's "Try again". Everything else about offline detection is
   * passive — it learns from requests the app was making anyway — so this is
   * the one path that asks on purpose, for when the user can see they have
   * signal and the app hasn't caught up (walked out of the dead zone, joined
   * the wifi, came off airplane mode).
   *
   * On success the store flips and the banner removes itself; BgbNet's own
   * offline→online edge drains the outbox, so nothing to do here. On failure
   * the banner stays and says so, rather than silently doing nothing and
   * leaving the user unsure whether the tap registered.
   */
  window.retryConnection = async function () {
    if (!window.BgbNet || window.BgbNet.isProbing()) return;
    syncOfflineBanner(true);            // paint "Checking…" in the tap frame
    const back = await window.BgbNet.probe();
    if (!back) {
      syncOfflineBanner(true);          // restore the button
      if (window.showToast) {
        window.showToast("Still no connection — your plays are safe on this device.", "error");
      }
    }
  };

  // Logout helper — referenced by ProfileSelfView.
  window.handleLogout = async function () {
    if (window.supabaseClient) {
      try { await window.supabaseClient.auth.signOut(); } catch (_) {}
    }
    window.session = null;
    _bootRouted = false;
    _profileLoaded = false;
    // Wipe persisted cache for this user BEFORE store.reset() so the unbind
    // sees the still-bound uid. The achievement receipts (which badges this
    // device has shown, whether the install was reported) are keyed by user
    // but live outside bgbCache, so they need their own line — otherwise the
    // next account on this phone inherits them.
    if (window.BgbAchievementPopup) window.BgbAchievementPopup.reset();
    if (window.Achievements) window.Achievements.forget();
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
    // Refresh the auth token first so any post-wake API call (or an imminent
    // OS-triggered reload) starts from a valid session rather than a token that
    // expired while the device slept. getSession() refreshes when near expiry.
    if (window.supabaseClient) {
      window.supabaseClient.auth.getSession().catch(() => {});
    }
    if (window.Bootstrap && window.Bootstrap.warmRefresh) {
      window.Bootstrap.warmRefresh().catch(() => {});
    }
    // Coming back to the tab is the most common moment for connectivity to
    // have returned without an `online` event firing (the OS suspended the
    // page across the transition). Cheap: flush() no-ops when offline or empty.
    if (window.Outbox) window.Outbox.flush();
  });

  document.addEventListener("DOMContentLoaded", () => {
    // Start publishing the visible-viewport box as CSS custom properties. Every
    // surface that pins an action row above the software keyboard reads these
    // (see ui/viewport-lock.js for why dvh alone isn't enough).
    window.BgbViewport.start();
    // Hold the page at 1x in an iOS Safari tab, where the viewport meta's
    // user-scalable=no is ignored (see ui/zoom-lock.js).
    window.BgbZoomLock.start();

    // Start watching connectivity before anything else can issue a request, so
    // the very first failure already counts toward offline detection.
    window.BgbNet.start();
    // Owns theme changes from here on; index.html's inline boot set the
    // initial attribute before first paint.
    window.BgbTheme.start();
    window.store.set("outboxCount", window.Outbox.count());
    // start() only publishes on an edge, so a page that loads already offline
    // would never fire the subscriber. Paint the banner from the current state.
    syncOfflineBanner(window.BgbNet.isOffline());
    // Same reasoning: store.set above only notifies when the value CHANGES, so
    // a cold load with items already queued would never paint the badge.
    syncOutboxIndicator();

    // Restore a previously-active play session, if any.
    const ps = window.PlaySession.load();
    if (ps && ps.isActive()) {
      window.store.set("activePlay", ps);
    }

    // Resolve the initial URL → route so a deep-link / refresh on
    // /play/{code}, /game/{id}, /profile/collection, etc. resumes there
    // after auth. matchPath() extracts the path params, folds the querystring
    // in and resolves any route alias, so there is nothing to unpack here.
    //
    // /b/<token> — the add-a-buddy QR link — is handled here rather than in the
    // router's path table on purpose. It is inbound-only: nothing in the app
    // ever navigates TO it, and pathFor() resolves by name with .find(), so a
    // second entry named "buddies" would silently make every future
    // router.go("buddies") build the wrong URL. Rewriting it to the Buddies
    // screen with the token as a param gets the pendingRoute stash below, and
    // therefore the bounce through /auth, for free.
    let qrMatch = null;
    try {
      const m = window.location.pathname.match(/^\/b\/([^/]+)\/?$/);
      // decodeURIComponent throws URIError on a malformed escape (/b/abc%).
      // Unguarded that would take down boot itself — and this is an inbound
      // public URL that strangers paste, so it has to survive being mangled.
      if (m) qrMatch = { name: "buddies", params: { qr: decodeURIComponent(m[1]) } };
    } catch (_) {}
    if (qrMatch) {
      // Hold first-run setup until the QR flow finishes — see QR_HOLD_MS.
      _qrHold = true;
      _qrHoldTimer = setTimeout(releaseQrHold, QR_HOLD_MS);
      // Replace the /b/<token> entry now, before anything else can push on top
      // of it. Left in place it stays behind the Buddies entry, where Back
      // lands on a path matchPath() deliberately doesn't know (dead button)
      // and a refresh replays the code. This is what actually makes the token
      // unreplayable; buddies-view then strips the ?qr= off its own entry.
      try {
        history.replaceState(null, "", window.router.pathFor("buddies", {}) || "/profile/buddies");
      } catch (_) {}
    }
    // matchPath folds window.location.search into params itself, so a deep link
    // like /profile/collection?shelf=wishlist hydrates the destination view.
    const initialMatch = qrMatch || window.router.matchPath(window.location.pathname);
    if (initialMatch) window.store.set("pendingRoute", initialMatch);

    // First paint = splash. initSupabase() flips us forward to either
    // the pending deep-link route or the feed. skipPush keeps the original
    // URL in the bar (and out of the back-stack) until auth resolves.
    window.router.go("splash", {}, { skipPush: true });
    wireBottomNav();
    // One document-wide icon pass for the static shell (bottom nav, header).
    // Views refresh their own subtree via View.refreshIcons() from here on.
    window.BgbIcons.render();
    initSupabase();
    setTimeout(bootWatchdog, BOOT_WATCHDOG_MS);

    // Register the app-shell worker. Wrapped defensively (same idiom as
    // travel-scrapbook): unsupported browsers, private modes and insecure
    // origins all throw or reject here, and none of them should stop the app
    // from booting — losing the offline shell is a degradation, not a failure.
    //
    // Deferred to `load` rather than fired here: a first-ever registration
    // installs the worker, and install precaches the entire shell. Kicking
    // that off alongside the boot's own /bootstrap means the two compete for
    // the connection on exactly the launch where the app has nothing cached to
    // fall back on. The shell is only needed on the NEXT launch, so it can
    // wait for the page to finish loading.
    const registerWorker = () => {
      try { navigator.serviceWorker?.register("/sw.js").catch(() => {}); } catch (_) {}
    };
    if (document.readyState === "complete") registerWorker();
    else window.addEventListener("load", registerWorker, { once: true });

    // Offer the install once the shell is up. The component owns its own
    // gating (phone viewport, signed in, not already installed, settle delay)
    // and no-ops on browsers that never report the app as installable.
    if (window.BgbInstallPrompt) window.BgbInstallPrompt.init();

    // Listen for badges unlocking mid-session. The queue itself waits for a
    // clear screen before showing anything, so this is safe to arm at boot.
    if (window.BgbAchievementPopup) window.BgbAchievementPopup.init();

    // Pocket Buddy. An installed PWA is indistinguishable from a browser tab
    // to the backend, so the app has to say so itself — from a cold start in
    // standalone display-mode (which covers every launch of an already
    // installed copy, including one installed on another device or before this
    // feature shipped) and from the `appinstalled` event that fires the moment
    // the user accepts. Both go through Achievements.reportInstalled(), which
    // keeps its own once-per-device receipt, so the pair cannot double-post.
    const reportInstall = () => {
      if (!window.Achievements) return;
      if (!window.store.get("user")) return;
      window.Achievements.reportInstalled();
    };
    const isStandalone = () => {
      try {
        return window.matchMedia("(display-mode: standalone)").matches
          || window.navigator.standalone === true;
      } catch (_) { return false; }
    };
    // Auth resolves after boot, so this waits for a user rather than firing at
    // load: subscribe() calls back on the sign-in that lands the session.
    if (isStandalone()) {
      reportInstall();
      window.store.subscribe("user", reportInstall);
    }
    window.addEventListener("appinstalled", reportInstall);

    // Unseen badges → the Profile tab's dot, from this device's own receipts.
    // Same timing argument as reportInstall above: auth resolves after boot,
    // so this runs on the sign-in that lands the session. Reading the cache
    // rather than fetching keeps boot at zero extra calls — /achievements is a
    // write as well as a read (it stamps unlock dates), so it is not something
    // to fire just to light a dot. The first screen that does read it
    // republishes.
    const publishUnseenBadges = () => {
      if (!window.Achievements || !window.store.get("user")) return;
      window.Achievements.publishUnseenFromCache();
    };
    publishUnseenBadges();
    window.store.subscribe("user", publishUnseenBadges);

    if (window.api) window.api.trackEvent("page_view");
  });
})();
