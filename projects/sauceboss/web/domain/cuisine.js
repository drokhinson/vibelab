'use strict';

// Cuisine domain — helpers that produce `{ name, emoji }` arrays for the
// filter UIs. Extracted from helpers.js in the 2026-05-24 domain/ carve-out.
//
// The Cuisine source-of-truth is the backend `sauceboss_cuisine_info`
// table, surfaced through GET /api/v1/sauceboss/cuisines. Init.js
// populates `state.allCuisines`. The helpers below fall back to deriving
// cuisines from `state.adminSauces` if the dedicated endpoint hasn't
// loaded yet (rare race condition during boot).

function availableCuisines() {
  // Prefer the dynamically loaded list from GET /cuisines.
  if (state.allCuisines && state.allCuisines.length) {
    return state.allCuisines.map(c => ({ name: c.cuisine, emoji: c.emoji }));
  }
  // Fallback: derive from admin sauces when API hasn't loaded yet.
  const seen = new Map();
  for (const s of (state.adminSauces || [])) {
    if (s.cuisine && !seen.has(s.cuisine)) seen.set(s.cuisine, s.cuisineEmoji || '🍽');
  }
  return [...seen].map(([name, emoji]) => ({ name, emoji }));
}

function saucebookCuisines() {
  // Derive distinct cuisines from the user's saucebook — only shows cuisines
  // the user actually has. Falls back to availableCuisines() if empty.
  const sauces = state.saucebook || [];
  if (!sauces.length) return availableCuisines();
  const seen = new Map();
  for (const s of sauces) {
    if (s.cuisine && !seen.has(s.cuisine)) {
      seen.set(s.cuisine, s.cuisineEmoji || '🍽');
    }
  }
  // Enrich with emoji from allCuisines if available.
  if (state.allCuisines) {
    for (const c of state.allCuisines) {
      if (seen.has(c.cuisine) && seen.get(c.cuisine) === '🍽') {
        seen.set(c.cuisine, c.emoji);
      }
    }
  }
  return [...seen].map(([name, emoji]) => ({ name, emoji })).sort((a, b) => a.name.localeCompare(b.name));
}
