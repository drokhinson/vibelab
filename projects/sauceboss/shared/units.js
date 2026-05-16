// Unit conversion + scaling. Pure functions — no globals.
// Ported from web/helpers.js 285-334.

import { TO_TSP, VOLUME_TO_ML, WEIGHT_TO_G, COUNT_UNITS } from './constants.js';

export function toTsp(amount, unit) {
  return amount * (TO_TSP[unit] || 1);
}

// Total tsp produced by a step's bowl, including everything inherited from
// upstream steps it combines in. Walks `inputFromSteps` recursively.
export function cumulativeStepTsp(steps, idx, servings, baseServings) {
  const step = steps[idx];
  if (!step) return 0;
  let total = step.ingredients.reduce(
    (s, it) => s + toTsp(scaleAmount(it.amount, servings, baseServings), it.unit),
    0,
  );
  const refs = Array.isArray(step.inputFromSteps) ? step.inputFromSteps : (step.inputFromStep ? [step.inputFromStep] : []);
  for (const ref of refs) {
    total += cumulativeStepTsp(steps, ref - 1, servings, baseServings);
  }
  return total;
}

// Pick a friendly display unit for a tsp total (cup ≥ 48, tbsp ≥ 3, else tsp).
export function tspToDisplay(tspTotal) {
  if (tspTotal >= 48) return { amount: +(tspTotal / 48).toFixed(1), unit: 'cup' };
  if (tspTotal >= 3) return { amount: +(tspTotal / 3).toFixed(1), unit: 'tbsp' };
  return { amount: +tspTotal.toFixed(1), unit: 'tsp' };
}

export function convertUnit(amount, unit, system, item) {
  if (system === 'imperial') return { amount, unit };
  if (item) {
    if (item.canonicalMl != null) return { amount: item.canonicalMl, unit: 'ml' };
    if (item.canonicalG != null) return { amount: item.canonicalG, unit: 'g' };
  }
  const lower = (unit || '').toLowerCase();
  if (COUNT_UNITS.has(lower)) return { amount, unit };
  if (VOLUME_TO_ML[lower]) return { amount: amount * VOLUME_TO_ML[lower], unit: 'ml' };
  if (WEIGHT_TO_G[lower]) return { amount: amount * WEIGHT_TO_G[lower], unit: 'g' };
  return { amount, unit };
}

export function formatAmount(num) {
  if (num >= 10) return Math.round(num).toString();
  const rounded = Math.round(num * 10) / 10;
  return rounded === Math.floor(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function scaleAmount(amount, servings, baseServings) {
  return amount * (servings / (baseServings || 2));
}

// Scales + converts a list of ingredient items for display.
// baseServings is the number of servings the recipe was authored for (default 2).
export function prepareItems(items, { servings, unitSystem, baseServings }) {
  const base = baseServings || 2;
  const factor = servings / base;
  return items.map((item) => {
    const scaled = scaleAmount(item.amount, servings, base);
    const scaledItem = {
      ...item,
      amount: scaled,
      canonicalMl: item.canonicalMl != null ? item.canonicalMl * factor : null,
      canonicalG: item.canonicalG != null ? item.canonicalG * factor : null,
    };
    const converted = convertUnit(scaled, item.unit, unitSystem, scaledItem);
    return {
      name: item.name,
      modifier: item.modifier || null,
      amount: converted.amount,
      unit: converted.unit,
      canonicalMl: scaledItem.canonicalMl,
      canonicalG: scaledItem.canonicalG,
    };
  });
}

// Sum a sauce's per-step ingredients into a single shopping-list view,
// keyed by (name, unit, modifier) so different units / preps of the same
// ingredient stay separate. Canonical ml/g totals are summed where present
// so the metric conversion matches what the per-step legend would show.
// Ported from web/helpers.js#aggregateSauceIngredients.
export function aggregateSauceIngredients(sauce) {
  const buckets = new Map();
  for (const step of (sauce?.steps || [])) {
    for (const ing of (step.ingredients || [])) {
      const key = `${ing.name}|${ing.unit}|${ing.modifier || ''}`;
      const prev = buckets.get(key);
      if (prev) {
        prev.amount += Number(ing.amount) || 0;
        if (ing.canonicalMl != null) prev.canonicalMl = (prev.canonicalMl || 0) + ing.canonicalMl;
        if (ing.canonicalG != null) prev.canonicalG = (prev.canonicalG || 0) + ing.canonicalG;
      } else {
        buckets.set(key, {
          name: ing.name,
          amount: Number(ing.amount) || 0,
          unit: ing.unit,
          modifier: ing.modifier || null,
          canonicalMl: ing.canonicalMl != null ? ing.canonicalMl : null,
          canonicalG: ing.canonicalG != null ? ing.canonicalG : null,
        });
      }
    }
  }
  return [...buckets.values()];
}
