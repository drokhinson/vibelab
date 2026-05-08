// Native re-implementation of web/assets/brand/dwp-logo.svg — three diagonally
// stacked tiles spelling D / W / P (bottom to top, top tile in front).

import React from 'react';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';
import { COLORS } from '../theme';

export default function DwpLogo({ size = 64 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect width={64} height={64} rx={14} fill={COLORS.surfaceSubtle} />
      {/* Bottom tile (D) — drawn first, visually behind */}
      <Rect x={10} y={36} width={22} height={22} rx={3} fill="#FFFFFF" stroke={COLORS.primary} strokeWidth={2} />
      <SvgText
        x={21}
        y={52}
        textAnchor="middle"
        fontFamily="Georgia"
        fontSize={13}
        fontWeight="700"
        fill={COLORS.primary}
      >
        D
      </SvgText>
      {/* Middle tile (W) */}
      <Rect x={21} y={21} width={22} height={22} rx={3} fill="#FFFFFF" stroke={COLORS.primary} strokeWidth={2} />
      <SvgText
        x={32}
        y={37}
        textAnchor="middle"
        fontFamily="Georgia"
        fontSize={13}
        fontWeight="700"
        fill={COLORS.primary}
      >
        W
      </SvgText>
      {/* Top tile (P) — drawn last, visually in front */}
      <Rect x={32} y={6} width={22} height={22} rx={3} fill="#FFFFFF" stroke={COLORS.primary} strokeWidth={2} />
      <SvgText
        x={43}
        y={22}
        textAnchor="middle"
        fontFamily="Georgia"
        fontSize={13}
        fontWeight="700"
        fill={COLORS.primary}
      >
        P
      </SvgText>
    </Svg>
  );
}
