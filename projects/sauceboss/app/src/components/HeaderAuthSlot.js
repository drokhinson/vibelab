// Top-right slot for the home header. Shows a "Sign in" pill when logged out,
// or an avatar bubble (initials) when logged in. Tapping the avatar navigates
// straight to the Settings screen — sign-out and admin actions live there.

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { LogIn } from 'lucide-react-native';
import { useAppState } from '../store/AppContext';
import { isAuthConfigured } from '../auth/supabase';
import AuthModal from './AuthModal';
import { COLORS } from '../theme';

function computeInitials(name) {
  const parts = (name || '').trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

export default function HeaderAuthSlot({ navigation }) {
  const state = useAppState();
  const [authOpen, setAuthOpen] = useState(false);

  if (!isAuthConfigured) {
    // Auth isn't wired in this build — render nothing.
    return null;
  }

  // Auth still hydrating — render a placeholder so layout doesn't shift.
  if (!state.authReady) {
    return <View style={styles.placeholder} />;
  }

  if (!state.currentUser) {
    return (
      <>
        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => setAuthOpen(true)}
          activeOpacity={0.8}
        >
          <LogIn size={14} color="#fff" />
          <Text style={styles.signInLabel}>Sign in</Text>
        </TouchableOpacity>
        <AuthModal visible={authOpen} onClose={() => setAuthOpen(false)} />
      </>
    );
  }

  const initials = computeInitials(state.currentUser.display_name || 'Saucier');

  return (
    <TouchableOpacity
      style={styles.pill}
      onPress={() => navigation?.navigate('Settings')}
      activeOpacity={0.8}
      accessibilityLabel="Account settings"
    >
      <Text style={styles.initials}>{initials}</Text>
      {state.currentUser.is_admin ? (
        <View style={styles.adminBadge}>
          <Text style={styles.adminBadgeText}>★</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    width: 38,
    height: 32,
  },
  signInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 36,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  signInLabel: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    marginLeft: 4,
  },
  pill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  initials: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '800',
  },
  adminBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    backgroundColor: '#FBBF24',
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adminBadgeText: {
    color: '#1A1A2E',
    fontSize: 10,
    fontWeight: '900',
  },
});
