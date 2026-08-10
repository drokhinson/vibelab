// GameDetailScreen — game hero + collection status + expansions + reference
// guide + recent plays. Serves the cached bundle instantly (bootstrap or a
// previous visit), then refreshes in the background with a visible hint —
// never a blank screen for a game we've seen before, never silently stale.

import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ExternalLink, BookOpen, Dices } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { RefreshHint, Row, Skeleton, Text } from '../ui';
import { useAppActions, useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import StatusTag from '../components/StatusTag';
import PlayCard from '../components/PlayCard';
import ReferenceGuideScroll from '../widgets/ReferenceGuideScroll';
import PlayDetailPopup from '../widgets/PlayDetailPopup';
import ExpansionsSection from './gameDetail/ExpansionsSection';
import AdminTools from './gameDetail/AdminTools';

export default function GameDetailScreen({ navigation, route }) {
  const { gameId, gameName } = route.params || {};
  const state = useAppState();
  const actions = useAppActions();
  const cached = state.gameBundles[gameId]?.bundle || null;
  const [bundle, setBundle] = useState(cached);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const b = await actions.loadGameBundle(gameId, { force: true });
      setBundle(b);
    } catch {}
    setRefreshing(false);
  }, [gameId, actions]);

  useEffect(() => {
    load();
  }, [load]);

  const game = bundle?.game || bundle;
  const me = state.currentUser;

  return (
    <View style={styles.safe}>
      <AppHeader title={game?.name || gameName || 'Game'} onBack={() => navigation.goBack()} />
      {!game ? (
        <View style={styles.body}>
          <Skeleton height={150} width={150} radius={RADII.lg} style={{ alignSelf: 'center' }} />
          <Skeleton height={24} width="60%" style={{ alignSelf: 'center', marginTop: SPACING.lg }} />
          <Skeleton height={40} style={{ marginTop: SPACING.xl }} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <RefreshHint visible={refreshing && !!cached} />
          <GameTile game={game} variant="hero" showStatus={false} />

          <View style={styles.actionRow}>
            <StatusTag gameId={game.id} game={game} addLabel="Add to collection" />
          </View>

          <Row gap="sm" justify="center" style={{ marginTop: SPACING.md }}>
            {me ? (
              <LinkChip Icon={Dices} label="Log a play" onPress={() => navigation.navigate('PlayFlow', { game })} />
            ) : null}
            {game.bgg_id ? (
              <LinkChip
                Icon={ExternalLink}
                label="BoardGameGeek"
                onPress={() => Linking.openURL(`https://boardgamegeek.com/boardgame/${game.bgg_id}`)}
              />
            ) : null}
            {game.rulebook_url ? (
              <LinkChip Icon={BookOpen} label="Rulebook" onPress={() => Linking.openURL(game.rulebook_url)} />
            ) : null}
          </Row>

          <ExpansionsSection expansions={bundle?.expansions || []} baseId={game.id} onChanged={load} />

          <View style={styles.section}>
            <ReferenceGuideScroll
              gameId={game.id}
              expansionIds={(bundle?.expansions || []).filter((e) => e.is_enabled).map((e) => e.expansion_game_id)}
            />
          </View>

          {(bundle?.recent_plays || []).length > 0 ? (
            <View style={styles.section}>
              <Text variant="heading" style={{ fontSize: 18 }}>
                Recent plays
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.playScroll}>
                {bundle.recent_plays.map((p) => (
                  <PlayCard
                    key={p.play_id || p.id}
                    card={{ ...p, play_id: p.play_id || p.id, game }}
                    variant="strip"
                    meId={me?.id}
                    meName={me?.display_name}
                    onOpenGame={() => {}}
                    onOpenDetail={(id) => PlayDetailPopup.show(id)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {me?.is_admin ? <AdminTools game={game} onChanged={load} /> : null}
        </ScrollView>
      )}
    </View>
  );
}

function LinkChip({ Icon, label, onPress }) {
  return (
    <Pressable style={styles.linkChip} onPress={onPress}>
      <Icon size={14} color={COLORS.accent} />
      <Text variant="caption" color={COLORS.accent} style={{ textTransform: 'none', letterSpacing: 0 }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 40 },
  actionRow: { alignItems: 'center', marginTop: SPACING.lg },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: COLORS.card,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    minHeight: 36,
  },
  section: { marginTop: SPACING.xl },
  playScroll: { gap: SPACING.md, paddingRight: SPACING.lg, marginTop: SPACING.sm },
});
