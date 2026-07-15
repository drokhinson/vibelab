// src/ui/PlayCard.js — the ONE canonical component for the Play object (per
// .claude/rules/ui-object-design.md). Ported from web/ui/play-card.js.
//
// The web card is a flip card (front polaroid ⇄ back scoreboard). In native the
// same information architecture is a tap-to-expand: the front shows photo + game
// name + winner caption; tapping expands the ranked scoreboard inline, hydrating
// the full play via Play.get on first open (exactly as the web back face does).
// The winner-caption buckets (coop / everyone-won / nobody-won / competitive)
// are ported 1:1.

import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Star, Crown } from 'lucide-react-native';
import UserBadge from '../components/UserBadge';
import { Play } from '../domain/play';
import { useAppState } from '../store/AppContext';
import { COLORS, FONTS, FONT_SIZES, SPACING, RADII, SHADOWS } from '../theme';

function countWinners(raw) {
  if (!raw) return 0;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).length;
}

function viewerInPlay(card, me) {
  if (!me || !me.id) return false;
  if (card.user && card.user.id === me.id) return true;
  return (card.participants || []).some((p) => p && p.user_id === me.id);
}

function winnerScoreFor(card) {
  if (!card.winner_display_name) return null;
  const players = card.players || [];
  const winner = players.find((p) => p.is_winner && p.name === card.winner_display_name)
    || players.find((p) => p.is_winner);
  if (!winner) return null;
  return (winner.score != null && winner.score !== '') ? winner.score : null;
}

// Returns { text, tone, score } — tone: 'win' | 'loss' | ''.
function winnerBlock(card, me) {
  const playMode = card.play_mode || 'competitive';
  const winnerCount = countWinners(card.winner_display_name);
  const participantTotal = card.participant_count || 0;
  const everyoneWon = participantTotal > 0 && winnerCount > 0 && winnerCount >= participantTotal;
  const nobodyWon = winnerCount === 0;
  const teamBucket = (playMode === 'cooperative') || everyoneWon || nobodyWon;
  const we = viewerInPlay(card, me) ? 'We' : 'They';

  if (teamBucket) {
    return winnerCount > 0
      ? { text: `${we} won!`, tone: 'win', score: null }
      : { text: `${we} lost`, tone: 'loss', score: null };
  }
  if (!card.winner_display_name) return { text: '', tone: '', score: null };
  const winnerIsSelf = !!(me && me.display_name && card.winner_display_name === me.display_name);
  const name = winnerIsSelf ? 'You' : card.winner_display_name;
  return { text: name, tone: 'win', score: winnerScoreFor(card) };
}

function PlayerRow({ pl, me }) {
  return (
    <View style={[styles.playerRow, pl.is_winner && styles.playerRowWin]}>
      <UserBadge
        avatar={pl.user_id ? (pl.avatar || null) : null}
        displayName={pl.name}
        size="sm"
        isGhost={!pl.user_id}
        isMe={!!(me && me.id === pl.user_id)}
      />
      <Text style={styles.playerName} numberOfLines={1}>{pl.name}</Text>
      {pl.is_winner ? <Crown size={14} color={COLORS.accent} /> : null}
      <Text style={styles.playerScore}>{pl.score != null ? String(pl.score) : ''}</Text>
    </View>
  );
}

export default function PlayCard({ card, variant = 'single', onOpenGame }) {
  const { currentUser: me } = useAppState();
  const [expanded, setExpanded] = useState(false);
  const [hydrated, setHydrated] = useState(null);
  const [hydrating, setHydrating] = useState(false);

  const g = card.game || {};
  const accent = g.theme_color || COLORS.accent;
  const photoSrc = card.photo_url || g.image_url || g.thumbnail_url || '';
  const wb = winnerBlock(card, me);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !hydrated && !hydrating) {
      setHydrating(true);
      try {
        const full = await Play.get(card.play_id);
        setHydrated(full);
      } catch {}
      setHydrating(false);
    }
  }

  const ranked = ((hydrated && hydrated.players) || card.players || []).slice().sort((a, b) => {
    const sa = a.score == null ? -Infinity : Number(a.score);
    const sb = b.score == null ? -Infinity : Number(b.score);
    return sb - sa;
  });
  const notes = hydrated && hydrated.notes;

  const isStrip = variant === 'strip';

  return (
    <TouchableOpacity
      style={[styles.card, isStrip && styles.cardStrip, { borderTopColor: accent }]}
      activeOpacity={0.9}
      onPress={toggle}
    >
      {photoSrc ? (
        <Image source={{ uri: photoSrc }} style={styles.photo} resizeMode="cover" />
      ) : (
        <View style={[styles.photo, styles.photoEmpty]} />
      )}

      <View style={styles.caption}>
        <TouchableOpacity
          disabled={!onOpenGame || !g.id}
          onPress={() => onOpenGame && g.id && onOpenGame(g.id, g.name)}
          style={styles.captionNameWrap}
        >
          <Text style={styles.captionName} numberOfLines={1}>{g.name || 'Unknown game'}</Text>
        </TouchableOpacity>
        {wb.text ? (
          <View style={styles.winWrap}>
            {wb.tone === 'win' ? <Star size={13} color={COLORS.accent} /> : null}
            <Text style={[styles.winText, wb.tone === 'loss' && styles.lossText]} numberOfLines={1}>
              {wb.text}{wb.score != null ? ` ${wb.score}` : ''}
            </Text>
          </View>
        ) : null}
      </View>

      {expanded ? (
        <View style={styles.scoreboard}>
          {hydrating && !hydrated ? (
            <ActivityIndicator color={COLORS.accent} style={{ paddingVertical: SPACING.md }} />
          ) : (
            <>
              {ranked.length === 0 ? (
                <Text style={styles.empty}>No players recorded.</Text>
              ) : (
                ranked.map((pl, i) => <PlayerRow key={i} pl={pl} me={me} />)
              )}
              {notes ? <Text style={styles.notes}>{notes}</Text> : null}
            </>
          )}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    borderTopWidth: 3,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
    ...SHADOWS.sm,
  },
  cardStrip: { width: 240, marginRight: SPACING.md },
  photo: { width: '100%', aspectRatio: 1.4, backgroundColor: COLORS.cardSoft },
  photoEmpty: { aspectRatio: 2.2 },
  caption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  captionNameWrap: { flexShrink: 1 },
  captionName: { fontFamily: FONTS.display, fontSize: FONT_SIZES.lg, color: COLORS.text },
  winWrap: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  winText: { fontFamily: FONTS.semibold, fontSize: FONT_SIZES.sm, color: COLORS.accentHover },
  lossText: { color: COLORS.textMuted, fontFamily: FONTS.regular, fontStyle: 'italic' },
  scoreboard: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 5,
  },
  playerRowWin: {},
  playerName: { flex: 1, fontFamily: FONTS.medium, fontSize: FONT_SIZES.md, color: COLORS.text },
  playerScore: { fontFamily: FONTS.bold, fontSize: FONT_SIZES.md, color: COLORS.text, minWidth: 28, textAlign: 'right' },
  empty: { fontFamily: FONTS.regular, fontSize: FONT_SIZES.sm, color: COLORS.textMuted, paddingVertical: SPACING.sm },
  notes: {
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.sm,
    lineHeight: 20,
  },
});
