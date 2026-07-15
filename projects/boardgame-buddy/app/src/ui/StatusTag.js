// src/ui/StatusTag.js — the collection-status pill for a Game tile. Ported from
// web/ui/status-tag.js. Renders owned/wishlist/played as a colored pill, or a
// "+" when there's no relationship. Tapping opens a small picker (Owned /
// Wishlist / Remove) wired through AppContext's collection actions, so every
// surface that shows the tile updates when the status changes (single source of
// truth = state.collectionMap, mirroring the web status-changed event).

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { LibraryBig, Star, History, Plus, Trash2 } from 'lucide-react-native';
import { useAppState, useAppActions } from '../store/AppContext';
import { COLORS, FONTS, FONT_SIZES, SPACING, RADII, SHADOWS } from '../theme';

const META = {
  owned: { label: 'Owned', color: COLORS.owned, Icon: LibraryBig },
  wishlist: { label: 'Wishlist', color: COLORS.wishlist, Icon: Star },
  played: { label: 'Played', color: COLORS.played, Icon: History },
};

export default function StatusTag({ gameId, size = 'sm', compact = false }) {
  const { collectionMap } = useAppState();
  const actions = useAppActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = (gameId && collectionMap && collectionMap[gameId]) || null;
  const iconSize = size === 'xs' ? 12 : 14;

  async function choose(next) {
    if (busy) return;
    setBusy(true);
    try {
      if (next === 'remove') await actions.removeCollectionStatus(gameId);
      else await actions.setCollectionStatus(gameId, next);
    } catch {}
    setBusy(false);
    setOpen(false);
  }

  let pill;
  if (status) {
    const m = META[status];
    const Icon = m.Icon;
    pill = (
      <View style={[styles.pill, { backgroundColor: m.color }, compact && styles.compact]}>
        <Icon size={iconSize} color={COLORS.white} />
        {!compact ? <Text style={styles.pillText}>{m.label}</Text> : null}
      </View>
    );
  } else {
    pill = (
      <View style={[styles.add, compact && styles.compact]}>
        <Plus size={iconSize + 1} color={COLORS.brown} />
      </View>
    );
  }

  const canRemove = status === 'owned' || status === 'wishlist';

  return (
    <>
      <TouchableOpacity
        onPress={(e) => { if (e && e.stopPropagation) e.stopPropagation(); setOpen(true); }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.8}
      >
        {pill}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            {['owned', 'wishlist'].filter((s) => s !== status).map((s) => {
              const m = META[s];
              const Icon = m.Icon;
              return (
                <TouchableOpacity key={s} style={styles.opt} onPress={() => choose(s)} disabled={busy}>
                  <Icon size={18} color={m.color} />
                  <Text style={styles.optText}>{m.label}</Text>
                </TouchableOpacity>
              );
            })}
            {canRemove ? (
              <TouchableOpacity style={styles.opt} onPress={() => choose('remove')} disabled={busy}>
                <Trash2 size={18} color={COLORS.danger} />
                <Text style={[styles.optText, { color: COLORS.danger }]}>Remove</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderRadius: RADII.pill,
  },
  compact: { paddingHorizontal: 5, paddingVertical: 5, borderRadius: RADII.pill },
  pillText: { fontFamily: FONTS.semibold, fontSize: FONT_SIZES.xs, color: COLORS.white },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderWidth: 1.5,
    borderColor: COLORS.borderStrong,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: RADII.pill,
  },
  backdrop: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  sheet: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingVertical: SPACING.xs,
    minWidth: 200,
    ...SHADOWS.lg,
  },
  opt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  optText: { fontFamily: FONTS.medium, fontSize: FONT_SIZES.md, color: COLORS.text },
});
