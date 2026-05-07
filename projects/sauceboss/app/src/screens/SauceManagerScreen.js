// Sauce Manager — three tabs (Sauces / Dish / Ingredients), all open to all
// users for browsing. The mutating affordances are gated by role:
//   - Sauces: any signed-in user can add. The owner of a row or any admin
//     can edit + delete.
//   - Dish: admin-only add/edit/delete.
//   - Ingredients: any signed-in user can add (POST /admin/foods is open to
//     any auth'd user on the backend). Admin can rename, delete, and merge.
//
// This file owns the orange header, search box, and tab bar. Each tab body
// lives in screens/manager/{Sauces,Dish,Ingredients}Tab.js so this file
// stays a small dispatcher.

import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Search, X } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import SaucesTab from './manager/SaucesTab';
import DishTab from './manager/DishTab';
import IngredientsTab from './manager/IngredientsTab';
import { COLORS } from '../theme';

const TABS = [
  { id: 'sauces', label: 'Sauces' },
  { id: 'dish', label: 'Dish' },
  { id: 'ingredients', label: 'Ingredients' },
];

const SEARCH_PLACEHOLDERS = {
  sauces: 'Search sauces, cuisine, ingredients…',
  dish: 'Search dishes…',
  ingredients: 'Search ingredients…',
};

export default function SauceManagerScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const insets = useSafeAreaInsets();

  const isAdmin = !!state.currentUser?.is_admin;
  const isLoggedIn = !!state.currentUser;
  const tab = state.managerTab || 'sauces';

  const scrollPaddingBottom = Math.max(100, insets.bottom + 80);
  const fabBottom = Math.max(26, insets.bottom + 20);

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10}>
            <ChevronLeft size={22} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title}>Sauce Manager</Text>
            <Text style={styles.subtitle}>
              {isAdmin ? 'Admin mode' : isLoggedIn ? 'Signed in' : 'Browse the catalog'}
            </Text>
          </View>
          <View style={{ width: 22 }} />
        </View>

        <View style={styles.tabBar}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <TouchableOpacity
                key={t.id}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => actions.setManagerTab(t.id)}
                activeOpacity={0.8}
              >
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.searchRow}>
          <Search size={16} color={COLORS.textMuted} />
          <TextInput
            value={state.managerSearch}
            onChangeText={(v) => actions.setManagerSearch(v)}
            placeholder={SEARCH_PLACEHOLDERS[tab]}
            placeholderTextColor={COLORS.textMuted}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {state.managerSearch ? (
            <TouchableOpacity onPress={() => actions.setManagerSearch('')} hitSlop={8}>
              <X size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {tab === 'sauces' ? (
        <SaucesTab
          navigation={navigation}
          scrollPaddingBottom={scrollPaddingBottom}
          fabBottom={fabBottom}
        />
      ) : tab === 'dish' ? (
        <DishTab
          navigation={navigation}
          scrollPaddingBottom={scrollPaddingBottom}
        />
      ) : (
        <IngredientsTab
          navigation={navigation}
          scrollPaddingBottom={scrollPaddingBottom}
          fabBottom={fabBottom}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  title: { color: '#fff', fontSize: 17, fontWeight: '800' },
  subtitle: { color: '#fff', opacity: 0.85, fontSize: 11, marginTop: 1 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderRadius: 999,
    padding: 4,
    marginBottom: 10,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: '#fff',
  },
  tabLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  tabLabelActive: {
    color: COLORS.primary,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.text,
    marginLeft: 8,
    paddingVertical: 4,
  },
});
