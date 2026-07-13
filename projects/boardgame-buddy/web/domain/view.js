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

    // Scoped Lucide refresh: replace [data-lucide] placeholders under `root`
    // (default: this view's container) instead of re-walking the whole
    // document — full-document scans get expensive with every view kept
    // mounted in the DOM. Falls back to a document-wide pass only when no
    // container exists.
    refreshIcons(root) {
      if (!window.lucide) return;
      const el = root || this.container;
      if (el) window.lucide.createIcons({ root: el });
      else window.lucide.createIcons();
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
  class Router {
    constructor() {
      this._views = new Map();
      this._current = null;
      this._stack = [];          // [{name, params}, ...]
      this._maxStack = 20;
      this._routes = this._buildRoutes();
      window.addEventListener("popstate", (ev) => this._onPopstate(ev));
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
        { name: "join-session",        pattern: /^\/join\/?$/,                    build: () => "/join" },
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
        { name: "log-play",            pattern: /^\/play\/?$/,                    build: () => "/play" },
        { name: "game-detail",         pattern: /^\/game\/([^/]+)\/?$/,
          consume: ["gameId"],
          extract: (m) => ({ gameId: decodeURIComponent(m[1]) }),
          build: (p) => `/game/${encodeURIComponent(p.gameId || "")}` },
        { name: "collection",          pattern: /^\/profile\/collection\/?$/,     build: () => "/profile/collection" },
        { name: "wishlist",            pattern: /^\/profile\/wishlist\/?$/,       build: () => "/profile/wishlist" },
        { name: "plays",               pattern: /^\/profile\/plays\/?$/,          build: () => "/profile/plays" },
        { name: "buddies",             pattern: /^\/profile\/buddies\/?$/,        build: () => "/profile/buddies" },
        { name: "profile-self",        pattern: /^\/profile\/?$/,                 build: () => "/profile" },
        { name: "profile-other",       pattern: /^\/u\/([^/]+)\/?$/,
          consume: ["userId"],
          extract: (m) => ({ userId: decodeURIComponent(m[1]) }),
          build: (p) => `/u/${encodeURIComponent(p.userId || "")}` },
        { name: "settings",            pattern: /^\/settings\/?$/,                build: () => "/settings" },
        { name: "admin",               pattern: /^\/admin\/?$/,                   build: () => "/admin" },
        { name: "feed",                pattern: /^\/(feed)?\/?$/,                 build: () => "/feed" },
      ];
    }

    register(name, view) {
      this._views.set(name, view);
    }

    // Resolve a URL pathname to {name, params} or null. Querystring values
    // are merged into params so /game/x?gameName=Catan hydrates both.
    matchPath(pathname) {
      const path = (pathname || "/").split("?")[0];
      for (const r of this._routes) {
        if (!r.pattern) continue;
        const m = path.match(r.pattern);
        if (m) {
          const params = r.extract ? r.extract(m) : {};
          return { name: r.name, params };
        }
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
      try {
        history.replaceState({ name: stateName, params: stateParams }, "", url);
      } catch (_) {}
      // Keep the store entry consistent with the new URL.
      window.store.set("currentRoute", { name: stateName, params: stateParams });
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
      if (prev && prev !== next && !skipPush && !fromPopstate && prev.name !== "splash") {
        this._stack.push({ name: prev.name, params: prev.params || {} });
        if (this._stack.length > this._maxStack) this._stack.shift();
      }

      // History.pushState mirrors _stack: every forward navigation lands a
      // new history entry whose state lets popstate replay the route. On
      // boot / popstate we explicitly skip this so we don't pile up
      // duplicate entries. If the URL already matches the target (e.g. the
      // post-auth navigation arriving at the deep-link the user typed),
      // replaceState avoids a duplicate adjacent entry.
      if (!skipPush && !fromPopstate) {
        const url = this.pathFor(name, params);
        if (url) {
          const current = window.location.pathname + window.location.search;
          try {
            if (current === url) {
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

      document.querySelectorAll("[data-view]").forEach((el) => {
        el.classList.toggle("hidden", el.dataset.view !== name);
      });

      const authed = !!window.store.get("user");
      document.querySelectorAll("[data-auth-only]").forEach((el) => {
        el.classList.toggle("hidden", !authed);
      });

      document.querySelectorAll(".bgb-nav button, .btm-nav button").forEach((btn) => {
        const views = btn.dataset.navViews
          ? btn.dataset.navViews.split(",").map((s) => s.trim())
          : [btn.dataset.nav];
        btn.classList.toggle("active", views.includes(name));
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
      else if (window.lucide) window.lucide.createIcons();
      if (window.api) window.api.trackEvent("view:" + name);
    }

    async back(fallback = "feed") {
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
      const url = this.pathFor(fallback, {});
      if (url) {
        try { history.replaceState({ name: fallback, params: {} }, "", url); } catch (_) {}
      }
      return this.go(fallback, {}, { skipPush: true });
    }

    // Non-destructive peek at where `back()` would land. Used by views that
    // want to label a back affordance with the destination name. Returns
    // the fallback when the stack is empty.
    peekBack(fallback = "feed") {
      const entry = this._stack[this._stack.length - 1];
      return entry ? entry.name : fallback;
    }

    async _onPopstate(ev) {
      const state = ev && ev.state;
      let target = null;
      if (state && state.name) {
        target = { name: state.name, params: state.params || {} };
      } else {
        // Direct URL load or hash-only change — resolve from pathname.
        target = this.matchPath(window.location.pathname);
      }
      if (!target) return;
      // Mirror the browser's pop on our internal stack so peekBack stays
      // accurate. Use fromPopstate to suppress the duplicate pushState.
      this._stack.pop();
      await this.go(target.name, target.params, { skipPush: true, fromPopstate: true });
    }
  }

  window.View = View;
  window.Router = Router;
  window.router = new Router();

  // Convenience: keep showView() working so legacy code paths that haven't
  // been migrated yet keep navigating correctly. Routes through the new
  // router so subscriptions still fire.
  window.showView = function (name, params) {
    window.router.go(name, params);
  };
})();
