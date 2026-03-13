// src/api/client.js — SauceBoss API client
// All fetch calls go through this file. Never call fetch() directly in screens.
// Set EXPO_PUBLIC_API_URL in app/.env to the Railway backend URL.

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000";

async function apiFetch(path) {
  const url = `${BASE_URL}/api/v1/sauceboss${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Returns all carbs with sauceCount.
 * Shape: [{ id, name, emoji, description, sauceCount }]
 */
export async function getCarbs() {
  return apiFetch("/carbs");
}

/**
 * Returns fully assembled sauce objects for a carb.
 * Shape: [{ id, name, cuisine, cuisineEmoji, color, description,
 *            compatibleCarbs[], ingredients[], steps[{ title, ingredients[] }] }]
 */
export async function getSaucesForCarb(carbId) {
  return apiFetch(`/carbs/${carbId}/sauces`);
}

/**
 * Returns sorted unique ingredient names for the filter panel.
 * Shape: ["garlic", "ginger", ...]
 */
export async function getIngredientsForCarb(carbId) {
  return apiFetch(`/carbs/${carbId}/ingredients`);
}
