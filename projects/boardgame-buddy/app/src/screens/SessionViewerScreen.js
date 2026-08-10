// SessionViewerScreen — the joiner's live mirror of a session. The phase
// follows the host via Realtime (+ poll safety net); the joiner edits only
// their own scoring column. Finalize → winner polaroid splash → Feed;
// abandoned → notice → back to the Play tab.

import React, { useCallback } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Row, Screen, Text } from '../ui';
import { useAppActions, useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import UserBadge from '../components/UserBadge';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import { alert as alertModal } from '../components/ConfirmModal';
import { showPolaroid } from '../components/PolaroidPopup';
import RoundScoreGrid from '../widgets/RoundScoreGrid';
import ReferenceGuideScroll from '../widgets/ReferenceGuideScroll';
import api from '../api/client';
import useSessionWatch from './session/useSessionWatch';

export default function SessionViewerScreen({ navigation, route }) {
  const code = route.params?.code;
  const me = useAppState().currentUser;
  const actions = useAppActions();

  const onFinalized = useCallback(
    async (row) => {
      // Pull the finalized play for the real winner + photo; fall back to a
      // generic splash if it isn't readable yet.
      let title = 'Game logged!';
      let caption = 'The host wrapped up the play — it’s on your feed.';
      let photoUrl = null;
      const playId = row?.finalized_play_id;
      if (playId) {
        try {
          const play = await api.play(playId);
          const winners = (play.players || []).filter((p) => p.is_winner);
          if (winners.length) {
            title = winners.length > 1 ? 'What a table!' : `${winners[0].name} wins!`;
            caption = play.game_name || caption;
          }
          photoUrl = play.photo_url || null;
        } catch {}
      }
      actions.afterPlaySaved(null);
      navigation.navigate('Home', { screen: 'FeedTab' });
      showPolaroid({ title, caption, photoUrl });
    },
    [actions, navigation],
  );

  const onAbandoned = useCallback(async () => {
    await alertModal({ title: 'Session ended', body: 'The host closed this table before finishing.' });
    navigation.navigate('Home', { screen: 'PlayTab' });
  }, [navigation]);

  const { session, phase, rounds, live, error } = useSessionWatch({ code, me, onFinalized, onAbandoned });

  if (!session) {
    return (
      <Screen pad={false} edges={{ top: false, bottom: false }} header={<AppHeader title={`Session · ${code || ''}`} onBack={() => navigation.goBack()} />}>
        {error ? <EmptyState tone="error" title="Can't reach the table" body={error} /> : <LoadingState label="Joining the table…" />}
      </Screen>
    );
  }

  const players = (session.participants || []).map((p) => ({
    key: p.user_id || p.id,
    name: p.display_name,
    user_id: p.user_id || null,
    avatar: p.avatar || null,
  }));

  const phaseLabel = phase === 'gather' ? 'Gathering' : phase === 'play' ? 'In play' : 'Settling up';

  return (
    <Screen
      pad={false}
      edges={{ top: false, bottom: false }}
      header={<AppHeader title={session.game?.name || `Session ${code}`} subtitle={`${code} · ${phaseLabel}`} onBack={() => navigation.goBack()} />}
    >
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {session.game ? <GameTile game={session.game} variant="thumb" showStatus={false} /> : null}

        {phase === 'gather' ? (
          <View style={styles.section}>
            <Text variant="title" center>
              Waiting for the host to start…
            </Text>
            <Text variant="label" style={{ marginTop: SPACING.sm }}>
              At the table
            </Text>
            <Row gap="sm" wrap>
              {players.map((p) => (
                <View key={p.key} style={styles.rosterChip}>
                  <UserBadge avatar={p.avatar} displayName={p.name} size="xs" isGhost={!p.user_id} isMe={p.user_id === me?.id} />
                  <Text variant="bodyMedium" style={{ fontSize: 13 }}>
                    {p.name}
                  </Text>
                </View>
              ))}
            </Row>
          </View>
        ) : null}

        {(phase === 'play' || phase === 'settle') && live ? (
          <View style={styles.section}>
            {phase === 'settle' ? (
              <View style={styles.settleBanner}>
                <Text variant="polaroid" center>
                  The host is settling up
                </Text>
                <Text variant="polaroidItalic" center>
                  Final scores and the table photo land on your feed in a moment.
                </Text>
              </View>
            ) : (
              <Text variant="small">Type your own scores — the host sees them live.</Text>
            )}
            <RoundScoreGrid
              players={players}
              rounds={rounds}
              getCell={(pi, ri) => live.getScore(players[pi].user_id, ri)}
              getTotal={(pi) => live.totalFor(players[pi].user_id)}
              canEditColumn={(pi) => phase === 'play' && !!me && players[pi].user_id === me.id}
              onSetCell={(pi, ri, v) => {
                if (me && players[pi].user_id === me.id) live.setMyScore(ri, v).catch(() => {});
              }}
              editable={phase === 'play'}
            />
            {session.game ? <ReferenceGuideScroll gameId={session.game.id} /> : null}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: SPACING.lg, gap: SPACING.lg, paddingBottom: 40 },
  section: { gap: SPACING.md },
  rosterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    minHeight: 36,
  },
  settleBanner: {
    backgroundColor: COLORS.polaroidBg,
    borderRadius: RADII.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.polaroidLine,
    gap: 4,
  },
});
