// SettingsScreen — profile/avatar edit, BGG link + sync (with status poll),
// become-admin, sign out, delete account (via ConfirmModal), privacy links.
// Mirrors web/views/settings-view.js.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Linking, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LogOut, Trash2, Shield, RefreshCw, Link2 } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState, useAppActions } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import AvatarCustomizer from '../components/AvatarCustomizer';
import { confirm, alert as alertModal } from '../components/ConfirmModal';
import api from '../api/client';

const PRIVACY_URL = 'https://boardgame-buddy.vercel.app/privacy.html';
const DELETE_URL = 'https://boardgame-buddy.vercel.app/delete-account.html';

export default function SettingsScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const me = state.currentUser;

  const [displayName, setDisplayName] = useState(me?.display_name || '');
  const [avatar, setAvatar] = useState(me?.avatar || null);
  const [savingProfile, setSavingProfile] = useState(false);

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader title="Settings" onBack={() => navigation.goBack()} />
      </SafeAreaView>
    );
  }

  async function saveProfile() {
    setSavingProfile(true);
    try {
      const updated = await api.upsertProfile(displayName.trim(), avatar);
      actions.dispatch({ type: 'SET_CURRENT_USER', user: { id: updated.id, display_name: updated.display_name, username: updated.username, avatar: updated.avatar, is_admin: !!updated.is_admin } });
      await alertModal({ title: 'Saved', body: 'Your profile has been updated.' });
    } catch (e) {
      await alertModal({ title: 'Save failed', body: e.message });
    }
    setSavingProfile(false);
  }

  async function onSignOut() {
    const ok = await confirm({ title: 'Sign out?', body: 'You can sign back in anytime.', confirmLabel: 'Sign out' });
    if (ok) { await actions.signOut(); navigation.navigate('Home'); }
  }

  async function onDelete() {
    const ok = await confirm({
      title: 'Delete your account?',
      body: 'This permanently deletes your profile, plays, collection, and chapters. This cannot be undone.',
      confirmLabel: 'Delete forever',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteAccount();
      await actions.signOut();
      navigation.navigate('Home');
    } catch (e) {
      await alertModal({ title: 'Delete failed', body: e.message });
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title="Settings" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Section title="Profile">
          <AvatarCustomizer displayName={displayName} value={avatar} onChange={setAvatar} />
          <Text style={styles.fieldLabel}>Display name</Text>
          <TextInput style={styles.input} value={displayName} onChangeText={setDisplayName} placeholder="Your name" placeholderTextColor={COLORS.textMuted} />
          <Pressable style={[styles.primary, savingProfile && styles.disabled]} onPress={saveProfile} disabled={savingProfile}>
            {savingProfile ? <ActivityIndicator color={COLORS.bg} /> : <Text style={styles.primaryLabel}>Save profile</Text>}
          </Pressable>
        </Section>

        <BggCard />

        {!me.is_admin ? <BecomeAdminCard /> : null}

        <Section title="Account">
          <Pressable style={styles.linkBtn} onPress={() => Linking.openURL(PRIVACY_URL)}>
            <Text style={styles.linkBtnLabel}>Privacy policy</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={() => Linking.openURL(DELETE_URL)}>
            <Text style={styles.linkBtnLabel}>How to delete your account</Text>
          </Pressable>
          <Pressable style={styles.rowBtn} onPress={onSignOut}>
            <LogOut size={18} color={COLORS.textSoft} />
            <Text style={styles.rowBtnLabel}>Sign out</Text>
          </Pressable>
          <Pressable style={styles.rowBtn} onPress={onDelete}>
            <Trash2 size={18} color={COLORS.rustText} />
            <Text style={[styles.rowBtnLabel, { color: COLORS.rustText }]}>Delete account</Text>
          </Pressable>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function BggCard() {
  const [status, setStatus] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try { setStatus(await api.bggStatus()); } catch {}
  }, []);

  useEffect(() => { refresh(); return () => pollRef.current && clearInterval(pollRef.current); }, [refresh]);

  function startPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.bggStatus();
        setStatus(s);
        if (s.session_total > 0 && s.session_done + s.session_errored >= s.session_total) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {}
    }, 2000);
  }

  async function link() {
    setBusy(true);
    try { await api.bggLink(username.trim(), password); setPassword(''); await refresh(); } catch (e) { await alertModal({ title: 'Link failed', body: e.message }); }
    setBusy(false);
  }
  async function sync() {
    setBusy(true);
    try { await api.bggSync(); startPoll(); } catch (e) { await alertModal({ title: 'Sync failed', body: e.message }); }
    setBusy(false);
  }
  async function unlink() {
    const ok = await confirm({ title: 'Unlink BoardGameGeek?', body: 'Your imported games stay; future syncs stop.', confirmLabel: 'Unlink', destructive: true });
    if (!ok) return;
    try { await api.bggUnlink(); await refresh(); } catch {}
  }

  const linked = status && status.auth_state && status.auth_state !== 'unlinked';
  const importing = status && status.session_total > 0 && status.session_done + status.session_errored < status.session_total;

  return (
    <Section title="BoardGameGeek">
      {status && status.auth_state === 'relink_required' ? (
        <Text style={styles.warn}>Your BGG login expired — re-link to sync again.</Text>
      ) : null}
      {linked ? (
        <>
          <Text style={styles.bggUser}>Linked as {status.bgg_username}</Text>
          {importing ? (
            <Text style={styles.importing}>Importing {status.session_done} of {status.session_total}…</Text>
          ) : null}
          <View style={styles.btnRow}>
            <Pressable style={[styles.secondary, busy && styles.disabled]} onPress={sync} disabled={busy || importing}>
              <RefreshCw size={15} color={COLORS.accent} />
              <Text style={styles.secondaryLabel}>Sync now</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={unlink}>
              <Text style={[styles.secondaryLabel, { color: COLORS.rustText }]}>Unlink</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.help}>Link your BGG account to import your collection and play history.</Text>
          <TextInput style={styles.input} value={username} onChangeText={setUsername} placeholder="BGG username" placeholderTextColor={COLORS.textMuted} autoCapitalize="none" />
          <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="BGG password" placeholderTextColor={COLORS.textMuted} secureTextEntry />
          <Pressable style={[styles.primary, busy && styles.disabled]} onPress={link} disabled={busy}>
            {busy ? <ActivityIndicator color={COLORS.bg} /> : (<><Link2 size={16} color={COLORS.bg} /><Text style={styles.primaryLabel}>  Link account</Text></>)}
          </Pressable>
        </>
      )}
    </Section>
  );
}

function BecomeAdminCard() {
  const actions = useAppActions();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    const r = await actions.becomeAdmin(key.trim());
    setBusy(false);
    if (!r.ok) await alertModal({ title: 'Failed', body: r.error || 'Invalid key.' });
  }
  return (
    <Section title="Admin access">
      <View style={styles.adminRow}>
        <TextInput style={[styles.input, { flex: 1, marginTop: 0 }]} value={key} onChangeText={setKey} placeholder="Admin key" placeholderTextColor={COLORS.textMuted} secureTextEntry />
        <Pressable style={[styles.secondary, busy && styles.disabled]} onPress={submit} disabled={busy}>
          <Shield size={15} color={COLORS.accent} />
          <Text style={styles.secondaryLabel}>Unlock</Text>
        </Pressable>
      </View>
    </Section>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 40 },
  section: { marginBottom: SPACING.xl, backgroundColor: COLORS.card, borderRadius: RADII.lg, padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.borderSoft },
  sectionTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18, marginBottom: SPACING.md },
  fieldLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 12, marginTop: SPACING.md },
  input: { backgroundColor: COLORS.bgElevated, borderRadius: RADII.md, paddingHorizontal: SPACING.md, paddingVertical: 11, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, marginTop: SPACING.sm, borderWidth: 1, borderColor: COLORS.border },
  primary: { flexDirection: 'row', backgroundColor: COLORS.accent, borderRadius: RADII.md, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', marginTop: SPACING.md },
  primaryLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 15 },
  secondary: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.bgElevated, borderRadius: RADII.md, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: COLORS.border },
  secondaryLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.accent, fontSize: 14 },
  disabled: { opacity: 0.6 },
  btnRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  rowBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 14 },
  rowBtnLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.textSoft, fontSize: 15 },
  linkBtn: { paddingVertical: 10 },
  linkBtnLabel: { fontFamily: FONTS.sansMedium, color: COLORS.accent, fontSize: 14 },
  help: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 13, lineHeight: 19 },
  bggUser: { fontFamily: FONTS.sansSemibold, color: COLORS.text, fontSize: 15 },
  importing: { fontFamily: FONTS.score, color: COLORS.accent, fontSize: 13, marginTop: 4 },
  warn: { fontFamily: FONTS.sansMedium, color: COLORS.rustText, fontSize: 13, marginBottom: SPACING.sm },
  adminRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
});
