// GameDetailScreen — game hero + collection status + expansions + reference
// guide + recent plays. Seeds from the gameBundles cache for instant paint,
// then refreshes. Mirrors web/views/game-detail-view.js.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, Linking, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ExternalLink, BookOpen, ChevronDown, ChevronRight } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING, gameAccent } from '../theme';
import { useAppState, useAppActions } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import StatusTag from '../components/StatusTag';
import PlayCard from '../components/PlayCard';
import LoadingState from '../components/LoadingState';
import ReferenceGuideScroll from '../widgets/ReferenceGuideScroll';
import PlayDetailPopup from '../widgets/PlayDetailPopup';
import api from '../api/client';

export default function GameDetailScreen({ navigation, route }) {
  const { gameId, gameName } = route.params || {};
  const state = useAppState();
  const actions = useAppActions();
  const [bundle, setBundle] = useState(state.gameBundles[gameId] || null);
  const [expOpen, setExpOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const b = await actions.loadGameBundle(gameId, { force: true });
      setBundle(b);
    } catch {}
  }, [gameId, actions]);

  useEffect(() => { load(); }, [load]);

  if (!bundle) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader title={gameName || 'Game'} onBack={() => navigation.goBack()} />
        <LoadingState label="Loading game…" />
      </SafeAreaView>
    );
  }

  const game = bundle.game || bundle;
  const expansions = bundle.expansions || [];
  const recentPlays = bundle.recent_plays || [];
  const me = state.currentUser;
  const enabledExpIds = expansions.filter((e) => e.is_enabled).map((e) => e.expansion_game_id);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title={game.name || 'Game'} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body}>
        <GameTile game={game} variant="hero" showStatus={false} />

        <View style={styles.actionRow}>
          <StatusTag gameId={game.id} addLabel="Add to collection" />
        </View>

        <View style={styles.linkRow}>
          {game.bgg_id ? (
            <Pressable style={styles.linkChip} onPress={() => Linking.openURL(`https://boardgamegeek.com/boardgame/${game.bgg_id}`)}>
              <ExternalLink size={14} color={COLORS.accent} />
              <Text style={styles.linkChipLabel}>BoardGameGeek</Text>
            </Pressable>
          ) : null}
          {game.rulebook_url ? (
            <Pressable style={styles.linkChip} onPress={() => Linking.openURL(game.rulebook_url)}>
              <BookOpen size={14} color={COLORS.accent} />
              <Text style={styles.linkChipLabel}>Rulebook</Text>
            </Pressable>
          ) : null}
        </View>

        {expansions.length > 0 ? (
          <View style={styles.section}>
            <Pressable style={styles.expHeader} onPress={() => setExpOpen((v) => !v)}>
              <Text style={styles.sectionTitle}>Expansions ({expansions.length})</Text>
              {expOpen ? <ChevronDown size={18} color={COLORS.textMuted} /> : <ChevronRight size={18} color={COLORS.textMuted} />}
            </Pressable>
            {expOpen ? (
              <View style={styles.expList}>
                {expansions.map((exp) => (
                  <ExpansionRow key={exp.expansion_game_id} exp={exp} baseId={game.id} onChanged={load} />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.section}>
          <ReferenceGuideScroll
            gameId={game.id}
            gameName={game.name}
            expansionIds={enabledExpIds}
            onAddChapter={() => navigation.navigate('ChapterEditor', { gameId: game.id, gameName: game.name, expansionIds: enabledExpIds })}
          />
        </View>

        {recentPlays.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Recent plays</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.playScroll}>
              {recentPlays.map((p) => (
                <PlayCard key={p.play_id || p.id} card={{ ...p, play_id: p.play_id || p.id, game }} variant="strip" meId={me?.id} meName={me?.display_name} onOpenGame={() => {}} onOpenDetail={(id) => PlayDetailPopup.show(id)} style={styles.playCard} />
              ))}
            </ScrollView>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ExpansionRow({ exp, baseId, onChanged }) {
  const [enabled, setEnabled] = useState(exp.is_enabled);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    const next = !enabled;
    setEnabled(next);
    try {
      await api.toggleExpansion(baseId, exp.expansion_game_id, next);
      onChanged && onChanged();
    } catch {
      setEnabled(!next);
    }
    setBusy(false);
  }
  return (
    <Pressable style={styles.expRow} onPress={toggle} disabled={busy}>
      {exp.color ? <View style={[styles.expDot, { backgroundColor: exp.color }]} /> : null}
      <Text style={styles.expName} numberOfLines={1}>{exp.name}</Text>
      <View style={[styles.toggle, enabled && styles.toggleOn]}>
        <View style={[styles.knob, enabled && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 40 },
  actionRow: { alignItems: 'center', marginTop: SPACING.lg },
  linkRow: { flexDirection: 'row', justifyContent: 'center', gap: SPACING.sm, marginTop: SPACING.md },
  linkChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.card, paddingHorizontal: 12, paddingVertical: 7, borderRadius: RADII.pill, borderWidth: 1, borderColor: COLORS.border },
  linkChipLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.accent, fontSize: 12 },
  section: { marginTop: SPACING.xl },
  sectionTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18 },
  expHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  expList: { marginTop: SPACING.sm, gap: 2 },
  expRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 10 },
  expDot: { width: 10, height: 10, borderRadius: 5 },
  expName: { flex: 1, fontFamily: FONTS.sansMedium, color: COLORS.text, fontSize: 14 },
  toggle: { width: 42, height: 24, borderRadius: 12, backgroundColor: COLORS.border, padding: 3, justifyContent: 'center' },
  toggleOn: { backgroundColor: COLORS.accent },
  knob: { width: 18, height: 18, borderRadius: 9, backgroundColor: COLORS.textSoft },
  knobOn: { backgroundColor: COLORS.bg, alignSelf: 'flex-end' },
  playScroll: { gap: SPACING.md, paddingRight: SPACING.lg, marginTop: SPACING.sm },
  playCard: {},
});
