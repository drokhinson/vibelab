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

  // Paint first, reconcile behind — the relation pill is the only thing that
  // changes, so reloading the whole profile (which drops it back to null and
  // re-shows the loader) for a round trip was the wrong shape.
  function patchRelation(patch) {
    setProfile((p) => (p ? { ...p, ...patch } : p));
  }

  async function addBuddy() {
    if (!profile) return;
    const before = {
      is_buddy: profile.is_buddy,
      has_pending_request: profile.has_pending_request,
      pending_request_direction: profile.pending_request_direction,
      pending_request_id: profile.pending_request_id,
    };
    patchRelation({
      has_pending_request: true,
      pending_request_direction: 'outgoing',
      pending_request_id: null,
    });
    try {
      const res = await api.sendBuddyRequest(userId);
      if (res && res.direction === 'incoming') {
        // Auto-accepted — they had already requested us.
        patchRelation({
          is_buddy: true,
          has_pending_request: false,
          pending_request_direction: null,
          pending_request_id: null,
        });
      } else {
        patchRelation({ pending_request_id: (res && res.id) || null });
      }
    } catch {
      patchRelation(before);
    }
  }

  async function acceptRequest() {
    if (!profile) return;
    const before = {
      is_buddy: profile.is_buddy,
      has_pending_request: profile.has_pending_request,
      pending_request_direction: profile.pending_request_direction,
      pending_request_id: profile.pending_request_id,
    };
    patchRelation({
      is_buddy: true,
      has_pending_request: false,
      pending_request_direction: null,
      pending_request_id: null,
    });
    try {
      // A profile fetched before the API carried pending_request_id still
      // needs the list lookup to find the edge.
      let id = profile.pending_request_id;
      if (!id) {
        const reqs = await api.buddyRequests();
        const inc = (reqs.incoming || []).find((r) => r.other_user_id === userId);
        id = inc && inc.id;
      }
      if (!id) throw new Error('no pending request');
      await api.acceptBuddy(id);
    } catch {
      patchRelation(before);
    }
  }

  async function declineRequest() {
    if (!profile || !profile.pending_request_id) return;
    const requestId = profile.pending_request_id;
    const before = {
      has_pending_request: profile.has_pending_request,
      pending_request_direction: profile.pending_request_direction,
      pending_request_id: requestId,
    };
    patchRelation({
      has_pending_request: false,
      pending_request_direction: null,
      pending_request_id: null,
    });
    try {
      await api.rejectBuddy(requestId);
    } catch {
      patchRelation(before);
    }
  }

  // Withdraw a request we sent. Reversible with the next tap, so no confirm —
  // ConfirmModal is reserved for the destructive gates.
  async function cancelRequest() {
    if (!profile || !profile.pending_request_id) return;
    const requestId = profile.pending_request_id;
    const before = {
      has_pending_request: profile.has_pending_request,
      pending_request_direction: profile.pending_request_direction,
      pending_request_id: requestId,
    };
    patchRelation({
      has_pending_request: false,
      pending_request_direction: null,
      pending_request_id: null,
    });
    try {
      await api.cancelBuddyRequest(requestId);
    } catch {
      patchRelation(before);
    }
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
            relation={relation}
            onPrimary={relation === 'incoming' ? acceptRequest : addBuddy}
            onSecondary={
              relation === 'incoming'
                ? declineRequest
                : relation === 'outgoing' && profile.pending_request_id
                ? cancelRequest
                : undefined
            }
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
