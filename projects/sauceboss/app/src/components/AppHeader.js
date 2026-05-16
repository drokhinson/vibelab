// Slim app-header that all screens share. Mirrors web's
// helpers.js#renderAppHeader (line 965). Layout:
//
//   [back?]  [title + subtitle (flex)]  [extraActions?] [manage?] [auth?]
//
// `manage` accepts 'auto' (default; shown only for admins), true (force on),
// or false (off). `back` is a function — pass `() => navigation.goBack()` to
// surface the chevron-left button. `auth` (default true) toggles the
// HeaderAuthSlot on the right.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as LucideIcons from 'lucide-react-native';
import { ChevronLeft, Settings2, X } from 'lucide-react-native';
import { useAppState } from '../store/AppContext';
import HeaderAuthSlot from './HeaderAuthSlot';
import { COLORS } from '../theme';

// Convert "user-cog" / "userCog" / "UserCog" → "UserCog" (Lucide's PascalCase
// component name). Mirrors web's renderAppHeader passing a kebab-case icon
// string straight to Lucide.
function toLucideName(name) {
  return name
    .split(/[-_\s]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

export default function AppHeader({
  title,
  subtitle,
  back,
  closeIcon = false, // when true, render `back` as an X (exit) instead of ChevronLeft
  manage = 'auto',
  extraActions,
  titleIcon,   // Lucide icon name string, e.g. "compass" or "book-open"
  titleEmoji,  // Emoji glyph string, e.g. "🍲"
  auth = true,
  navigation,
}) {
  const insets = useSafeAreaInsets();
  const state = useAppState();
  const isAdmin = !!(state.currentUser && state.currentUser.is_admin);
  const showManage = auth !== false && (manage === true || (manage === 'auto' && isAdmin));
  const TitleIconComp = titleIcon ? LucideIcons[toLucideName(titleIcon)] : null;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 10 }]}>
      <View style={styles.row}>
        {back ? (
          <TouchableOpacity
            style={styles.backBtn}
            onPress={back}
            hitSlop={10}
            accessibilityLabel={closeIcon ? 'Close' : 'Back'}
          >
            {closeIcon ? (
              <X size={22} color="#fff" />
            ) : (
              <ChevronLeft size={22} color="#fff" />
            )}
          </TouchableOpacity>
        ) : null}

        <View style={styles.titles}>
          <View style={styles.titleRow}>
            {titleEmoji ? <Text style={styles.titleEmoji}>{titleEmoji}</Text> : null}
            {TitleIconComp ? (
              <TitleIconComp size={18} color="#fff" style={styles.titleIcon} />
            ) : null}
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          </View>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.actions}>
          {extraActions}
          {showManage ? (
            <TouchableOpacity
              style={styles.manageBtn}
              onPress={() => navigation?.navigate('SauceManager')}
              accessibilityLabel="Manage dishes, ingredients, and sauces"
              activeOpacity={0.8}
            >
              <Settings2 size={14} color="#fff" />
              <Text style={styles.manageLabel}>Manage</Text>
            </TouchableOpacity>
          ) : null}
          {auth !== false ? <HeaderAuthSlot navigation={navigation} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  titles: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  titleEmoji: {
    fontSize: 20,
  },
  titleIcon: {
    marginRight: 2,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    flexShrink: 1,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  manageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 32,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  manageLabel: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
});
