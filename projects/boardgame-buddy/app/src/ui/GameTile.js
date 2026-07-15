// src/ui/GameTile.js — the ONE canonical component for the Game object (per
// .claude/rules/ui-object-design.md). Variants via the `variant` prop, never
// parallel implementations:
//   - 'polaroid' : cream tile w/ photo + caption (Find-a-Game grid, collection)
//   - 'rail'     : compact vertical tile for feed rails (hot games / revisit)
//   - 'thumb'    : small square thumbnail (plays list rows)
// The corner status pill (StatusTag) and expansion badge are shared across all.

import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { Dice6, GitFork } from 'lucide-react-native';
import StatusTag from './StatusTag';
import { gameMeta } from '../utils/format';
import { COLORS, FONTS, FONT_SIZES, SPACING, RADII, SHADOWS } from '../theme';

function Photo({ uri, style, iconSize = 28 }) {
  if (uri) return <Image source={{ uri }} style={style} resizeMode="cover" />;
  return (
    <View style={[style, styles.placeholder]}>
      <Dice6 size={iconSize} color={COLORS.borderStrong} />
    </View>
  );
}

function ExpansionBadge({ count }) {
  if (!count || count < 1) return null;
  return (
    <View style={styles.expBadge}>
      <GitFork size={11} color={COLORS.textSecondary} />
      <Text style={styles.expText}>{count}</Text>
    </View>
  );
}

export default function GameTile({ game, variant = 'polaroid', subtitle, expansionCount = 0, onPress, showStatus = true }) {
  if (!game) return null;
  const img = game.thumbnail_url || game.image_url || '';

  if (variant === 'rail') {
    return (
      <TouchableOpacity style={styles.rail} activeOpacity={0.85} onPress={onPress}>
        <View style={styles.railPhotoWrap}>
          <Photo uri={img} style={styles.railPhoto} />
          {showStatus && game.id ? (
            <View style={styles.railStatus}><StatusTag gameId={game.id} size="xs" compact /></View>
          ) : null}
          <ExpansionBadge count={expansionCount} />
        </View>
        <Text style={styles.railName} numberOfLines={2}>{game.name || 'Unknown game'}</Text>
        {subtitle ? <Text style={styles.railSub} numberOfLines={1}>{subtitle}</Text> : null}
      </TouchableOpacity>
    );
  }

  if (variant === 'thumb') {
    return (
      <TouchableOpacity activeOpacity={0.85} onPress={onPress}>
        <Photo uri={img} style={styles.thumb} iconSize={20} />
      </TouchableOpacity>
    );
  }

  // polaroid (default)
  const meta = gameMeta(game);
  return (
    <TouchableOpacity style={styles.polaroid} activeOpacity={0.85} onPress={onPress}>
      <View style={styles.polaroidPhotoWrap}>
        <Photo uri={img} style={styles.polaroidPhoto} iconSize={34} />
        {showStatus && game.id ? (
          <View style={styles.polaroidStatus}><StatusTag gameId={game.id} size="sm" compact /></View>
        ) : null}
        <ExpansionBadge count={expansionCount} />
      </View>
      <View style={styles.caption}>
        <Text style={styles.name} numberOfLines={2}>{game.name || 'Unknown game'}</Text>
        {subtitle ? (
          <Text style={styles.meta} numberOfLines={1}>{subtitle}</Text>
        ) : meta ? (
          <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.cardSoft },

  // polaroid
  polaroid: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
    ...SHADOWS.sm,
  },
  polaroidPhotoWrap: { position: 'relative', width: '100%', aspectRatio: 1 },
  polaroidPhoto: { width: '100%', height: '100%' },
  polaroidStatus: { position: 'absolute', top: 6, right: 6 },
  caption: { padding: SPACING.sm },
  name: { fontFamily: FONTS.display, fontSize: FONT_SIZES.md, color: COLORS.text },
  meta: { fontFamily: FONTS.regular, fontSize: FONT_SIZES.xs, color: COLORS.textSecondary, marginTop: 2 },

  // rail
  rail: { width: 116 },
  railPhotoWrap: { position: 'relative', width: 116, height: 116, borderRadius: RADII.md, overflow: 'hidden', backgroundColor: COLORS.cardSoft },
  railPhoto: { width: '100%', height: '100%' },
  railStatus: { position: 'absolute', top: 5, left: 5 },
  railName: { fontFamily: FONTS.semibold, fontSize: FONT_SIZES.sm, color: COLORS.text, marginTop: SPACING.xs },
  railSub: { fontFamily: FONTS.regular, fontSize: FONT_SIZES.xs, color: COLORS.textSecondary, marginTop: 1 },

  // thumb
  thumb: { width: 56, height: 56, borderRadius: RADII.sm, backgroundColor: COLORS.cardSoft },

  // expansion badge (shared)
  expBadge: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(255,251,241,0.92)',
    borderRadius: RADII.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  expText: { fontFamily: FONTS.semibold, fontSize: 10, color: COLORS.textSecondary },
});
