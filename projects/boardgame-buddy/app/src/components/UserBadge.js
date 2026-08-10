// UserBadge — the single canonical render for the User object. A colored circle
// holding either initials or one of a small board-game-themed icon library.
// Every surface that shows a player (feed, play cards, scoring grid, buddies,
// profile headers) renders through this so a user's chosen badge stays
// consistent app-wide. Ported from web/ui/user-badge.js.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, G, Circle, Rect } from 'react-native-svg';
import { COLORS, FONTS } from '../theme';

// BGB default = brown badge + gold initials.
const DEFAULT_AVATAR = { icon: 'initials', iconColor: '#C9922A', bgColor: '#2a1812' };
// Ghost players (free-text, no account) = light-grey baseline + gold initials.
const GHOST_AVATAR = { icon: 'initials', iconColor: '#C9922A', bgColor: '#C9C2B0' };

export const PALETTE = [
  { hex: '#f7f0df', light: true },
  { hex: '#ffffff', light: true },
  { hex: '#e0a02e', light: true },
  { hex: '#c79a5b', light: true },
  { hex: '#3f7d4a', light: false },
  { hex: '#2a8a7a', light: false },
  { hex: '#2f6a93', light: false },
  { hex: '#7a5293', light: false },
  { hex: '#b23b34', light: false },
  { hex: '#d2691e', light: false },
  { hex: '#2a2014', light: false },
  { hex: '#39424f', light: false },
];

// Icon library. Each renders inside a 24×24 viewBox; `color` is the iconColor.
const ICONS = {
  buddy: (c) => (
    <G transform="translate(0,1.27)" fill={c}>
      <Path fillRule="evenodd" d="M8 2.5 H16 A2.5 2.5 0 0 1 18.5 5 V11 A2.5 2.5 0 0 1 16 13.5 H8 A2.5 2.5 0 0 1 5.5 11 V5 A2.5 2.5 0 0 1 8 2.5 Z M9.85 7 A0.85 0.85 0 1 1 8.15 7 A0.85 0.85 0 1 1 9.85 7 Z M15.85 7 A0.85 0.85 0 1 1 14.15 7 A0.85 0.85 0 1 1 15.85 7 Z M9 9.8 Q12 11.6 15 9.8 Q12 10.7 9 9.8 Z" />
      <Circle cx="12" cy="14.5" r="1.5" />
      <Rect x="9" y="15.75" width="6" height="2.75" rx="1" />
      <Rect x="7" y="18.5" width="10" height="2.5" rx="1" />
    </G>
  ),
  meeple: (c) => <Path fill={c} d="M12 2c-1.5 0-2.7 1.2-2.7 2.7 0 .9.5 1.8 1.2 2.3-1.3.4-2.5 1-3.6 1.8C5.4 9.7 3.7 10 3.7 11.4c0 .9.8 1.4 1.7 1.4.8 0 1.6-.2 2.3-.6-.7 1.6-1.3 3.2-1.3 4.7 0 1.4 1.2 1.6 2.5 1.6h6.2c1.3 0 2.5-.2 2.5-1.6 0-1.5-.6-3.1-1.3-4.7.7.4 1.5.6 2.3.6.9 0 1.7-.5 1.7-1.4 0-1.4-1.7-1.7-3.2-2.6-1.1-.8-2.3-1.4-3.6-1.8.7-.5 1.2-1.4 1.2-2.3C14.7 3.2 13.5 2 12 2z" />,
  die: (c) => <Path fill={c} fillRule="evenodd" d="M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm1 3.6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM8 14.4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />,
  sword: (c) => <Path fill={c} d="M12 1.4 13.4 4v9.2h-2.8V4L12 1.4ZM7.4 13.7h9.2v2.3H7.4v-2.3ZM11 16.4h2v3.8h-2v-3.8Zm1 4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z" />,
  shield: (c) => <G transform="translate(0,1.64)"><Path fill={c} d="M12 1.8 3.6 4.9v6.2c0 5.2 3.6 8.9 8.4 11.1 4.8-2.2 8.4-5.9 8.4-11.1V4.9L12 1.8Z" /></G>,
  crown: (c) => <G transform="translate(0,-2.27)"><Path fill={c} d="M2 7.5 6.6 11 12 3.6 17.4 11 22 7.5l-2 12H4l-2-12Zm2.5 13.5h15v1.5h-15V21Z" /></G>,
  spade: (c) => <Path fill={c} d="M12 2C9 6.2 3.6 9 3.6 13.4A3.9 3.9 0 0 0 10.5 16c-.2 2.2-1 3.5-2.2 4.6h7.4c-1.2-1.1-2-2.4-2.2-4.6a3.9 3.9 0 0 0 6.9-2.6C20.4 9 15 6.2 12 2Z" />,
  heart: (c) => <G transform="translate(0.71,-0.45)"><Path fill={c} d="M12 21.3 4.3 14C1.4 11 2.6 6 6.4 5.2c2-.4 3.8.6 4.8 2.1 1-1.5 2.8-2.5 4.8-2.1C19.8 6 21 11 18.1 14L12 21.3Z" /></G>,
  rook: (c) => <G transform="translate(0,0.48)"><Path fill={c} d="M6 3.5h2.4v2h2.1v-2h2.6v2h2.1v-2H18v4.2l-2 1.8v6.8h2v3H6v-3h2V9.5L6 7.7V3.5Z" /></G>,
  hourglass: (c) => <Path fill={c} d="M5 2h14v2H5V2Zm2 3h10v2.6l-3.6 4.4 3.6 4.4V19H7v-2.6l3.6-4.4L7 7.6V5ZM5 20h14v2H5v-2Z" />,
};

export const AVATAR_ITEMS = [
  { key: 'initials', name: 'Initials' },
  { key: 'buddy', name: 'Buddy' },
  { key: 'meeple', name: 'Meeple' },
  { key: 'die', name: 'Die' },
  { key: 'sword', name: 'Sword' },
  { key: 'shield', name: 'Shield' },
  { key: 'crown', name: 'Crown' },
  { key: 'spade', name: 'Spade' },
  { key: 'heart', name: 'Heart' },
  { key: 'rook', name: 'Rook' },
  { key: 'hourglass', name: 'Hourglass' },
];

const SIZES = { xs: 24, sm: 32, md: 44, lg: 64 };
const FONT_SCALE = { xs: 10, sm: 13, md: 17, lg: 24 };

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

/**
 * @param {Object} props
 * @param {{icon:string,iconColor:string,bgColor:string}|null} [props.avatar]
 * @param {string} [props.displayName]
 * @param {string} [props.initials] explicit override
 * @param {'xs'|'sm'|'md'|'lg'} [props.size]
 * @param {boolean} [props.isGhost]
 * @param {boolean} [props.isMe]
 * @param {boolean} [props.forceInitials]
 */
export default function UserBadge({
  avatar,
  displayName,
  initials,
  size = 'sm',
  isGhost = false,
  isMe = false,
  forceInitials = false,
  style,
}) {
  const dim = SIZES[size] || SIZES.sm;
  const av = isGhost ? GHOST_AVATAR : avatar || DEFAULT_AVATAR;
  const text = (initials != null && String(initials).trim()) || initialsOf(displayName);
  const showInitials = forceInitials || av.icon === 'initials' || !ICONS[av.icon];
  const IconRender = ICONS[av.icon];

  return (
    <View
      style={[
        styles.badge,
        {
          width: dim,
          height: dim,
          borderRadius: dim / 2,
          backgroundColor: av.bgColor,
        },
        isMe && styles.me,
        style,
      ]}
    >
      {showInitials ? (
        <Text style={[styles.initials, { color: av.iconColor, fontSize: FONT_SCALE[size] || 13 }]}>
          {text}
        </Text>
      ) : (
        <Svg width={dim * 0.62} height={dim * 0.62} viewBox="0 0 24 24">
          {IconRender(av.iconColor)}
        </Svg>
      )}
    </View>
  );
}

export { DEFAULT_AVATAR, GHOST_AVATAR, ICONS };

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  me: { borderWidth: 2, borderColor: COLORS.accent },
  initials: { fontFamily: FONTS.sansBold, fontWeight: '700' },
});
