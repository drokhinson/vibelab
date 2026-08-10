// PlayDetailContent — body of PlayDetailPopup. View mode: photo, meta,
// scoreboard (with per-round breakdown when present), expansions, notes.
// Edit mode (own plays): date, notes, per-player score + winner toggle →
// PUT /plays/{id} full-replacement payload.

import React, { useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Star, Pencil, Trash2, LogOut } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Button, Input, Row, Text } from '../ui';
import UserBadge from '../components/UserBadge';
import { useAppState } from '../store/AppContext';

export default function PlayDetailContent({ play, editing, onStartEdit, onCancelEdit, onSave, onDelete, onLeave }) {
  const { currentUser } = useAppState();
  const meId = currentUser?.id;
  const isOwn = !!play.is_own;
  const isTagged = !isOwn && meId && (play.players || []).some((p) => p.user_id === meId);

  const photo = play.photo_url || play.game_thumbnail;
  const sorted = useMemo(
    () =>
      (play.players || []).slice().sort((a, b) => {
        const sa = a.score == null ? -Infinity : Number(a.score);
        const sb = b.score == null ? -Infinity : Number(b.score);
        return sb - sa;
      }),
    [play.players],
  );

  if (editing) {
    return <EditForm play={play} onCancel={onCancelEdit} onSave={onSave} />;
  }

  return (
    <View>
      {photo ? <Image source={{ uri: photo }} style={styles.photo} resizeMode="cover" /> : null}
      <Text variant="display" color={COLORS.polaroidInk} style={{ marginTop: SPACING.md }}>
        {play.game_name || 'Play'}
      </Text>
      <Text variant="small" color={COLORS.polaroidMuted}>
        {[play.played_at, play.play_mode !== 'competitive' ? play.play_mode : null, !isOwn ? `logged by ${play.logged_by_name}` : null]
          .filter(Boolean)
          .join('  ·  ')}
      </Text>

      <View style={styles.scoreboard}>
        {sorted.length === 0 ? (
          <Text variant="polaroidItalic">No players recorded.</Text>
        ) : (
          sorted.map((pl, i) => (
            <View key={i} style={[styles.row, pl.is_winner && styles.winnerRow]}>
              <UserBadge avatar={pl.avatar} displayName={pl.name} size="sm" isGhost={!pl.user_id} isMe={meId && pl.user_id === meId} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyMedium" color={COLORS.polaroidInk} numberOfLines={1}>
                  {pl.name}
                </Text>
                {Array.isArray(pl.round_scores) && pl.round_scores.length > 1 ? (
                  <Text variant="caption" color={COLORS.polaroidMuted}>
                    {pl.round_scores.map((s) => (s == null ? '–' : s)).join(' + ')}
                  </Text>
                ) : null}
              </View>
              {pl.is_winner ? <Star size={14} color={COLORS.accent} fill={COLORS.accent} /> : null}
              <Text variant="scoreBig" color={COLORS.polaroidInk}>
                {pl.score != null ? String(pl.score) : ''}
              </Text>
            </View>
          ))
        )}
      </View>

      {(play.expansions || []).length > 0 ? (
        <Row gap="xs" wrap style={{ marginTop: SPACING.md }}>
          {play.expansions.map((ex) => (
            <View key={ex.expansion_game_id || ex.id} style={styles.expChip}>
              {ex.color ? <View style={[styles.expDot, { backgroundColor: ex.color }]} /> : null}
              <Text variant="caption" color={COLORS.polaroidInkSoft}>
                {ex.name}
              </Text>
            </View>
          ))}
        </Row>
      ) : null}

      {play.notes ? (
        <Text variant="polaroidItalic" style={{ marginTop: SPACING.lg, fontSize: 15, lineHeight: 22 }}>
          {play.notes}
        </Text>
      ) : null}

      {isOwn ? (
        <Row gap="sm" justify="flex-end" style={{ marginTop: SPACING.xl }}>
          <Button label="Edit" variant="outline" size="sm" icon={Pencil} onPress={onStartEdit} />
          <Button label="Delete" variant="destructive" size="sm" icon={Trash2} onPress={onDelete} />
        </Row>
      ) : isTagged ? (
        <Row justify="flex-end" style={{ marginTop: SPACING.xl }}>
          <Button label="Leave play" variant="outline" size="sm" icon={LogOut} onPress={onLeave} />
        </Row>
      ) : null}
    </View>
  );
}

function EditForm({ play, onCancel, onSave }) {
  const [playedAt, setPlayedAt] = useState(String(play.played_at || ''));
  const [notes, setNotes] = useState(play.notes || '');
  const [players, setPlayers] = useState(() =>
    (play.players || []).map((p) => ({
      name: p.name,
      user_id: p.user_id || null,
      is_winner: !!p.is_winner,
      score: p.score == null ? '' : String(p.score),
      round_scores: p.round_scores || null,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function setPlayer(i, patch) {
    setPlayers((list) => list.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(playedAt.trim())) {
      setError('Date must be YYYY-MM-DD.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({
        played_at: playedAt.trim(),
        notes: notes.trim() || null,
        photo_url: play.photo_url || null,
        play_mode: play.play_mode || null,
        expansion_ids: (play.expansions || []).map((e) => e.expansion_game_id || e.id).filter(Boolean),
        players: players.map((p) => ({
          name: p.name,
          user_id: p.user_id,
          is_winner: p.is_winner,
          score: p.score === '' ? null : Number(p.score),
          // Editing totals invalidates a stale per-round breakdown.
          round_scores: null,
        })),
      });
    } catch (e) {
      setError(e.message || 'Save failed.');
    }
    setBusy(false);
  }

  return (
    <View>
      <Text variant="title" color={COLORS.polaroidInk}>
        Edit play
      </Text>
      <Input label="Played on" value={playedAt} onChangeText={setPlayedAt} placeholder="YYYY-MM-DD" style={{ marginTop: SPACING.md }} />
      <Text variant="caption" color={COLORS.polaroidMuted} style={{ marginTop: SPACING.lg, marginBottom: SPACING.xs }}>
        PLAYERS — tap the star to set the winner
      </Text>
      {players.map((p, i) => (
        <Row key={i} gap="sm" style={{ marginBottom: SPACING.sm }}>
          <Pressable onPress={() => setPlayer(i, { is_winner: !p.is_winner })} hitSlop={8} style={styles.starBtn}>
            <Star size={18} color={COLORS.accent} fill={p.is_winner ? COLORS.accent : 'transparent'} />
          </Pressable>
          <Text variant="bodyMedium" color={COLORS.polaroidInk} numberOfLines={1} style={{ flex: 1 }}>
            {p.name}
          </Text>
          <Input
            kind="score"
            value={p.score}
            onChangeText={(v) => setPlayer(i, { score: v.replace(/[^0-9-]/g, '') })}
            placeholder="—"
            style={{ width: 72 }}
          />
        </Row>
      ))}
      <Input
        label="Key moments"
        value={notes}
        onChangeText={setNotes}
        multiline
        inputStyle={{ minHeight: 80, textAlignVertical: 'top' }}
        style={{ marginTop: SPACING.md }}
      />
      {error ? (
        <Text variant="small" color={COLORS.rustText} style={{ marginTop: SPACING.sm }}>
          {error}
        </Text>
      ) : null}
      <Row gap="sm" justify="flex-end" style={{ marginTop: SPACING.lg }}>
        <Button label="Cancel" variant="outline" onPress={onCancel} disabled={busy} />
        <Button label="Save" onPress={save} busy={busy} />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  photo: { width: '100%', height: 220, borderRadius: RADII.md, backgroundColor: COLORS.polaroidBgSoft },
  scoreboard: { marginTop: SPACING.lg, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 6, paddingHorizontal: 8, borderRadius: RADII.sm },
  winnerRow: { backgroundColor: COLORS.accent + '22' },
  expChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: COLORS.polaroidBgSoft,
    borderRadius: RADII.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: COLORS.polaroidLine,
  },
  expDot: { width: 8, height: 8, borderRadius: 4 },
  starBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
});
