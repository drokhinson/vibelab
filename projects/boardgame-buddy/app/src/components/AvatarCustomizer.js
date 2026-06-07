// AvatarCustomizer — pick an icon glyph + background/icon colors for the user
// badge. Renders a live UserBadge preview. Ported from the avatarCustomizer in
// web/ui/polaroid-popup.js. Returns the chosen avatar via onChange.

import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import UserBadge, { AVATAR_ITEMS, PALETTE } from './UserBadge';

export default function AvatarCustomizer({ displayName, value, onChange }) {
  const [avatar, setAvatar] = useState(value || { icon: 'initials', iconColor: '#C9922A', bgColor: '#2a1812' });

  function update(patch) {
    const next = { ...avatar, ...patch };
    setAvatar(next);
    onChange && onChange(next);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.previewRow}>
        <UserBadge avatar={avatar} displayName={displayName} size="lg" />
      </View>

      <Text style={styles.label}>Icon</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {AVATAR_ITEMS.map((it) => {
          const selected = avatar.icon === it.key;
          return (
            <Pressable key={it.key} onPress={() => update({ icon: it.key })} style={[styles.iconCell, selected && styles.selectedCell]}>
              <UserBadge avatar={{ ...avatar, icon: it.key }} displayName={displayName} size="md" forceInitials={it.key === 'initials'} />
            </Pressable>
          );
        })}
      </ScrollView>

      <Text style={styles.label}>Background</Text>
      <View style={styles.swatches}>
        {PALETTE.map((p) => (
          <Pressable
            key={p.hex}
            onPress={() => update({ bgColor: p.hex })}
            style={[styles.swatch, { backgroundColor: p.hex }, avatar.bgColor === p.hex && styles.swatchSelected]}
          />
        ))}
      </View>

      <Text style={styles.label}>Icon color</Text>
      <View style={styles.swatches}>
        {PALETTE.map((p) => (
          <Pressable
            key={`ic-${p.hex}`}
            onPress={() => update({ iconColor: p.hex })}
            style={[styles.swatch, { backgroundColor: p.hex }, avatar.iconColor === p.hex && styles.swatchSelected]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
  previewRow: { alignItems: 'center', marginBottom: SPACING.sm },
  label: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: SPACING.sm },
  row: { gap: SPACING.sm, paddingVertical: SPACING.xs },
  iconCell: { padding: 4, borderRadius: RADII.md, borderWidth: 2, borderColor: 'transparent' },
  selectedCell: { borderColor: COLORS.accent },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: COLORS.border },
  swatchSelected: { borderColor: COLORS.accent, borderWidth: 3 },
});
