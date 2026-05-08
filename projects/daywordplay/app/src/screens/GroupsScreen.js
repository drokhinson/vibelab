import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Plus, Search, Check } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import LoadingState from '../components/LoadingState';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function GroupsScreen({ navigation }) {
  const { myGroups, activeGroupId, searchResults, searchLoading } = useAppState();
  const { setActiveGroup, searchGroups, joinGroupByCode } = useAppActions();
  const [query, setQuery] = useState('');

  useEffect(() => {
    const t = setTimeout(() => searchGroups(query).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [query, searchGroups]);

  const onJoinByCard = async (group) => {
    try {
      await joinGroupByCode(group.code);
    } catch {
      // Backend may require request-to-join; ignore here.
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.headerRow}>
        <Pressable style={styles.headerBtn} onPress={() => navigation.navigate('JoinByCode')}>
          <Plus size={14} color={COLORS.text} />
          <Text style={styles.headerBtnText}>Join</Text>
        </Pressable>
        <Pressable style={styles.headerBtn} onPress={() => navigation.navigate('CreateGroup')}>
          <Text style={styles.headerBtnText}>Create</Text>
        </Pressable>
      </View>

      {myGroups.length > 0 ? (
        <View style={{ paddingHorizontal: SPACING.lg }}>
          <Text style={styles.sectionLabel}>My Groups</Text>
          {myGroups.map((g) => (
            <Pressable
              key={g.id}
              style={[styles.card, g.id === activeGroupId && styles.cardActive]}
              onPress={() => setActiveGroup(g.id)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{g.name}</Text>
                <Text style={styles.cardMeta}>{g.id === activeGroupId ? 'Active group' : 'Tap to switch'}</Text>
              </View>
              <View style={styles.codePill}><Text style={styles.codePillText}>{g.code}</Text></View>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={{ paddingHorizontal: SPACING.lg, marginTop: SPACING.lg }}>
        <Text style={styles.sectionLabel}>Discover Groups</Text>
        <View style={styles.searchWrap}>
          <Search size={16} color={COLORS.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search groups…"
            placeholderTextColor={COLORS.textMuted}
            value={query}
            onChangeText={setQuery}
          />
        </View>
      </View>

      {searchLoading ? <LoadingState /> : (
        <FlatList
          data={searchResults}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingHorizontal: SPACING.lg, paddingBottom: SPACING.xxl }}
          renderItem={({ item }) => (
            <View style={styles.discoverCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text style={styles.cardMeta}>{item.member_count} member{item.member_count === 1 ? '' : 's'}</Text>
              </View>
              {item.is_member ? (
                <View style={styles.joinedRow}>
                  <Check size={14} color={COLORS.primary} />
                  <Text style={styles.joinedText}>Joined</Text>
                </View>
              ) : (
                <Pressable style={styles.joinBtn} onPress={() => onJoinByCard(item)}>
                  <Text style={styles.joinBtnText}>Join</Text>
                </Pressable>
              )}
            </View>
          )}
          ListEmptyComponent={
            !searchLoading && query
              ? <Text style={styles.empty}>No groups found for "{query}"</Text>
              : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.sm, padding: SPACING.lg },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.surface,
    borderRadius: RADII.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
  },
  headerBtnText: { color: COLORS.text, fontWeight: '600', fontSize: FONT_SIZES.small },
  sectionLabel: {
    fontSize: FONT_SIZES.caption,
    fontWeight: '700',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: SPACING.sm,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  cardActive: { borderColor: COLORS.primary, borderWidth: 2 },
  cardTitle: { fontSize: FONT_SIZES.card, fontWeight: '600', color: COLORS.text },
  cardMeta: { fontSize: FONT_SIZES.small, color: COLORS.textMuted, marginTop: 2 },
  codePill: { backgroundColor: COLORS.surfaceSubtle, paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs, borderRadius: RADII.sm },
  codePillText: { fontFamily: 'monospace', letterSpacing: 2, color: COLORS.primary, fontWeight: '700' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm, color: COLORS.text, fontSize: FONT_SIZES.body },
  discoverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  joinBtn: { backgroundColor: COLORS.primary, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADII.pill },
  joinBtnText: { color: '#fff', fontWeight: '700', fontSize: FONT_SIZES.small },
  joinedRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  joinedText: { color: COLORS.primary, fontWeight: '600', fontSize: FONT_SIZES.small },
  empty: { textAlign: 'center', color: COLORS.textMuted, padding: SPACING.lg },
});
