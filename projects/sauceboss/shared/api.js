// @ts-check
// API client factory — platform-agnostic. Native passes Expo's `fetch` and a
// Supabase token getter; future web can pass `window.fetch` and a Supabase JS
// session getter. Endpoint paths are defined here once.
//
// Backend returns sauces in two shapes:
//   * full envelopes (allSauces / browse-detail): `ingredients: [{name,...}]`
//   * slim saucebook envelopes (listSaucebook): `ingredientNames: [...strings]`
// Both paths funnel through `withIngredientNames` which produces the canonical
// `Set<string>` consumers query (see filter.js).
//
// Type contracts (see .claude/rules/typed-js.md): every method that reshapes
// the backend response into a different shape declares an `@returns` JSDoc
// tag below, so consumers can't drift away from the post-normalization shape.

import { withIngredientNames } from './filter.js';

/**
 * @typedef {Object<string, string>} IngredientCategoryMap
 *   Lowercased ingredient name → category label.
 *   e.g. `{ "garlic": "Produce", "olive oil": "Oils & Fats" }`.
 *   Post-013 the backend returns this dict directly (sauceboss_ingredient.category).
 *
 * @typedef {Object<string, string[]>} SubstitutionMap
 *   Ingredient name → list of substitute names.
 *   Post-013 the backend returns this dict directly (sauceboss_ingredient.substitutions[]).
 *
 * @typedef {Object} IngredientRow
 * @property {string} id
 * @property {string} name
 * @property {(string|null)=} plural
 * @property {(string|null)=} category
 * @property {(string[]|null)=} substitutions
 * @property {number=} usageCount
 * @property {number=} sauceCount
 * @property {(string|null)=} createdAt
 *
 * @typedef {Object} IngredientModifierRow
 * @property {string} id
 * @property {string} label    canonical lowercase label, e.g. "fresh" or "thinly sliced"
 * @property {'form'|'prep'} kind  form = source/state, prep = cut/preparation
 * @property {number} sortOrder
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
 *
 * @typedef {Object} PantryEntry
 * @property {string} ingredientId
 * @property {(string|null)=} foodId       — release/sauceboss-1.0 compat alias of ingredientId
 * @property {string} name
 * @property {(string|null)=} category     — joined from sauceboss_ingredient.category (NULL when uncategorized)
 * @property {boolean} missing
 *
 * @typedef {Object} PantryResponse
 * @property {PantryEntry[]} ingredients
 * @property {string[]} saucebookSauceIds
 *
 * @typedef {Object} ParsedIngredientResponse
 * @property {string} originalText
 * @property {(number|null)=} quantity
 * @property {(string|null)=} unitRaw
 * @property {(string|null)=} unitId
 * @property {string} ingredientRaw
 * @property {(number|null)=} canonicalMl
 * @property {(number|null)=} canonicalG
 * @property {(string|null)=} note
 * @property {(string|null)=} modifier
 *
 * @typedef {Object} ParsedRecipeResponse
 * @property {string} name
 * @property {string=} description
 * @property {(number|null)=} totalTimeMinutes
 * @property {(number|null)=} yieldServings
 * @property {string[]} instructions
 * @property {ParsedIngredientResponse[]} ingredients
 * @property {string} sourceUrl
 * @property {(string|null)=} canonicalUrl
 * @property {(string|null)=} warning
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

    // All dishes grouped by category — parents only with nested subtypes. Used
    // by the Sauce Builder's "pair with" picker.
    allItems: async () => {
      const data = await call('/items');
      return {
        carbs: data.carbs || [],
        proteins: data.proteins || [],
        salads: data.salads || [],
      };
    },

    // Post-013 the backend returns the dict shape directly (one round-trip,
    // reads sauceboss_ingredient.category — no join, no array-to-dict reshape).
    /** @returns {Promise<IngredientCategoryMap>} */
    ingredientCategories: async () => {
      const data = await call('/ingredient-categories');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    },
    // Post-013 the backend returns the dict shape directly (one round-trip,
    // reads sauceboss_ingredient.substitutions[]).
    /** @returns {Promise<SubstitutionMap>} */
    substitutions: async () => {
      const data = await call('/substitutions');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    },

    units: async () => {
      const data = await call('/units');
      return data.units || [];
    },

    /** @returns {Promise<IngredientModifierRow[]>} */
    ingredientModifiers: async () => {
      const data = await call('/ingredient-modifiers');
      return (data && data.modifiers) || [];
    },

    /** @returns {Promise<IngredientRow[]>} */
    ingredients: async (q, limit = 20) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      params.set('limit', String(limit));
      const data = await call(`/ingredients?${params.toString()}`);
      return data.ingredients || [];
    },

    /** @returns {Promise<ParsedRecipeResponse>} */
    importRecipeFromUrl: (url) => call('/import', { method: 'POST', body: { url } }),

    /**
     * Parse pasted text (or HTML markup) into a recipe draft.
     * Used for non-JSON file uploads (.txt/.md/.html) and for manually-pasted
     * Instagram captions when the auto-fetch can't reach the post.
     * @param {string} text
     * @param {(string|null)=} sourceUrl
     * @param {'text'|'html'=} contentType
     * @returns {Promise<ParsedRecipeResponse>}
     */
    importRecipeFromText: (text, sourceUrl = null, contentType = 'text') =>
      call('/import/text', { method: 'POST', body: { text, sourceUrl, contentType } }),

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

    // ── Profile (auth required) ──────────────────────────────────────────────
    getProfile: () => call('/profile'),
    upsertProfile: (displayName) => call('/profile', { method: 'POST', body: { display_name: displayName } }),
    becomeAdmin: (adminKey) => call('/profile/become-admin', { method: 'POST', body: { admin_key: adminKey } }),
    deleteProfile: () => call('/profile', { method: 'DELETE' }),

    // ── Authoring (auth required) ────────────────────────────────────────────
    createSauce: (data) => call('/sauces', { method: 'POST', body: data }),
    updateSauce: (id, data) => call(`/sauces/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    // Owner-or-admin delete. Backend enforces created_by match unless caller is_admin.
    deleteSauce: (id) => call(`/sauces/${encodeURIComponent(id)}`, { method: 'DELETE' }),

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
    /** @returns {Promise<IngredientRow[]>} */
    listIngredientsWithUsage: async () => {
      const data = await call('/ingredients-with-usage');
      return data.ingredients || [];
    },
    createIngredient: (payload) => call('/admin/ingredients', { method: 'POST', body: payload }),
    updateIngredient: (id, payload) => call(`/admin/ingredients/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
    // 409 if usageCount > 0 — caller must merge first.
    deleteIngredient: (id) => call(`/admin/ingredients/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    mergeIngredients: (keepId, mergeIds) => call('/admin/ingredients/merge', {
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

    // ── Saucebook (auth required) ────────────────────────────────────────────
    // Reference-based: sauces here are owned by their authors. Editing a
    // non-owned sauce server-side returns `{ forkedId }` (a new variant under
    // the family root, owned by the caller); the caller's saucebook row is
    // repointed to the new variant atomically.
    //
    // Slim envelope (Browse-shaped + addedAt + ingredientNames TEXT[]). No
    // `steps` / full `ingredients` — recipe view fetches the full envelope
    // via /sauces on tap (saucebookOpenRecipe → api.allSauces).
    /**
     * Slim metadata only — ingredientNames is NOT included by the backend
     * (migration 026 dropped the expensive ingredient_names_agg CTE). Callers
     * that need ingredient-availability filtering should hydrate from
     * api.allSauces() locally; web/auth.js loadSaucebook() is the reference.
     * withIngredientNames is still applied so each row carries an (initially
     * empty) Set ready for replacement.
     *
     * @returns {Promise<Array<{
     *   id: string, name: string, cuisine: string, cuisineEmoji: string,
     *   color: string, sauceType: string, createdBy: (string|null),
     *   authorName: string, parentSauceId: (string|null),
     *   addedAt: string, variantCount: number,
     *   attachments: Array<{kind: string, value: string}>,
     *   ingredientNames: Set<string>,
     * }>>}
     */
    listSaucebook: async () => {
      const data = await call('/saucebook');
      return (data?.sauces || []).map(withIngredientNames);
    },
    addToSaucebook:    (id) => call(`/saucebook/${encodeURIComponent(id)}`, { method: 'POST' }),
    removeFromSaucebook: (id) => call(`/saucebook/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ── Filter lookups (public, cached client-side) ───────────────────────────
    /** @returns {Promise<Array<{cuisine: string, emoji: string}>>} */
    cuisines: async () => {
      const data = await call('/cuisines');
      return Array.isArray(data) ? data : [];
    },
    /** @returns {Promise<Array<{id: string, name: string, emoji: string, category: string}>>} */
    filterDishes: async () => {
      const data = await call('/filter-dishes');
      return Array.isArray(data) ? data : [];
    },

    // ── Browse (auth optional; richer when signed in) ────────────────────────
    // Returns lightweight rows (no steps / ingredients) for a paginated
    // family-roots-only listing. Filters: q (name substring), cuisines[],
    // types[], dishes[], author (uuid). Sorted latest-first.
    browseSauces: async ({ q = '', cuisines = [], types = [], dishes = [], author = null, limit = 20, offset = 0 } = {}) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      for (const c of cuisines) params.append('cuisine', c);
      for (const t of types) params.append('type', t);
      for (const d of dishes) params.append('dish', d);
      if (author) params.set('author', author);
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      const data = await call(`/browse?${params.toString()}`);
      return { total: data?.total || 0, items: data?.items || [] };
    },
    listAuthors: async (q = '') => {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      return (await call(`/authors${params}`)) || [];
    },

    // ── Pantry (auth required) ───────────────────────────────────────────────
    // Negative list: rows in `missingIngredientIds` are ingredients the user is
    // OUT of. The Pantry tab + the meal-builder ingredient filter both write
    // here so the two views two-way-sync.
    getPantry: async () => {
      const data = await call('/pantry');
      return {
        ingredients: data?.ingredients || [],
        saucebookSauceIds: data?.saucebookSauceIds || [],
      };
    },
    setPantryMissing: async (missingIngredientIds) => {
      const data = await call('/pantry', { method: 'PUT', body: { missingIngredientIds } });
      return {
        ingredients: data?.ingredients || [],
        saucebookSauceIds: data?.saucebookSauceIds || [],
      };
    },
  };
}
