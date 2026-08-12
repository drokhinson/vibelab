// PendingUploadsBar — the one surface for the PendingPlay object (plays
// recorded offline, waiting in the outbox). Shows the count, a manual retry,
// and expands to per-play rows when something needs attention (a server
// rejection) or the user wants to inspect the queue. Discard routes through
// the shared ConfirmModal. Mounted on Feed and the Play tab.

import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { CloudUpload, ChevronDown, ChevronRight, RefreshCw, Trash2 } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Row, Text } from '../ui';
import { confirm } from './ConfirmModal';
import { discardPlay, flushOutbox, listPending, subscribeOutbox } from '../offline/playOutbox';
import { useAppActions } from '../store/AppContext';

export default function PendingUploadsBar({ style }) {
  const actions = useAppActions();
  const [items, setItems] = useState(listPending());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => subscribeOutbox((next) => setItems([...next])), []);

  if (!items.length) return null;
  const hasError = items.some((i) => i.lastError);

  async function retry() {
    setBusy(true);
    const { flushed } = await flushOutbox();
    for (const f of flushed) actions.afterPlaySaved(f.gameId);
    setBusy(false);
  }

  async function discard(item) {
    const ok = await confirm({
      title: 'Discard this recorded play?',
      body: `${item.gameSnapshot?.name || 'The play'} was never uploaded and will be lost for good.`,
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (ok) discardPlay(item.localId);
  }

  return (
    <View style={[styles.wrap, hasError && styles.wrapError, style]}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.headRow}>
        <CloudUpload size={16} color={hasError ? COLORS.rustText : COLORS.accent} />
        <Text variant="bodyMedium" style={{ flex: 1, fontSize: 13 }}>
          {items.length === 1 ? '1 play waiting to upload' : `${items.length} plays waiting to upload`}
        </Text>
        <Pressable onPress={retry} disabled={busy} hitSlop={8} style={styles.retryBtn}>
          <RefreshCw size={14} color={COLORS.accent} />
          <Text variant="caption" color={COLORS.accent}>
            {busy ? 'Uploading…' : 'Retry'}
          </Text>
        </Pressable>
        {open ? <ChevronDown size={15} color={COLORS.textMuted} /> : <ChevronRight size={15} color={COLORS.textMuted} />}
      </Pressable>

      {open
        ? items.map((item) => (
            <Row key={item.localId} gap="sm" style={styles.itemRow}>
              {item.gameSnapshot?.thumbnail_url ? (
                <Image source={{ uri: item.gameSnapshot.thumbnail_url }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, { backgroundColor: COLORS.cardSoft }]} />
              )}
              <View style={{ flex: 1 }}>
                <Text variant="bodyMedium" numberOfLines={1} style={{ fontSize: 13 }}>
                  {item.gameSnapshot?.name || 'Play'}
                </Text>
                <Text variant="caption" numberOfLines={1} color={item.lastError ? COLORS.rustText : COLORS.textMuted}>
                  {item.lastError
                    ? `Rejected: ${item.lastError}`
                    : [item.payload?.played_at, item.winnerName ? `${item.winnerName} won` : null].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Pressable onPress={() => discard(item)} hitSlop={10} style={styles.discardBtn}>
                <Trash2 size={15} color={COLORS.textMuted} />
              </Pressable>
            </Row>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.accent + '55',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  wrapError: { borderColor: COLORS.rust },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minHeight: 40 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.accent + '1c',
  },
  itemRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingVertical: SPACING.sm,
    minHeight: 48,
  },
  thumb: { width: 34, height: 34, borderRadius: RADII.sm },
  discardBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
