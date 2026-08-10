// ExpansionsSection — collapsible list of a base game's expansions with
// per-expansion enable toggles (drives which expansion chapters show in the
// reference guide and which expansions Gather offers).

import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { COLORS, SPACING } from '../../theme';
import { Text } from '../../ui';
import api from '../../api/client';

export default function ExpansionsSection({ expansions, baseId, onChanged }) {
  const [open, setOpen] = useState(false);
  if (!expansions.length) return null;
  return (
    <View style={styles.section}>
      <Pressable style={styles.header} onPress={() => setOpen((v) => !v)}>
        <Text variant="heading" style={{ fontSize: 18 }}>
          Expansions ({expansions.length})
        </Text>
        {open ? <ChevronDown size={18} color={COLORS.textMuted} /> : <ChevronRight size={18} color={COLORS.textMuted} />}
      </Pressable>
      {open ? (
        <View style={{ marginTop: SPACING.sm, gap: 2 }}>
          {expansions.map((exp) => (
            <ExpansionRow key={exp.expansion_game_id} exp={exp} baseId={baseId} onChanged={onChanged} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ExpansionRow({ exp, baseId, onChanged }) {
  const [enabled, setEnabled] = useState(exp.is_enabled);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    const next = !enabled;
    setEnabled(next); // optimistic — roll back on failure
    try {
      await api.toggleExpansion(baseId, exp.expansion_game_id, next);
      onChanged && onChanged();
    } catch {
      setEnabled(!next);
    }
    setBusy(false);
  }
  return (
    <Pressable style={styles.row} onPress={toggle} disabled={busy}>
      {exp.color ? <View style={[styles.dot, { backgroundColor: exp.color }]} /> : null}
      <Text variant="bodyMedium" numberOfLines={1} style={{ flex: 1 }}>
        {exp.name}
      </Text>
      <View style={[styles.toggle, enabled && styles.toggleOn]}>
        <View style={[styles.knob, enabled && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: SPACING.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 10, minHeight: 44 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  toggle: { width: 42, height: 24, borderRadius: 12, backgroundColor: COLORS.border, padding: 3, justifyContent: 'center' },
  toggleOn: { backgroundColor: COLORS.accent },
  knob: { width: 18, height: 18, borderRadius: 9, backgroundColor: COLORS.textSoft },
  knobOn: { backgroundColor: COLORS.bg, alignSelf: 'flex-end' },
});
