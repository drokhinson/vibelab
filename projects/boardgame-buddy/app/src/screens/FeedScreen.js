// FeedScreen — home: chronological play feed + hot-games / suggested-buddies /
// featured-from-collection rails, one heterogeneous FlatList over state.feed.
// Bootstrap seeds the first page so this paints instantly after boot;
// pull-to-refresh + cursor pagination after that.

import React, { memo, useCallback } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, Flame, Users, RotateCcw } from 'lucide-react-native';
import { COLORS, SPACING } from '../theme';
import { Row, Skeleton, Text } from '../ui';
import { useAppActions, useAppState } from '../store/AppContext';
import PlayCard from '../components/PlayCard';
import GameTile from '../components/GameTile';
import BuddyRow from '../components/BuddyRow';
import EmptyState from '../components/EmptyState';
import PendingUploadsBar from '../components/PendingUploadsBar';
import OfflineBanner from '../components/OfflineBanner';
import PlayDetailPopup from '../widgets/PlayDetailPopup';

export default function FeedScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const me = state.currentUser;

  const openGame = useCallback(
    (g) => navigation.navigate('GameDetail', { gameId: g.id, gameName: g.name }),
    [navigation],
  );

  const renderCard = useCallback(
    ({ item: card }) => <FeedCard card={card} me={me} openGame={openGame} navigation={navigation} />,
    [me, openGame, navigation],
  );

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header navigation={navigation} />
        <EmptyState
          title="Welcome to Boardgame Buddy"
          body="Sign in to see what your buddies are playing and log your own games."
          ctaLabel="Sign in"
          onCta={() => navigation.navigate('Auth')}
        />
      </SafeAreaView>
    );
  }

  const cards = state.feed?.cards || [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header navigation={navigation} />
      <OfflineBanner style={styles.pendingBar} />
      <PendingUploadsBar style={styles.pendingBar} />
      <FlatList
        data={cards}
        keyExtractor={(c, i) => `${c.kind}-${c.play_id || c.session_id || i}`}
        renderItem={renderCard}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={!!state.feedLoading && !!state.feed} onRefresh={actions.refreshFeed} tintColor={COLORS.accent} />}
        onEndReachedThreshold={0.5}
        onEndReached={actions.loadMoreFeed}
        windowSize={7}
        removeClippedSubviews
        ListEmptyComponent={
          state.feed ? (
            <EmptyState title="Quiet table" body="No plays yet. Log your first game from the Play tab." />
          ) : (
            <FeedSkeleton />
          )
        }
        ListFooterComponent={state.feedCursor && state.feedLoading ? <FeedSkeleton rows={1} /> : null}
      />
    </SafeAreaView>
  );
}

// One memoized renderer per card kind — a feed scroll never re-renders
// unchanged cards.
const FeedCard = memo(function FeedCard({ card, me, openGame, navigation }) {
  switch (card.kind) {
    case 'play':
      return (
        <View style={styles.cardWrap}>
          <PlayCard
            card={card}
            meId={me.id}
            meName={me.display_name}
            onOpenGame={() => card.game && openGame(card.game)}
            onOpenDetail={(id) => PlayDetailPopup.show(id)}
          />
        </View>
      );
    case 'play_session': {
      const plays = card.plays || [];
      if (plays.length === 1) {
        return (
          <View style={styles.cardWrap}>
            <PlayCard card={plays[0]} meId={me.id} meName={me.display_name} onOpenGame={() => plays[0].game && openGame(plays[0].game)} onOpenDetail={(id) => PlayDetailPopup.show(id)} />
          </View>
        );
      }
      return (
        <View style={styles.railWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railScroll}>
            {plays.map((p) => (
              <PlayCard key={p.play_id} card={p} variant="strip" meId={me.id} meName={me.display_name} onOpenGame={() => p.game && openGame(p.game)} onOpenDetail={(id) => PlayDetailPopup.show(id)} />
            ))}
          </ScrollView>
        </View>
      );
    }
    case 'hot_games':
      return <GameRail title="Hot this week" Icon={Flame} entries={card.games} openGame={openGame} countKey="play_count" countSuffix="plays" />;
    case 'featured_from_collection':
      return <GameRail title="Time to revisit" Icon={RotateCcw} entries={card.games} openGame={openGame} />;
    case 'suggested_buddies': {
      const list = card.suggestions || [];
      if (!list.length) return null;
      return (
        <View style={styles.railWrap}>
          <Row gap="xs" style={styles.railHeader}>
            <Users size={16} color={COLORS.accent} />
            <Text variant="heading" style={{ fontSize: 17 }}>
              Buddies you may know
            </Text>
          </Row>
          {list.slice(0, 5).map((b) => (
            <BuddyRow
              key={b.user_id}
              buddy={{ display_name: b.display_name, avatar: b.avatar, username: b.username }}
              relation="none"
              onPress={() => navigation.navigate('ProfileOther', { userId: b.user_id })}
              subtitle={b.reason}
            />
          ))}
        </View>
      );
    }
    default:
      return null;
  }
});

function GameRail({ title, Icon, entries, openGame, countKey, countSuffix }) {
  const list = entries || [];
  if (!list.length) return null;
  return (
    <View style={styles.railWrap}>
      <Row gap="xs" style={styles.railHeader}>
        <Icon size={16} color={COLORS.accent} />
        <Text variant="heading" style={{ fontSize: 17 }}>
          {title}
        </Text>
      </Row>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railScroll}>
        {list.map((entry, i) => (
          <View key={entry.game?.id || i} style={styles.railTile}>
            <GameTile game={entry.game} variant="preview" onPress={() => openGame(entry.game)} />
            {countKey && entry[countKey] != null ? (
              <Text variant="caption" center style={{ marginTop: 4 }}>
                {entry[countKey]} {countSuffix}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function FeedSkeleton({ rows = 3 }) {
  return (
    <View style={{ gap: SPACING.lg }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={{ gap: SPACING.sm }}>
          <Skeleton height={180} radius={12} />
          <Skeleton height={16} width="55%" />
        </View>
      ))}
    </View>
  );
}

function Header({ navigation }) {
  return (
    <Row justify="space-between" style={styles.header}>
      <Text variant="title" color={COLORS.accent} style={{ fontSize: 22 }}>
        Boardgame Buddy
      </Text>
      <Pressable style={styles.searchBtn} onPress={() => navigation.navigate('Search')} hitSlop={8}>
        <Search size={22} color={COLORS.text} />
      </Pressable>
    </Row>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm },
  pendingBar: { marginHorizontal: SPACING.lg, marginBottom: SPACING.xs },
  searchBtn: { width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center' },
  list: { padding: SPACING.lg, paddingBottom: 40 },
  cardWrap: { marginBottom: SPACING.lg },
  railWrap: { marginBottom: SPACING.lg },
  railHeader: { marginBottom: SPACING.sm },
  railScroll: { gap: SPACING.md, paddingRight: SPACING.lg },
  railTile: { width: 120 },
});
