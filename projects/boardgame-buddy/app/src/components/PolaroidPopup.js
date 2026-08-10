// PolaroidPopup — the celebratory splash surface (winner reveal after a play
// is finalized; joiner settle-up splash). A cream instant-photo card that
// drops in with a slight rotation, like web/ui/polaroid-popup.js. Imperative:
// mounted once at root, any screen calls showPolaroid().
//
// Not for confirmations — destructive gates go through ConfirmModal (§3c).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { PartyPopper } from 'lucide-react-native';
import { COLORS, MOTION, RADII, SHADOWS, SPACING } from '../theme';
import { Button, Text } from '../ui';

let _show = null;

/**
 * @param {{ title?: string, caption?: string, photoUrl?: string|null,
 *           buttonLabel?: string }} opts
 * @returns {Promise<void>} resolves on dismiss
 */
export function showPolaroid(opts = {}) {
  if (!_show) return Promise.resolve();
  return _show(opts);
}

export default function PolaroidHost() {
  const [cfg, setCfg] = useState(null);
  const resolverRef = useRef(null);
  const drop = useSharedValue(0);

  const show = useCallback(
    (opts) =>
      new Promise((resolve) => {
        resolverRef.current = resolve;
        setCfg(opts);
      }),
    [],
  );
  if (_show !== show) _show = show;

  useEffect(() => {
    if (cfg) {
      drop.value = 0;
      drop.value = withSpring(1, { damping: 14, stiffness: 120 });
    }
  }, [cfg, drop]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: withTiming(drop.value ? 1 : 0, { duration: MOTION.fast }),
    transform: [
      { translateY: (1 - drop.value) * -80 },
      { rotate: `${(1 - drop.value) * 6 - 2}deg` },
    ],
  }));

  const close = () => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setCfg(null);
    if (r) r();
  };

  if (!cfg) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Animated.View style={cardStyle}>
          <Pressable style={styles.card} onPress={() => {}}>
            <View style={styles.photoFrame}>
              {cfg.photoUrl ? (
                <Image source={{ uri: cfg.photoUrl }} style={styles.photo} resizeMode="cover" />
              ) : (
                <View style={[styles.photo, styles.photoEmpty]}>
                  <PartyPopper size={44} color={COLORS.polaroidAccent} />
                </View>
              )}
            </View>
            {cfg.title ? (
              <Text variant="polaroid" center style={{ fontSize: 20, marginTop: SPACING.md }}>
                {cfg.title}
              </Text>
            ) : null}
            {cfg.caption ? (
              <Text variant="polaroidItalic" center style={{ marginTop: SPACING.xs }}>
                {cfg.caption}
              </Text>
            ) : null}
            <Button
              label={cfg.buttonLabel || 'Nice!'}
              onPress={close}
              full
              style={{ marginTop: SPACING.lg }}
            />
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: COLORS.overlay, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  card: {
    backgroundColor: COLORS.polaroidBg,
    borderRadius: RADII.md,
    padding: SPACING.md,
    width: 300,
    ...SHADOWS.lg,
  },
  photoFrame: { borderRadius: RADII.sm, overflow: 'hidden', backgroundColor: COLORS.polaroidBgSoft },
  photo: { width: '100%', height: 210 },
  photoEmpty: { alignItems: 'center', justifyContent: 'center' },
});
