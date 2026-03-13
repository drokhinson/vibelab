import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
} from 'react-native';
import PieChart from '../components/PieChart';
import { COLORS } from '../theme';

export default function RecipeScreen({ route }) {
  const { sauce, carb } = route.params;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Sauce hero card */}
        <View style={styles.heroCard}>
          <View style={[styles.heroAccent, { backgroundColor: sauce.color }]} />
          <View style={styles.heroContent}>
            <View style={styles.badgeRow}>
              <View style={styles.cuisineBadge}>
                <Text style={styles.cuisineBadgeText}>
                  {sauce.cuisineEmoji} {sauce.cuisine}
                </Text>
              </View>
              <View style={styles.carbBadge}>
                <Text style={styles.carbBadgeText}>
                  {carb?.emoji} {carb?.name}
                </Text>
              </View>
            </View>
            <Text style={styles.sauceName}>{sauce.name}</Text>
            <Text style={styles.sauceDesc}>{sauce.description}</Text>
            <Text style={styles.stepsCount}>
              {sauce.steps.length} step{sauce.steps.length > 1 ? 's' : ''}
            </Text>
          </View>
        </View>

        {/* How to read */}
        <View style={styles.tipCard}>
          <Text style={styles.tipTitle}>💡 Reading the charts</Text>
          <Text style={styles.tipBody}>
            Each slice shows the relative proportion of that ingredient — bigger slice = more of it.
            Use this to scale up or down by eye without measuring precisely.
          </Text>
        </View>

        {/* Step pie charts */}
        <Text style={styles.sectionLabel}>STEPS</Text>
        {sauce.steps.map((step, i) => (
          <PieChart key={i} step={step} index={i} size={190} />
        ))}

        {/* Full ingredient list */}
        <View style={styles.ingredientsCard}>
          <Text style={styles.ingredientsTitle}>Full Ingredient List</Text>
          {sauce.ingredients.map((ing, i) => (
            <View key={i} style={[styles.ingRow, i < sauce.ingredients.length - 1 && styles.ingRowBorder]}>
              <Text style={styles.ingName}>{ing.name}</Text>
              <Text style={styles.ingAmt}>{ing.amount} {ing.unit}</Text>
            </View>
          ))}
        </View>

        {/* Compatible carbs */}
        <View style={styles.carbsCard}>
          <Text style={styles.carbsTitle}>Also goes well with</Text>
          <View style={styles.carbChips}>
            {sauce.compatibleCarbs.map(c => (
              <View key={c} style={styles.carbChip}>
                <Text style={styles.carbChipText}>{c}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scroll: {
    padding: 16,
    paddingBottom: 48,
  },

  // Hero card
  heroCard: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.10,
    shadowRadius: 10,
    elevation: 5,
  },
  heroAccent: {
    height: 6,
    width: '100%',
  },
  heroContent: {
    padding: 18,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  cuisineBadge: {
    backgroundColor: COLORS.primary + '18',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cuisineBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
  },
  carbBadge: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  carbBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  sauceName: {
    fontSize: 24,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: 6,
    lineHeight: 29,
  },
  sauceDesc: {
    fontSize: 14,
    color: COLORS.textSecondary,
    lineHeight: 20,
    marginBottom: 10,
  },
  stepsCount: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textMuted,
  },

  // Tip
  tipCard: {
    backgroundColor: '#FFFBEB',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  tipTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#92400E',
    marginBottom: 4,
  },
  tipBody: {
    fontSize: 12,
    color: '#78350F',
    lineHeight: 18,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: COLORS.textMuted,
    marginBottom: 10,
  },

  // Full ingredient list
  ingredientsCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginTop: 4,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  ingredientsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 10,
  },
  ingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  ingRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  ingName: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '500',
    flex: 1,
  },
  ingAmt: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },

  // Compatible carbs
  carbsCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  carbsTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 10,
  },
  carbChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  carbChip: {
    backgroundColor: COLORS.background,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  carbChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
});
