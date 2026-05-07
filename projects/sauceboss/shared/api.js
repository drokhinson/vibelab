// API client factory — platform-agnostic. Native passes Expo's `fetch` and a
// Supabase token getter; future web can pass `window.fetch` and a Supabase JS
// session getter. Endpoint paths are defined here once.
//
// Backend returns sauces with `ingredients[]`. We attach an `ingredientNames`
// Set so screens can do O(1) lookups in the filter — same shape the web app uses.

import { withIngredientNames } from './filter.js';

const PREFIX = '/api/v1/sauceboss';

export function makeApi({ fetchFn, getAuthToken, baseUrl }) {
  const _fetch = fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!_fetch) throw new Error('makeApi requires a fetchFn');
  const _getToken = getAuthToken || (() => null);
  const base = (baseUrl || '').replace(/\/$/, '');

  async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = await _getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const url = `${base}${PREFIX}${path}`;
    const res = await _fetch(url, { ...opts, headers, body });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j.detail && j.detail.message) || j.detail || '';
      } catch {
        // ignore
      }
      const msg = detail ? `${res.status} ${detail}` : `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    // ── Public ────────────────────────────────────────────────────────────────
    health: () => call('/health'),

    initialLoad: async () => {
      const data = await call('/initial-load');
      return {
        carbs: data.carbs || [],
        proteins: data.proteins || [],
        saladBases: data.saladBases || [],
      };
    },

    itemLoad: async (itemId) => {
      const data = await call(`/items/${encodeURIComponent(itemId)}/load`);
      return {
        item: data.item || null,
        variants: data.variants || [],
        sauces: (data.sauces || []).map(withIngredientNames),
        ingredients: data.ingredients || [],
      };
    },

    // All items grouped by category — parents only with nested variants. Used
    // by the Sauce Builder's "pair with" picker.
    allItems: async () => {
      const data = await call('/items');
      return {
        carbs: data.carbs || [],
        proteins: data.proteins || [],
        salads: data.salads || [],
      };
    },

    ingredientCategories: () => call('/ingredient-categories'),
    substitutions: () => call('/substitutions'),

    units: async () => {
      const data = await call('/units');
      return data.units || [];
    },

    foods: async (q, limit = 20) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      params.set('limit', String(limit));
      const data = await call(`/foods?${params.toString()}`);
      return data.foods || [];
    },

    importRecipeFromUrl: (url) => call('/import', { method: 'POST', body: { url } }),

    allSauces: async () => {
      const sauces = await call('/sauces');
      return sauces.map(withIngredientNames);
    },

    // ── Profile + favorites (auth required) ──────────────────────────────────
    getProfile: () => call('/profile'),
    upsertProfile: (displayName) => call('/profile', { method: 'POST', body: { display_name: displayName } }),
    becomeAdmin: (adminKey) => call('/profile/become-admin', { method: 'POST', body: { admin_key: adminKey } }),
    deleteProfile: () => call('/profile', { method: 'DELETE' }),

    listFavorites: async () => {
      const data = await call('/favorites');
      const map = new Map();
      for (const entry of data.favorites || []) {
        map.set(entry.sauceId, entry.createdAt || null);
      }
      return map;
    },
    addFavorite: (sauceId) => call(`/favorites/${encodeURIComponent(sauceId)}`, { method: 'PUT' }),
    removeFavorite: (sauceId) => call(`/favorites/${encodeURIComponent(sauceId)}`, { method: 'DELETE' }),

    // ── Authoring (auth required) ────────────────────────────────────────────
    createSauce: (data) => call('/sauces', { method: 'POST', body: data }),
    updateSauce: (id, data) => call(`/sauces/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    // Owner-or-admin delete. Backend enforces created_by match unless caller is_admin.
    deleteSauce: (id) => call(`/sauces/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    createFood: (payload) => call('/admin/foods', { method: 'POST', body: payload }),
  };
}
