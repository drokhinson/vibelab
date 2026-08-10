// ProfileSelfScreen — own profile hub (the ProfileTab). Identity + stats +
// shelf preview + nav links. Stats seed from bootstrap; shelf preview comes
// straight from the offline collection store, so this paints with zero
// network.

import React, { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Settings, ChevronRight, LibraryBig, Star, History, Users, Shield } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Row, Text } from '../ui';
import { useAppState } from '../store/AppContext';
import UserBadge from '../components/UserBadge';
import StatsStrip from '../components/StatsStrip';
import GameTile from '../components/GameTile';
import EmptyState from '../components/EmptyState';
import api from '../api/client';
import { collectionGames, refreshCollection, subscribeCollection } from '../offline/collectionStore';

export default function ProfileSelfScreen({ navigation }) {
  const state = useAppState();
  const me = state.currentUser;
  const [stats, setStats] = useState(state.stats);
  const [shelf, setShelf] = useState(() => ownedPreview());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setStats(state.stats);
  }, [state.stats]);

  useEffect(() => {
    const unsub = subscribeCollection(() => setShelf(ownedPreview()));
    return unsub;
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([
      api.myStats().then(setStats).catch(() => {}),
      refreshCollection(),
    ]);
    setRefreshing(false);
  }

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <EmptyState
          title="Your profile"
          body="Sign in to track your plays, shelf, and buddies."
          ctaLabel="Sign in"
          onCta={() => navigation.navigate('Auth')}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.accent} />}
      >
        <Row justify="space-between" style={{ marginBottom: SPACING.lg }}>
          <Row gap="md" style={{ flex: 1 }}>
            <UserBadge avatar={me.avatar} displayName={me.display_name} size="lg" isMe />
            <View style={{ flex: 1 }}>
              <Text variant="display" style={{ fontSize: 24 }}>
                {me.display_name}
              </Text>
              {me.username ? <Text variant="small">@{me.username}</Text> : null}
            </View>
          </Row>
          <Pressable style={styles.iconBtn} onPress={() => navigation.navigate('Settings')} hitSlop={8}>
            <Settings size={22} color={COLORS.textSoft} />
          </Pressable>
        </Row>

        <StatsStrip stats={stats} />

        <Row justify="space-between" style={{ marginTop: SPACING.xl, marginBottom: SPACING.sm }}>
          <Text variant="heading" style={{ fontSize: 18 }}>
            Your shelf
          </Text>
          <Pressable onPress={() => navigation.navigate('Collection', { status: 'owned' })} hitSlop={8}>
            <Text variant="bodyMedium" color={COLORS.accent} style={{ fontSize: 13 }}>
              See all
            </Text>
          </Pressable>
        </Row>
        {shelf.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.previewScroll}>
            {shelf.map((g) => (
              <View key={g.id} style={styles.previewCell}>
                <GameTile
                  game={g}
                  variant="preview"
                  onPress={() => navigation.navigate('GameDetail', { gameId: g.id, gameName: g.name })}
                />
              </View>
            ))}
          </ScrollView>
        ) : (
          <Text variant="small">No owned games yet.</Text>
        )}

        <View style={styles.links}>
          <LinkRow Icon={LibraryBig} label="Collection" onPress={() => navigation.navigate('Collection', { status: 'owned' })} />
          <LinkRow Icon={Star} label="Wishlist" onPress={() => navigation.navigate('Collection', { status: 'wishlist' })} />
          <LinkRow Icon={History} label="Plays" onPress={() => navigation.navigate('Plays')} />
          <LinkRow Icon={Users} label="Buddies" onPress={() => navigation.navigate('Buddies')} />
          {me.is_admin ? <LinkRow Icon={Shield} label="Admin tools" onPress={() => navigation.navigate('Admin')} /> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ownedPreview() {
  return collectionGames()
    .filter((g) => g.status === 'owned' && !g.is_expansion)
    .slice(0, 8);
}

function LinkRow({ Icon, label, onPress }) {
  return (
    <Pressable style={styles.linkRow} onPress={onPress}>
      <Icon size={20} color={COLORS.accent} />
      <Text variant="bodyMedium" style={{ flex: 1, fontSize: 15 }}>
        {label}
      </Text>
      <ChevronRight size={18} color={COLORS.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 40 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  previewScroll: { gap: SPACING.md, paddingRight: SPACING.lg },
  previewCell: { width: 96 },
  links: {
    marginTop: SPACING.xl,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    overflow: 'hidden',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: 14,
    paddingHorizontal: SPACING.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    minHeight: 48,
  },
});
