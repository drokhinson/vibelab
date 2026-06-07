// PlayCard — the single canonical render for the Play object. A two-faced flip
// card styled like an instant photo (cream surface, soft shadow). Front: photo
// + caption (game name + winner block). Back: ranked scoreboard + notes +
// maximize → PlayDetailPopup. Full play hydrates on first flip. Ported from
// web/ui/play-card.js. variant: 'single' | 'strip' (in-session rail).

import React, { useState, useRef } from 'react';
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, interpolate } from 'react-native-reanimated';
import { Maximize2, Star } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING, SHADOWS, gameAccent } from '../theme';
import UserBadge from './UserBadge';
import api from '../api/client';

function countWinners(raw) {
  if (!raw) return 0;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).length;
}
function viewerInPlay(card, meId) {
  if (!meId) return false;
  if (card.user && card.user.id === meId) return true;
  return (card.participants || []).some((p) => p && p.user_id === meId);
}

function WinnerBlock({ card, meId, meName }) {
  const playMode = card.play_mode || 'competitive';
  const winnerCount = countWinners(card.winner_display_name);
  const total = card.participant_count || 0;
  const everyoneWon = total > 0 && winnerCount >= total;
  const nobodyWon = winnerCount === 0;
  const teamBucket = playMode === 'cooperative' || everyoneWon || nobodyWon;
  const we = viewerInPlay(card, meId) ? 'We' : 'They';

  if (teamBucket) {
    return winnerCount > 0 ? (
      <Text style={styles.win}>{we} won!</Text>
    ) : (
      <Text style={styles.winLoss}>{we} lost</Text>
    );
  }
  if (!card.winner_display_name) return null;
  const isSelf = !!(meName && card.winner_display_name === meName);
  const name = isSelf ? 'You' : card.winner_display_name;
  const players = card.players || [];
  const winner = players.find((p) => p.is_winner && p.name === card.winner_display_name) || players.find((p) => p.is_winner);
  const score = winner && winner.score != null && winner.score !== '' ? winner.score : null;
  return (
    <View style={styles.winRow}>
      <Star size={12} color={COLORS.accent} fill={COLORS.accent} />
      <Text style={styles.win} numberOfLines={1}>{name}{score != null ? `  ${score}` : ''}</Text>
    </View>
  );
}

/**
 * @param {Object} props
 * @param {Object} props.card  FeedPlayCard / PlayResponse shape (needs play_id)
 * @param {'single'|'strip'} [props.variant]
 * @param {string} [props.meId]
 * @param {string} [props.meName]
 * @param {() => void} [props.onOpenGame]
 * @param {(playId:string)=>void} [props.onOpenDetail]
 */
export default function PlayCard({ card, variant = 'single', meId, meName, onOpenGame, onOpenDetail, style }) {
  const [flipped, setFlipped] = useState(false);
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(false);
  const rot = useSharedValue(0);
  const requested = useRef(false);

  const g = card.game || {};
  const accent = g.theme_color || gameAccent(g);
  const photoSrc = card.photo_url || g.image_url || g.thumbnail_url;

  async function flip() {
    const next = !flipped;
    setFlipped(next);
    rot.value = withTiming(next ? 1 : 0, { duration: 380 });
    if (next && !full && !requested.current) {
      requested.current = true;
      setLoading(true);
      try {
        const p = await api.play(card.play_id);
        setFull(p);
      } catch {}
      setLoading(false);
    }
  }

  const frontStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1000 }, { rotateY: `${interpolate(rot.value, [0, 1], [0, 180])}deg` }],
    backfaceVisibility: 'hidden',
  }));
  const backStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1000 }, { rotateY: `${interpolate(rot.value, [0, 1], [180, 360])}deg` }],
    backfaceVisibility: 'hidden',
  }));

  const isStrip = variant === 'strip';

  return (
    <Pressable onPress={flip} style={[styles.card, isStrip && styles.strip, { borderColor: accent + '55' }, style]}>
      {/* Front */}
      <Animated.View style={[frontStyle, !flipped ? null : styles.hiddenFace]}>
        <View style={styles.photo}>
          {photoSrc ? (
            <Image source={{ uri: photoSrc }} style={styles.photoImg} resizeMode="cover" />
          ) : (
            <View style={[styles.photoImg, styles.photoPlaceholder, { backgroundColor: accent + '33' }]} />
          )}
        </View>
        <View style={styles.caption}>
          <Pressable onPress={onOpenGame} hitSlop={4} style={styles.captionNameWrap}>
            <Text style={styles.captionName} numberOfLines={1}>{g.name || 'Unknown game'}</Text>
          </Pressable>
          <WinnerBlock card={card} meId={meId} meName={meName} />
        </View>
      </Animated.View>

      {/* Back (absolute overlay) */}
      <Animated.View style={[styles.back, backStyle, flipped ? null : styles.hiddenFace]}>
        <Pressable style={styles.maximize} hitSlop={8} onPress={() => onOpenDetail && onOpenDetail(card.play_id)}>
          <Maximize2 size={15} color={COLORS.polaroidInkSoft} />
        </Pressable>
        <Text style={styles.backTitle} numberOfLines={1}>{g.name || (full && full.game_name) || ''}</Text>
        {loading ? (
          <ActivityIndicator color={COLORS.polaroidAccent} style={{ marginTop: 20 }} />
        ) : (
          <Scoreboard play={full || card} meId={meId} />
        )}
        {(full && full.notes) ? <Text style={styles.notes} numberOfLines={4}>{full.notes}</Text> : null}
        <Text style={styles.flipHint}>Tap to flip back</Text>
      </Animated.View>
    </Pressable>
  );
}

function Scoreboard({ play, meId }) {
  const players = (play.players || []).slice().sort((a, b) => {
    const sa = a.score == null ? -Infinity : Number(a.score);
    const sb = b.score == null ? -Infinity : Number(b.score);
    return sb - sa;
  });
  if (!players.length) return <Text style={styles.empty}>No players recorded.</Text>;
  return (
    <View style={styles.scoreList}>
      {players.map((pl, i) => (
        <View key={i} style={[styles.scoreRow, pl.is_winner && styles.winnerRow]}>
          <UserBadge avatar={pl.avatar} displayName={pl.name} size="xs" isGhost={!pl.user_id} isMe={meId && pl.user_id === meId} />
          <Text style={styles.scoreName} numberOfLines={1}>{pl.name}</Text>
          <Text style={styles.scoreVal}>{pl.score != null ? String(pl.score) : ''}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.polaroidBg,
    borderRadius: RADII.md,
    padding: 8,
    borderWidth: 1,
    ...SHADOWS.polaroid,
    minHeight: 220,
  },
  strip: { width: 240 },
  hiddenFace: { opacity: 0 },
  photo: { borderRadius: RADII.sm, overflow: 'hidden', backgroundColor: COLORS.polaroidBgSoft },
  photoImg: { width: '100%', height: 180 },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  caption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, paddingHorizontal: 2, gap: 8 },
  captionNameWrap: { flex: 1 },
  captionName: { fontFamily: FONTS.polaroid, color: COLORS.polaroidInk, fontSize: 15 },
  winRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  win: { fontFamily: FONTS.sansSemibold, color: COLORS.polaroidAccent, fontSize: 13 },
  winLoss: { fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidMuted, fontSize: 13, fontStyle: 'italic' },

  back: { ...StyleSheet.absoluteFillObject, padding: SPACING.md, backgroundColor: COLORS.polaroidBg, borderRadius: RADII.md },
  maximize: { position: 'absolute', top: 8, right: 8, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  backTitle: { fontFamily: FONTS.display, color: COLORS.polaroidInk, fontSize: 17, marginRight: 32, marginBottom: SPACING.sm },
  scoreList: { gap: 2 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, paddingHorizontal: 6, borderRadius: RADII.sm },
  winnerRow: { backgroundColor: COLORS.accent + '22' },
  scoreName: { flex: 1, fontFamily: FONTS.sansMedium, color: COLORS.polaroidInkSoft, fontSize: 13 },
  scoreVal: { fontFamily: FONTS.scoreBold, color: COLORS.polaroidInk, fontSize: 14 },
  empty: { fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidMuted, fontSize: 13 },
  notes: { fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidInkSoft, fontSize: 13, marginTop: SPACING.sm, fontStyle: 'italic' },
  flipHint: { position: 'absolute', bottom: 8, alignSelf: 'center', fontFamily: FONTS.sans, color: COLORS.polaroidMuted, fontSize: 11 },
});
