// domain/view.js — View base class + History-API Router.
//
// Adapted from projects/boardgame-buddy/web/domain/view.js, trimmed of the
// Store/auth coupling this app doesn't need. Every view owns one container in
// index.html (matched by data-view="<name>"). The router keeps the address bar
// in sync (pushState), supports the back button (popstate), and survives
// refresh/deep-links when paired with vercel.json's SPA rewrite.

(function () {
  class View {
    constructor(name) {
      this.name = name;
      this._mounted = false;
      this.params = {};
    }

    get container() {
      return document.querySelector(`[data-view="${this.name}"]`);
    }

    async mount(params) {
      this.params = params || {};
      if (this._mounted) {
        await this.onParamsChange?.(this.params);
        return;
      }
      this._mounted = true;
      try { this.renderLoading(); } catch (_) {}
      await this.onMount?.();
      this.render();
    }

    async unmount() {
      if (!this._mounted) return;
      this._mounted = false;
      await this.onUnmount?.();
    }

    refreshIcons(root) {
      if (!window.lucide) return;
      const el = root || this.container;
      window.lucide.createIcons(el ? { root: el } : undefined);
    }

    renderLoading() {}
    render() {}
  }

  class Router {
    constructor() {
      this._views = new Map();
      this._current = null;
      this._depth = 0; // how many forward navigations we've pushed
      this._routes = [
        { name: "trip", pattern: /^\/trip\/([^/]+)\/?$/,
          consume: ["id"],
          extract: (m) => ({ id: decodeURIComponent(m[1]) }),
          build: (p) => `/trip/${encodeURIComponent(p.id || "")}` },
        { name: "home", pattern: /^\/?$/, build: () => "/" },
      ];
      window.addEventListener("popstate", (ev) => this._onPopstate(ev));
    }

    register(name, view) { this._views.set(name, view); }

    matchPath(pathname) {
      const path = (pathname || "/").split("?")[0];
      for (const r of this._routes) {
        if (!r.pattern) continue;
        const m = path.match(r.pattern);
        if (m) return { name: r.name, params: r.extract ? r.extract(m) : {} };
      }
      return { name: "home", params: {} };
    }

    pathFor(name, params) {
      const entry = this._routes.find((r) => r.name === name);
      if (!entry || !entry.build) return null;
      return entry.build(params || {});
    }

    async go(name, params, { skipPush = false, fromPopstate = false } = {}) {
      const next = this._views.get(name);
      if (!next) { console.error("Unknown view:", name); return; }
      const prev = this._current;

      if (!skipPush && !fromPopstate) {
        const url = this.pathFor(name, params);
        if (url) {
          const current = window.location.pathname + window.location.search;
          try {
            if (current === url) {
              history.replaceState({ name, params: params || {} }, "", url);
            } else {
              history.pushState({ name, params: params || {} }, "", url);
              this._depth += 1;
            }
          } catch (_) {}
        }
      }

      // Instant visibility flip BEFORE any async work in mount().
      document.querySelectorAll("[data-view]").forEach((el) => {
        el.classList.toggle("hidden", el.dataset.view !== name);
      });
      window.scrollTo(0, 0);
      this._current = next;

      if (prev && prev !== next) {
        Promise.resolve().then(() => prev.unmount())
          .catch((e) => console.warn(`unmount(${prev.name}) failed:`, e));
      }
      await next.mount(params || {});
      if (next.refreshIcons) next.refreshIcons();
    }

    async back(fallback = "home") {
      if (this._depth > 0) {
        try { history.back(); return; } catch (_) {}
      }
      const url = this.pathFor(fallback, {});
      if (url) { try { history.replaceState({ name: fallback, params: {} }, "", url); } catch (_) {} }
      return this.go(fallback, {}, { skipPush: true });
    }

    async _onPopstate(ev) {
      const state = ev && ev.state;
      const target = (state && state.name)
        ? { name: state.name, params: state.params || {} }
        : this.matchPath(window.location.pathname);
      if (this._depth > 0) this._depth -= 1;
      await this.go(target.name, target.params, { skipPush: true, fromPopstate: true });
    }
  }

  window.View = View;
  window.router = new Router();
})();
