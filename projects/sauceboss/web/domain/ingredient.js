'use strict';

// Ingredient domain — state-injecting shims over shared/filter.js and
// shared/fuzzy.js. Extracted from helpers.js in the 2026-05-24 domain/
// carve-out.
//
// The Ingredient backend shape is:
//   { id, name, category, usageCount?, sauceCount? }
// Pantry entries embed an Ingredient with a `missing` boolean flag.
// See `web/types.d.ts` IngredientRow for the canonical typedef and
// `shared/api.js` for the network normalization.

function getSubstitutionText(ingredientName) {
  return SBShared.filter.getSubstitutionText(ingredientName, state.substitutions);
}

function getIngredientFrequencies() {
  return SBShared.filter.getIngredientFrequencies(state.saucesForCurrentItem);
}

function groupIngredientsByCategory() {
  return SBShared.filter.groupIngredientsByCategory({
    sauces: state.saucesForCurrentItem,
    allIngredients: state.allIngredients,
    ingredientCategories: state.ingredientCategories,
  });
}

function fuzzyMatchIngredients(query) {
  return SBShared.fuzzy.fuzzyMatchIngredients(query, state.ingredientCategories);
}

function isKnownIngredient(name) {
  return SBShared.fuzzy.isKnownIngredient(name, state.ingredientCategories);
}

// Update the local ingredientCategories map immediately so any open recipe /
// builder view re-renders with the new category. Server-side persistence
// happens via api.updateIngredient(id, { category }) — see admin-view.js
// submitFoodForm — which requires the ingredient id, not just the name.
// Builder-side classification only updates the local cache; the category
// will land in the DB the next time an admin opens the ingredient row.
function classifyIngredientLocal(name, category) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return;
  state.ingredientCategories[key] = category;
}
