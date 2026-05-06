// Sauce family grouping — root + variants. Pure functions; favorites + currentUser
// are passed in as args (no globals).
// Ported from web/sauces.js 19-61.

// Group a flat list of sauces into families: { root, variants[] } keyed by root id.
// A sauce with parentSauceId is attached as a variant to its parent; orphans
// (parent not in this list) render as their own root.
export function buildSauceFamilies(sauces) {
  const byId = new Map();
  for (const s of sauces) byId.set(s.id, s);

  const families = new Map();
  for (const s of sauces) {
    if (!s.parentSauceId || !byId.has(s.parentSauceId)) {
      if (!families.has(s.id)) families.set(s.id, { root: s, variants: [] });
    }
  }
  for (const s of sauces) {
    if (s.parentSauceId && byId.has(s.parentSauceId)) {
      const fam = families.get(s.parentSauceId);
      if (fam) fam.variants.push(s);
    }
  }
  return families;
}

// Pick which sauce in a family to show in the list / open in the recipe by default.
// Rule: if the user has favorited any sibling, pick the one with the most recent
// favorite timestamp; otherwise show the root.
//
// `favorites` is a Map<sauceId, ISOString>. `currentUser` is the auth user object,
// or null if signed out — when null, we always return the root.
export function pickDisplayedFromFamily(family, favorites, currentUser) {
  if (!currentUser) return family.root;
  const all = [family.root, ...family.variants];
  let best = null;
  let bestTime = -Infinity;
  for (const s of all) {
    if (!favorites || !favorites.has(s.id)) continue;
    const ts = favorites.get(s.id);
    const t = ts ? Date.parse(ts) : 0;
    if (t > bestTime) {
      bestTime = t;
      best = s;
    }
  }
  return best || family.root;
}

export function familyHasFavorite(family, favorites, currentUser) {
  if (!currentUser || !favorites) return false;
  if (favorites.has(family.root.id)) return true;
  return family.variants.some((v) => favorites.has(v.id));
}
