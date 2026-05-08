// Monochrome tile-stack glyph used in the bottom Tab bar's Word tab.
// Mirrors web's helpers.js icons.dwpMark — three stroked rounded rects in
// currentColor so it inherits the active/inactive tab tint.

import React from 'react';
import Svg, { Rect } from 'react-native-svg';

export default function DwpMark({ size = 24, color = 'currentColor' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={2} y={13} width={9} height={9} rx={1.5} stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <Rect x={7.5} y={7.5} width={9} height={9} rx={1.5} stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <Rect x={13} y={2} width={9} height={9} rx={1.5} stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
