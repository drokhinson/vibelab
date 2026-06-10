// FeedScreen — home: chronological play feed + hot-games / suggested-buddies /
// featured-from-collection rails. Mirrors web/views/feed-view.js. Cursor-
// paginated FlatList off state.feed; composes PlayCard, GameTile, BuddyRow.

import React, { useCallback } from 'react';
import { View, Text, FlatList, ScrollView, Pressable, RefreshControl, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, Flame, Users, RotateCcw } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState, useAppActions } from '../store/AppContext';
import PlayCard from '../components/PlayCard';
import GameTile from '../components/GameTile';
import BuddyRow from '../components/BuddyRow';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import PlayDetailPopup from '../widgets/PlayDetailPopup';

export default function FeedScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const me = state.currentUser;

  const openGame = useCallback((g) => navigation.navigate('GameDetail', { gameId: g.id, gameName: g.name }), [navigation]);

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

  const cards = (state.feed && state.feed.cards) || [];

  const renderCard = ({ item: card }) => {
    switch (card.kind) {
      case 'play':
        return (
          <View style={styles.cardWrap}>
            <PlayCard card={card} meId={me.id} meName={me.display_name} onOpenGame={() => card.game && openGame(card.game)} onOpenDetail={(id) => PlayDetailPopup.show(id)} />
          </View>
        );
      case 'play_session':
        return <PlaySessionRail card={card} me={me} openGame={openGame} />;
      case 'hot_games':
        return <GameRail title="Hot this week" Icon={Flame} entries={card.games} openGame={openGame} countKey="play_count" countSuffix="plays" />;
      case 'featured_from_collection':
        return <GameRail title="Time to revisit" Icon={RotateCcw} entries={card.games} openGame={openGame} />;
      case 'suggested_buddies':
        return <SuggestedBuddies card={card} navigation={navigation} />;
      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header navigation={navigation} />
      <FlatList
        data={cards}
        keyExtractor={(c, i) => `${c.kind}-${c.play_id || c.session_id || i}`}
        renderItem={renderCard}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={!!state.feedLoading} onRefresh={actions.refreshFeed} tintColor={COLORS.accent} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => state.feedCursor && actions.loadMoreFeed(state.feedCursor)}
        ListEmptyComponent={
          state.feed ? (
            <EmptyState title="Quiet table" body="No plays yet. Log your first game from the Play tab." />
          ) : (
            <LoadingState label="Loading your feed…" />
          )
        }
      />
    </SafeAreaView>
  );
}

function Header({ navigation }) {
  return (
    <View style={styles.header}>
      <Text style={styles.brand}>Boardgame Buddy</Text>
      <Pressable style={styles.searchBtn} onPress={() => navigation.navigate('Search')} hitSlop={8}>
        <Search size={22} color={COLORS.text} />
      </Pressable>
    </View>
  );
}

function PlaySessionRail({ card, me, openGame }) {
  const plays = card.plays || [];
  const single = plays.length === 1;
  if (single) {
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
          <PlayCard key={p.play_id} card={p} variant="strip" meId={me.id} meName={me.display_name} onOpenGame={() => p.game && openGame(p.game)} onOpenDetail={(id) => PlayDetailPopup.show(id)} style={styles.stripCard} />
        ))}
      </ScrollView>
    </View>
  );
}

function GameRail({ title, Icon, entries, openGame, countKey, countSuffix }) {
  const list = entries || [];
  if (!list.length) return null;
  return (
    <View style={styles.railWrap}>
      <View style={styles.railHeader}>
        <Icon size={16} color={COLORS.accent} />
        <Text style={styles.railTitle}>{title}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railScroll}>
        {list.map((entry, i) => (
          <View key={entry.game.id || i} style={styles.railTile}>
            <GameTile game={entry.game} variant="preview" onPress={() => openGame(entry.game)} />
            {countKey && entry[countKey] != null ? (
              <Text style={styles.railMeta}>{entry[countKey]} {countSuffix}</Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function SuggestedBuddies({ card, navigation }) {
  const list = card.suggestions || [];
  if (!list.length) return null;
  return (
    <View style={styles.railWrap}>
      <View style={styles.railHeader}>
        <Users size={16} color={COLORS.accent} />
        <Text style={styles.railTitle}>Buddies you may know</Text>
      </View>
      {list.slice(0, 5).map((b) => (
        <BuddyRow key={b.user_id} buddy={{ display_name: b.display_name, avatar: b.avatar, username: b.username }} relation="none" onPress={() => navigation.navigate('ProfileOther', { userId: b.user_id })} subtitle={b.reason} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm },
  brand: { fontFamily: FONTS.displayBold, color: COLORS.accent, fontSize: 22 },
  searchBtn: { width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center' },
  list: { padding: SPACING.lg, paddingBottom: 40, gap: SPACING.lg },
  cardWrap: { marginBottom: SPACING.lg },
  railWrap: { marginBottom: SPACING.lg },
  railHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: SPACING.sm },
  railTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 17 },
  railScroll: { gap: SPACING.md, paddingRight: SPACING.lg },
  railTile: { width: 120 },
  railMeta: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 11, marginTop: 4, textAlign: 'center' },
  stripCard: { marginRight: 0 },
});
