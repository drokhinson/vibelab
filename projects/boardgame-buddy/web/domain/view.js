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

    // Synchronous loading placeholder rendered before onMount() runs.
    // Default is a no-op; override in subclasses that fetch on mount.
    renderLoading() {}

    // Default render() is a no-op — subclasses override.
    render() {}
  }

  // Router ──────────────────────────────────────────────────────────────────────
  // Maintains its own back stack — the SPA never touches the browser history,
  // so history.back() doesn't work and we model it ourselves. router.back()
  // pops the most recent entry; falls back to a caller-chosen default
  // (e.g. 'feed') when the stack is empty.
  class Router {
    constructor() {
      this._views = new Map();
      this._current = null;
      this._stack = [];          // [{name, params}, ...]
      this._maxStack = 20;
    }

    register(name, view) {
      this._views.set(name, view);
    }

    async go(name, params, { skipPush = false } = {}) {
      const next = this._views.get(name);
      if (!next) {
        console.error("Unknown view:", name);
        return;
      }
      const prev = this._current;
      if (prev && prev !== next && !skipPush) {
        this._stack.push({ name: prev.name, params: prev.params || {} });
        if (this._stack.length > this._maxStack) this._stack.shift();
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

      document.querySelectorAll(".btm-nav button").forEach((btn) => {
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

      if (window.lucide) window.lucide.createIcons();
      if (window.api) window.api.trackEvent("view:" + name);
    }

    async back(fallback = "feed") {
      const entry = this._stack.pop();
      // skipPush so back→forward→back doesn't keep growing the stack.
      if (entry) return this.go(entry.name, entry.params, { skipPush: true });
      return this.go(fallback, {}, { skipPush: true });
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
