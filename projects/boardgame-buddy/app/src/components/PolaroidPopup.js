// PolaroidPopup — the celebratory splash surface (winner reveal after a play
// is finalized; joiner settle-up splash). A cream instant-photo card that
// drops in with a slight rotation, like web/ui/polaroid-popup.js. Imperative:
// mounted once at root, any screen calls showPolaroid().
//
// The host's wrap-up card also carries the save's state, so the card is
// updatable after it goes up: showPolaroid() returns a card id and
// updatePolaroid(patch, cardId) no-ops once a newer card has replaced it —
// without that guard a slow save could repaint the card belonging to the
// NEXT round.
//
// The card is NOT modal while the write runs. The outbox guarantees delivery,
// so there is nothing for the host to wait on: the card goes up with its CTA
// and its dismiss live in the same frame, carrying no save state. Every exit —
// the backdrop, the hardware back, a failed card's fallback — shares one
// destination, so there is one `close`.
//
// One bottom button at a time:
//   saved → "Another round?"   error → "Retry" (dismiss returns to Settle Up)
//
// A failed photo becomes a `warning` line ON the card rather than a second
// modal — this popup is a singleton, so an alert() would dismiss the very card
// it was warning about.
//
// Not for confirmations — destructive gates go through ConfirmModal (§3c).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { ArrowRight, PartyPopper, RotateCcw } from 'lucide-react-native';
import { COLORS, MOTION, RADII, SHADOWS, SPACING } from '../theme';
import { Button, Row, Text } from '../ui';

let _show = null;
let _update = null;

/**
 * @typedef {Object} PolaroidOpts
 * @property {string} [title]
 * @property {string} [caption]
 * @property {string|null} [photoUrl]
 * @property {string} [buttonLabel]   fallback CTA when there's no next game
 * @property {string|null} [error]    takes the button slot, as Retry
 * @property {string|null} [warning]  advisory line (e.g. photo didn't land)
 * @property {() => void} [onAnotherRound] owns the button slot when set
 * @property {() => void} [onRetry]
 * @property {() => void} [onDismiss] every exit's destination — backdrop tap,
 *   hardware back, and the fallback CTA
 */

/**
 * @param {PolaroidOpts} opts
 * @returns {number} card id for updatePolaroid()
 */
export function showPolaroid(opts = {}) {
  return _show ? _show(opts) : 0;
}

/** Patch the live card. No-ops if `cardId` isn't the card currently up. */
export function updatePolaroid(patch, cardId) {
  if (_update) _update(patch, cardId);
}

export default function PolaroidHost() {
  const [cfg, setCfg] = useState(null);
  const cardIdRef = useRef(0);
  const drop = useSharedValue(0);

  const show = useCallback((opts) => {
    const id = ++cardIdRef.current;
    setCfg({ ...opts, _id: id });
    return id;
  }, []);
  if (_show !== show) _show = show;

  const update = useCallback((patch, cardId) => {
    setCfg((prev) => {
      if (!prev) return prev;
      if (cardId != null && cardId !== prev._id) return prev; // stale writer
      return { ...prev, ...patch };
    });
  }, []);
  if (_update !== update) _update = update;

  useEffect(() => {
    if (cfg) {
      drop.value = 0;
      drop.value = withSpring(1, { damping: 14, stiffness: 120 });
    }
  }, [cfg?._id, drop]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: withTiming(drop.value ? 1 : 0, { duration: MOTION.fast }),
    transform: [{ translateY: (1 - drop.value) * -80 }, { rotate: `${(1 - drop.value) * 6 - 2}deg` }],
  }));

  if (!cfg) return null;

  const close = () => {
    const onDismiss = cfg.onDismiss;
    setCfg(null);
    if (onDismiss) onDismiss();
  };

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

            {cfg.error ? (
              <Text variant="small" center color={COLORS.rust} style={{ marginTop: SPACING.sm }}>
                {cfg.error}
              </Text>
            ) : null}
            {cfg.warning && !cfg.error ? (
              <Text variant="caption" center color={COLORS.polaroidMuted} style={{ marginTop: SPACING.sm }}>
                {cfg.warning}
              </Text>
            ) : null}

            {/* Exactly one button. An error owns the slot until it clears —
                retrying is the only thing worth doing with a rejected play —
                and otherwise the card's job is to offer the next game. */}
            <Row gap="sm" style={{ marginTop: SPACING.lg }}>
              {cfg.error ? (
                <Button label="Retry" icon={RotateCcw} onPress={() => cfg.onRetry && cfg.onRetry()} style={{ flex: 1 }} />
              ) : cfg.onAnotherRound ? (
                <Button
                  label="Another round?"
                  icon={RotateCcw}
                  onPress={() => {
                    const fn = cfg.onAnotherRound;
                    setCfg(null);
                    if (fn) fn();
                  }}
                  style={{ flex: 1 }}
                />
              ) : (
                <Button label={cfg.buttonLabel || 'Go to feed'} icon={ArrowRight} onPress={close} style={{ flex: 1 }} />
              )}
            </Row>
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
