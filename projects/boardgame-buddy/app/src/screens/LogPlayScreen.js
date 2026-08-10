// LogPlayScreen — the Play tab: host a session (fast path: quick-pick an
// owned/recent game, offline-capable), resume an in-progress draft, join by
// code, and see buddies' joinable live sessions.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Dices, RotateCcw, Ticket, X } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Button, Card, Row, Screen, Text } from '../ui';
import EmptyState from '../components/EmptyState';
import SessionCard from '../components/SessionCard';
import GameFinder from '../widgets/GameFinder';
import { confirm } from '../components/ConfirmModal';
import { useAppActions, useAppState } from '../store/AppContext';
import api from '../api/client';
import { loadDraft, clearDraft } from '../models/playSession';

export default function LogPlayScreen({ navigation }) {
  const { currentUser } = useAppState();
  const actions = useAppActions();
  const [draft, setDraft] = useState(null);
  const [joinable, setJoinable] = useState([]);

  // Refresh the resume banner + joinable list on every focus — both change
  // outside this screen (sessions expire, buddies start games).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (currentUser) {
        loadDraft().then((d) => alive && setDraft(d));
        api.joinableSessions().then(
          (r) => alive && setJoinable(r?.sessions || []),
          () => {},
        );
        actions.refreshHostSeeds();
      }
      return () => {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.id]),
  );

  if (!currentUser) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.bg }} edges={['top']}>
        <EmptyState
          icon={Dices}
          title="Ready to play?"
          body="Sign in to host live score sessions and log your plays."
          ctaLabel="Sign in"
          onCta={() => navigation.navigate('Auth')}
        />
      </SafeAreaView>
    );
  }

  async function discardDraft() {
    const ok = await confirm({
      title: 'Discard the saved session?',
      body: `Your in-progress ${draft?.game?.name || 'play'} draft will be lost.`,
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (!ok) return;
    if (draft?.code) api.updateSessionPhase(draft.code, 'abandoned').catch(() => {});
    await clearDraft();
    setDraft(null);
  }

  return (
    <Screen scroll edges={{ top: true, bottom: false }}>
      <Text variant="display" style={{ marginTop: SPACING.sm }}>
        Play
      </Text>

      {draft ? (
        <Card variant="polaroid" pad="md" style={{ marginTop: SPACING.md }}>
          <Row gap="md">
            <RotateCcw size={20} color={COLORS.polaroidAccent} />
            <View style={{ flex: 1 }}>
              <Text variant="polaroid">Session in progress</Text>
              <Text variant="polaroidItalic">
                {draft.game?.name || 'No game picked yet'} · code {draft.code || '—'}
              </Text>
            </View>
          </Row>
          <Row gap="sm" justify="flex-end" style={{ marginTop: SPACING.sm }}>
            <Button label="Discard" variant="outline" size="sm" icon={X} onPress={discardDraft} />
            <Button label="Resume" size="sm" onPress={() => navigation.navigate('PlayFlow', {})} />
          </Row>
        </Card>
      ) : null}

      <Card pad="md" style={{ marginTop: SPACING.md }}>
        <Row gap="md">
          <Dices size={22} color={COLORS.accent} />
          <View style={{ flex: 1 }}>
            <Text variant="heading">Host a game night</Text>
            <Text variant="caption">Open a table, share the code, score live.</Text>
          </View>
          <Button label="Host" size="sm" onPress={() => navigation.navigate('PlayFlow', {})} />
        </Row>
      </Card>

      <Card pad="md" style={{ marginTop: SPACING.sm }}>
        <Row gap="md">
          <Ticket size={22} color={COLORS.accent} />
          <View style={{ flex: 1 }}>
            <Text variant="heading">Join with a code</Text>
            <Text variant="caption">Got a 5-letter code from the host?</Text>
          </View>
          <Button label="Join" variant="secondary" size="sm" onPress={() => navigation.navigate('JoinSession')} />
        </Row>
      </Card>

      {joinable.length > 0 ? (
        <View style={{ marginTop: SPACING.lg }}>
          <Text variant="label" style={{ marginBottom: SPACING.sm }}>
            Live now
          </Text>
          {joinable.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              style={{ marginBottom: SPACING.sm }}
              onPress={() => navigation.navigate('SessionRouter', { code: s.code })}
            />
          ))}
        </View>
      ) : null}

      <View style={{ marginTop: SPACING.lg }}>
        <Text variant="label" style={{ marginBottom: SPACING.sm }}>
          Start with a game
        </Text>
        <GameFinder
          includeRecentlyPlayed
          placeholder="Search your shelf — works offline"
          onPick={(game) => navigation.navigate('PlayFlow', { game })}
        />
      </View>
    </Screen>
  );
}
