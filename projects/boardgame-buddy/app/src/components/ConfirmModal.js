// src/components/ConfirmModal.js — the ONE project-wide destructive-confirm
// surface (mirrors web's PolaroidPopup.confirm, per web-frontend.md). Every
// destructive action awaits useConfirm()({...}); there are no bespoke
// per-screen dialogs.
//
//   const confirm = useConfirm();
//   if (await confirm({ title, body, confirmLabel, destructive })) { ... }

import React, {
  createContext, useCallback, useContext, useRef, useState,
} from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { COLORS, FONTS, FONT_SIZES, SPACING, RADII, SHADOWS } from '../theme';

const ConfirmContext = createContext(() => Promise.resolve(false));

export function ConfirmProvider({ children }) {
  const [opts, setOpts] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setOpts({
        title: options.title || 'Are you sure?',
        body: options.body || '',
        confirmLabel: options.confirmLabel || 'Confirm',
        cancelLabel: options.cancelLabel || 'Cancel',
        destructive: options.destructive !== false, // default destructive
      });
    });
  }, []);

  const settle = useCallback((value) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpts(null);
    if (resolve) resolve(value);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        visible={!!opts}
        transparent
        animationType="fade"
        onRequestClose={() => settle(false)}
      >
        <View style={styles.backdrop}>
          <View style={styles.card}>
            {opts ? (
              <>
                <Text style={styles.title}>{opts.title}</Text>
                {opts.body ? <Text style={styles.body}>{opts.body}</Text> : null}
                <View style={styles.row}>
                  <TouchableOpacity
                    style={[styles.btn, styles.cancel]}
                    onPress={() => settle(false)}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.cancelText}>{opts.cancelLabel}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btn, opts.destructive ? styles.danger : styles.primary]}
                    onPress={() => settle(true)}
                    activeOpacity={0.85}
                  >
                    <Text style={opts.destructive ? styles.dangerText : styles.primaryText}>
                      {opts.confirmLabel}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmContext);
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    padding: SPACING.xl,
    ...SHADOWS.lg,
  },
  title: {
    fontFamily: FONTS.displayBold,
    fontSize: FONT_SIZES.xl,
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
  body: {
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.md,
    color: COLORS.textSecondary,
    lineHeight: 22,
    marginBottom: SPACING.lg,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  btn: {
    minWidth: 96,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: RADII.pill,
  },
  cancel: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: COLORS.borderStrong,
  },
  cancelText: {
    fontFamily: FONTS.semibold,
    fontSize: FONT_SIZES.md,
    color: COLORS.textSecondary,
  },
  primary: { backgroundColor: COLORS.accent },
  primaryText: {
    fontFamily: FONTS.semibold,
    fontSize: FONT_SIZES.md,
    color: COLORS.brown,
  },
  danger: { backgroundColor: COLORS.danger },
  dangerText: {
    fontFamily: FONTS.semibold,
    fontSize: FONT_SIZES.md,
    color: COLORS.white,
  },
});
