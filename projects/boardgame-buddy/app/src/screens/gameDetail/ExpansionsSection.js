// ExpansionsSection — collapsible list of a base game's expansions with
// per-expansion enable toggles (drives which expansion chapters show in the
// reference guide and which expansions Gather offers), plus the Import
// expansions entry point.
//
// The section renders for every base game, including ones with nothing
// imported: expansions are hidden from game search, so this is the only
// place one can be pulled into the catalog. It renders nothing on an
// expansion's own page.

import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react-native';
import { COLORS, SPACING } from '../../theme';
import { Button, Row, Text } from '../../ui';
import ImportExpansionsSheet from '../../widgets/ImportExpansionsSheet';
import { stripBaseGameName } from '../../domain/expansionName';
import api from '../../api/client';

export default function ExpansionsSection({ game, expansions, onChanged }) {
  const [open, setOpen] = useState(false);
  const importRef = useRef(null);

  if (!game || game.is_expansion) return null;
  const list = expansions || [];

  return (
    <View style={styles.section}>
      <Row justify="space-between">
        <Pressable style={styles.header} onPress={() => setOpen((v) => !v)} disabled={list.length === 0}>
          <Text variant="heading" style={{ fontSize: 18 }}>
            Expansions{list.length ? ` (${list.length})` : ''}
          </Text>
          {list.length ? (
            open ? (
              <ChevronDown size={18} color={COLORS.textMuted} />
            ) : (
              <ChevronRight size={18} color={COLORS.textMuted} />
            )
          ) : null}
        </Pressable>
        <Button label="Import" icon={Plus} variant="outline" size="sm" onPress={() => importRef.current?.present()} />
      </Row>

      {list.length === 0 ? (
        <Text variant="small" style={{ marginTop: SPACING.xs }}>
          No expansions in BoardgameBuddy yet.
        </Text>
      ) : open ? (
        <View style={{ marginTop: SPACING.sm, gap: 2 }}>
          {list.map((exp) => (
            <ExpansionRow
              key={exp.expansion_game_id}
              exp={exp}
              baseId={game.id}
              baseName={game.name}
              onChanged={onChanged}
            />
          ))}
        </View>
      ) : null}

      <ImportExpansionsSheet ref={importRef} gameId={game.id} gameName={game.name} onImported={onChanged} />
    </View>
  );
}

function ExpansionRow({ exp, baseId, baseName, onChanged }) {
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
        {stripBaseGameName(exp.name, baseName)}
      </Text>
      <View style={[styles.toggle, enabled && styles.toggleOn]}>
        <View style={[styles.knob, enabled && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: SPACING.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minHeight: 44, flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: 10, minHeight: 44 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  toggle: { width: 42, height: 24, borderRadius: 12, backgroundColor: COLORS.border, padding: 3, justifyContent: 'center' },
  toggleOn: { backgroundColor: COLORS.accent },
  knob: { width: 18, height: 18, borderRadius: 9, backgroundColor: COLORS.textSoft },
  knobOn: { backgroundColor: COLORS.bg, alignSelf: 'flex-end' },
});
