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
      if (prev && prev !== next) {
        if (!skipPush) {
          this._stack.push({ name: prev.name, params: prev.params || {} });
          if (this._stack.length > this._maxStack) this._stack.shift();
        }
        await prev.unmount();
      }
      window.store.set("currentRoute", { name, params: params || {} });
      window.store.set("currentView", name);

      // Toggle DaisyUI containers
      document.querySelectorAll("[data-view]").forEach((el) => {
        el.classList.toggle("hidden", el.dataset.view !== name);
      });

      this._current = next;
      await next.mount(params);

      // Auth-only chrome visibility
      const authed = !!window.store.get("user");
      document.querySelectorAll("[data-auth-only]").forEach((el) => {
        el.classList.toggle("hidden", !authed);
      });

      // Bottom-nav active state (only when authed).
      document.querySelectorAll(".btm-nav button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.nav === name);
      });

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
