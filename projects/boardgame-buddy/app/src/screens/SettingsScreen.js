// SettingsScreen — profile + avatar, BGG sync, admin unlock, data refresh,
// sign out / delete account (both gated by the shared ConfirmModal).

import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { DatabaseZap, LogOut, Shield, Trash2 } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Button, Input, Row, Screen, Text } from '../ui';
import { useAppActions, useAppState, ACTIONS } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import AvatarCustomizer from '../components/AvatarCustomizer';
import { alert as alertModal, confirm } from '../components/ConfirmModal';
import api from '../api/client';
import cache from '../store/cache';
import { refreshCollection } from '../offline/collectionStore';
import BggSyncCard from './settings/BggSyncCard';

const PRIVACY_URL = 'https://vibelab-boardgamebuddy.vercel.app/privacy.html';
const DELETE_URL = 'https://vibelab-boardgamebuddy.vercel.app/delete-account.html';

export default function SettingsScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const me = state.currentUser;

  const [displayName, setDisplayName] = useState(me?.display_name || '');
  const [avatar, setAvatar] = useState(me?.avatar || null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [refreshingData, setRefreshingData] = useState(false);

  if (!me) {
    return <Screen pad={false} edges={{ top: false, bottom: false }} header={<AppHeader title="Settings" onBack={() => navigation.goBack()} />} />;
  }

  async function saveProfile() {
    setSavingProfile(true);
    try {
      const updated = await api.upsertProfile(displayName.trim(), avatar);
      actions.dispatch({
        type: ACTIONS.SET_CURRENT_USER,
        user: { id: updated.id, display_name: updated.display_name, username: updated.username, avatar: updated.avatar, is_admin: !!updated.is_admin },
      });
      await alertModal({ title: 'Saved', body: 'Your profile has been updated.' });
    } catch (e) {
      await alertModal({ title: 'Save failed', body: e.message });
    }
    setSavingProfile(false);
  }

  async function refreshLocalData() {
    setRefreshingData(true);
    cache.invalidate('');
    await Promise.all([refreshCollection(), actions.refreshFeed(), actions.refreshHostSeeds()]);
    setRefreshingData(false);
    await alertModal({ title: 'Refreshed', body: 'Local caches were cleared and re-synced.' });
  }

  async function onSignOut() {
    const ok = await confirm({ title: 'Sign out?', body: 'You can sign back in anytime.', confirmLabel: 'Sign out' });
    if (ok) {
      await actions.signOut();
      navigation.navigate('Home');
    }
  }

  async function onDelete() {
    const ok = await confirm({
      title: 'Delete your account?',
      body: 'This permanently deletes your profile, plays, collection, and chapters. This cannot be undone.',
      confirmLabel: 'Delete forever',
      destructive: true,
    });
    if (!ok) return;
    const doubleOk = await confirm({
      title: 'Absolutely sure?',
      body: 'There is no way back after this.',
      confirmLabel: 'Yes, delete everything',
      destructive: true,
    });
    if (!doubleOk) return;
    try {
      await api.deleteAccount();
      await actions.signOut();
      navigation.navigate('Home');
    } catch (e) {
      await alertModal({ title: 'Delete failed', body: e.message });
    }
  }

  return (
    <Screen pad={false} edges={{ top: false, bottom: false }} header={<AppHeader title="Settings" onBack={() => navigation.goBack()} />}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Section title="Profile">
          <AvatarCustomizer displayName={displayName} value={avatar} onChange={setAvatar} />
          <Input label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="Your name" style={{ marginTop: SPACING.md }} />
          <Button label="Save profile" onPress={saveProfile} busy={savingProfile} full style={{ marginTop: SPACING.md }} />
        </Section>

        <Section title="BoardGameGeek">
          <BggSyncCard />
        </Section>

        {!me.is_admin ? <BecomeAdminCard /> : null}

        <Section title="Data">
          <Row gap="sm">
            <DatabaseZap size={18} color={COLORS.textSoft} />
            <Text variant="small" style={{ flex: 1 }}>
              Feeling out of date? Clear local caches and pull everything fresh.
            </Text>
            <Button label="Refresh" variant="secondary" size="sm" onPress={refreshLocalData} busy={refreshingData} />
          </Row>
        </Section>

        <Section title="Account">
          <Pressable style={styles.linkBtn} onPress={() => Linking.openURL(PRIVACY_URL)}>
            <Text variant="bodyMedium" color={COLORS.accent} style={{ fontSize: 14 }}>
              Privacy policy
            </Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={() => Linking.openURL(DELETE_URL)}>
            <Text variant="bodyMedium" color={COLORS.accent} style={{ fontSize: 14 }}>
              How to delete your account
            </Text>
          </Pressable>
          <Pressable style={styles.rowBtn} onPress={onSignOut}>
            <LogOut size={18} color={COLORS.textSoft} />
            <Text variant="bodyMedium" color={COLORS.textSoft} style={{ fontSize: 15 }}>
              Sign out
            </Text>
          </Pressable>
          <Pressable style={styles.rowBtn} onPress={onDelete}>
            <Trash2 size={18} color={COLORS.rustText} />
            <Text variant="bodyMedium" color={COLORS.rustText} style={{ fontSize: 15 }}>
              Delete account
            </Text>
          </Pressable>
        </Section>

        <Text variant="caption" center style={{ marginTop: SPACING.sm }}>
          Game data powered by BoardGameGeek.
        </Text>
      </ScrollView>
    </Screen>
  );
}

function BecomeAdminCard() {
  const actions = useAppActions();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!key.trim()) return;
    setBusy(true);
    const r = await actions.becomeAdmin(key.trim());
    setBusy(false);
    if (!r.ok) await alertModal({ title: 'Failed', body: r.error || 'Invalid key.' });
  }
  return (
    <Section title="Admin access">
      <Row gap="sm">
        <Input value={key} onChangeText={setKey} placeholder="Admin key" secureTextEntry style={{ flex: 1 }} />
        <Button label="Unlock" icon={Shield} variant="secondary" size="sm" onPress={submit} busy={busy} />
      </Row>
    </Section>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text variant="heading" style={{ fontSize: 18, marginBottom: SPACING.md }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: SPACING.lg, paddingBottom: 40 },
  section: {
    marginBottom: SPACING.lg,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    padding: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
  },
  linkBtn: { paddingVertical: 10, minHeight: 40, justifyContent: 'center' },
  rowBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 14, minHeight: 48 },
});
