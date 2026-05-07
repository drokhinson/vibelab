// Profile + auth controls. Mirrors the web settings flow:
// - Display name (editable)
// - Become admin (one-shot; takes ADMIN_API_KEY)
// - Sign out
// - Delete account (with confirm)

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Star, LogOut, Trash2, Save } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import EmptyState from '../components/EmptyState';
import { COLORS, SHADOWS } from '../theme';

function computeInitials(name) {
  const parts = (name || '').trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

export default function SettingsScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const user = state.currentUser;

  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [adminKey, setAdminKey] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState(null);

  useEffect(() => {
    setDisplayName(user?.display_name || '');
  }, [user?.display_name]);

  if (!user) {
    return (
      <View style={styles.screen}>
        <EmptyState
          title="Not signed in"
          body="Sign in from the home screen to manage your profile."
          action="Back to home"
          onAction={() => navigation.navigate('MealBuilder')}
        />
      </View>
    );
  }

  async function saveName() {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed === user.display_name) return;
    setSavingName(true);
    setNameError(null);
    const res = await actions.updateDisplayName(trimmed);
    setSavingName(false);
    if (!res.ok) setNameError(res.error || 'Could not save');
  }

  async function handleBecomeAdmin() {
    if (!adminKey.trim()) return;
    const res = await actions.becomeAdmin(adminKey.trim());
    if (res.ok) setAdminKey('');
  }

  function confirmSignOut() {
    Alert.alert('Sign out', 'You can sign back in any time.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await actions.signOut();
          navigation.navigate('MealBuilder');
        },
      },
    ]);
  }

  function confirmDelete() {
    Alert.alert(
      'Delete account?',
      'This removes your profile and all favorites. Sauces you created stay in the catalog but lose their owner attribution. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await actions.deleteAccount();
            navigation.navigate('MealBuilder');
          },
        },
      ],
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      {/* Profile card */}
      <View style={styles.card}>
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarInitials}>{computeInitials(user.display_name)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName} numberOfLines={1}>
              {user.display_name || 'Saucier'}
            </Text>
            {user.is_admin ? (
              <View style={styles.adminBadge}>
                <Star size={11} color="#1A1A2E" />
                <Text style={styles.adminBadgeText}>Admin</Text>
              </View>
            ) : null}
          </View>
        </View>

        <Text style={styles.label}>Display name</Text>
        <View style={styles.nameRow}>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            style={styles.input}
            autoCapitalize="words"
            autoCorrect={false}
            placeholder="Saucier"
            placeholderTextColor={COLORS.textMuted}
          />
          <TouchableOpacity
            style={[
              styles.saveBtn,
              (savingName || !displayName.trim() || displayName.trim() === user.display_name) && styles.saveBtnDisabled,
            ]}
            onPress={saveName}
            disabled={savingName || !displayName.trim() || displayName.trim() === user.display_name}
            activeOpacity={0.8}
          >
            {savingName ? <ActivityIndicator color="#fff" size="small" /> : <Save size={16} color="#fff" />}
          </TouchableOpacity>
        </View>
        {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
      </View>

      {/* Become admin */}
      {!user.is_admin ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Become an admin</Text>
          <Text style={styles.helpText}>
            Enter your one-time admin key to unlock editing the full catalog.
          </Text>
          <TextInput
            value={adminKey}
            onChangeText={setAdminKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Admin key"
            placeholderTextColor={COLORS.textMuted}
            style={styles.input}
          />
          {state.becomeAdminError ? (
            <Text style={styles.errorText}>{state.becomeAdminError}</Text>
          ) : null}
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              (state.becomeAdminBusy || !adminKey.trim()) && styles.primaryBtnDisabled,
            ]}
            onPress={handleBecomeAdmin}
            disabled={state.becomeAdminBusy || !adminKey.trim()}
            activeOpacity={0.8}
          >
            {state.becomeAdminBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnLabel}>Claim admin</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Account actions */}
      <View style={styles.card}>
        <TouchableOpacity style={styles.row} onPress={confirmSignOut} activeOpacity={0.7}>
          <LogOut size={18} color={COLORS.text} />
          <Text style={styles.rowLabel}>Sign out</Text>
        </TouchableOpacity>
        <View style={styles.divider} />
        <TouchableOpacity style={styles.row} onPress={confirmDelete} activeOpacity={0.7}>
          <Trash2 size={18} color={COLORS.dangerText} />
          <Text style={[styles.rowLabel, { color: COLORS.dangerText }]}>Delete account</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  scroll: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    ...SHADOWS.sm,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarInitials: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  profileName: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.text,
  },
  adminBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FBBF24',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginTop: 4,
  },
  adminBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1A1A2E',
    marginLeft: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.background,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: COLORS.text,
    marginBottom: 8,
  },
  saveBtn: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
    marginBottom: 8,
  },
  saveBtnDisabled: {
    opacity: 0.4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 4,
  },
  helpText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginBottom: 12,
  },
  errorText: {
    color: COLORS.dangerText,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    marginBottom: 6,
  },
  primaryBtn: {
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 6,
  },
  primaryBtnDisabled: {
    opacity: 0.5,
  },
  primaryBtnLabel: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  rowLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    marginLeft: 12,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.surfaceSubtle,
  },
});
