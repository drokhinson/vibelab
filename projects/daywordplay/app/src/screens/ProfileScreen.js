import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function ProfileScreen({ navigation }) {
  const { currentUser, session, bookmarks, myGroups } = useAppState();
  const { signOut, deleteAccount, leaveGroup } = useAppActions();
  const [pendingId, setPendingId] = useState(null);

  const displayName = currentUser?.display_name || 'Player';
  const initial = displayName[0]?.toUpperCase() || '?';
  const email = session?.user?.email || '';

  const onLogout = () => {
    Alert.alert('Log out?', 'You can sign back in any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => signOut().catch(() => {}) },
    ]);
  };

  const onDelete = () => {
    Alert.alert(
      'Delete account',
      'This permanently deletes your profile, group memberships, sentences, votes, and bookmarks. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteAccount().catch(() => {}) },
      ],
    );
  };

  const onLeave = (group) => {
    Alert.alert(`Leave "${group.name}"?`, '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          setPendingId(group.id);
          try { await leaveGroup(group.id); } catch {}
          finally { setPendingId(null); }
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.header}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initial}</Text></View>
        <Text style={styles.name}>{displayName}</Text>
        {email ? <Text style={styles.email}>{email}</Text> : null}
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{bookmarks.length}</Text>
          <Text style={styles.statLabel}>Saved Words</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{myGroups.length}</Text>
          <Text style={styles.statLabel}>Groups</Text>
        </View>
      </View>

      <Text style={styles.sectionLabel}>My Groups</Text>
      {myGroups.length === 0 ? (
        <Text style={styles.empty}>You haven’t joined any groups yet.</Text>
      ) : (
        myGroups.map((g) => (
          <View key={g.id} style={styles.groupRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.groupName}>{g.name}</Text>
              <Text style={styles.groupCode}>code · {g.code}</Text>
            </View>
            <Pressable
              onPress={() => onLeave(g)}
              disabled={pendingId === g.id}
              style={[styles.leaveBtn, pendingId === g.id && { opacity: 0.5 }]}
            >
              <Text style={styles.leaveBtnText}>{pendingId === g.id ? '…' : 'Leave'}</Text>
            </Pressable>
          </View>
        ))
      )}

      <Pressable style={styles.adminLink} onPress={() => navigation.navigate('Admin')}>
        <Text style={styles.adminLinkText}>Admin tools</Text>
      </Pressable>

      <Pressable style={styles.logoutBtn} onPress={onLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
      </Pressable>
      <Pressable style={styles.deleteBtn} onPress={onDelete}>
        <Text style={styles.deleteText}>Delete Account</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACING.lg, paddingBottom: SPACING.xxl, backgroundColor: COLORS.background },
  header: { alignItems: 'center', marginBottom: SPACING.lg },
  avatar: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: SPACING.sm,
  },
  avatarText: { color: '#fff', fontSize: 32, fontWeight: '800' },
  name: { fontSize: FONT_SIZES.title, fontWeight: '800', color: COLORS.text },
  email: { color: COLORS.textMuted, fontSize: FONT_SIZES.small, marginTop: SPACING.xs },
  statsRow: { flexDirection: 'row', gap: SPACING.md, marginBottom: SPACING.lg },
  statCard: {
    flex: 1, backgroundColor: COLORS.surface, padding: SPACING.lg,
    borderRadius: RADII.lg, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border,
  },
  statValue: { fontSize: 24, fontWeight: '800', color: COLORS.primary },
  statLabel: { color: COLORS.textMuted, fontSize: FONT_SIZES.small },
  sectionLabel: {
    fontSize: FONT_SIZES.small, fontWeight: '700', color: COLORS.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: SPACING.sm,
  },
  empty: { color: COLORS.textMuted, marginBottom: SPACING.lg },
  groupRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surface, padding: SPACING.md, borderRadius: RADII.md,
    marginBottom: SPACING.sm, borderWidth: 1, borderColor: COLORS.border,
  },
  groupName: { fontWeight: '600', color: COLORS.text, fontSize: FONT_SIZES.body },
  groupCode: { color: COLORS.textMuted, fontSize: FONT_SIZES.small, marginTop: 2 },
  leaveBtn: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADII.pill, borderWidth: 1, borderColor: COLORS.border },
  leaveBtnText: { color: COLORS.dangerText, fontWeight: '600', fontSize: FONT_SIZES.small },
  adminLink: { alignSelf: 'center', marginTop: SPACING.lg, padding: SPACING.sm },
  adminLinkText: { color: COLORS.textMuted, fontSize: FONT_SIZES.small },
  logoutBtn: {
    marginTop: SPACING.lg, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.borderStrong, paddingVertical: SPACING.md,
    borderRadius: RADII.lg, alignItems: 'center',
  },
  logoutText: { color: COLORS.text, fontWeight: '700' },
  deleteBtn: { marginTop: SPACING.sm, paddingVertical: SPACING.md, alignItems: 'center' },
  deleteText: { color: COLORS.dangerText, fontWeight: '600' },
});
