'use strict';

// Sauce domain — state-injecting shims over the pure helpers in
// shared/filter.js. Extracted from helpers.js in the 2026-05-24
// domain/ carve-out (per .claude/rules/ui-object-design.md §6).
//
// The Sauce backend shape is:
//   { id, name, cuisine, cuisineEmoji, sauceType, color, defaultServings,
//     parentSauceId?, createdBy?, authorName?, steps: Step[], ... }
// See `web/types.d.ts` for the JSDoc-typedef definition (when added) and
// `shared/api.js` for the network normalization.

function isSauceAvailable(sauce) {
  return SBShared.filter.isSauceAvailable(sauce, state.disabledIngredients);
}

function missingSauceIngredients(sauce) {
  return SBShared.filter.missingSauceIngredients(sauce, state.disabledIngredients);
}

// Count how many of a sauce's ingredients are flagged missing in the user's
// pantry. Reads `sauce.ingredientNames` (Set<string>), which `listSaucebook`
// hydrates from the backend's pre-deduped TEXT[] and `allSauces` hydrates
// from `ingredients[].name` via withIngredientNames.
function sauceMissingCount(sauce) {
  if (!sauce || !(sauce.ingredientNames instanceof Set)) return 0;
  if (!state.disabledIngredients || state.disabledIngredients.size === 0) return 0;
  let n = 0;
  for (const name of sauce.ingredientNames) {
    if (state.disabledIngredients.has(name)) n += 1;
  }
  return n;
}

function getCurrentSauceContext() {
  return { sauces: state.saucesForCurrentItem, allIngredients: state.allIngredients };
}
