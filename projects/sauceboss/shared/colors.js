// Ingredient color picker — fixed colors for known ingredients, fallback to palette.
// Ported from web/helpers.js 336-339.

import { ING_COLOR, PALETTE, STEP_OUTPUT_COLOR } from './constants.js';

export function ingColor(name, idx) {
  const lower = (name || '').toLowerCase();
  if (lower.startsWith('step ') && lower.includes('combined')) return STEP_OUTPUT_COLOR;
  return ING_COLOR[lower] || PALETTE[idx % PALETTE.length];
}
