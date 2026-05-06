// SVG donut chart. Pure rendering — caller scales/converts items first.
//
// Props:
//   items   [{ name, amount, unit }]   — already prepared (servings + units applied)
//   size    number                      — diameter in px (default 140)

import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { toTsp, ingColor, arcPath } from '#shared';
import { COLORS } from '../theme';

export default function PieChart({ items, size = 140 }) {
  if (!items || items.length === 0) return null;

  // Qualitative items ("to taste") have no quantitative value — exclude from the
  // proportions but still render for legend completeness (StepCard handles legend).
  const quantitative = items.filter((i) => i.unit !== 'to taste');
  const total = quantitative.reduce((s, it) => s + toTsp(it.amount, it.unit), 0);
  if (total === 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 6;
  const innerR = r * 0.42;

  let currentAngle = 0;
  const slices = [];
  quantitative.forEach((item, i) => {
    const tspValue = toTsp(item.amount, item.unit);
    const sweep = (tspValue / total) * 360;
    slices.push({
      key: `${item.name}-${i}`,
      d: arcPath(cx, cy, r, currentAngle, currentAngle + sweep),
      color: ingColor(item.name, i),
    });
    currentAngle += sweep;
  });

  if (slices.length === 1) {
    // Single ingredient — solid circle (no stroke gaps)
    return (
      <View>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Circle cx={cx} cy={cy} r={r} fill={slices[0].color} stroke={COLORS.background} strokeWidth={2} />
          <Circle cx={cx} cy={cy} r={innerR} fill={COLORS.background} />
        </Svg>
      </View>
    );
  }

  return (
    <View>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {slices.map((s) => (
          <Path key={s.key} d={s.d} fill={s.color} stroke={COLORS.background} strokeWidth={2} />
        ))}
        <Circle cx={cx} cy={cy} r={innerR} fill={COLORS.background} />
      </Svg>
    </View>
  );
}
