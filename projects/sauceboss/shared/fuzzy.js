// Fuzzy ingredient matching for the builder autocomplete.
// Ported from web/helpers.js 411-451.

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

// Returns up to 6 matching ingredient names ordered by score (exact > prefix > substring > distance).
export function fuzzyMatchIngredients(query, ingredientCategories) {
  const q = (query || '').toLowerCase().trim();
  if (q.length < 2) return [];
  const known = Object.keys(ingredientCategories || {});
  return known
    .map((name) => {
      const lower = name.toLowerCase();
      if (lower === q) return { name, score: 10 };
      if (lower.startsWith(q)) return { name, score: 5 };
      if (lower.includes(q)) return { name, score: 3 };
      const dist = levenshtein(q, lower);
      if (dist <= 2) return { name, score: 2 - dist * 0.5 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((m) => m.name);
}

export function isKnownIngredient(name, ingredientCategories) {
  const trimmed = (name || '').trim().toLowerCase();
  if (!trimmed || !ingredientCategories) return false;
  if (trimmed in ingredientCategories) return true;
  return Object.keys(ingredientCategories).some((k) => k.toLowerCase() === trimmed);
}
