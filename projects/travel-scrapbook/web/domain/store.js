// domain/store.js — tiny pub/sub state store shared across views.
(function () {
  const _data = new Map();
  const _subs = new Map(); // key → Set<fn>

  window.store = {
    get(key) { return _data.get(key); },
    set(key, value) {
      _data.set(key, value);
      const subs = _subs.get(key);
      if (subs) for (const fn of subs) { try { fn(value); } catch (e) { console.error(e); } }
    },
    subscribe(key, fn) {
      if (!_subs.has(key)) _subs.set(key, new Set());
      _subs.get(key).add(fn);
      return () => _subs.get(key)?.delete(fn);
    },
  };
})();
