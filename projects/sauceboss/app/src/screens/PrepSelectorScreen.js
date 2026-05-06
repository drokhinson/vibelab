// Optional preparation-variant picker (e.g. basmati vs jasmine rice).
// Only shown when state.preparations is non-empty.

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import EmptyState from '../components/EmptyState';
import { flowMetaFor } from '#shared/constants';
import { COLORS, SHADOWS } from '../theme';

export default function PrepSelectorScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const item = state.selectedItem;
  const meta = flowMetaFor(item);

  if (!item) {
    return (
      <View style={styles.screen}>
        <EmptyState body="Pick an item from the home screen first." />
      </View>
    );
  }

  const onPick = (prep) => {
    actions.setPrep(prep);
    navigation.navigate('SauceSelector');
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {item.emoji} How are you preparing the {item.name.toLowerCase()}?
        </Text>
        <Text style={styles.subtitle}>
          Pick a variant — we'll match it with the right {meta.sauceTypeLabel}.
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
        <View style={styles.grid}>
          {state.preparations.map((prep) => (
            <TouchableOpacity
              key={prep.id}
              style={styles.card}
              onPress={() => onPick(prep)}
              activeOpacity={0.85}
            >
              <Text style={styles.emoji}>{prep.emoji || item.emoji}</Text>
              <Text style={styles.name} numberOfLines={1}>{prep.name}</Text>
              {prep.description ? (
                <Text style={styles.desc} numberOfLines={2}>
                  {prep.description}
                </Text>
              ) : null}
              {prep.cookTimeMinutes ? (
                <Text style={styles.time}>~{prep.cookTimeMinutes} min</Text>
              ) : null}
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={styles.skipBtn}
          onPress={() => navigation.navigate('SauceSelector')}
          activeOpacity={0.7}
        >
          <Text style={styles.skipLabel}>Skip — show me everything</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: {
    backgroundColor: COLORS.background,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
  },
  subtitle: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  scrollBody: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 14,
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
    fontSize: 32,
    marginBottom: 6,
  },
  name: {
    fontSize: 14,
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
  time: {
    fontSize: 11,
    color: COLORS.primary,
    fontWeight: '700',
    marginTop: 4,
  },
  skipBtn: {
    alignSelf: 'center',
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  skipLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
});
