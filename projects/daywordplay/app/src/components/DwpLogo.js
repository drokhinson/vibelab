// Native re-implementation of web/assets/brand/dwp-logo.svg.

import React from 'react';
import Svg, { Circle, Path, Rect, Text as SvgText, Line } from 'react-native-svg';
import { COLORS } from '../theme';

export default function DwpLogo({ size = 64 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect width={64} height={64} rx={14} fill={COLORS.surfaceSubtle} />
      <Path
        d="M8 18 Q22 12 32 18 Q42 12 56 18 L56 50 Q42 44 32 50 Q22 44 8 50 Z"
        fill="#FFFFFF"
        stroke={COLORS.primary}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Line x1={32} y1={18} x2={32} y2={50} stroke={COLORS.primary} strokeWidth={2} strokeLinecap="round" />
      <Circle cx={20} cy={34} r={6} fill={COLORS.primary} />
      <SvgText
        x={20}
        y={37}
        textAnchor="middle"
        fontSize={8}
        fontWeight="700"
        fill={COLORS.surfaceSubtle}
      >
        A
      </SvgText>
      <Circle cx={44} cy={34} r={6} fill={COLORS.primaryDark} />
      <SvgText
        x={44}
        y={37}
        textAnchor="middle"
        fontSize={8}
        fontWeight="700"
        fill={COLORS.surfaceSubtle}
      >
        Z
      </SvgText>
    </Svg>
  );
}
