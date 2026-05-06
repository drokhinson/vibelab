// Sauce builder validation. Returns { ok, errors[] }.
// Used by Phase 3 builder. Lives here so native and web share rules.
// Ported from web/builder.js validateBuilder.

export function validateBuilder(builder) {
  const errors = [];
  if (!builder) return { ok: false, errors: ['No builder state'] };

  if (!builder.name || !builder.name.trim()) errors.push('Sauce needs a name');
  if (!builder.cuisine || !builder.cuisine.trim()) errors.push('Pick a cuisine');
  if (!builder.color) errors.push('Pick a color');
  if (!builder.sauceType) errors.push('Choose Sauce, Marinade, or Dressing');
  if (!builder.itemIds || builder.itemIds.length === 0) errors.push('Pair with at least one item');

  if (!builder.steps || builder.steps.length === 0) {
    errors.push('At least one step is required');
  } else {
    builder.steps.forEach((step, idx) => {
      if (!step.title || !step.title.trim()) {
        errors.push(`Step ${idx + 1} needs a title`);
      }
      const ings = step.ingredients || [];
      const validIngs = ings.filter((i) => i.name && i.name.trim());
      if (validIngs.length === 0) {
        errors.push(`Step ${idx + 1} needs at least one ingredient`);
      }
      validIngs.forEach((ing) => {
        if (ing.unit !== 'to taste' && (ing.amount === '' || ing.amount == null)) {
          errors.push(`${ing.name} in step ${idx + 1} needs an amount (or "to taste")`);
        }
      });
    });
  }

  if (builder.unassignedIngredients && builder.unassignedIngredients.length > 0) {
    errors.push(`Drain ${builder.unassignedIngredients.length} unassigned ingredient(s) into a step before saving`);
  }

  return { ok: errors.length === 0, errors };
}
