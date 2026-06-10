// ProfileOtherScreen — public profile for any user. Stats + collection preview
// + buddy-relation header. Mirrors web/views/profile-other-view.js.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import UserBadge from '../components/UserBadge';
import StatsStrip from '../components/StatsStrip';
import GameTile from '../components/GameTile';
import BuddyRow from '../components/BuddyRow';
import LoadingState from '../components/LoadingState';
import api from '../api/client';

export default function ProfileOtherScreen({ navigation, route }) {
  const userId = route.params?.userId;
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [preview, setPreview] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, s, grid] = await Promise.all([
      api.publicProfile(userId).catch(() => null),
      api.userStats(userId).catch(() => null),
      api.collectionGrid({ status: 'owned', page: 1, per_page: 6, user_id: userId, exclude_expansions: true }).catch(() => ({ items: [] })),
    ]);
    setProfile(p);
    setStats(s);
    setPreview(grid.items || []);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  async function addBuddy() {
    setBusy(true);
    try { await api.sendBuddyRequest(userId); await load(); } catch {}
    setBusy(false);
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader title="Profile" onBack={() => navigation.goBack()} />
        <LoadingState label="Loading profile…" />
      </SafeAreaView>
    );
  }

  const relation = profile.is_buddy
    ? 'buddies'
    : profile.has_pending_request
    ? profile.pending_request_direction === 'incoming' ? 'incoming' : 'outgoing'
    : 'add';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title={profile.display_name} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.identity}>
          <UserBadge avatar={profile.avatar} displayName={profile.display_name} size="lg" />
          <Text style={styles.name}>{profile.display_name}</Text>
          {profile.username ? <Text style={styles.username}>@{profile.username}</Text> : null}
        </View>

        <View style={styles.relationCard}>
          <BuddyRow
            buddy={{ display_name: profile.display_name, username: profile.username, avatar: profile.avatar }}
            relation={relation === 'incoming' ? 'add' : relation}
            busy={busy}
            onPrimary={addBuddy}
          />
        </View>

        <StatsStrip stats={stats} />

        {preview.length ? (
          <>
            <Text style={styles.sectionTitle}>Shelf</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.previewScroll}>
              {preview.map((it) => {
                const g = it.game || it;
                return <View key={g.id} style={styles.previewCell}><GameTile game={g} variant="preview" showStatus={false} onPress={() => navigation.navigate('GameDetail', { gameId: g.id, gameName: g.name })} /></View>;
              })}
            </ScrollView>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 40 },
  identity: { alignItems: 'center', gap: 6, marginBottom: SPACING.lg },
  name: { fontFamily: FONTS.displayBold, color: COLORS.text, fontSize: 24, marginTop: SPACING.sm },
  username: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 13 },
  relationCard: { backgroundColor: COLORS.card, borderRadius: RADII.lg, paddingHorizontal: SPACING.md, marginBottom: SPACING.lg, borderWidth: 1, borderColor: COLORS.borderSoft },
  sectionTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18, marginTop: SPACING.xl, marginBottom: SPACING.sm },
  previewScroll: { gap: SPACING.md, paddingRight: SPACING.lg },
  previewCell: { width: 96 },
});
