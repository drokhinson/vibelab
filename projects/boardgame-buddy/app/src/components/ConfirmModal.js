// ConfirmModal — the ONE project-wide destructive-confirm + info-alert surface
// (the native equivalent of web's PolaroidPopup.confirm/alert). Mounted once at
// the app root; any screen calls the imperative `confirm()` / `alert()` exports.
// Every destructive action (delete play, abandon session, unfriend, delete
// chapter, delete account, remove from collection) routes through here — no
// per-screen dialogs (.claude/rules/ui-object-design.md §3c).

import React, { useState, useCallback, useRef } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { COLORS, FONTS, RADII, SPACING, SHADOWS } from '../theme';

// Module-level bridge so non-React callers (services) can invoke the modal.
let _handler = null;

/**
 * Ask for confirmation. Resolves true if confirmed, false if cancelled.
 * @param {{title?:string, body?:string, confirmLabel?:string, cancelLabel?:string, destructive?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirm(opts = {}) {
  if (!_handler) return Promise.resolve(false);
  return _handler({ ...opts, mode: 'confirm' });
}

/** Info alert with a single dismiss button. Resolves when dismissed. */
export function alert(opts = {}) {
  if (!_handler) return Promise.resolve();
  return _handler({ ...opts, mode: 'alert' });
}

export default function ConfirmHost() {
  const [cfg, setCfg] = useState(null);
  const resolverRef = useRef(null);

  const handle = useCallback(
    (opts) =>
      new Promise((resolve) => {
        resolverRef.current = resolve;
        setCfg(opts);
      }),
    [],
  );

  // Register the imperative bridge once.
  if (_handler !== handle) _handler = handle;

  const close = (value) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setCfg(null);
    if (r) r(value);
  };

  if (!cfg) return null;
  const isConfirm = cfg.mode === 'confirm';
  const destructive = !!cfg.destructive;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(isConfirm ? false : undefined)}>
      <Pressable style={styles.backdrop} onPress={() => close(isConfirm ? false : undefined)}>
        <Pressable style={styles.card} onPress={() => {}}>
          {cfg.title ? <Text style={styles.title}>{cfg.title}</Text> : null}
          {cfg.body ? <Text style={styles.body}>{cfg.body}</Text> : null}
          <View style={styles.actions}>
            {isConfirm ? (
              <Pressable style={[styles.btn, styles.cancel]} onPress={() => close(false)}>
                <Text style={styles.cancelLabel}>{cfg.cancelLabel || 'Cancel'}</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.btn, destructive ? styles.destructive : styles.primary]}
              onPress={() => close(isConfirm ? true : undefined)}
            >
              <Text style={destructive ? styles.destructiveLabel : styles.primaryLabel}>
                {cfg.confirmLabel || (isConfirm ? 'Confirm' : 'OK')}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'center', padding: SPACING.xl },
  card: { backgroundColor: COLORS.polaroidBg, borderRadius: RADII.lg, padding: SPACING.xl, ...SHADOWS.lg },
  title: { fontFamily: FONTS.display, color: COLORS.polaroidInk, fontSize: 22, marginBottom: SPACING.sm },
  body: { fontFamily: FONTS.sans, color: COLORS.polaroidInkSoft, fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.sm, marginTop: SPACING.xl },
  btn: { paddingHorizontal: SPACING.lg, paddingVertical: 10, borderRadius: RADII.pill, minWidth: 84, alignItems: 'center' },
  cancel: { backgroundColor: COLORS.polaroidBgSoft },
  cancelLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.polaroidInkSoft, fontSize: 14 },
  primary: { backgroundColor: COLORS.accent },
  primaryLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 14 },
  destructive: { backgroundColor: COLORS.rust },
  destructiveLabel: { fontFamily: FONTS.sansBold, color: COLORS.white, fontSize: 14 },
});
