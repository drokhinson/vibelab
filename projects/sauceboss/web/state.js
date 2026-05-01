'use strict';

// ─── Builder constants ───────────────────────────────────────────────────────
const CUISINES = [
  { name: 'Italian', emoji: '🇮🇹' },
  { name: 'Asian', emoji: '🌏' },
  { name: 'Mexican', emoji: '🇲🇽' },
  { name: 'Mediterranean', emoji: '🫒' },
  { name: 'BBQ', emoji: '🔥' },
  { name: 'French', emoji: '🇫🇷' },
  { name: 'Indian', emoji: '🇮🇳' },
];
const UNITS = ['tsp', 'tbsp', 'cup', 'oz', 'g', 'clove', 'cloves', 'piece', 'pinch', 'to taste'];
const COLOR_SWATCHES = ['#E85D04','#DC2626','#22C55E','#3B1F0A','#FBBF24','#457B9D','#7C3AED','#EA580C','#15803D','#B91C1C'];

const SAUCE_TYPES = [
  { value: 'sauce',    label: 'Sauce',    category: 'carb',    pairLabel: 'Carbs'    },
  { value: 'marinade', label: 'Marinade', category: 'protein', pairLabel: 'Proteins' },
  { value: 'dressing', label: 'Dressing', category: 'salad',   pairLabel: 'Salads'   },
];

// ─── Colour palette ───────────────────────────────────────────────────────────
const PALETTE = [
  '#E85D04','#F48C06','#FAA307','#FFBA08','#E63946','#457B9D','#2A9D8F',
  '#E9C46A','#9B2226','#6D6875','#B5838D','#264653','#BB3E03','#CA6702',
  '#0096C7','#48CAE4','#52B788','#D62828','#F77F00','#FCBF49',
];

// Fixed colours for well-known ingredients
const ING_COLOR = {
  'soy sauce':'#3B1F0A','sesame oil':'#D97706','peanut butter':'#B45309',
  'lime juice':'#84CC16','garlic':'#FDE68A','ginger':'#FCA5A5',
  'honey':'#F59E0B','sriracha':'#EF4444','fish sauce':'#92400E',
  'tamarind paste':'#7C3AED','sugar':'#FEF3C7','brown sugar':'#D4A84B',
  'olive oil':'#65A30D','butter':'#FBBF24','heavy cream':'#FEF9C3',
  'parmesan':'#FCD34D','pine nuts':'#D4A84B','lemon juice':'#FDE047',
  'white wine':'#E9D8A6','chili flakes':'#DC2626','basil':'#22C55E',
  'oregano':'#16A34A','tomato':'#DC2626','ketchup':'#B91C1C',
  'vinegar':'#7DD3FC','rice vinegar':'#BAE6FD','mirin':'#F0ABFC',
  'sake':'#DDD6FE','gochujang':'#DC2626','chipotle':'#A16207',
  'yogurt':'#F5F5F4','sour cream':'#F9FAFB','cream cheese':'#FFFBEB',
  'dijon mustard':'#CA8A04','mustard':'#EAB308','mayo':'#FEF9C3',
  'hot sauce':'#EF4444','worcestershire sauce':'#78350F',
  'cumin':'#D97706','coriander':'#84CC16','turmeric':'#F59E0B',
  'paprika':'#EA580C','garam masala':'#7C3AED','chili powder':'#DC2626',
  'cilantro':'#4ADE80','parsley':'#22C55E','dill':'#86EFAC',
  'spinach':'#15803D','tomato puree':'#B91C1C','coconut milk':'#FFFBEB',
  'onion':'#DDD6FE','shallot':'#C4B5FD','water':'#BFDBFE',
  'cashews':'#D4A84B','mustard seeds':'#EAB308','curry leaves':'#4ADE80',
};
const STEP_OUTPUT_COLOR = '#94A3B8'; // slate for "Step N combined" slices

// ─── Unit conversion constants ────────────────────────────────────────────────
const TO_TSP = { tsp: 1, tsps: 1, tbsp: 3, tbsps: 3, cup: 48, cups: 48, oz: 6, clove: 2, cloves: 2, g: 0.4, piece: 8, pinch: 0.3 };
const VOLUME_TO_ML = { tsp: 5, tbsp: 15, cup: 240, oz: 30 };
const WEIGHT_TO_G  = { oz: 28 };
const COUNT_UNITS  = new Set(['clove', 'cloves', 'piece', 'pieces', 'pinch']);

const CATEGORY_ORDER = ['Produce', 'Dairy', 'Oils & Fats', 'Sauces & Condiments', 'Broths', 'Spices', 'Sweeteners', 'Nuts & Seeds', 'Pantry Staples'];

// ─── Global state ─────────────────────────────────────────────────────────────
let state = {
  // ── Current screen ──────────────────────────────────────────────────────────
  screen: 'meal-builder',       // home is the meal builder
  loading: null,                // when set, the active screen renders an inline pot loader

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

  // ── Admin / builder ─────────────────────────────────────────────────────────
  builder: null,
  adminKey: null,
  adminSauces: [],
  adminLoading: false,
  adminError: null,
  adminSaucesLoading: false,                                       // tab-scoped loaders for sauce manager
  adminItemsLoading: false,
  adminFoodsLoading: false,
  sauceManagerTab: 'sauces',                                      // 'sauces' | 'dish' | 'ingredients'
  sauceManagerSearch: '',                                          // search query (applies to active tab)
  sauceManagerTypeFilter: 'all',                                   // 'all' | 'sauce' | 'marinade' | 'dressing'
  itemSections: { carbs: false, proteins: false, salads: false }, // category-level expand (default collapsed)
  cuisineSections: {},                                             // { [cuisine]: true } — open only when explicitly true
  expandedParents: {},                                             // { [parentId]: true }
  adminItems: { carbs: [], proteins: [], salads: [] },             // parents w/ nested variants
  itemForm: null,                                                  // shared add/edit form

  // ── Ingredients tab ────────────────────────────────────────────────────────
  adminFoods: [],                                                  // [{ id, name, plural, usageCount, sauceCount }]
  foodForm: null,                                                  // { mode: 'add' | 'edit', id?, name, category, categoryDraft, error?, saving? }
  foodMerge: null,                                                 // { keepId, mergeIds: Set<string>, error?, saving? }
  ingredientSections: {},                                          // { [category]: true } — open only when explicitly true
  expandedFoodIds: new Set(),                                      // food ids whose sauces panel is open
};

function defaultBuilder() {
  return {
    name: '', cuisine: '', cuisineEmoji: '', color: '#E85D04', description: '', sourceUrl: '',
    sauceType: 'sauce',          // 'sauce' | 'marinade' | 'dressing'
    steps: [{ title: '', inputFromStep: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] }],
    itemIds: [], saving: false, error: null,
    acStep: null, acIng: null, acResults: [], acSelected: -1,
    pendingCategories: [],
    importUrl: '', importing: false, importError: null,
    cuisineDraftMode: false, cuisineDraftName: '', cuisineDraftEmoji: '',
  };
}
