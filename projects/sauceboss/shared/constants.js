// SauceBoss shared constants — pure data, no DOM, no React Native imports.

// ── DB-driven reference data ─────────────────────────────────────────────────
// CUISINES, UNITS, and QUALITATIVE_UNITS are loaded at runtime from the
// backend and should NOT be hardcoded here.
//
//   Source of truth:
//     • Cuisines  → DB table `sauceboss_cuisine_info`
//                   API: GET /api/v1/sauceboss/cuisines
//     • Units     → DB table `sauceboss_unit`
//                   API: GET /api/v1/sauceboss/units
//     • Qualitative units → derived from `sauceboss_unit.quantifiable = false`
//
//   Web:    loaded in helpers.js → loadFilterLookups(), overwrites window globals.
//   Native: loaded in AppContext.js boot effect, stored in state.refCuisines / state.refUnits.
//
// Empty defaults below prevent import errors; they're replaced before the UI
// renders any consumer (builder dropdown, cuisine chips, pie-chart gating).

/** @type {{ name: string, emoji: string }[]} */
export const CUISINES = [];

/** @type {string[]} */
export const UNITS = [];

/** Units where the amount field is disabled and the ingredient is excluded from the pie chart. */
export const QUALITATIVE_UNITS = new Set();

export const COLOR_SWATCHES = [
  '#E85D04', '#DC2626', '#22C55E', '#3B1F0A', '#FBBF24',
  '#457B9D', '#7C3AED', '#EA580C', '#15803D', '#B91C1C',
];

export const SAUCE_TYPES = [
  { value: 'sauce',       label: 'Sauce',       category: 'carb',    pairLabel: 'Carbs'    },
  { value: 'marinade',    label: 'Marinade',    category: 'protein', pairLabel: 'Proteins' },
  { value: 'dressing',    label: 'Dressing',    category: 'salad',   pairLabel: 'Salads'   },
  // Migration 009: dip/spread pairs with carb (bread / crackers / pretzels).
  { value: 'dip',         label: 'Dip/Spread',  category: 'carb',    pairLabel: 'Carbs'    },
  // Migration 011: standalone recipe — not paired with any dish category.
  // `category: null` is the signal for "no pairing step in the builder, no
  // surface in the meal-builder flow". Filterable by type in Browse + Saucebook.
  { value: 'full_recipe', label: 'Full Recipe', category: null,      pairLabel: null       },
];

export const PALETTE = [
  '#E85D04', '#F48C06', '#FAA307', '#FFBA08', '#E63946', '#457B9D', '#2A9D8F',
  '#E9C46A', '#9B2226', '#6D6875', '#B5838D', '#264653', '#BB3E03', '#CA6702',
  '#0096C7', '#48CAE4', '#52B788', '#D62828', '#F77F00', '#FCBF49',
];

export const ING_COLOR = {
  'soy sauce': '#3B1F0A', 'sesame oil': '#D97706', 'peanut butter': '#B45309',
  'lime juice': '#84CC16', 'garlic': '#FDE68A', 'ginger': '#FCA5A5',
  'honey': '#F59E0B', 'sriracha': '#EF4444', 'fish sauce': '#92400E',
  'tamarind paste': '#7C3AED', 'sugar': '#FEF3C7', 'brown sugar': '#D4A84B',
  'olive oil': '#65A30D', 'butter': '#FBBF24', 'heavy cream': '#FEF9C3',
  'parmesan': '#FCD34D', 'pine nuts': '#D4A84B', 'lemon juice': '#FDE047',
  'white wine': '#E9D8A6', 'chili flakes': '#DC2626', 'basil': '#22C55E',
  'oregano': '#16A34A', 'tomato': '#DC2626', 'ketchup': '#B91C1C',
  'vinegar': '#7DD3FC', 'rice vinegar': '#BAE6FD', 'mirin': '#F0ABFC',
  'sake': '#DDD6FE', 'gochujang': '#DC2626', 'chipotle': '#A16207',
  'yogurt': '#F5F5F4', 'sour cream': '#F9FAFB', 'cream cheese': '#FFFBEB',
  'dijon mustard': '#CA8A04', 'mustard': '#EAB308', 'mayo': '#FEF9C3',
  'hot sauce': '#EF4444', 'worcestershire sauce': '#78350F',
  'cumin': '#D97706', 'coriander': '#84CC16', 'turmeric': '#F59E0B',
  'paprika': '#EA580C', 'garam masala': '#7C3AED', 'chili powder': '#DC2626',
  'cilantro': '#4ADE80', 'parsley': '#22C55E', 'dill': '#86EFAC',
  'spinach': '#15803D', 'tomato puree': '#B91C1C', 'coconut milk': '#FFFBEB',
  'onion': '#DDD6FE', 'shallot': '#C4B5FD', 'water': '#BFDBFE',
  'cashews': '#D4A84B', 'mustard seeds': '#EAB308', 'curry leaves': '#4ADE80',
};

export const STEP_OUTPUT_COLOR = '#94A3B8';

export const TO_TSP = {
  tsp: 1, tsps: 1, tbsp: 3, tbsps: 3, cup: 48, cups: 48,
  oz: 6, clove: 2, cloves: 2, g: 0.4, piece: 8, pinch: 0.3,
};
export const VOLUME_TO_ML = { tsp: 5, tbsp: 15, cup: 240, oz: 30 };
export const WEIGHT_TO_G = { oz: 28 };
export const COUNT_UNITS = new Set(['clove', 'cloves', 'piece', 'pieces', 'pinch']);

export const CATEGORY_ORDER = [
  'Produce', 'Dairy', 'Oils & Fats', 'Sauces & Condiments',
  'Broths', 'Spices', 'Sweeteners', 'Nuts & Seeds', 'Pantry Staples',
];

export const ITEM_FLOW_META = {
  carb:    { sauceTypeLabel: 'sauces',    sauceWord: 'Sauce'    },
  protein: { sauceTypeLabel: 'marinades', sauceWord: 'Marinade' },
  salad:   { sauceTypeLabel: 'dressings', sauceWord: 'Dressing' },
};

export function flowMetaFor(item) {
  if (!item) return ITEM_FLOW_META.carb;
  return ITEM_FLOW_META[item.category] || ITEM_FLOW_META.carb;
}
