// Sauce builder helpers — used by Phase 3.
// Pure transformations on builder state. No side effects, no globals.

// Test if an ingredient name appears in a step's instruction text.
// Used to auto-route imported ingredients to the step that mentions them.
export function ingNameInInstruction(name, instruction) {
  if (!name || !instruction) return false;
  const needle = name.toLowerCase().trim();
  if (!needle) return false;
  return instruction.toLowerCase().includes(needle);
}

// Best-effort unit normalization from a recipe-scrapers parse.
// "1 tablespoon olive oil" → { amount: 1, unit: 'tbsp' }.
export function unitDisplayFromParsed(unit) {
  const u = (unit || '').toLowerCase().trim();
  if (!u) return '';
  if (u === 'teaspoon' || u === 'teaspoons' || u === 't') return 'tsp';
  if (u === 'tablespoon' || u === 'tablespoons' || u === 'tbl' || u === 'T') return 'tbsp';
  if (u === 'cup' || u === 'cups' || u === 'c') return 'cup';
  if (u === 'ounce' || u === 'ounces') return 'oz';
  if (u === 'gram' || u === 'grams') return 'g';
  if (u === 'clove' || u === 'cloves') return 'cloves';
  if (u === 'pinch' || u === 'pinches') return 'pinch';
  if (u === 'piece' || u === 'pieces') return 'piece';
  return u;
}

// Apply a parsed-recipe payload onto a fresh builder. Routes ingredients
// into steps by matching the ingredient name against each step's instruction.
// Anything unmatched lands in `unassignedIngredients` so the user can drain
// them into the right step before saving.
export function applyParsedRecipe(builder, parsed) {
  const next = { ...builder };
  next.name = parsed.name || next.name || '';
  next.description = parsed.description || next.description || '';
  next.sourceUrl = parsed.sourceUrl || next.sourceUrl || '';

  const steps = (parsed.steps || []).map((s, idx) => ({
    title: s.title || `Step ${idx + 1}`,
    instructions: s.instructions || s.text || '',
    inputFromStep: null,
    ingredients: [],
  }));
  if (steps.length === 0) {
    steps.push({ title: 'Step 1', instructions: '', inputFromStep: null, ingredients: [] });
  }

  const unassigned = [];
  for (const ing of parsed.ingredients || []) {
    const item = {
      name: (ing.name || '').trim(),
      amount: ing.amount != null ? ing.amount : '',
      unit: unitDisplayFromParsed(ing.unit) || 'tsp',
    };
    if (!item.name) continue;
    const target = steps.find((s) => ingNameInInstruction(item.name, s.instructions));
    if (target) {
      target.ingredients.push(item);
    } else {
      unassigned.push(item);
    }
  }

  next.steps = steps;
  next.unassignedIngredients = unassigned;
  return next;
}
