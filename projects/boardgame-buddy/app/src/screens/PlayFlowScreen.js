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
import { confirm } from '../components/ConfirmModal';
import { showPolaroid, updatePolaroid } from '../components/PolaroidPopup';
import { attachPhoto } from './play/playSave';
import { useAppActions, useAppState } from '../store/AppContext';
import usePlaySession from './play/usePlaySession';
import { PHASES } from '../models/playSession';
import GatherStep from './play/GatherStep';
import PlayStep from './play/PlayStep';
import SettleStep from './play/SettleStep';

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
    fresh: !!route.params?.fresh,
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

  // The wrap-up card's two destinations, defined once. The success paths below
  // have to restore goToFeed explicitly: they clear the failure path's dismiss
  // override, and a bare `onDismiss: null` would take the feed navigation with
  // it, leaving "Go to feed" closing the card onto a spent Settle Up screen.
  const goToFeed = () => navigation.navigate('Home', { screen: 'FeedTab' });
  // Backing out means "done with this game", not "show me the feed".
  const goToPlayTab = () => navigation.navigate('Home', { screen: 'PlayTab' });

  // Persist the play behind the wrap-up card. Never awaited by the tap
  // handler — the card is already up, and it carries the save's state.
  async function runSaveBehindCard(snap, cardId) {
    updatePolaroid({ saving: true, error: null }, cardId);
    const result = await session.runSave(snap);

    if (!result.ok) {
      // Server rejection: offer Retry and leave the draft untouched, so
      // closing the card lands back on an intact Settle Up.
      updatePolaroid(
        {
          saving: false,
          error: result.error || 'Failed to save',
          onRetry: () => runSaveBehindCard(snap, cardId),
          onDismiss: () => session.setError(result.error || 'Failed to save'),
        },
        cardId,
      );
      return;
    }

    actions.setActiveSession(null);

    if (result.queued) {
      // Offline: the outbox owns it from here, so this is a success, not a
      // Retry — the play uploads on the next flush.
      updatePolaroid(
        {
          saving: false,
          error: null,
          onDismiss: goToFeed,
          caption: 'Saved on this phone — uploads when you’re back online.',
        },
        cardId,
      );
      return;
    }

    // Refresh behind the still-up card so "Go to feed" lands on a feed that
    // already contains this play.
    actions.afterPlaySaved(result.game?.id);
    actions.refreshHostSeeds();
    updatePolaroid({ saving: false, error: null, onDismiss: goToFeed }, cardId);

    // Unblocked on the play landing, not on the photo — the photo has always
    // been best-effort, and it only ever cost the host time to wait on it.
    if (result.uploadPromise) {
      const ok = await attachPhoto(result.uploadPromise, result.playId);
      if (!ok) {
        updatePolaroid(
          { warning: 'Saved without the photo — you can add it later from the play card.' },
          cardId,
        );
      }
    }
  }

  async function advance() {
    if (phase === 'gather') {
      if (!draft.game?.id) return session.setError('Pick a game first.');
      if (!draft.players.length) return session.setError('Add at least one player.');
      session.advancePhase('play');
    } else if (phase === 'play') {
      session.advancePhase('settle');
    } else {
      // Snapshot before anything clears or recycles the draft.
      const snap = session.snapshotForSave();
      if (!snap) return;
      const seed = session.nextRoundSeed();

      // Card up in the same frame as the tap; the write runs behind it.
      const cardId = showPolaroid({
        title: 'Well played!',
        caption: snap.winner ? `${snap.winner.name} takes ${snap.game?.name || 'the game'}` : snap.game?.name || '',
        photoUrl: snap.photoUrl || snap.game?.image_url || snap.game?.thumbnail_url || null,
        saving: true,
        onAnotherRound: () => session.startAnotherRound(seed),
        onDismiss: goToFeed,
        onClose: goToPlayTab,
      });
      runSaveBehindCard(snap, cardId);
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
  // A game pick is the only prerequisite. Gating this on the session code made
  // the host stare at a greyed-out Continue while POST /sessions went to
  // Railway and back — and the code isn't needed to play, only to be joined.
  // advancePhase flips locally and lets the lobby catch up.
  const ctaDisabled = phase === 'gather' ? !draft.game?.id : false;

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
