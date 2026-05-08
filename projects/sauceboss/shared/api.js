// @ts-check
// API client factory — platform-agnostic. Native passes Expo's `fetch` and a
// Supabase token getter; future web can pass `window.fetch` and a Supabase JS
// session getter. Endpoint paths are defined here once.
//
// Backend returns sauces with `ingredients[]`. We attach an `ingredientNames`
// Set so screens can do O(1) lookups in the filter — same shape the web app uses.
//
// Type contracts (see .claude/rules/typed-js.md): every method that reshapes
// the backend response into a different shape declares an `@returns` JSDoc
// tag below, so consumers can't drift away from the post-normalization shape.

import { withIngredientNames } from './filter.js';

/**
 * @typedef {Object<string, string>} IngredientCategoryMap
 *   Lowercased ingredient name → category label.
 *   e.g. `{ "garlic": "Produce", "olive oil": "Oils & Fats" }`.
 *   The backend returns this as an array of `{ ingredientName, category }`
 *   rows; `api.ingredientCategories()` reshapes it into this dict.
 *
 * @typedef {Object} SubstitutionEntry
 * @property {string} substituteName
 * @property {(string|null)=} notes
 *
 * @typedef {Object<string, SubstitutionEntry[]>} SubstitutionMap
 *   Ingredient name → list of substitutes. Backend returns a flat array of
 *   `{ ingredientName, substituteName, notes }` rows; `api.substitutions()`
 *   groups them under their ingredient name.
 *
 * @typedef {Object} FoodRow
 * @property {string} id
 * @property {string} name
 * @property {(string|null)=} plural
 * @property {number=} usageCount
 * @property {number=} sauceCount
 * @property {(string|null)=} createdAt
 *
 * @typedef {Object} UnitRow
 * @property {string} id
 * @property {string} singular
 * @property {string} plural
 * @property {string} abbrev
 * @property {string} abbrevPlural
 * @property {string} dimension
 * @property {(number|null)=} canonicalMl
 * @property {(number|null)=} canonicalG
 * @property {string[]=} aliases
 */

const PREFIX = '/api/v1/sauceboss';

// Coerce FastAPI's `detail` (string | object | list of validation errors)
// into a single readable line. Without this, Pydantic 422s render as
// "[object Object]" because Array.toString returns "[object Object]" on RN.
function formatErrorDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object' && detail.message) return detail.message;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== 'body').join('.') : '';
        const msg = d?.msg || d?.message || JSON.stringify(d);
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join('; ');
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

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
        detail = formatErrorDetail(j.detail);
      } catch {
        // ignore — fall through to status text
      }
      const msg = detail ? `${res.status} ${detail}` : `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Same plumbing as `call`, but returns the raw response body as text.
  // Used by the export endpoints (which return `application/json` or
  // `text/markdown` files via `Content-Disposition: attachment`) where the
  // caller wants the bytes verbatim to write to disk + share, not parsed.
  async function callText(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = await _getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url = `${base}${PREFIX}${path}`;
    const res = await _fetch(url, { ...opts, headers });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
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

    // Normalize the array response into the dict shape every consumer expects:
    //   `{ "tomato": "Produce", "olive oil": "Oils & Fats", ... }`
    // The backend returns `[{ ingredientName, category }, ...]` so without this
    // step `cats[name]` lookups silently fall back to "Uncategorized" (and the
    // ingredient filter panel falls back to "Pantry Staples" for everything).
    /** @returns {Promise<IngredientCategoryMap>} */
    ingredientCategories: async () => {
      const data = await call('/ingredient-categories');
      if (!Array.isArray(data)) return data || {};
      /** @type {IngredientCategoryMap} */
      const out = {};
      for (const c of data) {
        if (c && c.ingredientName) out[c.ingredientName] = c.category;
      }
      return out;
    },
    // Same shape problem as ingredient-categories: backend returns
    //   `[{ ingredientName, substituteName, notes }, ...]`
    // but consumers (StepCard, the recipe view) expect
    //   `{ "<name>": [{ substituteName, notes }, ...] }`
    /** @returns {Promise<SubstitutionMap>} */
    substitutions: async () => {
      const data = await call('/substitutions');
      if (!Array.isArray(data)) return data || {};
      /** @type {SubstitutionMap} */
      const out = {};
      for (const s of data) {
        if (!s || !s.ingredientName) continue;
        if (!out[s.ingredientName]) out[s.ingredientName] = [];
        out[s.ingredientName].push({ substituteName: s.substituteName, notes: s.notes });
      }
      return out;
    },

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

    // ── Single-sauce export (public) ─────────────────────────────────────────
    // Both return the raw response body as a string so the caller can write
    // it to disk and hand it to the platform's share sheet. JSON returns the
    // versioned single-sauce envelope; MD returns the human-readable
    // markdown the backend renders via `_render_sauce_markdown`.
    exportSauceJson: (id) => callText(`/sauces/${encodeURIComponent(id)}/export.json`),
    exportSauceMd:   (id) => callText(`/sauces/${encodeURIComponent(id)}/export.md`),

    // Bulk admin export — every sauce in the catalog as a single versioned
    // JSON envelope. Backend gates on JWT + is_admin (`get_current_admin`).
    exportAllSaucesJson: () => callText('/admin/sauces/export.json'),

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

    // POST upserts an ingredient → category mapping. Used by the Food form
    // when the admin / authoring user classifies a freshly added or renamed
    // ingredient. Mirrors the web's classifyIngredient.
    classifyIngredient: (ingredientName, category) => call('/ingredient-categories', {
      method: 'POST',
      body: { ingredientName, category },
    }),

    // ── Sauce-manager Dish tab (admin CRUD) ─────────────────────────────────
    createItem: (payload) => call('/admin/items', { method: 'POST', body: payload }),
    updateItem: (id, payload) => call(`/admin/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
    deleteItem: (id) => call(`/admin/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ── Sauce-manager Sauces tab (admin) ────────────────────────────────────
    // Admin-scoped variant of /sauces. Returns every sauce regardless of pairings,
    // including unpaired roots, so the manager can edit/merge/delete.
    adminListSauces: () => call('/admin/sauces'),
    // Admin force-delete (bypasses owner check). Owners can use deleteSauce above.
    adminDeleteSauce: (id) => call(`/admin/sauces/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ── Sauce-manager Ingredients tab (mostly admin) ─────────────────────────
    /** @returns {Promise<FoodRow[]>} */
    listFoodsWithUsage: async () => {
      const data = await call('/foods-with-usage');
      return data.foods || [];
    },
    createFood: (payload) => call('/admin/foods', { method: 'POST', body: payload }),
    updateFood: (id, payload) => call(`/admin/foods/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
    // 409 if usageCount > 0 — caller must merge first.
    deleteFood: (id) => call(`/admin/foods/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    mergeFoods: (keepId, mergeIds) => call('/admin/foods/merge', {
      method: 'POST',
      body: { keepId, mergeIds },
    }),

    // Bulk-assign sauces as variants of a parent. Admin only — sets
    // parent_sauce_id = parentId on every sauce in sauceIds. Backend rejects
    // parents that are themselves variants, self-references, or targets that
    // already have variants of their own.
    assignSauceVariants: (parentId, sauceIds) => call(
      `/admin/sauces/${encodeURIComponent(parentId)}/variants`,
      { method: 'POST', body: { sauceIds } },
    ),
  };
}
