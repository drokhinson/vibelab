// domain/view.js — Base class for screen controllers.
//
// Each view subclass owns ONE container in index.html (matched by
// `data-view="<name>"`). mount() runs once when the view becomes visible;
// unmount() runs when the user navigates away so subscriptions don't leak.

(function () {
  class View {
    constructor(name) {
      this.name = name;
      this._unsubs = [];
      this._mounted = false;
    }

    get container() {
      return document.querySelector(`[data-view="${this.name}"]`);
    }

    // Lifecycle ────────────────────────────────────────────────────────────────
    async mount(params) {
      if (this._mounted) {
        // Re-route to the same view with new params — let subclass handle.
        this.params = params || {};
        await this.onParamsChange?.(this.params);
        return;
      }
      this._mounted = true;
      this.params = params || {};
      // Paint a synchronous placeholder so the user sees the new view
      // immediately — even if onMount() does data fetching. Subclasses
      // override renderLoading() to swap in a skeleton or empty shell;
      // the default is a no-op so fast views don't flash a spinner.
      try { this.renderLoading(); } catch (_) {}
      await this.onMount?.();
      this.render();
    }

    async unmount() {
      if (!this._mounted) return;
      this._mounted = false;
      for (const fn of this._unsubs) {
        try { fn(); } catch (_) {}
      }
      this._unsubs = [];
      await this.onUnmount?.();
    }

    // Subclasses use this to subscribe to Store keys safely.
    listen(key, fn) {
      const unsub = window.store.subscribe(key, fn);
      this._unsubs.push(unsub);
    }

    // Subscribe to a global DOM event with auto-removal on unmount. Useful
    // for cross-view notifications (e.g. the `status-changed` custom event
    // fired by the status-tag picker).
    listenDom(event, fn) {
      document.addEventListener(event, fn);
      this._unsubs.push(() => document.removeEventListener(event, fn));
    }

    // Scoped icon refresh: hydrate [data-icon] placeholders under `root`
    // (default: this view's container) instead of re-walking the whole
    // document — full-document scans get expensive with every view kept
    // mounted in the DOM. Falls back to a document-wide pass only when no
    // container exists.
    refreshIcons(root) {
      const el = root || this.container;
      window.BgbIcons.render(el || undefined);
    }

    // Synchronous loading placeholder rendered before onMount() runs.
    // Default is a no-op; override in subclasses that fetch on mount.
    renderLoading() {}

    // Default render() is a no-op — subclasses override.
    render() {}
  }

  // Router ──────────────────────────────────────────────────────────────────────
  // Browser-URL aware: every router.go() pushes a History API entry so refresh
  // survives, deep links work (/play/{code}, /u/{userId}, /game/{id}, etc.),
  // and the device back button is wired up. We still maintain an internal
  // _stack alongside history because the browser doesn't expose history entry
  // metadata — peekBack() and back-affordance labels need it. The two stay in
  // sync: every push to _stack is matched by a pushState, every pop matches
  // a back() / popstate.
  //
  // Route → path mapping lives in _routes below. matchPath() resolves an
  // incoming URL (initial load, popstate); pathFor() builds the URL for a
  // route name + params. Params not consumed by a path template become
  // querystring so deep-link entries still hydrate the destination view
  // with extras like gameName, expansionIds, mode, etc.

  // The global header's two toggle buttons and the screen each one opens and
  // closes. go() below keeps their aria-pressed in step with the current view;
  // init.js#toggleScreen is the other half. One list so the pair can never
  // drift into "the bell knows and the gear doesn't", which is exactly how the
  // gear's box ended up never lighting on the screen it opens.
  // Selected by data-toggle rather than by class: each toggle exists twice,
  // once in the header (phone, tablet) and once in the wide tier's nav rail,
  // and both copies wear the screen's state.
  const HEADER_TOGGLES = [
    ['[data-toggle="notifications"]', "notifications"],
    ['[data-toggle="settings"]', "settings"],
  ];
  // The screens half of that table, for init.js#toggleScreen — it has to know
  // that the OTHER header screen is currently open, and reading it from here
  // is what keeps the pair one list rather than two that can disagree.
  window.BgbHeaderScreens = HEADER_TOGGLES.map(([, view]) => view);

  // The only screens a signed-out visitor belongs on. Everything else in the
  // route table reads account data, so replaying one from history after a
  // sign-out paints an empty shell of somebody's app — see _gateBack.
  //
  // privacy and terms are here because they have to resolve for a stranger:
  // Google's consent screen links to both permanently. They are NOT in
  // CHROMELESS_VIEWS below — a signed-in user opens them from Settings, and
  // taking the nav away there would strand the reader.
  const PUBLIC_VIEWS = ["auth", "privacy", "terms", "splash"];

  // Screens that deliberately show no app chrome: the splash covers boot, and
  // the sign-in screen must not offer a nav bar into an app nobody is signed
  // in to. index.html marks the header and the nav [data-auth-only].
  const CHROMELESS_VIEWS = ["splash", "auth"];

  class Router {
    constructor() {
      this._views = new Map();
      this._current = null;
      this._stack = [];          // [{name, params}, ...]
      this._maxStack = 20;
      this._routes = this._buildRoutes();
      window.addEventListener("popstate", (ev) => this._onPopstate(ev));
      // The `user` subscription is NOT taken here — see go().
      this._chromeSub = null;
    }

    _buildRoutes() {
      // Order matters: longest / most specific patterns first so e.g.
      // /game/:id/chapters wins over /game/:id, and /play/:code wins over
      // /play. Routes without `pattern` are pathFor-only (e.g. session-viewer
      // shares /play/:code with play-flow — match resolves to play-flow and
      // the view layer decides host-vs-joiner from the lobby fetch).
      // Note: `splash` is intentionally absent. It's a transient loading
      // view that should never appear in URLs or the back stack — pathFor
      // returns null for unknown names and go() skips pushState in that case.
      return [
        { name: "auth",                pattern: /^\/auth\/?$/,                    build: () => "/auth" },
        { name: "reference-guide-add", pattern: /^\/game\/([^/]+)\/chapters\/?$/,
          consume: ["gameId"],
          extract: (m) => ({ gameId: decodeURIComponent(m[1]) }),
          build: (p) => `/game/${encodeURIComponent(p.gameId || "")}/chapters` },
        { name: "play-flow",           pattern: /^\/play\/([^/]+)\/?$/,
          consume: ["code"],
          extract: (m) => ({ code: decodeURIComponent(m[1]) }),
          build: (p) => p.code ? `/play/${encodeURIComponent(p.code)}` : "/play" },
        { name: "session-viewer",
          consume: ["code"],
          build: (p) => p.code ? `/play/${encodeURIComponent(p.code)}` : "/play" },
        // /join is the retired standalone Join screen — its code entry and
        // active-session list are the bottom half of the Play tab now. Kept as
        // an alias so shared links and bookmarks still land somewhere sane.
        { name: "log-play",            pattern: /^\/(play|join)\/?$/,             build: () => "/play" },
        { name: "discovery",           pattern: /^\/discover\/?$/,               build: () => "/discover" },
        { name: "add-games",           pattern: /^\/games\/add\/?$/,              build: () => "/games/add" },
        { name: "game-explorer",       pattern: /^\/games\/?$/,                   build: () => "/games" },
        { name: "game-detail",         pattern: /^\/game\/([^/]+)\/?$/,
          consume: ["gameId"],
          extract: (m) => ({ gameId: decodeURIComponent(m[1]) }),
          build: (p) => `/game/${encodeURIComponent(p.gameId || "")}` },
        { name: "collection",          pattern: /^\/profile\/collection\/?$/,     build: () => "/profile/collection" },
        // Match-only alias. The wishlist is a shelf of the collection spoke now
        // (?shelf=wishlist), but the standalone path was bookmarkable for long
        // enough that dropping it would strand real links and home-screen
        // shortcuts. No `build`: nothing navigates TO this name any more, and
        // pathFor("collection", {shelf}) is what writes the canonical URL.
        { name: "wishlist",            pattern: /^\/profile\/wishlist\/?$/,
          alias: "collection",         aliasParams: { shelf: "wishlist" } },
        { name: "plays",               pattern: /^\/profile\/plays\/?$/,          build: () => "/profile/plays" },
        { name: "buddies",             pattern: /^\/profile\/buddies\/?$/,        build: () => "/profile/buddies" },
        { name: "stats",               pattern: /^\/profile\/stats\/?$/,          build: () => "/profile/stats" },
        { name: "achievements",        pattern: /^\/profile\/achievements\/?$/,   build: () => "/profile/achievements" },
        { name: "profile-self",        pattern: /^\/profile\/?$/,                 build: () => "/profile" },
        { name: "profile-other",       pattern: /^\/u\/([^/]+)\/?$/,
          consume: ["userId"],
          extract: (m) => ({ userId: decodeURIComponent(m[1]) }),
          build: (p) => `/u/${encodeURIComponent(p.userId || "")}` },
        { name: "import-wizard",       pattern: /^\/settings\/import\/?$/,
          build: () => "/settings/import" },
        // The two importers were separate screens at separate paths for
        // months, so both live in bookmarks and home-screen shortcuts. Aliased
        // rather than dropped — same trick /admin uses above — so an old link
        // lands on the wizard with its branch already picked. No `build`:
        // nothing navigates TO these names any more, and the view replaces the
        // url with the canonical one on the way in.
        { name: "import-plays",        pattern: /^\/settings\/import-plays\/?$/,
          alias: "import-wizard", aliasParams: { source: "notes" } },
        { name: "photo-import",        pattern: /^\/settings\/import-photos\/?$/,
          alias: "import-wizard", aliasParams: { source: "photos" } },
        // The imports spoke and its drill-down. `batchId` is in the PATH, not
        // the querystring, because it is what the page is rather than a hint
        // about how you got there — the opposite call from `compose` below.
        //
        // One letter from the importer above, and deliberately so: `/import`
        // is the wizard that writes plays and `/imports` is the history of what
        // it wrote. The patterns are anchored, so `/settings/imports` cannot
        // match `import-wizard`'s — do not "tidy" these into one.
        { name: "import-detail",       pattern: /^\/settings\/imports\/([^/]+)\/?$/,
          consume: ["batchId"],
          extract: (m) => ({ batchId: decodeURIComponent(m[1]) }),
          build: (p) => `/settings/imports/${encodeURIComponent(p.batchId || "")}` },
        { name: "imports",             pattern: /^\/settings\/imports\/?$/,
          build: () => "/settings/imports" },
        { name: "bgg-sync",            pattern: /^\/settings\/bgg\/?$/,
          build: () => "/settings/bgg" },
        // `compose` stays OFF the path and rides as querystring: it is a
        // display hint about how to arrive, not part of what the page is
        // (.claude/rules/web-frontend.md, "Path params for identity,
        // querystring for extras"). The view strips it with replaceUrl once the
        // sheet is up, so a refresh lands on the board rather than re-opening it.
        { name: "feedback",            pattern: /^\/settings\/feedback\/?$/,
          build: () => "/settings/feedback" },
        { name: "whats-new",           pattern: /^\/settings\/whats-new\/?$/,
          build: () => "/settings/whats-new" },
        { name: "notifications",       pattern: /^\/notifications\/?$/,           build: () => "/notifications" },
        { name: "settings",            pattern: /^\/settings\/?$/,                build: () => "/settings" },
        { name: "admin-reports",       pattern: /^\/admin\/reports\/?$/,          build: () => "/admin/reports" },
        { name: "admin-bgg-data",      pattern: /^\/admin\/bgg-data\/?$/,         build: () => "/admin/bgg-data" },
        // The four backfills were four spokes, then four panels on one, and are
        // two panels now — descriptions, stats and publishers became one queue.
        // Match-only aliases so an admin's bookmark still lands on the screen
        // that holds its queue, whichever panel that is today.
        // /admin/publishers never had a pattern of its own — it is listed here
        // for the same reason as the other three, not because anything could
        // have linked to it.
        { name: "admin-images",        pattern: /^\/admin\/images\/?$/,           build: () => "/admin/images",
          alias: "admin-bgg-data" },
        { name: "admin-descriptions",  pattern: /^\/admin\/descriptions\/?$/,     build: () => "/admin/descriptions",
          alias: "admin-bgg-data" },
        { name: "admin-stats",         pattern: /^\/admin\/stats\/?$/,            build: () => "/admin/stats",
          alias: "admin-bgg-data" },
        { name: "admin-publishers",    pattern: /^\/admin\/publishers\/?$/,       build: () => "/admin/publishers",
          alias: "admin-bgg-data" },
        { name: "admin-release-notices", pattern: /^\/admin\/release-notices\/?$/,
          build: () => "/admin/release-notices" },
        { name: "admin-affiliates",    pattern: /^\/admin\/affiliates\/?$/,       build: () => "/admin/affiliates" },
        // /admin/USAGE, not /admin/stats: that name and that path are already
        // taken above, as the legacy alias for the BGG-stats backfill panel.
        // Two different screens called "admin stats" is how a bookmark ends up
        // on the wrong one.
        { name: "admin-usage",         pattern: /^\/admin\/usage\/?$/,           build: () => "/admin/usage" },
        // The run log, one screen for all five admin jobs. `tool` is in the
        // PATH because it is what the page IS, not a hint about how you got
        // here — same call as import-detail's batchId above. Declared before
        // the bare /admin alias so the longer pattern is tried first.
        { name: "admin-run",           pattern: /^\/admin\/run\/([^/]+)\/?$/,
          consume: ["tool"],
          extract: (m) => ({ tool: decodeURIComponent(m[1]) }),
          build: (p) => `/admin/run/${encodeURIComponent(p.tool || "")}` },
        // The admin tools used to be one stacked screen at /admin. Aliased
        // rather than dropped so an old bookmark lands on the Settings card
        // that now indexes the three spokes, instead of a 404-ish blank.
        { name: "admin",               pattern: /^\/admin\/?$/,                   build: () => "/admin",
          alias: "settings" },
        // The two legal documents. Real routes rather than static .html files
        // (see views/legal-view.js). Google's OAuth brand review loads both of
        // these URLs, and the consent screen links to them permanently — so
        // they have to resolve for a signed-out stranger, which is why they sit
        // above the auth gate rather than inside Settings.
        { name: "privacy",             pattern: /^\/privacy\/?$/,                 build: () => "/privacy" },
        { name: "terms",               pattern: /^\/terms\/?$/,                   build: () => "/terms" },
        { name: "feed",                pattern: /^\/(feed)?\/?$/,                 build: () => "/feed" },
      ];
    }

    register(name, view) {
      this._views.set(name, view);
    }

    // Resolve a URL pathname to {name, params} or null. Querystring values are
    // merged into params so /game/x?gameName=Catan hydrates both.
    //
    // The merge lives here rather than at the call site because there are three
    // call sites and only one of them used to do it: the boot path in init.js
    // did, so a cold deep link worked, but the popstate fallback below (browser
    // -supplied entries, which carry no state object) did not — walking back to
    // /profile/collection?shelf=wishlist landed on the default shelf.
    //
    // A route may also declare `alias` + `aliasParams`, which resolve it to a
    // DIFFERENT view: that is how a retired path stays live without a second
    // view registered under its name. Extracted and querystring params win over
    // aliasParams, so an explicit ?shelf= in the URL is still honoured.
    matchPath(pathname, search) {
      const path = (pathname || "/").split("?")[0];
      const qs = search === undefined ? window.location.search : search;
      for (const r of this._routes) {
        if (!r.pattern) continue;
        const m = path.match(r.pattern);
        if (!m) continue;
        const params = { ...(r.aliasParams || {}), ...(r.extract ? r.extract(m) : {}) };
        try {
          for (const [k, v] of new URLSearchParams(qs).entries()) {
            if (params[k] == null) params[k] = v;
          }
        } catch (_) {}
        return { name: r.alias || r.name, params };
      }
      return null;
    }

    // Build a URL for `go(name, params)`. Path params (those in `consume`)
    // populate the template; the rest become querystring.
    pathFor(name, params) {
      const entry = this._routes.find((r) => r.name === name);
      if (!entry || !entry.build) return null;
      const p = params || {};
      let url = entry.build(p);
      const consumed = entry.consume || [];
      const extras = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) {
        if (consumed.includes(k)) continue;
        if (v == null || v === "") continue;
        extras.set(k, String(v));
      }
      const qs = extras.toString();
      return qs ? `${url}?${qs}` : url;
    }

    /**
     * Every route a link can point at with no parameters — the set the release
     * notice editor's "take me there" picker offers.
     *
     * Derived from the table rather than hand-listed anywhere, because a
     * hand-list drifts the first time a route is renamed and the only symptom
     * is a button that silently goes nowhere (pathFor returns null, go() skips
     * its pushState) in front of every user.
     *
     * Two filters, and both matter:
     *   `build`   — a match-only alias (wishlist, import-plays) resolves an old
     *               URL but nothing navigates TO it, so it cannot be a target.
     *   `consume` — a route with path params (game-detail, play-flow) cannot be
     *               built without them, so offering it would produce exactly
     *               the dead button this exists to prevent.
     *
     * @returns {string[]} route names, in table order
     */
    routeNames() {
      return this._routes
        // `alias` entries are match-only: they have a `build`, but no view is
        // registered under their name, so go() would console.error on one. The
        // release-notice editor picks its destination out of this list, so a
        // retired path in it is a published notice whose button does nothing.
        .filter((r) => r.build && !r.alias && !(r.consume && r.consume.length))
        .map((r) => r.name);
    }

    // Update the browser URL to match the current route + params without
    // navigating. Useful when state catches up to a route — e.g. play-flow's
    // host doesn't have the lobby code at navigation time, but once
    // _ensureLobbyOpen resolves we want /play/{code} in the address bar so
    // a refresh resumes the session.
    replaceUrl(name, params) {
      const url = this.pathFor(name, params);
      if (!url) return;
      const stateName = name;
      const stateParams = params || {};
      // stamp() carries an overlay guard's marking across the replace — the
      // entry being replaced is the guard's own when a sheet is open, and an
      // unmarked one is a back press that does nothing (ui/back-guard.js).
      const state = { name: stateName, params: stateParams };
      try {
        history.replaceState(
          window.BgbBackGuard ? window.BgbBackGuard.stamp(state) : state, "", url);
      } catch (_) {}
      // Keep the store entry consistent with the new URL.
      window.store.set("currentRoute", { name: stateName, params: stateParams });
    }

    // The view containers, the auth-only chrome, the nav tabs and the header
    // toggles are static shell markup (index.html), so they are queried once
    // rather than five document walks per navigation.
    _shell() {
      if (!this._shellNodes) {
        const all = (sel) => Array.from(document.querySelectorAll(sel));
        this._shellNodes = {
          views: all("[data-view]"),
          authOnly: all("[data-auth-only]"),
          navButtons: all(".bgb-nav button[data-nav]"),
          toggles: HEADER_TOGGLES.map(([sel, view]) => [all(sel), view]),
        };
      }
      return this._shellNodes;
    }

    async go(name, params, { skipPush = false, fromPopstate = false } = {}) {
      const next = this._views.get(name);
      if (!next) {
        console.error("Unknown view:", name);
        return;
      }
      const prev = this._current;
      // Push the *previous* view onto the back-stack only when this is a
      // forward navigation (i.e. not an unconscious popstate / boot replay).
      // splash is transient and never a meaningful back destination — drop it.

      // History.pushState mirrors _stack: every forward navigation lands a
      // new history entry whose state lets popstate replay the route. On
      // boot / popstate we explicitly skip this so we don't pile up
      // duplicate entries. If the URL already matches the target (e.g. the
      // post-auth navigation arriving at the deep-link the user typed),
      // replaceState avoids a duplicate adjacent entry.
      if (!skipPush && !fromPopstate) {
        const url = this.pathFor(name, params);
        if (url) {
          // A SUCCESSFUL SIGN-IN SPENDS THE LOGIN SCREEN'S HISTORY ENTRY
          // rather than stacking the app on top of it. Pushing left /auth
          // sitting directly under the first screen the user landed on, so
          // one back gesture on Android put a signed-in account back on the
          // login form — with the app's own header and nav around it, since
          // the entry is replayed through this same function.
          //
          // Read off the CURRENT PATH, not off `prev`: the handover goes
          // auth → splash → feed, and splash has no URL of its own (pathFor
          // returns null for it), so /auth is still the entry being stood on
          // when the destination finally resolves. _onPopstate holds the
          // other half of this for entries that predate the sign-in.
          //
          // Only a route INTO the app spends it. Walking from the login
          // screen to the privacy policy (which a signed-out stranger must be
          // able to read — Google's consent screen links to it) has to leave
          // that entry where it is, or the × on the document has nothing to
          // go back to.
          const leavingAuth = !PUBLIC_VIEWS.includes(name) && this._onAuthPath();
          // Only here, so the stack never holds an entry history does not.
          if (prev && prev !== next && prev.name !== "splash" && !leavingAuth) {
            this._stack.push({ name: prev.name, params: prev.params || {} });
            if (this._stack.length > this._maxStack) this._stack.shift();
          }
          const current = window.location.pathname + window.location.search;
          try {
            if (current === url || leavingAuth) {
              history.replaceState({ name, params: params || {} }, "", url);
            } else {
              history.pushState({ name, params: params || {} }, "", url);
            }
          } catch (_) {}
        }
      }

      // Instant UI updates — visibility, active tab, and store all happen
      // before any awaited work so the user perceives the tap as immediate.
      // Any data fetching the destination view needs happens in onMount,
      // backed by renderLoading() for the placeholder. The previous view's
      // unmount is fire-and-forget so a hung cleanup (e.g. supabase
      // removeChannel waiting on a never-READY socket) can't freeze nav.
      window.store.set("currentRoute", { name, params: params || {} });
      window.store.set("currentView", name);

      const shell = this._shell();
      shell.views.forEach((el) => {
        el.classList.toggle("hidden", el.dataset.view !== name);
      });

      // A new screen starts at the top of itself. Views are shown and hidden by
      // toggling .hidden on siblings of one scrolling document, so the scroll
      // offset is a property of the PAGE, not of the view — walk from a
      // scrolled Profile hub into Buddies and the browser has no reason to move
      // it, so Buddies opens halfway down. Nothing reset it before this.
      //
      // Here, beside the visibility flip and before any await, so it lands in
      // the tap's own frame (.claude/rules/web-frontend.md, "Navigation feels
      // instantaneous") rather than after the destination's data arrives.
      //
      // Forward navigations only. A popstate is the user returning to a screen
      // they had already scrolled, and yanking that to the top would be its own
      // bug; restoring the offset properly needs a per-entry record this router
      // does not keep, so back is left exactly as it was.
      if (prev !== next && !fromPopstate) {
        try { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }
        catch (_) { window.scrollTo(0, 0); }   // older Safari rejects the options form
      }

      // Who is signed in is not a navigation event — see _applyAuthChrome for
      // the bug that fact caused. Subscribed on the first navigation rather
      // than in the constructor, so this module keeps no load-order
      // dependency on store.js and the subscriber can never run before the
      // shell below has been queried.
      if (!this._chromeSub) {
        this._chromeSub = window.store.subscribe(
          "user", () => this._applyAuthChrome());
      }
      this._applyAuthChrome(name);

      shell.navButtons.forEach((btn) => {
        const views = btn.dataset.navViews
          ? btn.dataset.navViews.split(",").map((s) => s.trim())
          : [btn.dataset.nav];
        btn.classList.toggle("active", views.includes(name));
      });

      // Each global-header button is its screen's only opener AND its only
      // closer (init.js#toggleScreen), so it carries that screen's state the way
      // the nav tabs above carry theirs. aria-pressed rather than a modifier
      // class: they are toggle buttons, so the state a screen reader announces
      // and the one styles.css draws are the same fact, written once. Set here
      // rather than in the buttons' own click handlers because the screens close
      // plenty of ways those handlers never hear about — the device back button,
      // a deep link, a notification tapped through to a play — and every one of
      // them lands in this function.
      shell.toggles.forEach(([buttons, view]) => {
        buttons.forEach((btn) => btn.setAttribute("aria-pressed", String(name === view)));
      });

      this._current = next;

      if (prev && prev !== next) {
        Promise.resolve()
          .then(() => prev.unmount())
          .catch((e) => console.warn(`unmount(${prev.name}) failed:`, e));
      }

      await next.mount(params);

      // Scope the icon pass to the destination view — the static shell's
      // icons (bottom nav) are created once at boot by init.js.
      if (next.refreshIcons) next.refreshIcons();
      else window.BgbIcons.render();
      if (window.api) window.api.trackEvent("view:" + name);
    }

    // Whether the entry currently being stood on is the sign-in screen.
    // Resolved through the route table rather than a second copy of its
    // pattern, with an empty search so a querystring cannot change the answer.
    _onAuthPath() {
      const match = this.matchPath(window.location.pathname, "");
      return !!match && match.name === "auth";
    }

    /**
     * Show or hide the app chrome — the global header and the bottom nav.
     *
     * WHO IS SIGNED IN IS NOT A NAVIGATION EVENT, and treating it as one is
     * what shipped a feed with no bottom nav. This used to run only inside
     * go(), off whatever `user` happened to be at that instant — but the
     * profile lands on its own schedule, and several paths route BEFORE it
     * does: init.js routes a valid session forward even when /bootstrap has
     * not answered yet (a signed-in user must never be stranded on the
     * splash) and recovers the profile in the background, and the boot
     * watchdog does the same with nothing but a session in hand. Both left
     * the chrome hidden with nothing to turn it back on until the NEXT
     * navigation — which is exactly why the reported bug healed the moment
     * the user pressed back.
     *
     * So this is a `user` subscriber too (taken on the first navigation, see
     * go()), and it is idempotent: whichever of the two runs last is right.
     */
    _applyAuthChrome(viewName) {
      const name = viewName || window.store.get("currentView");
      const show = !!window.store.get("user") && !CHROMELESS_VIEWS.includes(name);
      this._shell().authOnly.forEach((el) => el.classList.toggle("hidden", !show));
    }

    /**
     * Keep a back press from crossing the session boundary.
     *
     * History entries outlive the session that created them, and there is no
     * API for deleting one. go() spends the login screen's own entry on the
     * way out, which covers the ordinary sign-in; this covers the entries
     * that pushState cannot reach — an /auth pushed by a mid-session sign-out
     * with the previous account's screens still stacked underneath it, and
     * those screens themselves once the store has been reset.
     *
     * Returns the route to honour, which may not be the one the browser
     * popped. Being signed in means the login screen is not a destination;
     * being signed out means the app's screens are not either.
     *
     * Mid-boot it honours everything: nothing is settled yet, `user` is null
     * for a session that is merely still restoring, and answering "signed
     * out" there would bounce a signed-in user to the login screen over a
     * back press.
     */
    _gateBack(target) {
      if (!this._current || this._current.name === "splash") return target;
      const authed = !!window.store.get("user");
      if (authed && target.name === "auth") return { name: "feed", params: {} };
      if (!authed && !PUBLIC_VIEWS.includes(target.name)) return { name: "auth", params: {} };
      return target;
    }

    async back(fallback = "feed", fallbackParams = {}) {
      // Prefer the browser history's back so the URL and our _stack stay in
      // sync — popstate (below) will pop _stack and call go(). When _stack
      // is empty we have nowhere to go back to, so fall through to the
      // caller-supplied fallback and replace the URL.
      if (this._stack.length > 0) {
        try {
          history.back();
          return;
        } catch (_) { /* fall through */ }
      }
      const url = this.pathFor(fallback, fallbackParams);
      if (url) {
        try { history.replaceState({ name: fallback, params: fallbackParams }, "", url); } catch (_) {}
      }
      return this.go(fallback, fallbackParams, { skipPush: true });
    }

    // Hierarchical "up" for spoke screens whose header carries a parent
    // affordance ("Back to profile") rather than a plain back arrow. The
    // parent is a fixed destination, but reaching it with go() pushes a
    // SECOND copy of it onto history, and the device back button then walks
    // straight back into the spoke: buddies → their profile → their
    // collection → up → profile → back → collection → back → profile → …
    // an endless two-screen loop with buddies stranded underneath.
    //
    // So: when the parent is exactly where a browser-back would land, take
    // it — the spoke's history entry is consumed instead of duplicated, and
    // whatever sat under it (buddies) becomes reachable again. When it isn't
    // the parent (deep link straight into the spoke, or a cross-link from
    // somewhere else), swap the current entry for the parent so the spoke
    // still doesn't linger in history behind it.
    //
    // Match on the built URL, not just the route name, so a spoke for one
    // user doesn't "go up" into a different user's profile.
    async up(name, params) {
      const target = this.pathFor(name, params || {});
      const top = this._stack[this._stack.length - 1];
      if (top && top.name === name && target && this.pathFor(top.name, top.params) === target) {
        try {
          history.back();
          return;
        } catch (_) { /* fall through to the replace path */ }
      }
      if (target) {
        try { history.replaceState({ name, params: params || {} }, "", target); } catch (_) {}
      }
      return this.go(name, params || {}, { skipPush: true });
    }

    // Swap the current screen for a sibling that occupies the same layer,
    // spending the current history entry instead of stacking a new one on top
    // of it. go() would deepen history, and the sibling's own close (a back())
    // would then land on the screen it replaced rather than on the screen the
    // pair was opened from — which is how the header's bell and gear ended up
    // handing the user to each other instead of closing.
    //
    // Nothing is pushed onto _stack either: the entry we replace was never on
    // it (the screen under the pair is), so back and peekBack keep pointing at
    // wherever the first of the two was opened from.
    async swap(name, params) {
      const url = this.pathFor(name, params || {});
      if (url) {
        try { history.replaceState({ name, params: params || {} }, "", url); } catch (_) {}
      }
      return this.go(name, params || {}, { skipPush: true });
    }

    // Non-destructive peek at where `back()` would land. Used by views that
    // want to label a back affordance with the destination name. Returns
    // the fallback when the stack is empty.
    peekBack(fallback = "feed") {
      const entry = this._stack[this._stack.length - 1];
      return entry ? entry.name : fallback;
    }

    async _onPopstate(ev) {
      // An overlay on screen owns the back gesture: the press closes the sheet
      // or modal the user is looking at (dismissing the keyboard first), and
      // the screen behind it stays exactly where it was. Only once nothing is
      // open does back mean "previous screen" again. See ui/back-guard.js.
      if (window.BgbBackGuard && window.BgbBackGuard.handlePopstate(ev)) return;

      const state = ev && ev.state;
      let target = null;
      if (state && state.name) {
        target = { name: state.name, params: state.params || {} };
      } else {
        // Direct URL load or hash-only change — resolve from pathname.
        target = this.matchPath(window.location.pathname);
      }
      if (!target) return;
      // A back press must not cross the session boundary. The entry has
      // already been popped by the browser, so the substitute takes its place
      // rather than stacking on top of it — otherwise a second press walks
      // straight back into the screen we just refused.
      const gated = this._gateBack(target);
      if (gated !== target) {
        const url = this.pathFor(gated.name, gated.params);
        if (url) {
          try {
            history.replaceState(
              { name: gated.name, params: gated.params }, "", url);
          } catch (_) {}
        }
        target = gated;
      }
      // Mirror the browser's pop on our internal stack so peekBack stays
      // accurate. Use fromPopstate to suppress the duplicate pushState.
      this._stack.pop();
      await this.go(target.name, target.params, { skipPush: true, fromPopstate: true });
    }
  }

  window.View = View;
  window.router = new Router();

})();
