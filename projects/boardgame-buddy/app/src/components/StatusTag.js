// StatusTag — the one collection-status pill for every game tile. Renders the
// owned / prev_owned / wishlist / played pill, or a "+" button when there's no
// relationship. Tapping opens a shared picker that flips shelf state via the
// app-wide setCollectionStatus action, so every mounted tile re-renders from
// myCollectionMap. Ported from web/ui/status-tag.js (CustomEvent → context).

import React, { useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { LibraryBig, Star, History, Archive, Plus, Trash2, GitFork } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING, SHADOWS } from '../theme';
import { useAppState, useAppActions } from '../store/AppContext';

// Every status the map can hold needs an entry, not just the settable ones:
// a game with no META renders a blank pill, which is how a status added on the
// server reaches a user as a missing control rather than an error.
const META = {
  owned: { Icon: LibraryBig, label: 'Owned', color: COLORS.owned },
  prev_owned: { Icon: Archive, label: 'Prev. owned', color: COLORS.prevOwned },
  wishlist: { Icon: Star, label: 'Wishlist', color: COLORS.wishlist },
  played: { Icon: History, label: 'Played', color: COLORS.played },
};

// What the picker offers, in the order it lists them. Prev. owned sits under
// Owned because it IS a kind of owned — the game stays on the Owned shelf.
// 'played' is absent: it is derived from logged plays, with no row to set.
const CHOICES = ['owned', 'prev_owned', 'wishlist'];

// Sub-labels, so "Prev. owned" doesn't have to be self-explanatory.
const BLURB = {
  owned: 'On your shelf',
  prev_owned: 'Sold, gifted or donated',
  wishlist: 'Games you want',
};

/**
 * @param {Object} props
 * @param {string} props.gameId
 * @param {'sm'|'xs'|'lg'} [props.size]
 * @param {boolean} [props.compact] icon-only corner chip
 * @param {string} [props.addLabel] label next to + when no status
 */
export default function StatusTag({ gameId, size = 'sm', compact = false, addLabel }) {
  const state = useAppState();
  const actions = useAppActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = state.myCollectionMap[gameId] || null;

  const dim = size === 'xs' ? 11 : size === 'lg' ? 16 : 13;

  async function choose(next) {
    setBusy(true);
    try {
      await actions.setCollectionStatus(gameId, next);
    } catch {}
    setBusy(false);
    setOpen(false);
  }

  const m = status ? META[status] : null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={8}
        style={[
          styles.tag,
          compact && styles.compact,
          m ? { backgroundColor: m.color + '26', borderColor: m.color } : styles.add,
        ]}
      >
        {m ? (
          <>
            <m.Icon size={dim} color={m.color} />
            {!compact && <Text style={[styles.label, { color: m.color }]}>{m.label}</Text>}
          </>
        ) : (
          <>
            <Plus size={dim + 1} color={COLORS.accent} />
            {!compact && addLabel ? <Text style={[styles.label, { color: COLORS.accent }]}>{addLabel}</Text> : null}
          </>
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Shelf status</Text>
            {CHOICES.map((s) =>
              s === status ? null : (
                <Pressable key={s} style={styles.opt} disabled={busy} onPress={() => choose(s)}>
                  {React.createElement(META[s].Icon, { size: 18, color: META[s].color })}
                  <View style={styles.optText}>
                    <Text style={styles.optLabel}>{META[s].label}</Text>
                    <Text style={styles.optSub}>{BLURB[s]}</Text>
                  </View>
                </Pressable>
              ),
            )}
            {/* Remove stays separate from "Prev. owned" even though the two
                overlap in practice: Prev. owned means "I had this and let it
                go" and keeps the row; Remove means "this was never mine". */}
            {CHOICES.includes(status) && (
              <Pressable style={styles.opt} disabled={busy} onPress={() => choose(null)}>
                <Trash2 size={18} color={COLORS.rustText} />
                <Text style={[styles.optLabel, { color: COLORS.rustText }]}>Remove</Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

export function ExpansionBadge({ count }) {
  if (!count || count < 1) return null;
  return (
    <View style={styles.expBadge}>
      <GitFork size={11} color={COLORS.textSoft} />
      <Text style={styles.expText}>{count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  compact: { paddingHorizontal: 5, paddingVertical: 5 },
  add: { backgroundColor: COLORS.bg + 'cc', borderColor: COLORS.accent },
  label: { fontFamily: FONTS.sansSemibold, fontSize: 11 },
  backdrop: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'center', padding: SPACING.xl },
  sheet: { backgroundColor: COLORS.card, borderRadius: RADII.lg, padding: SPACING.md, ...SHADOWS.lg },
  sheetTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18, marginBottom: SPACING.sm },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56 },
  optText: { flex: 1 },
  optLabel: { fontFamily: FONTS.sansMedium, color: COLORS.text, fontSize: 15 },
  optSub: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 12, marginTop: 1 },
  expBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: COLORS.bg + 'cc',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: RADII.pill,
  },
  expText: { fontFamily: FONTS.sansSemibold, color: COLORS.textSoft, fontSize: 11 },
});
