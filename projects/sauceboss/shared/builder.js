// Sauce builder helpers — pure transformations on builder state. No side
// effects, no globals. The shape they assume matches the backend's
// `/api/v1/sauceboss/import` response (ParsedRecipeResponse): top-level
// `name`, `description`, `instructions[]` (strings), `ingredients[]` with
// `foodRaw`, `quantity`, `unitRaw`, `originalText`, `canonicalMl`, `canonicalG`,
// and `sourceUrl`.

import { UNITS } from './constants.js';

// Substring match plus a single-letter plural stem so "tomatoes" matches
// "tomato" and vice versa. Cheaper and more predictable than fuzzy matching.
export function ingNameInInstruction(name, instructionLower) {
  const n = (name || '').toLowerCase().trim();
  if (!n) return false;
  if (instructionLower.includes(n)) return true;
  if (n.endsWith('s') && n.length > 3 && instructionLower.includes(n.slice(0, -1))) return true;
  if (!n.endsWith('s') && instructionLower.includes(n + 's')) return true;
  return false;
}

// Picks the unit string the builder UI should show for a parsed ingredient.
// Prefers an exact match in UNITS (so the existing select reflects it
// correctly); otherwise maps common pluralisations / abbreviations.
export function unitDisplayFromParsed(parsedIng) {
  const raw = (parsedIng?.unitRaw || '').toLowerCase().trim();
  if (!raw) return 'tsp';
  const exact = UNITS.find((u) => u.toLowerCase() === raw);
  if (exact) return exact;
  const map = {
    teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp',
    tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp',
    cups: 'cup',
    gram: 'g', grams: 'g', kg: 'g', kilogram: 'g', kilograms: 'g',
    ounce: 'oz', ounces: 'oz', pound: 'oz', pounds: 'oz',
    cloves: 'clove', pieces: 'piece',
  };
  return map[raw] || raw;
}

// Apply a parsed-recipe payload (from /import) onto a builder. Strategy:
//   - Top-level fields (name, description, sourceUrl) fill if currently empty.
//   - Each scraped instruction becomes its own builder step (title blank so
//     the user names them; the full paragraph lives in `instructions` and
//     renders as a collapsible toggle in the recipe view).
//   - Each parsed ingredient is assigned to the earliest step whose
//     instruction text mentions its name; later mentions get the same row
//     with a blank amount so the user can split the quantity manually.
//   - Ingredients not mentioned in any instruction (e.g. "salt to taste")
//     land in `unassignedIngredients` — a staging tray the user must drain
//     (move into a step or delete) before save.
//   - If the scrape returned no instructions, fall back to a single
//     "Imported from <host>" step containing every ingredient.
export function applyParsedRecipe(builder, parsed) {
  const next = { ...builder, unassignedIngredients: [] };

  if (!next.name) next.name = parsed.name || next.name || '';
  if (parsed.description && !next.description) next.description = parsed.description;
  if (parsed.sourceUrl && !next.sourceUrl) next.sourceUrl = parsed.sourceUrl;

  const allIngs = (parsed.ingredients || [])
    .map((p) => {
      const food = (p.foodRaw || '').trim();
      if (!food) return null;
      return {
        name: food,
        amount: p.quantity != null ? String(p.quantity) : '',
        unit: unitDisplayFromParsed(p),
        originalText: p.originalText || '',
        canonicalMl: p.canonicalMl != null ? p.canonicalMl : null,
        canonicalG: p.canonicalG != null ? p.canonicalG : null,
      };
    })
    .filter(Boolean);

  const instructions = (parsed.instructions || [])
    .map((s) => (typeof s === 'string' ? s : s?.text || ''))
    .map((s) => (s || '').trim())
    .filter(Boolean);

  // Fallback: no scraped instructions — single dump step with everything.
  if (instructions.length === 0) {
    let stepTitle = 'Imported';
    try {
      stepTitle = `Imported from ${new URL(parsed.sourceUrl).hostname.replace(/^www\./, '')}`;
    } catch {
      // ignore — sourceUrl might be missing
    }
    next.steps = [{
      title: stepTitle,
      instructions: '',
      inputFromStep: null,
      ingredients: allIngs.length > 0 ? allIngs : [{ name: '', amount: '', unit: 'tsp' }],
    }];
    return next;
  }

  // Build empty steps from instructions; route ingredients into them.
  const steps = instructions.map((text) => ({
    title: '',
    instructions: text,
    inputFromStep: null,
    ingredients: [],
    _instr: text.toLowerCase(),
  }));

  const unmatched = [];
  for (const ing of allIngs) {
    const hits = [];
    for (let i = 0; i < steps.length; i++) {
      if (ingNameInInstruction(ing.name, steps[i]._instr)) hits.push(i);
    }
    if (hits.length === 0) {
      unmatched.push(ing);
      continue;
    }
    steps[hits[0]].ingredients.push(ing);
    // Subsequent hits get a blank-amount row so the user can split quantities.
    for (let i = 1; i < hits.length; i++) {
      steps[hits[i]].ingredients.push({
        name: ing.name,
        amount: '',
        unit: ing.unit,
        originalText: '',
        canonicalMl: null,
        canonicalG: null,
      });
    }
  }

  // Drop the lowercased helper, ensure every step has at least one row.
  for (const s of steps) {
    delete s._instr;
    if (s.ingredients.length === 0) {
      s.ingredients.push({ name: '', amount: '', unit: 'tsp' });
    }
  }

  next.unassignedIngredients = unmatched;
  next.steps = steps;
  return next;
}

// Map a sauce dict (RPC shape from `get_sauceboss_all_sauces_full`, or a
// `.sauce.json` export's inner `sauce` payload) into a fresh builder draft.
// Used by:
//   • web's `openBuilderEdit` (settings.js) for editing an existing sauce.
//   • web's `handleImportSauceFile` (settings.js) for file-import.
//   • native's `SauceBuilderScreen` (edit + file-import).
// Numeric step/ingredient fields are stringified because the builder TextInputs
// bind to strings. Pass `defaults.color` to choose a fallback when the sauce
// has no color set (web defaults to "#E85D04", native picks the first swatch).
export function builderFromSauce(sauce, defaults = {}) {
  const fallbackColor = defaults.color || '#E85D04';
  // Post-013, dish-level targets live on `attachments[]`; older callers may
  // still pass `itemIds` (array of dish ids).
  const fromAttachments = Array.isArray(sauce.attachments)
    ? sauce.attachments.filter((a) => a && a.kind === 'dish').map((a) => a.value)
    : [];
  const itemIds = fromAttachments.length
    ? fromAttachments
    : Array.isArray(sauce.itemIds) ? sauce.itemIds.slice() : [];
  return {
    name: sauce.name || '',
    cuisine: sauce.cuisine || '',
    cuisineEmoji: sauce.cuisineEmoji || '',
    color: sauce.color || fallbackColor,
    description: sauce.description || '',
    sourceUrl: sauce.sourceUrl || '',
    sauceType: sauce.sauceType || 'sauce',
    parentSauceId: sauce.parentSauceId || null,
    itemIds,
    steps: (sauce.steps || []).map((s) => ({
      title: s.title || '',
      instructions: s.instructions || '',
      inputFromStep: s.inputFromStep || null,
      estimatedTime: s.estimatedTime != null ? String(s.estimatedTime) : '',
      ingredients: (s.ingredients || []).map((i) => ({
        name: i.name || '',
        amount: i.amount != null ? String(i.amount) : '',
        unit: i.unit || 'tsp',
      })),
    })),
    unassignedIngredients: [],
  };
}
