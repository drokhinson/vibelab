'use strict';

// Builder constants (CUISINES, UNITS, COLOR_SWATCHES, SAUCE_TYPES, PALETTE,
// ING_COLOR, STEP_OUTPUT_COLOR, TO_TSP, VOLUME_TO_ML, WEIGHT_TO_G, COUNT_UNITS,
// CATEGORY_ORDER) are defined in shared/constants.js and exposed on `window`
// by shared-bridge.js — they're available as globals from this script onward.

// ─── Auth ─────────────────────────────────────────────────────────────────────
let supabaseClient = null;
let session = null;          // Supabase auth session (full JWT) or null
let currentUser = null;      // { user_id, display_name, is_admin } or null

// ─── Global state ─────────────────────────────────────────────────────────────
let state = {
  // ── Current screen ──────────────────────────────────────────────────────────
  screen: 'meal-builder',       // home is the meal builder
  loading: null,                // when set, the active screen renders an inline pot loader
  mealCategory: 'carbs',        // 'carbs' | 'proteins' | 'salads' — active home tab

  // ── Initial-load lists (populated once on boot) ────────────────────────────
  carbs: [],
  proteins: [],
  saladBases: [],

  // ── Current selection (one item flow) ───────────────────────────────────────
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
  disabledIngredients: new Set(),
  filterOpen: false,
  expandedCuisines: new Set(),

  // ── Final meal (filled from selections above when sauce is picked) ─────────
  meal: {
    item: null,                 // the chosen carb / protein / salad
    prep: null,                 // optional chosen variant
    sauce: null,                // the chosen sauce (sauce / marinade / dressing)
  },

  // ── Favorites (populated on sign-in) ──────────────────────────────────────
  favorites: new Map(),         // Map<sauceId, createdAtIso> — timestamp drives "most recently favorited" tiebreak for variant family default
  favoritesOnly: false,         // toggle for the sauce-selector "❤️ Favorites only" filter
  authModalOpen: false,         // sign-in modal visibility
  authMode: 'login',            // 'login' | 'signup'
  authBusy: false,
  authError: null,
  becomeAdminBusy: false,
  becomeAdminError: null,

  // ── Admin / builder ─────────────────────────────────────────────────────────
  builder: null,
  adminSauces: [],
  adminError: null,
  adminSaucesLoading: false,                                       // tab-scoped loaders for sauce manager
  adminItemsLoading: false,
  adminFoodsLoading: false,
  sauceManagerTab: 'sauces',                                      // 'sauces' | 'dish' | 'ingredients'
  sauceManagerSearch: '',                                          // search query (applies to active tab)
  sauceManagerTypeFilter: 'all',                                   // 'all' | 'sauce' | 'marinade' | 'dressing'
  sauceManagerFavoritesOnly: false,                                // sauces-tab fav filter; independent of state.favoritesOnly
  itemSections: { carbs: false, proteins: false, salads: false }, // category-level expand (default collapsed)
  cuisineSections: {},                                             // { [cuisine]: true } — open only when explicitly true
  expandedParents: {},                                             // { [parentId]: true }
  adminItems: { carbs: [], proteins: [], salads: [] },             // parents w/ nested variants
  itemForm: null,                                                  // shared add/edit form
  sauceMerge: null,                                                // { keepId, mergeIds: Set<id>, saving, error } — long-press a sauce in the manager to enter "assign variants" mode

  // ── Ingredients tab ────────────────────────────────────────────────────────
  adminFoods: [],                                                  // [{ id, name, plural, usageCount, sauceCount }]
  foodForm: null,                                                  // { mode: 'add' | 'edit', id?, name, category, categoryDraft, error?, saving? }
  foodMerge: null,                                                 // { keepId, mergeIds: Set<string>, error?, saving? }
  ingredientSections: {},                                          // { [category]: true } — open only when explicitly true
  expandedFoodIds: new Set(),                                      // food ids whose sauces panel is open
};

function defaultBuilder() {
  return {
    name: '', cuisine: '', cuisineEmoji: '', color: '', description: '', sourceUrl: '',
    sauceType: '',               // '' | 'sauce' | 'marinade' | 'dressing' — must be selected by user
    parentSauceId: null,         // when set, this sauce is a variant of the chosen parent
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
