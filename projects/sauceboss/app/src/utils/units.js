// Converts any amount+unit to teaspoons for proportional pie chart display.
// Exact equivalences don't need to be perfect — we just need relative proportions.
const TO_TSP = {
  tsp: 1,
  tsps: 1,
  tbsp: 3,
  tbsps: 3,
  cup: 48,
  cups: 48,
  oz: 6,
  ozs: 6,
  clove: 2,
  cloves: 2,
  g: 0.4,
  piece: 8,
  pieces: 8,
  pinch: 0.3,
};

export function toTsp(amount, unit) {
  return amount * (TO_TSP[unit] ?? 1);
}

export function formatAmount(amount, unit) {
  // Format nicely: "3 tsp", "½ cup", "2 tbsp"
  const fractions = { 0.25: '¼', 0.5: '½', 0.75: '¾', 0.33: '⅓', 0.67: '⅔' };
  const amountStr = fractions[amount] ?? (Number.isInteger(amount) ? String(amount) : amount.toFixed(1));
  return `${amountStr} ${unit}`;
}
