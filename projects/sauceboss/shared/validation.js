// Sauce builder validation. Returns { ok, errors[] }.
// Used by Phase 3 builder. Lives here so native and web share rules.
// Ported from web/builder.js validateBuilder.

export function validateBuilder(builder, opts = {}) {
  const errors = [];
  if (!builder) return { ok: false, errors: ['No builder state'] };

  const qualitativeUnits = opts.qualitativeUnits instanceof Set
    ? opts.qualitativeUnits
    : new Set(['to taste']);

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
      // A step is valid if it has at least one ingredient OR it combines a
      // previous step. The combine-only case lets users author "reduce + plate"
      // style steps that take an upstream bowl and add nothing new.
      const refs = Array.isArray(step.inputFromSteps)
        ? step.inputFromSteps
        : (step.inputFromStep ? [step.inputFromStep] : []);
      const hasRefs = refs.length > 0;
      if (validIngs.length === 0 && !hasRefs) {
        errors.push(`Step ${idx + 1} needs at least one ingredient or a previous step`);
      }
      validIngs.forEach((ing) => {
        if (!qualitativeUnits.has(ing.unit) && (ing.amount === '' || ing.amount == null)) {
          errors.push(`${ing.name} in step ${idx + 1} needs an amount`);
        }
      });
    });
  }

  if (builder.unassignedIngredients && builder.unassignedIngredients.length > 0) {
    errors.push(`Drain ${builder.unassignedIngredients.length} unassigned ingredient(s) into a step before saving`);
  }

  return { ok: errors.length === 0, errors };
}
