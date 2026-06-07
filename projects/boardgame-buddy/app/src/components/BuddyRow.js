// BuddyRow — the canonical render for the Buddy/User-in-a-list object. Avatar +
// name + a relation affordance (add / accept / pending / buddies / unfriend).
// Used on the Buddies screen, profile headers, played-with & suggestion lists.

import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { UserPlus, Check, Clock, UserMinus, X } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import UserBadge from './UserBadge';

/**
 * @param {Object} props
 * @param {{display_name?:string, username?:string, avatar?:object}} props.buddy
 * @param {'none'|'add'|'incoming'|'outgoing'|'buddies'} [props.relation]
 * @param {() => void} [props.onPress] open the user's profile
 * @param {() => void} [props.onPrimary] add / accept
 * @param {() => void} [props.onSecondary] reject / unfriend
 * @param {boolean} [props.busy]
 * @param {string} [props.subtitle]
 */
export default function BuddyRow({ buddy, relation = 'none', onPress, onPrimary, onSecondary, busy, subtitle }) {
  const name = buddy.display_name || buddy.other_display_name || 'Player';
  const username = buddy.username || buddy.other_username;
  const avatar = buddy.avatar || buddy.other_avatar || null;

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <UserBadge avatar={avatar} displayName={name} size="md" isGhost={buddy.isGhost} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        {subtitle ? (
          <Text style={styles.sub} numberOfLines={1}>{subtitle}</Text>
        ) : username ? (
          <Text style={styles.sub} numberOfLines={1}>@{username}</Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        {busy ? <ActivityIndicator color={COLORS.accent} /> : <Affordance relation={relation} onPrimary={onPrimary} onSecondary={onSecondary} />}
      </View>
    </Pressable>
  );
}

function Affordance({ relation, onPrimary, onSecondary }) {
  if (relation === 'add') {
    return (
      <Pressable style={[styles.pill, styles.pillPrimary]} onPress={onPrimary} hitSlop={6}>
        <UserPlus size={15} color={COLORS.bg} />
        <Text style={styles.pillPrimaryLabel}>Add</Text>
      </Pressable>
    );
  }
  if (relation === 'incoming') {
    return (
      <View style={styles.dual}>
        <Pressable style={[styles.iconBtn, styles.accept]} onPress={onPrimary} hitSlop={6}>
          <Check size={16} color={COLORS.bg} />
        </Pressable>
        <Pressable style={[styles.iconBtn, styles.reject]} onPress={onSecondary} hitSlop={6}>
          <X size={16} color={COLORS.rustText} />
        </Pressable>
      </View>
    );
  }
  if (relation === 'outgoing') {
    return (
      <View style={styles.pillMuted}>
        <Clock size={14} color={COLORS.textMuted} />
        <Text style={styles.pillMutedLabel}>Requested</Text>
      </View>
    );
  }
  if (relation === 'buddies') {
    return (
      <Pressable style={styles.iconBtnPlain} onPress={onSecondary} hitSlop={6}>
        <UserMinus size={16} color={COLORS.textMuted} />
      </Pressable>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm },
  body: { flex: 1 },
  name: { fontFamily: FONTS.sansSemibold, color: COLORS.text, fontSize: 15 },
  sub: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 12, marginTop: 1 },
  actions: { minWidth: 44, alignItems: 'flex-end' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: RADII.pill },
  pillPrimary: { backgroundColor: COLORS.accent },
  pillPrimaryLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 13 },
  pillMuted: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: RADII.pill, backgroundColor: COLORS.card },
  pillMutedLabel: { fontFamily: FONTS.sansMedium, color: COLORS.textMuted, fontSize: 12 },
  dual: { flexDirection: 'row', gap: 6 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  accept: { backgroundColor: COLORS.success },
  reject: { backgroundColor: COLORS.rust + '33', borderWidth: 1, borderColor: COLORS.rust },
  iconBtnPlain: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
