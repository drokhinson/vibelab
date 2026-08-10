// Module-level TTL cache + serve-then-refresh hook. Screen-local paginated
// data (collection grid pages, plays list, buddies, profile bundles) lives
// here, NOT in global state. Mirrors web/domain/cache.js.
//
// Contract (anti-stale rules):
//   • get() serves cached data instantly so navigation never blocks.
//   • useCachedResource always revalidates in the background and exposes
//     `refreshing` so screens can show a RefreshHint — data is never
//     silently stale.
//   • Mutations call invalidate(prefix) so the next read refetches.

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const _store = new Map(); // key -> { data, at }

export const cache = {
  get(key, { ttl = DEFAULT_TTL_MS } = {}) {
    const hit = _store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > ttl) {
      _store.delete(key);
      return undefined;
    }
    return hit.data;
  },
  /** Like get() but returns even expired entries (for offline fallback). */
  getStale(key) {
    return _store.get(key)?.data;
  },
  set(key, data) {
    _store.set(key, { data, at: Date.now() });
  },
  /** Drop every key that starts with prefix ('' clears all). */
  invalidate(prefix = '') {
    for (const key of _store.keys()) {
      if (key.startsWith(prefix)) _store.delete(key);
    }
  },
};

/**
 * Serve-then-refresh resource hook.
 *   const { data, loading, refreshing, error, refresh } = useCachedResource(
 *     `plays:${filterKey}`, () => api.plays(params));
 *
 * - Cached data renders immediately (loading=false, refreshing=true while the
 *   background revalidation runs).
 * - No cached data → loading=true until the fetch lands.
 * - key change re-runs the cycle. refresh() forces a refetch (pull-to-refresh).
 *
 * @template T
 * @param {string|null} key   null disables the hook (e.g. waiting on auth)
 * @param {() => Promise<T>} fetcher
 * @param {{ ttl?: number }} [opts]
 */
export function useCachedResource(key, fetcher, { ttl = DEFAULT_TTL_MS } = {}) {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const cached = key != null ? cache.get(key, { ttl }) : undefined;
  const [state, setState] = useState({
    data: cached,
    loading: key != null && cached === undefined,
    refreshing: false,
    error: null,
  });
  // Monotonic token — a stale fetch resolving late must not clobber a newer
  // key's data (async state & race conditions rule).
  const seqRef = useRef(0);

  const run = useCallback(
    async (mode) => {
      if (key == null) return;
      const seq = ++seqRef.current;
      setState((s) => ({
        ...s,
        loading: mode === 'initial',
        refreshing: mode !== 'initial',
        error: mode === 'initial' ? null : s.error,
      }));
      try {
        const data = await fetcherRef.current();
        if (seq !== seqRef.current) return;
        cache.set(key, data);
        setState({ data, loading: false, refreshing: false, error: null });
      } catch (e) {
        if (seq !== seqRef.current) return;
        setState((s) => ({
          // Keep stale data visible on a failed refresh; only surface the
          // error when we had nothing to show.
          data: s.data,
          loading: false,
          refreshing: false,
          error: s.data === undefined ? e : null,
        }));
      }
    },
    [key],
  );

  useEffect(() => {
    if (key == null) return;
    const hit = cache.get(key, { ttl });
    if (hit !== undefined) {
      setState({ data: hit, loading: false, refreshing: true, error: null });
      run('revalidate');
    } else {
      setState({ data: undefined, loading: true, refreshing: false, error: null });
      run('initial');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = useCallback(() => run('refresh'), [run]);

  return { ...state, refresh };
}

export default cache;
