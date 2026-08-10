// GhostPlayersSection — free-text player nicknames from logged plays. Two
// housekeeping flows, both in a bottom sheet (entry stays off the list): link
// a ghost to a real account, or merge two spellings of the same ghost.

import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ghost, Link2, Merge } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../../theme';
import { Button, Input, Row, Sheet, Text } from '../../ui';
import UserBadge from '../../components/UserBadge';
import { confirm } from '../../components/ConfirmModal';
import api from '../../api/client';

export default function GhostPlayersSection({ ghosts, onChanged }) {
  const sheetRef = useRef(null);
  const [target, setTarget] = useState(null); // ghost being managed
  const [mode, setMode] = useState('link'); // 'link' | 'merge'
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  if (!ghosts.length) return null;

  function openFor(ghost, m) {
    setTarget(ghost);
    setMode(m);
    setQ('');
    setResults([]);
    sheetRef.current?.present();
  }

  async function searchAccounts(term) {
    setQ(term);
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      setResults((await api.searchProfiles(term.trim())) || []);
    } catch {
      setResults([]);
    }
  }

  async function linkTo(profile) {
    const ok = await confirm({
      title: `Link “${target.display_name}” to ${profile.display_name}?`,
      body: 'Every play that lists this nickname will now credit their account. This cannot be undone.',
      confirmLabel: 'Link',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.linkGhost(target.display_name, profile.id);
      sheetRef.current?.dismiss();
      onChanged && onChanged();
    } catch {}
    setBusy(false);
  }

  async function mergeInto(other) {
    const ok = await confirm({
      title: `Merge “${target.display_name}” into “${other.display_name}”?`,
      body: 'All plays under the first nickname are renamed to the second. This cannot be undone.',
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.mergeGhosts(target.display_name, other.display_name);
      sheetRef.current?.dismiss();
      onChanged && onChanged();
    } catch {}
    setBusy(false);
  }

  return (
    <View style={styles.section}>
      <Row gap="xs" style={{ marginBottom: SPACING.xs }}>
        <Ghost size={16} color={COLORS.textSoft} />
        <Text variant="heading" style={{ fontSize: 18 }}>
          Ghost players
        </Text>
      </Row>
      <Text variant="caption" style={{ marginBottom: SPACING.sm }}>
        Nicknames from your plays without an account. Link them when friends join.
      </Text>
      {ghosts.map((g) => (
        <Row key={g.display_name} gap="md" style={styles.row}>
          <UserBadge displayName={g.display_name} isGhost size="sm" />
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium" numberOfLines={1}>
              {g.display_name}
            </Text>
            <Text variant="caption">{g.play_count} plays</Text>
          </View>
          <Pressable style={styles.action} onPress={() => openFor(g, 'link')} hitSlop={6}>
            <Link2 size={16} color={COLORS.accent} />
          </Pressable>
          <Pressable style={styles.action} onPress={() => openFor(g, 'merge')} hitSlop={6}>
            <Merge size={16} color={COLORS.textSoft} />
          </Pressable>
        </Row>
      ))}

      <Sheet
        ref={sheetRef}
        title={mode === 'link' ? `Link “${target?.display_name}”` : `Merge “${target?.display_name}”`}
        snap="70%"
      >
        {mode === 'link' ? (
          <>
            <Input placeholder="Search accounts…" value={q} onChangeText={searchAccounts} autoCorrect={false} />
            <View style={{ marginTop: SPACING.md }}>
              {results.map((p) => (
                <Row key={p.id} gap="md" style={styles.row}>
                  <UserBadge avatar={p.avatar} displayName={p.display_name} size="sm" />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyMedium">{p.display_name}</Text>
                    {p.username ? <Text variant="caption">@{p.username}</Text> : null}
                  </View>
                  <Button label="Link" size="sm" busy={busy} onPress={() => linkTo(p)} />
                </Row>
              ))}
            </View>
          </>
        ) : (
          <View>
            <Text variant="small" style={{ marginBottom: SPACING.md }}>
              Pick the nickname to keep — plays under “{target?.display_name}” move to it.
            </Text>
            {ghosts
              .filter((g) => g.display_name !== target?.display_name)
              .map((g) => (
                <Row key={g.display_name} gap="md" style={styles.row}>
                  <UserBadge displayName={g.display_name} isGhost size="sm" />
                  <Text variant="bodyMedium" style={{ flex: 1 }}>
                    {g.display_name}
                  </Text>
                  <Button label="Keep this" size="sm" variant="outline" busy={busy} onPress={() => mergeInto(g)} />
                </Row>
              ))}
          </View>
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: SPACING.xl },
  row: { paddingVertical: SPACING.sm, minHeight: 52 },
  action: {
    width: 40,
    height: 40,
    borderRadius: RADII.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
});
