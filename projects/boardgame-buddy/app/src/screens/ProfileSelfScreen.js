// src/screens/ProfileSelfScreen.js — own profile. Phase 1 ships a functional
// shell: identity badge + sign-out (so the auth round-trip is testable). The
// stats strip, collection grid, and avatar customizer land in Phase 4.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { LogOut } from 'lucide-react-native';
import AppHeader from '../components/AppHeader';
import UserBadge from '../components/UserBadge';
import { useAppState, useAppActions } from '../store/AppContext';
import { useConfirm } from '../components/ConfirmModal';
import { COLORS, FONTS, FONT_SIZES, SPACING, RADII } from '../theme';

export default function ProfileSelfScreen() {
  const { currentUser, session } = useAppState();
  const actions = useAppActions();
  const confirm = useConfirm();

  const name = (currentUser && currentUser.display_name)
    || (session && session.user && session.user.email)
    || 'You';
  const email = session && session.user && session.user.email;

  async function onSignOut() {
    const ok = await confirm({
      title: 'Sign out?',
      body: "You'll need to sign back in to see your shelf and plays.",
      confirmLabel: 'Sign out',
      destructive: true,
    });
    if (ok) actions.signOut();
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Profile" />
      <View style={styles.body}>
        <UserBadge avatar={currentUser && currentUser.avatar} displayName={name} size="lg" isMe />
        <Text style={styles.name}>{name}</Text>
        {email ? <Text style={styles.email}>{email}</Text> : null}

        <Text style={styles.note}>
          Stats, your collection, and avatar customization arrive in a later build.
        </Text>

        <TouchableOpacity style={styles.signOut} onPress={onSignOut} activeOpacity={0.85}>
          <LogOut size={18} color={COLORS.danger} />
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  body: { flex: 1, alignItems: 'center', paddingTop: SPACING.xxl, paddingHorizontal: SPACING.xl },
  name: {
    fontFamily: FONTS.displayBold,
    fontSize: FONT_SIZES.xxl,
    color: COLORS.text,
    marginTop: SPACING.md,
  },
  email: {
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  note: {
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.sm,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: SPACING.xl,
    maxWidth: 300,
    lineHeight: 20,
  },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.xxl,
    borderWidth: 1.5,
    borderColor: COLORS.danger,
    borderRadius: RADII.pill,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
  },
  signOutText: {
    fontFamily: FONTS.semibold,
    fontSize: FONT_SIZES.md,
    color: COLORS.danger,
  },
});
