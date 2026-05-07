// Home — three category tabs (Carbs / Proteins / Salads), grid of items.
// Tapping an item kicks off the item-load fetch, then navigates to PrepSelector
// (if variants exist) or SauceSelector.

import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Wheat, Drumstick, Salad, ChefHat } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import PotIllustration from '../components/PotIllustration';
import LoadingPot from '../components/LoadingPot';
import EmptyState from '../components/EmptyState';
import HeaderAuthSlot from '../components/HeaderAuthSlot';
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
  const insets = useSafeAreaInsets();
  const items = itemsForTab(state, state.mealCategory);

  const onPickItem = async (item) => {
    const { hasVariants, error } = await actions.selectItem(item);
    if (error) return;
    navigation.navigate(hasVariants ? 'PrepSelector' : 'SauceSelector');
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
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.logo}>SauceBoss</Text>
            <Text style={styles.subtitle}>What are you cooking with?</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.managerBtn}
              onPress={() => navigation.navigate('SauceManager')}
              activeOpacity={0.8}
            >
              <ChefHat size={14} color="#fff" />
              <Text style={styles.managerBtnLabel}>Sauces</Text>
            </TouchableOpacity>
            <HeaderAuthSlot navigation={navigation} />
          </View>
        </View>
      </View>

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

        {state.itemLoading ? (
          <LoadingPot label="Loading…" />
        ) : (
          content
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    backgroundColor: COLORS.primary,
    paddingBottom: 18,
    paddingHorizontal: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerText: {
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  managerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  managerBtnLabel: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
    marginLeft: 4,
  },
  logo: {
    fontSize: 26,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 0.5,
  },
  subtitle: {
    color: '#fff',
    opacity: 0.85,
    fontSize: 13,
    marginTop: 2,
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
