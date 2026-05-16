// domain/store.js — Namespaced pub/sub store. Replaces the legacy
// state.js global-let pattern with a single Store instance whose namespaces
// (session, feed, closet, activePlay, search) survive view unmount/remount.

(function () {
  class Store {
    constructor() {
      this._data = {
        session: null,        // Supabase auth session
        user: null,           // CurrentUser shape from /profile
        feed: null,           // FeedPageResponse (most recent first-page fetch)
        feedCursor: null,     // ISO timestamp of next page (null = none)
        feedLoading: false,
        activePlay: null,     // PlaySession serialized form (see play-session.js)
        search: null,         // last UnifiedSearchResponse
        currentView: "splash",
        currentRoute: { name: "splash", params: {} },
      };
      this._subs = new Map(); // key → Set<fn>
    }

    get(key) { return this._data[key]; }

    set(key, value) {
      const prev = this._data[key];
      if (prev === value) return;
      this._data[key] = value;
      const subs = this._subs.get(key);
      if (subs) {
        for (const fn of subs) {
          try { fn(value, prev); } catch (e) { console.error("Store sub error", e); }
        }
      }
    }

    // Manually fire a change without mutating — used by `invalidate('feed')` so
    // any subscribed view re-fetches.
    invalidate(key) {
      const subs = this._subs.get(key);
      if (subs) {
        for (const fn of subs) {
          try { fn(this._data[key], this._data[key]); } catch (e) { console.error(e); }
        }
      }
    }

    // Returns an unsubscribe fn. Views should call this in `unmount()`.
    subscribe(key, fn) {
      if (!this._subs.has(key)) this._subs.set(key, new Set());
      this._subs.get(key).add(fn);
      return () => this._subs.get(key).delete(fn);
    }

    reset() {
      this._data = {
        session: null,
        user: null,
        feed: null,
        feedCursor: null,
        feedLoading: false,
        activePlay: null,
        search: null,
        currentView: "splash",
        currentRoute: { name: "splash", params: {} },
      };
      for (const subs of this._subs.values()) {
        for (const fn of subs) {
          try { fn(null, null); } catch (_) {}
        }
      }
    }
  }

  window.Store = Store;
  window.store = new Store();
})();
