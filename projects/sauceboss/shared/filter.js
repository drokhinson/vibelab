// Sauce / ingredient filter helpers. Pure — takes context as args, no globals.
// Ported from web/helpers.js 342-409.

import { CATEGORY_ORDER } from './constants.js';

// `sauce.ingredientNames` is expected to be a Set<string>.
export function isSauceAvailable(sauce, disabledIngredients) {
  if (!disabledIngredients || disabledIngredients.size === 0) return true;
  for (const name of sauce.ingredientNames) {
    if (disabledIngredients.has(name)) return false;
  }
  return true;
}

export function missingSauceIngredients(sauce, disabledIngredients) {
  const missing = [];
  if (!disabledIngredients) return missing;
  for (const name of sauce.ingredientNames) {
    if (disabledIngredients.has(name)) missing.push(name);
  }
  return missing;
}

export function getSubstitutionText(ingredientName, substitutions) {
  const subs = substitutions && substitutions[ingredientName];
  if (!subs || subs.length === 0) return '';
  return subs[0].substituteName;
}

export function getIngredientFrequencies(sauces) {
  const freq = {};
  for (const sauce of sauces) {
    for (const name of sauce.ingredientNames) {
      freq[name] = (freq[name] || 0) + 1;
    }
  }
  return freq;
}

// Produces ordered category groups for the filter panel. Highly common ingredients
// (≥30% of sauces, min 2) bubble up into a "Key Ingredients" group at the top.
export function groupIngredientsByCategory({ sauces, allIngredients, ingredientCategories }) {
  const freq = getIngredientFrequencies(sauces);
  const totalSauces = sauces.length;
  const threshold = Math.max(2, Math.ceil(totalSauces * 0.3));

  const keySet = new Set();
  const keyItems = [];
  for (const name of allIngredients) {
    if ((freq[name] || 0) >= threshold) {
      keySet.add(name);
      keyItems.push({ name, count: freq[name] });
    }
  }
  keyItems.sort((a, b) => b.count - a.count);

  const groups = {};
  for (const name of allIngredients) {
    if (keySet.has(name)) continue;
    const category = (ingredientCategories && ingredientCategories[name]) || 'Pantry Staples';
    if (!groups[category]) groups[category] = [];
    groups[category].push({ name, count: freq[name] || 0 });
  }

  const result = [];
  if (keyItems.length > 0) {
    result.push({ category: 'Key Ingredients', items: keyItems, isKey: true });
  }
  for (const c of CATEGORY_ORDER) {
    if (groups[c]) result.push({ category: c, items: groups[c] });
  }
  return result;
}

// Convenience: attach `ingredientNames` Set to each sauce for fast lookups.
// Backend returns sauces with `ingredients[]` but no Set, so callers wrap them.
export function withIngredientNames(sauce) {
  return {
    ...sauce,
    ingredientNames: new Set((sauce.ingredients || []).map((i) => i.name)),
  };
}
