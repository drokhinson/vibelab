// Tiny text helpers shared between native and web.
//
// Backend stores ingredient names lowercased (parser + save normalize to
// lowercase + singular). UI surfaces should call `capitalizeIngredient`
// before display so users see "Jalapeño" instead of "jalapeño".

/**
 * Capitalize the first character of each whitespace-separated word.
 * Preserves the rest of the word verbatim — keeps unicode + apostrophes
 * intact ("jalapeño" → "Jalapeño", "olive oil" → "Olive Oil").
 */
export function capitalizeIngredient(name) {
  if (!name) return '';
  return String(name)
    .split(/(\s+)/)
    .map((token) => {
      if (!token.trim()) return token;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join('');
}
