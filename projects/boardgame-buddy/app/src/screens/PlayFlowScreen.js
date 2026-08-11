// PlayFlowScreen — the host cascade orchestrator. Three steps (Gather → Play
// → Settle Up) in a NON-swipeable horizontal pager; the phase is server-
// authoritative (joiners follow it), so navigation is gated to the Continue
// CTA and the back arrow. usePlaySession owns all state; this file owns
// layout + phase-driven paging.

import React, { useEffect, useRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { ChevronLeft, Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, SPACING } from '../theme';
import { Button, FooterBar, Row, Text } from '../ui';
import LoadingState from '../components/LoadingState';
import { alert, confirm } from '../components/ConfirmModal';
import { showPolaroid } from '../components/PolaroidPopup';
import { useAppActions, useAppState } from '../store/AppContext';
import usePlaySession from './play/usePlaySession';
import GatherStep from './play/GatherStep';
import PlayStep from './play/PlayStep';
import SettleStep from './play/SettleStep';

const PHASES = ['gather', 'play', 'settle'];
const TITLES = { gather: 'Gather', play: 'Play', settle: 'Settle Up' };

export default function PlayFlowScreen({ navigation, route }) {
  const { currentUser } = useAppState();
  const actions = useAppActions();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pagerRef = useRef(null);

  const session = usePlaySession({
    me: currentUser,
    initialCode: route.params?.code || null,
    initialGame: route.params?.game || null,
  });
  const { ready, draft, error, saving } = session;
  const phase = draft?.phase && PHASES.includes(draft.phase) ? draft.phase : 'gather';
  const phaseIdx = PHASES.indexOf(phase);

  // Phase change → slide the pager. scrollEnabled stays false so the phase is
  // the only thing that moves it.
  useEffect(() => {
    pagerRef.current?.scrollTo({ x: phaseIdx * width, animated: true });
  }, [phaseIdx, width]);

  async function goBack() {
    if (phase === 'gather') {
      // Draft persists — LogPlay shows a resume banner.
      navigation.goBack();
      return;
    }
    session.advancePhase(PHASES[phaseIdx - 1]);
  }

  async function abandon() {
    const ok = await confirm({
      title: 'Discard this play?',
      body: "Players in the lobby will be kicked and any scores so far will be lost. This can't be undone.",
      confirmLabel: 'Discard',
      cancelLabel: 'Keep playing',
      destructive: true,
    });
    if (!ok) return;
    await session.abandon();
    actions.setActiveSession(null);
    navigation.goBack();
  }

  async function advance() {
    if (phase === 'gather') {
      if (!draft.game?.id) return session.setError('Pick a game first.');
      if (!draft.players.length) return session.setError('Add at least one player.');
      session.advancePhase('play');
    } else if (phase === 'play') {
      session.advancePhase('settle');
    } else {
      const result = await session.save();
      if (!result.ok) return;
      actions.setActiveSession(null);
      if (result.queued) {
        // Offline: the play sits in the outbox — nothing changed server-side.
        navigation.navigate('Home', { screen: 'FeedTab' });
        showPolaroid({
          title: 'Well played!',
          caption: 'Saved on this phone — uploads when you’re back online.',
          photoUrl: result.photoUrl || result.game?.thumbnail_url || null,
        });
        return;
      }
      actions.afterPlaySaved(result.game?.id);
      actions.refreshHostSeeds();
      if (result.photoFailed) {
        await alert({
          title: "Photo couldn't be uploaded",
          body: 'Your play was saved without the photo. You can add it later from the play card.',
        });
      }
      navigation.navigate('Home', { screen: 'FeedTab' });
      showPolaroid({
        title: 'Well played!',
        caption: result.winner ? `${result.winner.name} takes ${result.game?.name || 'the game'}` : result.game?.name || '',
        photoUrl: result.photoUrl || result.game?.image_url || result.game?.thumbnail_url || null,
      });
    }
  }

  if (!ready || !draft) {
    return (
      <View style={[styles.safe, { justifyContent: 'center' }]}>
        <LoadingState label="Opening the table…" />
      </View>
    );
  }

  const ctaLabel = phase === 'gather' ? 'Continue to Play' : phase === 'play' ? 'Wrap up' : saving ? 'Saving…' : 'Save play';
  const ctaDisabled =
    phase === 'gather' ? !draft.game?.id || (!session.lobby?.code && !draft.offlineTable) : false;

  return (
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      {/* Cascade header */}
      <Row style={styles.header}>
        <Pressable onPress={goBack} hitSlop={10} style={styles.headerBtn}>
          <ChevronLeft size={26} color={COLORS.text} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading" style={{ fontSize: 18 }}>
            {TITLES[phase]}
          </Text>
          <Text variant="score" color={COLORS.textMuted} style={{ fontSize: 12 }}>
            {phaseIdx + 1} / 3
          </Text>
        </View>
        <Pressable onPress={abandon} hitSlop={10} style={styles.headerBtn}>
          <Trash2 size={20} color={COLORS.rustText} />
        </Pressable>
      </Row>

      {error ? (
        <Text variant="small" color={COLORS.rustText} center style={{ paddingHorizontal: SPACING.lg, paddingBottom: SPACING.xs }}>
          {error}
        </Text>
      ) : null}

      {/* Controlled pager + CTA, keyboard-safe: the FooterBar rides above the
          keyboard so Continue/Save is never covered while typing scores. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          decelerationRate="fast"
        >
          {PHASES.map((p) => (
            <ScrollView
              key={p}
              style={{ width }}
              contentContainerStyle={styles.stepBody}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {p === 'gather' ? (
                <GatherStep session={session} navigation={navigation} />
              ) : p === 'play' ? (
                <PlayStep session={session} />
              ) : (
                <SettleStep session={session} />
              )}
            </ScrollView>
          ))}
        </ScrollView>

        <FooterBar bottomInset={insets.bottom}>
          <Button label={ctaLabel} onPress={advance} disabled={ctaDisabled} busy={saving} full style={{ flex: 1 }} />
        </FooterBar>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  stepBody: { padding: SPACING.lg, paddingBottom: SPACING.xxl },
});
