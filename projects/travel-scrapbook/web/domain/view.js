// domain/view.js — View base class + History-API Router.
// Adapted from the canonical implementation in
// projects/boardgame-buddy/web/domain/view.js with this app's route table.

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

    async mount(params) {
      if (this._mounted) {
        this.params = params || {};
        await this.onParamsChange?.(this.params);
        return;
      }
      this._mounted = true;
      this.params = params || {};
      try { this.renderLoading(); } catch (_) {}
      await this.onMount?.();
      this.render();
    }

    async unmount() {
      if (!this._mounted) return;
      this._mounted = false;
      for (const fn of this._unsubs) { try { fn(); } catch (_) {} }
      this._unsubs = [];
      await this.onUnmount?.();
    }

    listen(key, fn) {
      this._unsubs.push(window.store.subscribe(key, fn));
    }

    refreshIcons(root) {
      if (!window.lucide) return;
      const el = root || this.container;
      if (el) window.lucide.createIcons({ root: el });
      else window.lucide.createIcons();
    }

    renderLoading() {}
    render() {}
  }

  class Router {
    constructor() {
      this._views = new Map();
      this._current = null;
      this._stack = [];
      this._maxStack = 20;
      this._routes = [
        { name: 'login',    pattern: /^\/login\/?$/,          build: () => '/login' },
        { name: 'scrap',    pattern: /^\/scrap\/?$/,          build: () => '/scrap' },
        { name: 'share',    pattern: /^\/share\/?$/,          build: () => '/share' },
        { name: 'inbox',    pattern: /^\/inbox\/?$/,          build: () => '/inbox' },
        { name: 'settings', pattern: /^\/settings\/?$/,       build: () => '/settings' },
        { name: 'trip',     pattern: /^\/trip\/([^/]+)\/?$/,
          consume: ['tripId'],
          extract: (m) => ({ tripId: decodeURIComponent(m[1]) }),
          build: (p) => `/trip/${encodeURIComponent(p.tripId || '')}` },
        { name: 'trips',    pattern: /^\/?$/,                 build: () => '/' },
      ];
      window.addEventListener('popstate', (ev) => this._onPopstate(ev));
    }

    register(name, view) { this._views.set(name, view); }

    matchPath(pathname) {
      const path = (pathname || '/').split('?')[0];
      for (const r of this._routes) {
        if (!r.pattern) continue;
        const m = path.match(r.pattern);
        if (m) {
          const params = r.extract ? r.extract(m) : {};
          // Merge querystring extras (e.g. /scrap?url=…&title=…).
          for (const [k, v] of new URLSearchParams(window.location.search)) {
            if (!(k in params)) params[k] = v;
          }
          return { name: r.name, params };
        }
      }
      return null;
    }

    pathFor(name, params) {
      const entry = this._routes.find((r) => r.name === name);
      if (!entry || !entry.build) return null;
      const p = params || {};
      const url = entry.build(p);
      const consumed = entry.consume || [];
      const extras = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) {
        if (consumed.includes(k) || v == null || v === '') continue;
        extras.set(k, String(v));
      }
      const qs = extras.toString();
      return qs ? `${url}?${qs}` : url;
    }

    async go(name, params, { skipPush = false, fromPopstate = false } = {}) {
      const next = this._views.get(name);
      if (!next) { console.error('Unknown view:', name); return; }
      const prev = this._current;
      if (prev && prev !== next && !skipPush && !fromPopstate && prev.name !== 'splash') {
        this._stack.push({ name: prev.name, params: prev.params || {} });
        if (this._stack.length > this._maxStack) this._stack.shift();
      }

      if (!skipPush && !fromPopstate) {
        const url = this.pathFor(name, params);
        if (url) {
          const current = window.location.pathname + window.location.search;
          try {
            if (current === url) history.replaceState({ name, params: params || {} }, '', url);
            else history.pushState({ name, params: params || {} }, '', url);
          } catch (_) {}
        }
      }

      // Instant visibility flip before any awaited work.
      window.store.set('currentRoute', { name, params: params || {} });
      document.querySelectorAll('[data-view]').forEach((el) => {
        el.classList.toggle('hidden', el.dataset.view !== name);
      });
      const authed = !!window.store.get('user');
      document.querySelectorAll('[data-auth-only]').forEach((el) => {
        el.classList.toggle('hidden', !authed || document.body.classList.contains('popup-mode'));
      });
      document.querySelectorAll('.ts-header__nav button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.nav === name);
      });

      this._current = next;
      if (prev && prev !== next) {
        Promise.resolve().then(() => prev.unmount())
          .catch((e) => console.warn(`unmount(${prev.name}) failed:`, e));
      }
      await next.mount(params);
      next.refreshIcons?.();
      window.api?.trackEvent('view:' + name);
    }

    async back(fallback = 'trips') {
      if (this._stack.length > 0) {
        try { history.back(); return; } catch (_) {}
      }
      const url = this.pathFor(fallback, {});
      if (url) { try { history.replaceState({ name: fallback, params: {} }, '', url); } catch (_) {} }
      return this.go(fallback, {}, { skipPush: true });
    }

    async _onPopstate(ev) {
      const state = ev && ev.state;
      const target = state?.name
        ? { name: state.name, params: state.params || {} }
        : this.matchPath(window.location.pathname);
      if (!target) return;
      this._stack.pop();
      await this.go(target.name, target.params, { skipPush: true, fromPopstate: true });
    }
  }

  window.View = View;
  window.Router = Router;
  window.router = new Router();
})();
