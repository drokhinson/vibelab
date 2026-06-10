// GameTile — the single canonical render for the Game object. Variants are
// props, never parallel implementations (.claude/rules/ui-object-design.md):
//   tile     — collection grid cell (cream polaroid)
//   preview  — small profile-preview cell
//   hero     — game-detail header (box art + meta)
//   thumb    — plays-list / recent-plays row thumbnail
//   polaroid — Gather game-picker grid (cream surface + Fraunces caption)
// Composes StatusTag + ExpansionBadge. Per-game accent is the only inline color.

import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { Dice6 } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING, SHADOWS, gameAccent } from '../theme';
import StatusTag, { ExpansionBadge } from './StatusTag';

function playerRange(game) {
  const lo = game.min_players;
  const hi = game.max_players;
  if (!lo && !hi) return '';
  if (lo === hi) return `${lo}P`;
  return `${lo || '?'}–${hi || '?'}P`;
}
function playTime(game) {
  const m = game.playing_time;
  if (!m) return '';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${r}m` : `${h}h`;
}
function metaText(game) {
  return [playerRange(game), playTime(game)].filter(Boolean).join(' · ');
}

function Cover({ game, height, radius = RADII.md, showStatus, expansionCount }) {
  const img = game.thumbnail_url || game.image_url;
  return (
    <View style={[styles.cover, { height, borderRadius: radius }]}>
      {img ? (
        <Image source={{ uri: img }} style={styles.coverImg} resizeMode="cover" />
      ) : (
        <View style={[styles.coverPlaceholder, { backgroundColor: gameAccent(game) + '33' }]}>
          <Dice6 size={28} color={gameAccent(game)} />
        </View>
      )}
      {showStatus && game.id ? (
        <View style={styles.statusOverlay}>
          <StatusTag gameId={game.id} compact />
        </View>
      ) : null}
      {expansionCount ? (
        <View style={styles.expOverlay}>
          <ExpansionBadge count={expansionCount} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * @param {Object} props
 * @param {Object} props.game
 * @param {'tile'|'preview'|'hero'|'thumb'|'polaroid'} [props.variant]
 * @param {() => void} [props.onPress]
 * @param {boolean} [props.showStatus]
 * @param {number} [props.expansionCount]
 */
export default function GameTile({ game, variant = 'tile', onPress, showStatus = true, expansionCount = 0, style }) {
  if (!game) return null;
  const meta = metaText(game);

  if (variant === 'thumb') {
    return (
      <Pressable style={[styles.thumbRow, style]} onPress={onPress}>
        <Cover game={game} height={56} radius={RADII.sm} showStatus={false} />
        <View style={styles.thumbBody}>
          <Text style={styles.thumbName} numberOfLines={1}>{game.name || 'Unknown game'}</Text>
          {meta ? <Text style={styles.metaMuted}>{meta}</Text> : null}
        </View>
      </Pressable>
    );
  }

  if (variant === 'hero') {
    const img = game.thumbnail_url || game.image_url;
    return (
      <View style={[styles.hero, style]}>
        {img ? (
          <Image source={{ uri: img }} style={styles.heroImg} resizeMode="cover" />
        ) : (
          <View style={[styles.heroImg, styles.coverPlaceholder, { backgroundColor: gameAccent(game) + '33' }]}>
            <Dice6 size={48} color={gameAccent(game)} />
          </View>
        )}
        <Text style={styles.heroName}>{game.name || 'Unknown game'}</Text>
        <View style={styles.heroMetaRow}>
          {meta ? <Text style={styles.metaMuted}>{meta}</Text> : null}
          {game.year_published ? <Text style={styles.metaMuted}>· {game.year_published}</Text> : null}
        </View>
      </View>
    );
  }

  // tile / preview / polaroid — cream polaroid card.
  const coverH = variant === 'preview' ? 96 : 130;
  return (
    <Pressable style={[styles.polaroid, variant === 'preview' && styles.polaroidPreview, style]} onPress={onPress}>
      <Cover game={game} height={coverH} showStatus={showStatus} expansionCount={expansionCount} />
      <View style={styles.caption}>
        <Text style={styles.gameName} numberOfLines={2}>{game.name || 'Unknown game'}</Text>
        {meta && variant !== 'preview' ? <Text style={styles.captionMeta}>{meta}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: { width: '100%', overflow: 'hidden', backgroundColor: COLORS.bgElevated },
  coverImg: { width: '100%', height: '100%' },
  coverPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  statusOverlay: { position: 'absolute', top: 6, right: 6 },
  expOverlay: { position: 'absolute', bottom: 6, right: 6 },

  // Polaroid cream card.
  polaroid: {
    backgroundColor: COLORS.polaroidBg,
    borderRadius: RADII.md,
    padding: 7,
    ...SHADOWS.polaroid,
  },
  polaroidPreview: { padding: 5 },
  caption: { paddingTop: 6, paddingHorizontal: 2 },
  gameName: { fontFamily: FONTS.polaroid, color: COLORS.polaroidInk, fontSize: 13, lineHeight: 16 },
  captionMeta: { fontFamily: FONTS.sans, color: COLORS.polaroidMuted, fontSize: 11, marginTop: 2 },

  // Thumb row.
  thumbRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  thumbBody: { flex: 1 },
  thumbName: { fontFamily: FONTS.sansSemibold, color: COLORS.text, fontSize: 14 },
  metaMuted: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 12, marginTop: 2 },

  // Hero.
  hero: { alignItems: 'center' },
  heroImg: { width: 150, height: 150, borderRadius: RADII.lg, backgroundColor: COLORS.bgElevated },
  heroName: { fontFamily: FONTS.displayBold, color: COLORS.text, fontSize: 24, textAlign: 'center', marginTop: SPACING.md },
  heroMetaRow: { flexDirection: 'row', gap: 4, marginTop: 4 },
});
