// PlayDetailPopup — the single "open a play" destination (.claude/rules/
// ui-object-design.md §3b). Opened from PlayCard's maximize AND from a row tap
// in PlaysScreen, so the affordance is consistent. Imperative singleton:
// PlayDetailPopup.show(playId). Host mounted once at app root.

import React, { useState, useCallback, useRef } from 'react';
import { View, Text, Image, Pressable, ScrollView, Modal, ActivityIndicator, StyleSheet } from 'react-native';
import { X, Star } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING, SHADOWS } from '../theme';
import api from '../api/client';
import UserBadge from '../components/UserBadge';

let _show = null;

const PlayDetailPopup = {
  show(playId) {
    if (_show) _show(playId);
  },
};

export function PlayDetailHost() {
  const [playId, setPlayId] = useState(null);
  const [play, setPlay] = useState(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  const open = useCallback(async (id) => {
    const seq = ++reqRef.current;
    setPlayId(id);
    setPlay(null);
    setLoading(true);
    try {
      const p = await api.play(id);
      if (seq === reqRef.current) setPlay(p);
    } catch {}
    if (seq === reqRef.current) setLoading(false);
  }, []);

  if (_show !== open) _show = open;

  const close = () => {
    reqRef.current++;
    setPlayId(null);
    setPlay(null);
  };

  if (!playId) return null;

  const photo = play && (play.photo_url || (play.game && (play.game.image_url || play.game.thumbnail_url)));
  const players = play ? (play.players || []).slice().sort((a, b) => {
    const sa = a.score == null ? -Infinity : Number(a.score);
    const sb = b.score == null ? -Infinity : Number(b.score);
    return sb - sa;
  }) : [];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Pressable style={styles.close} onPress={close} hitSlop={10}>
            <X size={22} color={COLORS.polaroidInkSoft} />
          </Pressable>
          {loading || !play ? (
            <ActivityIndicator color={COLORS.polaroidAccent} style={{ paddingVertical: 60 }} />
          ) : (
            <ScrollView contentContainerStyle={styles.scroll}>
              {photo ? <Image source={{ uri: photo }} style={styles.photo} resizeMode="cover" /> : null}
              <Text style={styles.title}>{play.game_name || (play.game && play.game.name) || 'Play'}</Text>
              <Text style={styles.meta}>
                {[play.played_at, play.duration_minutes ? `${play.duration_minutes} min` : null].filter(Boolean).join('  ·  ')}
              </Text>
              <View style={styles.scoreboard}>
                {players.length === 0 ? (
                  <Text style={styles.empty}>No players recorded.</Text>
                ) : (
                  players.map((pl, i) => (
                    <View key={i} style={[styles.row, pl.is_winner && styles.winnerRow]}>
                      <UserBadge avatar={pl.avatar} displayName={pl.name} size="sm" isGhost={!pl.user_id} />
                      <Text style={styles.name} numberOfLines={1}>{pl.name}</Text>
                      {pl.is_winner ? <Star size={14} color={COLORS.accent} fill={COLORS.accent} /> : null}
                      <Text style={styles.score}>{pl.score != null ? String(pl.score) : ''}</Text>
                    </View>
                  ))
                )}
              </View>
              {play.notes ? <Text style={styles.notes}>{play.notes}</Text> : null}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'flex-end' },
  card: { backgroundColor: COLORS.polaroidBg, borderTopLeftRadius: RADII.xl, borderTopRightRadius: RADII.xl, maxHeight: '88%', ...SHADOWS.lg },
  close: { position: 'absolute', top: SPACING.md, right: SPACING.md, zIndex: 2, padding: 6 },
  scroll: { padding: SPACING.xl },
  photo: { width: '100%', height: 220, borderRadius: RADII.md, backgroundColor: COLORS.polaroidBgSoft },
  title: { fontFamily: FONTS.displayBold, color: COLORS.polaroidInk, fontSize: 24, marginTop: SPACING.md },
  meta: { fontFamily: FONTS.sans, color: COLORS.polaroidMuted, fontSize: 13, marginTop: 2 },
  scoreboard: { marginTop: SPACING.lg, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 6, paddingHorizontal: 8, borderRadius: RADII.sm },
  winnerRow: { backgroundColor: COLORS.accent + '22' },
  name: { flex: 1, fontFamily: FONTS.sansMedium, color: COLORS.polaroidInk, fontSize: 15 },
  score: { fontFamily: FONTS.scoreBold, color: COLORS.polaroidInk, fontSize: 16, minWidth: 28, textAlign: 'right' },
  empty: { fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidMuted, fontSize: 14 },
  notes: { fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidInkSoft, fontSize: 15, lineHeight: 22, marginTop: SPACING.lg, fontStyle: 'italic' },
});

export default PlayDetailPopup;
