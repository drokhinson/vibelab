import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { toTsp, formatAmount } from '../utils/units';
import { COLORS } from '../theme';

// ── Colour palette ─────────────────────────────────────────────────────────────
const PALETTE = [
  '#E85D04', '#F48C06', '#FAA307', '#2A9D8F', '#457B9D',
  '#E63946', '#6D6875', '#B5838D', '#264653', '#52B788',
  '#9B2226', '#CA6702', '#0096C7', '#D62828', '#48CAE4',
];

// Fixed colours for well-known ingredients so they stay consistent
const ING_COLORS = {
  'soy sauce':    '#3B1F0A', 'sesame oil':  '#D97706', 'peanut butter': '#B45309',
  'lime juice':   '#84CC16', 'garlic':      '#FDE68A', 'ginger':        '#FCA5A5',
  'honey':        '#F59E0B', 'sriracha':    '#EF4444', 'fish sauce':    '#92400E',
  'tamarind paste':'#7C3AED','sugar':        '#FEF3C7', 'brown sugar':   '#D4A84B',
  'olive oil':    '#65A30D', 'butter':      '#FBBF24', 'heavy cream':   '#FEF9C3',
  'parmesan':     '#FCD34D', 'pine nuts':   '#D4A84B', 'lemon juice':   '#FDE047',
  'white wine':   '#E9D8A6', 'chili flakes':'#DC2626', 'basil':         '#22C55E',
  'oregano':      '#16A34A', 'tomato':      '#DC2626', 'ketchup':       '#B91C1C',
  'vinegar':      '#7DD3FC', 'rice vinegar':'#BAE6FD', 'mirin':         '#F0ABFC',
  'sake':         '#DDD6FE', 'gochujang':   '#DC2626', 'chipotle':      '#A16207',
  'yogurt':       '#F5F5F4', 'sour cream':  '#F9FAFB', 'mayo':          '#FEF9C3',
  'dijon mustard':'#CA8A04', 'mustard':     '#EAB308', 'hot sauce':     '#EF4444',
  'worcestershire sauce': '#78350F',
  'cumin':        '#D97706', 'coriander':   '#84CC16', 'turmeric':      '#F59E0B',
  'paprika':      '#EA580C', 'garam masala':'#7C3AED', 'chili powder':  '#DC2626',
  'cilantro':     '#4ADE80', 'parsley':     '#22C55E', 'dill':          '#86EFAC',
  'spinach':      '#15803D', 'tomato puree':'#B91C1C', 'onion':         '#DDD6FE',
  'shallot':      '#C4B5FD', 'water':       '#BFDBFE',
};

function getColor(name, index) {
  return ING_COLORS[name.toLowerCase()] ?? PALETTE[index % PALETTE.length];
}

// ── SVG arc math ───────────────────────────────────────────────────────────────
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startDeg, endDeg) {
  // Clamp full-circle edge case
  if (endDeg - startDeg >= 360) endDeg = startDeg + 359.99;
  const s = polarToCartesian(cx, cy, r, startDeg);
  const e = polarToCartesian(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${cx} ${cy}`,
    `L ${s.x.toFixed(3)} ${s.y.toFixed(3)}`,
    `A ${r} ${r} 0 ${largeArc} 1 ${e.x.toFixed(3)} ${e.y.toFixed(3)}`,
    'Z',
  ].join(' ');
}

// ── Main component ─────────────────────────────────────────────────────────────
/**
 * PieChart — renders a single step as an SVG pie + legend.
 *
 * Props:
 *   step  { title: string, ingredients: [{ name, amount, unit }] }
 *   index number  — step number (0-based)
 *   size  number  — diameter in px (default 180)
 */
export default function PieChart({ step, index, size = 180 }) {
  const items = step.ingredients;
  const total = items.reduce((sum, item) => sum + toTsp(item.amount, item.unit), 0);

  if (total === 0 || items.length === 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2 - 8;

  // Build slice data
  let currentAngle = 0;
  const slices = items.map((item, i) => {
    const tspValue = toTsp(item.amount, item.unit);
    const pct = tspValue / total;
    const sweep = pct * 360;
    const color = getColor(item.name, i);
    const slice = { item, pct, sweep, startAngle: currentAngle, color };
    currentAngle += sweep;
    return slice;
  });

  return (
    <View style={styles.card}>
      {/* Step header */}
      <Text style={styles.stepLabel}>STEP {index + 1}</Text>
      <Text style={styles.stepTitle}>{step.title}</Text>

      {/* Pie chart */}
      <View style={styles.chartWrapper}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Subtle shadow ring */}
          <Circle cx={cx} cy={cy} r={r + 2} fill="rgba(0,0,0,0.05)" />
          {slices.map((slice, i) => (
            <Path
              key={i}
              d={describeArc(cx, cy, r, slice.startAngle, slice.startAngle + slice.sweep)}
              fill={slice.color}
              stroke="#FFF8F0"
              strokeWidth={items.length === 1 ? 0 : 2}
            />
          ))}
          {/* Centre hole for donut look */}
          <Circle cx={cx} cy={cy} r={r * 0.38} fill="#FFF8F0" />
        </Svg>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {slices.map((slice, i) => (
          <View key={i} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: slice.color }]} />
            <Text style={styles.legendName} numberOfLines={1}>
              {slice.item.name}
            </Text>
            <Text style={styles.legendAmount}>
              {formatAmount(slice.item.amount, slice.item.unit)}
            </Text>
            <View style={[styles.pctBadge, { backgroundColor: slice.color + 'CC' }]}>
              <Text style={styles.pctText}>{Math.round(slice.pct * 100)}%</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.09,
    shadowRadius: 10,
    elevation: 4,
  },
  stepLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: COLORS.primary,
    marginBottom: 2,
  },
  stepTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 16,
  },
  chartWrapper: {
    alignItems: 'center',
    marginBottom: 16,
  },
  legend: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 10,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F9FAFB',
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
    marginRight: 10,
    flexShrink: 0,
  },
  legendName: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '500',
    marginRight: 8,
  },
  legendAmount: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: '600',
    marginRight: 6,
  },
  pctBadge: {
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    minWidth: 36,
    alignItems: 'center',
  },
  pctText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
});
