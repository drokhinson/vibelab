// Meal Builder — three category tabs (Carbs / Proteins / Salads), grid of
// items. Tapping an item kicks off the item-load fetch, then navigates to
// PrepSelector (auto-redirecting to SauceSelector if no variants exist).
//
// Post-three-tab migration this is no longer the home screen — it's
// launched from the Saucebook chef-hat FAB and pushes onto the root stack.

import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Wheat, Drumstick, Salad } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import PotIllustration from '../components/PotIllustration';
import LoadingPot from '../components/LoadingPot';
import EmptyState from '../components/EmptyState';
import { COLORS, SHADOWS } from '../theme';

const TABS = [
  { id: 'carbs', label: 'Carbs', Icon: Wheat },
  { id: 'proteins', label: 'Proteins', Icon: Drumstick },
  { id: 'salads', label: 'Salads', Icon: Salad },
];

function itemsForTab(state, id) {
  if (id === 'proteins') return state.proteins;
  if (id === 'salads') return state.saladBases;
  return state.carbs;
}

export default function MealBuilderScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const items = itemsForTab(state, state.mealCategory);

  // Navigate immediately so the loading state lives on the destination screen
  // (the "choose variant" header) instead of overlaying the dish grid the user
  // just tapped. We don't yet know whether the item has variants — we always
  // route through PrepSelector, which auto-redirects to SauceSelector once the
  // load resolves with an empty preparations list.
  const onPickItem = (item) => {
    navigation.navigate('PrepSelector');
    actions.selectItem(item);
  };

  const content = useMemo(() => {
    if (state.bootError) {
      return (
        <EmptyState
          title="Couldn't reach the kitchen"
          body={state.bootError}
          action="Try again"
          onAction={actions.retryBoot}
        />
      );
    }
    if (!state.initialLoaded) return <LoadingPot label="Warming up the kitchen…" />;
    if (!items || items.length === 0) {
      const tab = TABS.find((t) => t.id === state.mealCategory);
      return <EmptyState body={`No ${(tab?.label || '').toLowerCase()} yet.`} />;
    }
    return (
      <View style={styles.grid}>
        {items.map((item) => (
          <TouchableOpacity
            key={item.id}
            style={styles.card}
            onPress={() => onPickItem(item)}
            activeOpacity={0.85}
          >
            <Text style={styles.emoji}>{item.emoji}</Text>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            {item.description ? (
              <Text style={styles.desc} numberOfLines={2}>
                {item.description}
              </Text>
            ) : null}
          </TouchableOpacity>
        ))}
      </View>
    );
  }, [state.initialLoaded, state.bootError, items, state.mealCategory, actions]);

  return (
    <View style={styles.screen}>
      <AppHeader
        title="Meal Builder"
        subtitle="What are you cooking with?"
        // X (close) instead of chevron-back — exit the meal flow entirely.
        // The meal builder is its own end-to-end mini-flow; in-flow step-back
        // is via the bottom "← Back to <step>" link on PrepSelector + SauceSelector.
        back={() => navigation.navigate('Home', { screen: 'SaucebookTab' })}
        closeIcon
        manage={false}
        auth={false}
        navigation={navigation}
      />

      <ScrollView contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <PotIllustration width={180} height={140} />
        </View>

        <View style={styles.tabs}>
          {TABS.map(({ id, label, Icon }) => {
            const active = state.mealCategory === id;
            return (
              <TouchableOpacity
                key={id}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => actions.setMealCategory(id)}
                activeOpacity={0.7}
              >
                <Icon size={18} color={active ? COLORS.primary : COLORS.textSecondary} />
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {content}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollBody: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  hero: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: COLORS.primary,
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginLeft: 6,
  },
  tabLabelActive: {
    color: COLORS.primary,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  card: {
    width: '48%',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    alignItems: 'center',
    ...SHADOWS.sm,
  },
  emoji: {
    fontSize: 36,
    marginBottom: 6,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
  },
  desc: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 3,
    textAlign: 'center',
    lineHeight: 14,
  },
});
