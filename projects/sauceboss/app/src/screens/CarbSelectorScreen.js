import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { getCarbs } from '../data/database';
import { COLORS } from '../theme';

export default function CarbSelectorScreen({ navigation }) {
  const db = useSQLiteContext();
  const [carbs, setCarbs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCarbs(db).then(rows => {
      setCarbs(rows);
      setLoading(false);
    });
  }, [db]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={styles.loader} size="large" color={COLORS.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroBlock}>
          <Text style={styles.heroTitle}>What are you{'\n'}cooking tonight?</Text>
          <Text style={styles.heroSub}>Pick your carb to see matching sauces.</Text>
        </View>

        <View style={styles.grid}>
          {carbs.map(carb => (
            <TouchableOpacity
              key={carb.id}
              style={styles.card}
              onPress={() => navigation.navigate('SauceSelector', { carb })}
              activeOpacity={0.75}
            >
              <Text style={styles.emoji}>{carb.emoji}</Text>
              <Text style={styles.carbName}>{carb.name}</Text>
              <Text style={styles.carbDesc}>{carb.desc}</Text>
              <View style={styles.countBadge}>
                <Text style={styles.countText}>{carb.sauceCount} sauces</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.footnote}>
          22 sauces across 7 cuisines — pick what looks good.
        </Text>
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
    paddingBottom: 40,
  },
  heroBlock: {
    marginBottom: 20,
    paddingTop: 4,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: COLORS.text,
    lineHeight: 32,
    marginBottom: 6,
  },
  heroSub: {
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    width: '47.5%',
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 18,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  emoji: {
    fontSize: 46,
    marginBottom: 8,
  },
  carbName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 3,
  },
  carbDesc: {
    fontSize: 11,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 15,
    marginBottom: 10,
  },
  countBadge: {
    backgroundColor: COLORS.primary + '18',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
  },
  footnote: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 24,
  },
});
