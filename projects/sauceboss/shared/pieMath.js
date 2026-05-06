// Pie chart geometry — pure math, returns SVG path strings.
// Web embeds these in <svg>; native passes them to <Path d=...> in react-native-svg.
// Ported from web/helpers.js 463-475.

export function polarToCartesian(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function arcPath(cx, cy, r, startDeg, endDeg) {
  let end = endDeg;
  if (end - startDeg >= 360) end = startDeg + 359.99;
  const s = polarToCartesian(cx, cy, r, startDeg);
  const e = polarToCartesian(cx, cy, r, end);
  const large = end - startDeg > 180 ? 1 : 0;
  return `M${cx} ${cy} L${s.x.toFixed(2)} ${s.y.toFixed(2)} A${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}Z`;
}
