'use strict';

// ─── Carb cook times ─────────────────────────────────────────────────────────
const CARB_COOK_TIMES = {
  pasta:    { minutes: 10, label: '8-12 min' },
  rice:     { minutes: 18, label: '15-20 min' },
  noodles:  { minutes: 8,  label: '5-10 min' },
  bread:    { minutes: 0,  label: 'Ready to serve' },
  potatoes: { minutes: 25, label: '20-30 min' },
  couscous: { minutes: 5,  label: '5 min' },
};

// ─── Sauce step times (per sauce id → array of minutes per step) ─────────────
const SAUCE_TIMES = {
  'peanut-sauce':        [3, 2],
  'teriyaki':            [2, 5],
  'gochujang-sauce':     [3],
  'pad-thai-sauce':      [3],
  'sesame-ginger':       [2, 2],
  'marinara':            [5, 15],
  'alfredo':             [3, 5],
  'pesto':               [5],
  'arrabbiata':          [5, 15],
  'aglio-olio':          [8, 2],
  'salsa-roja':          [10, 3],
  'chipotle-cream':      [3],
  'quick-mole':          [5, 8],
  'tzatziki':            [3, 2],
  'chermoula':           [3, 3],
  'harissa-sauce':       [3],
  'bbq-sauce':           [3, 10],
  'honey-mustard':       [3],
  'buffalo':             [5],
  'beurre-blanc':        [8, 5],
  'tikka-masala':        [5, 3, 10],
  'saag-sauce':          [5, 3, 5],
  'dal-makhani':         [5, 10, 5],
  'korma-sauce':         [5, 8],
  'vindaloo-sauce':      [5, 10],
  'coconut-tomato-curry':[5, 10],
};

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
const UNITS = ['tsp', 'tbsp', 'cup', 'oz', 'g', 'clove', 'cloves', 'piece', 'pinch'];
const COLOR_SWATCHES = ['#E85D04','#DC2626','#22C55E','#3B1F0A','#FBBF24','#457B9D','#7C3AED','#EA580C','#15803D','#B91C1C'];

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

const CATEGORY_ORDER = ['Produce', 'Dairy', 'Oils & Fats', 'Sauces & Condiments', 'Spices', 'Sweeteners', 'Nuts & Seeds', 'Pantry Staples'];

// ─── Global state ─────────────────────────────────────────────────────────────
let state = {
  // ── Current screen ──────────────────────────────────────────────────────────
  screen: 'meal-builder',       // home is the meal builder

  // ── Meal selections (one path is populated; others stay null) ──────────────
  meal: {
    protein: null,              // selected protein (from state.proteins)
    marinade: null,             // selected marinade sauce object
    carb: null,                 // selected carb
    prep: null,                 // selected carb prep
    sauce: null,                // selected sauce object
    saladBase: null,            // selected salad base
    dressing: null,             // selected dressing sauce object
  },

  // ── Shared selector state ────────────────────────────────────────────────────
  carbs: [],                    // loaded at boot from DB
  selectedCarb: null,
  saucesForCurrentCarb: [],
  allIngredients: [],
  disabledIngredients: new Set(),
  filterOpen: false,
  expandedCuisines: new Set(),
  selectedSauce: null,
  servings: 2,
  unitSystem: 'imperial',       // 'imperial' | 'metric'
  ingredientCategories: {},
  substitutions: {},
  preparations: [],
  selectedPrep: null,

  // ── Dressings path ──────────────────────────────────────────────────────────
  saladBases: [],
  selectedSaladBase: null,
  dressingsForCurrentBase: [],
  allDressingIngredients: [],

  // ── Marinades path ──────────────────────────────────────────────────────────
  proteins: [],
  selectedProtein: null,
  marinadesForCurrentProtein: [],
  allMarinadeIngredients: [],

  // ── Admin / builder ─────────────────────────────────────────────────────────
  builder: null,
  adminKey: null,
  adminSauces: [],
  adminLoading: false,
  adminError: null,
  sauceManagerTab: 'sauces',                    // 'sauces' | 'items'
  itemSections: { carbs: true, proteins: true }, // expanded by default
  editItemForm: null,                            // {id, category, name, emoji, ...}
  addCarbForm: null,
  addProteinForm: null,
};

function defaultBuilder() {
  return {
    name: '', cuisine: '', cuisineEmoji: '', color: '#E85D04', description: '',
    steps: [{ title: '', inputFromStep: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] }],
    carbIds: [], saving: false, error: null,
    acStep: null, acIng: null, acResults: [], acSelected: -1,
    pendingCategories: [],
  };
}
