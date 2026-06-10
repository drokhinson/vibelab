// ProfileSelfScreen — own profile hub (also the ProfileTab). Avatar + stats +
// collection preview + recent plays + nav into Collection/Wishlist/Plays/
// Buddies/Settings/Admin. Mirrors web/views/profile-self-view.js.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Settings, ChevronRight, LibraryBig, Star, History, Users, Shield } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState } from '../store/AppContext';
import UserBadge from '../components/UserBadge';
import StatsStrip from '../components/StatsStrip';
import GameTile from '../components/GameTile';
import EmptyState from '../components/EmptyState';
import api from '../api/client';

export default function ProfileSelfScreen({ navigation }) {
  const state = useAppState();
  const me = state.currentUser;
  const [stats, setStats] = useState(state.stats);
  const [preview, setPreview] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!me) return;
    const [s, grid] = await Promise.all([
      api.myStats().catch(() => null),
      api.collectionGrid({ status: 'owned', page: 1, per_page: 6, exclude_expansions: true }).catch(() => ({ items: [] })),
    ]);
    if (s) setStats(s);
    setPreview(grid.items || []);
  }, [me]);

  useEffect(() => { load(); }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <EmptyState title="Your profile" body="Sign in to track your plays, shelf, and buddies." ctaLabel="Sign in" onCta={() => navigation.navigate('Auth')} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.accent} />}>
        <View style={styles.headerRow}>
          <View style={styles.identity}>
            <UserBadge avatar={me.avatar} displayName={me.display_name} size="lg" isMe />
            <View style={styles.nameBlock}>
              <Text style={styles.name}>{me.display_name}</Text>
              {me.username ? <Text style={styles.username}>@{me.username}</Text> : null}
            </View>
          </View>
          <Pressable style={styles.iconBtn} onPress={() => navigation.navigate('Settings')} hitSlop={8}>
            <Settings size={22} color={COLORS.textSoft} />
          </Pressable>
        </View>

        <StatsStrip stats={stats} />

        <View style={styles.previewHead}>
          <Text style={styles.sectionTitle}>Your shelf</Text>
          <Pressable onPress={() => navigation.navigate('Collection', { status: 'owned' })} hitSlop={8}>
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>
        {preview && preview.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.previewScroll}>
            {preview.map((it) => {
              const g = it.game || it;
              return <View key={g.id} style={styles.previewCell}><GameTile game={g} variant="preview" onPress={() => navigation.navigate('GameDetail', { gameId: g.id, gameName: g.name })} /></View>;
            })}
          </ScrollView>
        ) : (
          <Text style={styles.muted}>No owned games yet.</Text>
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

function LinkRow({ Icon, label, onPress }) {
  return (
    <Pressable style={styles.linkRow} onPress={onPress}>
      <Icon size={20} color={COLORS.accent} />
      <Text style={styles.linkLabel}>{label}</Text>
      <ChevronRight size={18} color={COLORS.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.lg },
  identity: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  nameBlock: { flex: 1 },
  name: { fontFamily: FONTS.displayBold, color: COLORS.text, fontSize: 24 },
  username: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 13 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  previewHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: SPACING.xl, marginBottom: SPACING.sm },
  sectionTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18 },
  seeAll: { fontFamily: FONTS.sansSemibold, color: COLORS.accent, fontSize: 13 },
  previewScroll: { gap: SPACING.md, paddingRight: SPACING.lg },
  previewCell: { width: 96 },
  muted: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 14 },
  links: { marginTop: SPACING.xl, backgroundColor: COLORS.card, borderRadius: RADII.lg, borderWidth: 1, borderColor: COLORS.borderSoft, overflow: 'hidden' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: 14, paddingHorizontal: SPACING.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  linkLabel: { flex: 1, fontFamily: FONTS.sansSemibold, color: COLORS.text, fontSize: 15 },
});
