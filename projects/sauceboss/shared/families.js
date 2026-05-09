// Sauce family grouping — root + variants. Pure functions; no globals.

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

// The list / accordion view shows one row per family. Without favorites, the
// rule is: show the family root. Variants are still reachable from the recipe
// view's variant switcher.
export function pickDisplayedFromFamily(family /* {root, variants} */) {
  return family ? family.root : null;
}
