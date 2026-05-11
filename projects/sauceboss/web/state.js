'use strict';

// Builder constants (CUISINES, UNITS, COLOR_SWATCHES, SAUCE_TYPES, PALETTE,
// ING_COLOR, STEP_OUTPUT_COLOR, TO_TSP, VOLUME_TO_ML, WEIGHT_TO_G, COUNT_UNITS,
// CATEGORY_ORDER) are defined in shared/constants.js and exposed on `window`
// by shared-bridge.js — they're available as globals from this script onward.

// ─── Auth ─────────────────────────────────────────────────────────────────────
let supabaseClient = null;
let session = null;          // Supabase auth session (full JWT) or null
let currentUser = null;      // { id, display_name, is_admin } or null

// ─── Global state ─────────────────────────────────────────────────────────────
let state = {
  // ── Tab-bar navigation (added by the saucebook redesign) ───────────────────
  // Three primary tabs in the bottom nav: 'browse' | 'saucebook' | 'pantry'.
  // Anonymous users land on 'browse'; the others render lock badges and route
  // to the auth modal on tap (see tabs.js setActiveTab).
  activeTab: 'browse',

  // ── Current screen ──────────────────────────────────────────────────────────
  // 'tab-shell' = the tab content (saucebook / browse / pantry); other values
  // are screens that appear on top of the tab shell (meal builder steps,
  // recipe view, recipe builder, admin).
  screen: 'tab-shell',
  loading: null,                // when set, the active screen renders an inline pot loader

  // ── Initial-load lists (populated once on boot) ────────────────────────────
  carbs: [],
  proteins: [],
  saladBases: [],
  // ── Dynamic filter lookups (loaded once on boot, used by Browse + Saucebook) ──
  allCuisines: [],              // [{cuisine, emoji}] from GET /cuisines
  allFilterDishes: [],          // [{id, name, emoji, category}] from GET /filter-dishes
  // ── Saucebook (per-user library; references — not copies). Populated by
  // api.listSaucebook() on login; cleared on logout. Each row is a full sauce
  // envelope (matches all-sauces-full shape) plus addedAt + authorName +
  // variantCount. Used by the Saucebook tab + meal-builder filter + Pantry.
  saucebook: [],
  saucebookLoading: false,
  saucebookLoaded: false,
  saucebookSearch: '',

  // ── Browse tab state ──────────────────────────────────────────────────────
  browse: {
    items: [],                  // current page of lightweight rows
    total: 0,
    q: '',
    cuisines: new Set(),        // multi-select cuisine filter
    cuisineFilterQ: '',         // type-to-filter text for narrowing cuisine chips
    types: new Set(),           // multi-select type filter (sauce/marinade/dressing/dip)
    dishes: new Set(),          // multi-select compatible-dish filter (dish ids)
    dishFilterQ: '',            // type-to-filter text for narrowing dish chips
    authorId: null,             // selected author (uuid) or null
    authorQuery: '',            // current author autocomplete query
    authorResults: [],          // [{ userId, displayName, sauceCount }]
    page: 0,
    pageSize: 20,
    loading: false,
    hasMore: true,
    filtersOpen: false,
    error: null,
  },

  // ── Pantry tab state (negative list — rows here are foods the user is OUT of) ─
  pantry: {
    ingredients: [],            // [{ ingredientId, name, missing }]
    missing: new Set(),         // Set<ingredientId> — synced to /pantry on every change
    loading: false,
    error: null,
  },

  // ── Meal-builder flow (category → dish/subtype → sauce → recipe) ─────────
  mealFlow: {
    category: null,             // 'carb' | 'protein' | 'salad'
    dish: null,                 // sauceboss_dish row at dish_level='dish'
    subtype: null,              // optional sauceboss_dish row at dish_level='subtype'
  },

  // ── Current selection (legacy — kept for the recipe-view path) ──────────────
  selectedItem: null,           // a parent item (carb / protein / salad)
  selectedPrep: null,           // optional variant of selectedItem
  preparations: [],             // variants for selectedItem (may be empty)
  saucesForCurrentItem: [],     // sauces/marinades/dressings paired with selectedItem
  allIngredients: [],           // unique ingredient names across saucesForCurrentItem
  selectedSauce: null,
  selectedSauceFamily: [],      // [root, ...variants] for selectedSauce; powers the recipe-view variant switcher
  servings: 2,
  unitSystem: 'imperial',       // 'imperial' | 'metric'
  ingredientCategories: {},
  substitutions: {},
  filterOpen: false,
  recipeIngredientsOpen: false,
  expandedCuisines: new Set(),

  // ── Final meal (filled from selections above when sauce is picked) ─────────
  meal: {
    item: null,                 // the chosen carb / protein / salad
    prep: null,                 // optional chosen variant
    sauce: null,                // the chosen sauce (sauce / marinade / dressing)
  },

  authModalOpen: false,         // sign-in modal visibility
  authMode: 'login',            // 'login' | 'signup'
  authBusy: false,
  authError: null,
  becomeAdminBusy: false,
  becomeAdminError: null,

  // ── Edit mode ──────────────────────────────────────────────────────────────
  // Toggle that gates editorial UI (FABs, edit/delete buttons, import/export).
  // Visible only to logged-in users; anonymous users never see editing chrome.
  editMode: false,

  // ── Admin / builder ─────────────────────────────────────────────────────────
  builder: null,
  adminSauces: [],
  adminError: null,
  adminSaucesLoading: false,                                       // tab-scoped loaders for sauce manager
  adminItemsLoading: false,
  adminIngredientsLoading: false,
  sauceManagerTab: 'sauces',                                      // 'sauces' | 'dish' | 'ingredients'
  sauceManagerSearch: '',                                          // search query (applies to active tab)
  sauceManagerTypeFilter: 'all',                                   // 'all' | 'sauce' | 'marinade' | 'dressing'
  itemSections: { carbs: false, proteins: false, salads: false }, // category-level expand (default collapsed)
  cuisineSections: {},                                             // { [cuisine]: true } — open only when explicitly true
  expandedParents: {},                                             // { [parentId]: true }
  adminItems: { carbs: [], proteins: [], salads: [] },             // parents w/ nested variants
  itemForm: null,                                                  // shared add/edit form
  sauceMerge: null,                                                // { keepId, mergeIds: Set<id>, saving, error } — long-press a sauce in the manager to enter "assign variants" mode

  // ── Ingredients tab ────────────────────────────────────────────────────────
  adminIngredients: [],                                                  // [{ id, name, plural, usageCount, sauceCount }]
  foodForm: null,                                                  // { mode: 'add' | 'edit', id?, name, category, categoryDraft, error?, saving? }
  foodMerge: null,                                                 // { keepId, mergeIds: Set<string>, error?, saving? }
  ingredientSections: {},                                          // { [category]: true } — open only when explicitly true
  expandedFoodIds: new Set(),                                      // food ids whose sauces panel is open
};

// disabledIngredients: Set<ingredientName> — kept as a real mutable Set so
// existing filter helpers (`isSauceAvailable`, `missingSauceIngredients`,
// `getSubstitutionText`) work unchanged. For logged-in users, `auth.js`
// mirrors `state.pantry.missing` (Set<ingredientId>) into this set after each
// pantry hydration, and `togglePantryMissing` keeps the two in sync.
state.disabledIngredients = new Set();

function defaultBuilder() {
  return {
    // ── Wizard navigation ──────────────────────────────────────────────
    recipeSource: null,          // 'url' | 'reel' | 'file' | 'manual' | null
    returnToReview: false,       // when true, Continue on any step jumps to review

    // ── Recipe info ────────────────────────────────────────────────────
    name: '', cuisine: '', cuisineEmoji: '', color: '', description: '', sourceUrl: '',
    sauceType: '',               // '' | 'sauce' | 'marinade' | 'dressing' — must be selected by user

    // ── Steps & ingredients ────────────────────────────────────────────
    steps: [{ title: '', instructions: '', inputFromStep: null, estimatedTime: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] }],
    unassignedIngredients: [],   // imported ingredients not yet placed in a step; recipe cannot save while non-empty
    itemIds: [], saving: false, error: null,
    acStep: null, acIng: null, acResults: [], acSelected: -1,
    pendingCategories: [],
    importUrl: '', importing: false, importError: null,
    cuisineDraftMode: false, cuisineDraftName: '', cuisineDraftEmoji: '',
    editingId: null,             // when set, builderSave PATCHes instead of POSTing
  };
}
