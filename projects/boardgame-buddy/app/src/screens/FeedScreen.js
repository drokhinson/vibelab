// src/screens/FeedScreen.js — Strava-style chronological feed. Ported from
// web/views/feed-view.js: same play-session grouping, the three rails (hot
// games / suggested buddies / time-to-revisit), infinite scroll, and the empty
// state. First paint comes from the SWR-cached first page (seeded at bootstrap);
// pull-to-refresh + tab-focus warm the live blocks.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, ScrollView, TouchableOpacity, RefreshControl,
  ActivityIndicator, StyleSheet,
} from 'react-native';
import { Newspaper, Flame, UserPlus, Archive } from 'lucide-react-native';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import PlayCard from '../ui/PlayCard';
import GameTile from '../ui/GameTile';
import UserBadge from '../components/UserBadge';
import { Feed } from '../domain/feed';
import { Buddy } from '../domain/buddy';
import { useAppState } from '../store/AppContext';
import { formatShortDate, formatPlayedAt } from '../utils/format';
import { COLORS, FONTS, FONT_SIZES, SPACING } from '../theme';

// ── Session grouping (ported from feed-view.js groupCards) ──────────────────
function sessionKey(card) {
  const ids = (card.participants && card.participants.length)
    ? card.participants.map((p) => p.user_id).join(',')
    : `logger:${(card.user && card.user.id) || ''}`;
  return `${card.played_at}|${ids}`;
}

function groupCards(rawCards) {
  const out = [];
  const byKey = new Map();
  for (const card of rawCards) {
    if (card.kind !== 'play') { out.push(card); continue; }
    const key = sessionKey(card);
    let existing = byKey.get(key);
    if (!existing) {
      existing = { kind: 'play_session', played_at: card.played_at, participants: card.participants || [], plays: [] };
      byKey.set(key, existing);
      out.push(existing);
    }
    existing.plays.push(card);
  }
  return out;
}

function sessionTitle({ participants, viewer, loggerFallback, gameCount, gameNameForSingle }) {
  let tokens = (participants || []).map((p) => ({
    isViewer: viewer && p.user_id === viewer.id,
    name: (viewer && p.user_id === viewer.id) ? 'You' : (p.display_name || 'Someone'),
  }));
  if (tokens.length === 0) {
    tokens = loggerFallback && loggerFallback.id
      ? [{ isViewer: viewer && loggerFallback.id === viewer.id, name: (viewer && loggerFallback.id === viewer.id) ? 'You' : (loggerFallback.display_name || 'Someone') }]
      : [{ isViewer: false, name: 'Someone' }];
  }
  const vi = tokens.findIndex((t) => t.isViewer);
  if (vi > 0) { const [me] = tokens.splice(vi, 1); tokens.unshift(me); }
  let who;
  if (tokens.length === 1) who = tokens[0].name;
  else if (tokens.length === 2) who = `${tokens[0].name} and ${tokens[1].name}`;
  else if (tokens.length === 3) who = `${tokens[0].name}, ${tokens[1].name}, and ${tokens[2].name}`;
  else who = `${tokens[0].name}, ${tokens[1].name}, and ${tokens.length - 2} others`;
  const trailing = gameNameForSingle ? `played ${gameNameForSingle}` : `played ${gameCount} games`;
  return `${who} ${trailing}`;
}

// ── Card renderers ──────────────────────────────────────────────────────────
function Rail({ icon, title, children }) {
  return (
    <View style={styles.rail}>
      <View style={styles.railHead}>{icon}<Text style={styles.railTitle}>{title}</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.railScroll}>
        {children}
      </ScrollView>
    </View>
  );
}

function SuggestedBuddyTile({ s, onAdd }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.buddyTile}>
      <UserBadge avatar={s.avatar} displayName={s.display_name} size="lg" />
      <Text style={styles.buddyName} numberOfLines={1}>{s.display_name}</Text>
      <Text style={styles.buddyMutual}>{s.mutual_count} mutual</Text>
      <TouchableOpacity
        style={[styles.addBtn, sent && styles.addBtnSent]}
        disabled={sent || busy}
        onPress={async () => { setBusy(true); const ok = await onAdd(s.user_id); setBusy(false); if (ok) setSent(true); }}
      >
        <Text style={styles.addBtnText}>{sent ? 'Sent' : 'Add'}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function FeedScreen() {
  const { currentUser, feed: seededFeed } = useAppState();
  const viewer = currentUser ? { id: currentUser.id, display_name: currentUser.display_name } : null;

  const [page, setPage] = useState(seededFeed || null);
  const [loading, setLoading] = useState(!seededFeed);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const loadingMore = useRef(false);

  const load = useCallback(async ({ cursor = null } = {}) => {
    if (!cursor) setLoading((v) => (page ? v : true));
    setError(null);
    try {
      const data = await Feed.fetchPage({ cursor });
      setPage((prev) => (cursor && prev
        ? { ...data, cards: [...prev.cards, ...data.cards] }
        : data));
    } catch (e) {
      setError(e.message || 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load({}); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await Feed.refreshFirstPage();
      setPage(data);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to refresh');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const onEndReached = useCallback(() => {
    if (loadingMore.current || !page || !page.next_cursor) return;
    loadingMore.current = true;
    load({ cursor: page.next_cursor }).finally(() => { loadingMore.current = false; });
  }, [page, load]);

  const addBuddy = useCallback(async (userId) => {
    try { await Buddy.sendRequest(userId); return true; } catch { return false; }
  }, []);

  const cards = groupCards((page && page.cards) || []);

  const renderItem = ({ item }) => {
    switch (item.kind) {
      case 'play_session': {
        const first = item.plays[0];
        const single = item.plays.length === 1;
        const title = sessionTitle({
          participants: item.participants,
          viewer,
          loggerFallback: first && first.user,
          gameCount: item.plays.length,
          gameNameForSingle: single && first && first.game ? first.game.name : null,
        });
        return (
          <View style={styles.session}>
            <View style={styles.sessionHead}>
              <Text style={styles.sessionTitle} numberOfLines={2}>{title}</Text>
              <Text style={styles.sessionDate}>{formatPlayedAt(item.played_at)}</Text>
            </View>
            {single ? (
              <PlayCard card={first} variant="single" />
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sessionScroll}>
                {item.plays.map((p) => <PlayCard key={p.play_id} card={p} variant="strip" />)}
              </ScrollView>
            )}
          </View>
        );
      }
      case 'hot_games':
        return (
          <Rail icon={<Flame size={16} color={COLORS.accentHover} />} title="Hot this week">
            {(item.games || []).map((e) => (
              <GameTile
                key={e.game.id}
                game={e.game}
                variant="rail"
                subtitle={`${e.play_count} plays`}
              />
            ))}
          </Rail>
        );
      case 'featured_from_collection':
        return (
          <Rail icon={<Archive size={16} color={COLORS.accentHover} />} title="Time to revisit">
            {(item.games || []).map((e) => (
              <GameTile
                key={e.game.id}
                game={e.game}
                variant="rail"
                subtitle={e.last_played_at ? `Last: ${formatShortDate(e.last_played_at)}` : 'Never played'}
              />
            ))}
          </Rail>
        );
      case 'suggested_buddies':
        return (
          <Rail icon={<UserPlus size={16} color={COLORS.accentHover} />} title="Buddies you may know">
            {(item.suggestions || []).map((s) => (
              <SuggestedBuddyTile key={s.user_id} s={s} onAdd={addBuddy} />
            ))}
          </Rail>
        );
      default:
        return null;
    }
  };

  const keyExtractor = (item, i) => {
    if (item.kind === 'play_session') return 'sess:' + (item.plays[0] && item.plays[0].play_id) + ':' + i;
    return item.kind + ':' + i;
  };

  return (
    <View style={styles.flex}>
      <AppHeader
        title="BoardgameBuddy"
        right={<UserBadge avatar={currentUser && currentUser.avatar} displayName={currentUser && currentUser.display_name} size="sm" isMe />}
      />
      {loading && !page ? (
        <View style={styles.center}><ActivityIndicator size="large" color={COLORS.accent} /></View>
      ) : (
        <FlatList
          data={cards}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={cards.length === 0 ? styles.emptyContainer : styles.list}
          showsVerticalScrollIndicator={false}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.accent} />}
          ListEmptyComponent={
            <EmptyState
              icon={<Newspaper size={48} color={COLORS.accent} />}
              title="Your feed is quiet"
              message="Log a play or add a buddy to fill it up."
            />
          }
          ListHeaderComponent={error ? <Text style={styles.error}>{error}</Text> : null}
          ListFooterComponent={
            page && page.next_cursor
              ? <ActivityIndicator color={COLORS.accent} style={{ paddingVertical: SPACING.lg }} />
              : (cards.length > 0 ? <Text style={styles.end}>You've reached the end.</Text> : null)
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: SPACING.lg, gap: SPACING.lg },
  emptyContainer: { flexGrow: 1 },
  error: { fontFamily: FONTS.medium, fontSize: FONT_SIZES.sm, color: COLORS.danger, marginBottom: SPACING.md },
  end: { textAlign: 'center', color: COLORS.textMuted, fontFamily: FONTS.regular, fontSize: FONT_SIZES.xs, paddingVertical: SPACING.lg },

  session: { gap: SPACING.sm },
  sessionHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: SPACING.sm },
  sessionTitle: { flex: 1, fontFamily: FONTS.semibold, fontSize: FONT_SIZES.md, color: COLORS.text },
  sessionDate: { fontFamily: FONTS.regular, fontSize: FONT_SIZES.xs, color: COLORS.textMuted, marginTop: 2 },
  sessionScroll: { gap: 0, paddingRight: SPACING.xs },

  rail: { gap: SPACING.sm },
  railHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  railTitle: { fontFamily: FONTS.displayBold, fontSize: FONT_SIZES.lg, color: COLORS.text },
  railScroll: { gap: SPACING.md, paddingRight: SPACING.lg },

  buddyTile: { width: 108, alignItems: 'center', gap: 3 },
  buddyName: { fontFamily: FONTS.semibold, fontSize: FONT_SIZES.sm, color: COLORS.text, marginTop: SPACING.xs },
  buddyMutual: { fontFamily: FONTS.regular, fontSize: FONT_SIZES.xs, color: COLORS.textSecondary },
  addBtn: { marginTop: 4, backgroundColor: COLORS.accent, borderRadius: 999, paddingHorizontal: SPACING.lg, paddingVertical: 5 },
  addBtnSent: { backgroundColor: COLORS.borderStrong },
  addBtnText: { fontFamily: FONTS.semibold, fontSize: FONT_SIZES.xs, color: COLORS.brown },
});
