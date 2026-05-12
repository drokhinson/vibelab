// Unit conversion + scaling. Pure functions — no globals.
// Ported from web/helpers.js 285-334.

import { TO_TSP, VOLUME_TO_ML, WEIGHT_TO_G, COUNT_UNITS } from './constants.js';

export function toTsp(amount, unit) {
  return amount * (TO_TSP[unit] || 1);
}

// Total tsp produced by a step's bowl, including everything inherited from
// upstream steps it combines in. Walks `inputFromStep` recursively.
export function cumulativeStepTsp(steps, idx, servings, baseServings) {
  const step = steps[idx];
  if (!step) return 0;
  let total = step.ingredients.reduce(
    (s, it) => s + toTsp(scaleAmount(it.amount, servings, baseServings), it.unit),
    0,
  );
  if (step.inputFromStep) {
    total += cumulativeStepTsp(steps, step.inputFromStep - 1, servings, baseServings);
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
  const factor = servings / (baseServings || 2);
  return items.map((item) => {
    const scaled = scaleAmount(item.amount, servings);
    const scaledItem = {
      ...item,
      amount: scaled,
      canonicalMl: item.canonicalMl != null ? item.canonicalMl * factor : null,
      canonicalG: item.canonicalG != null ? item.canonicalG * factor : null,
    };
    const converted = convertUnit(scaled, item.unit, unitSystem, scaledItem);
    return {
      name: item.name,
      amount: converted.amount,
      unit: converted.unit,
      canonicalMl: scaledItem.canonicalMl,
      canonicalG: scaledItem.canonicalG,
    };
  });
}
