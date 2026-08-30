// ProfileOtherScreen — public profile: identity, buddy CTA, stats, shelf
// preview, recent-plays link. Cached serve-then-refresh so revisits paint
// instantly.

import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Users } from 'lucide-react-native';
import { COLORS, SPACING } from '../theme';
import { Button, RefreshHint, Row, Screen, Skeleton, Text } from '../ui';
import AppHeader from '../components/AppHeader';
import UserBadge from '../components/UserBadge';
import StatsStrip from '../components/StatsStrip';
import GameTile from '../components/GameTile';
import api from '../api/client';
import cache, { useCachedResource } from '../store/cache';

export default function ProfileOtherScreen({ navigation, route }) {
  const userId = route.params?.userId;
  const [busy, setBusy] = useState(false);

  const { data, loading, refreshing, refresh } = useCachedResource(userId ? `profile:${userId}` : null, async () => {
    const [profile, stats, grid] = await Promise.all([
      api.publicProfile(userId),
      api.userStats(userId).catch(() => null),
      api.collectionGrid({ status: 'owned', page: 1, per_page: 6, user_id: userId, exclude_expansions: true }).catch(() => ({ items: [] })),
    ]);
    return { profile, stats, preview: grid.items || [] };
  });

  async function addBuddy() {
    setBusy(true);
    try {
      await api.sendBuddyRequest(userId);
      cache.invalidate(`profile:${userId}`);
      refresh();
    } catch {}
    setBusy(false);
  }

  const profile = data?.profile;

  return (
    <Screen
      pad={false}
      edges={{ top: false, bottom: false }}
      header={<AppHeader title={profile?.display_name || 'Profile'} onBack={() => navigation.goBack()} />}
    >
      {loading || !profile ? (
        <View style={styles.body}>
          <Skeleton height={64} width={64} radius={32} style={{ alignSelf: 'center' }} />
          <Skeleton height={22} width="50%" style={{ alignSelf: 'center', marginTop: SPACING.md }} />
          <Skeleton height={64} style={{ marginTop: SPACING.xl }} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <RefreshHint visible={refreshing} />
          <View style={styles.identity}>
            <UserBadge avatar={profile.avatar} displayName={profile.display_name} size="lg" />
            <Text variant="display" style={{ fontSize: 24, marginTop: SPACING.sm }}>
              {profile.display_name}
            </Text>
            {profile.username ? <Text variant="small">@{profile.username}</Text> : null}
          </View>

          <Row justify="center" style={{ marginBottom: SPACING.lg }}>
            <BuddyCta profile={profile} busy={busy} onAdd={addBuddy} />
          </Row>

          <StatsStrip stats={data.stats} />

          {data.preview.length ? (
            <>
              <Row justify="space-between" style={{ marginTop: SPACING.xl, marginBottom: SPACING.sm }}>
                <Text variant="heading" style={{ fontSize: 18 }}>
                  Shelf
                </Text>
                <Button
                  label="See all"
                  variant="ghost"
                  size="sm"
                  onPress={() => navigation.navigate('Collection', { status: 'owned', userId })}
                />
              </Row>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.previewScroll}>
                {data.preview.map((it) => {
                  const g = it.game || it;
                  return (
                    <View key={g.id} style={styles.previewCell}>
                      <GameTile
                        game={g}
                        variant="preview"
                        showStatus={false}
                        onPress={() => navigation.navigate('GameDetail', { gameId: g.id, gameName: g.name })}
                      />
                    </View>
                  );
                })}
              </ScrollView>
            </>
          ) : null}

          <Row justify="center" style={{ marginTop: SPACING.xl }}>
            <Button
              label="View play history"
              variant="outline"
              size="sm"
              onPress={() => navigation.navigate('Plays', { userId })}
            />
          </Row>
        </ScrollView>
      )}
    </Screen>
  );
}

function BuddyCta({ profile, busy, onAdd }) {
  if (profile.is_buddy) {
    return (
      <Row gap="xs">
        <Users size={15} color={COLORS.success} />
        <Text variant="bodyMedium" color={COLORS.success}>
          Buddies
        </Text>
      </Row>
    );
  }
  if (profile.has_pending_request) {
    return (
      <Text variant="small">
        {profile.pending_request_direction === 'incoming' ? 'They sent you a request — see Buddies' : 'Request sent'}
      </Text>
    );
  }
  return <Button label="Add buddy" size="sm" icon={Users} onPress={onAdd} busy={busy} />;
}

const styles = StyleSheet.create({
  body: { padding: SPACING.lg, paddingBottom: 40 },
  identity: { alignItems: 'center', gap: 4, marginBottom: SPACING.md },
  previewScroll: { gap: SPACING.md, paddingRight: SPACING.lg },
  previewCell: { width: 96 },
});
