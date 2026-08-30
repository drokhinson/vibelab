// PlayDetailPopup — the single "open a play" destination (ui-object-design
// §3b): PlayCard's maximize, plays-list rows, and feed all land here.
// Imperative singleton: PlayDetailPopup.show(playId). Host mounted at root.
// Owner plays can be edited (date / notes / scores / winner) and deleted;
// plays you're only tagged in can be left. Content lives in
// PlayDetailContent.js to keep this file inside the 300-line budget.

import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { X } from 'lucide-react-native';
import { COLORS, RADII, SHADOWS, SPACING } from '../theme';
import api from '../api/client';
import { confirm } from '../components/ConfirmModal';
import PlayDetailContent from './PlayDetailContent';

let _show = null;
let _onMutated = null;

const PlayDetailPopup = {
  show(playId) {
    if (_show) _show(playId);
  },
  /** AppRoot wires this to actions.afterPlaySaved-style invalidation. */
  setMutationListener(fn) {
    _onMutated = fn;
  },
};

export function PlayDetailHost() {
  const [playId, setPlayId] = useState(null);
  const [play, setPlay] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const reqRef = useRef(0);

  const open = useCallback(async (id) => {
    const seq = ++reqRef.current;
    setPlayId(id);
    setPlay(null);
    setEditing(false);
    setLoading(true);
    try {
      const p = await api.play(id);
      if (seq === reqRef.current) setPlay(p);
    } catch {}
    if (seq === reqRef.current) setLoading(false);
  }, []);

  if (_show !== open) _show = open;

  const close = () => {
    reqRef.current++;
    setPlayId(null);
    setPlay(null);
    setEditing(false);
  };

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete this play?',
      body: 'The play and its scores are removed for everyone. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deletePlay(play.id);
      if (_onMutated) _onMutated(play.game_id);
      close();
    } catch {}
  }

  async function handleLeave() {
    const ok = await confirm({
      title: 'Leave this play?',
      body: "You'll be removed from the player list. The play stays in the logger's history.",
      confirmLabel: 'Leave',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.leavePlay(play.id);
      if (_onMutated) _onMutated(play.game_id);
      close();
    } catch {}
  }

  async function handleSave(payload) {
    const updated = await api.updatePlay(play.id, payload);
    setPlay(updated);
    setEditing(false);
    if (_onMutated) _onMutated(play.game_id);
  }

  if (!playId) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Pressable style={styles.close} onPress={close} hitSlop={10}>
            <X size={22} color={COLORS.polaroidInkSoft} />
          </Pressable>
          {loading || !play ? (
            <ActivityIndicator color={COLORS.polaroidAccent} style={{ paddingVertical: 60 }} />
          ) : (
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
              <PlayDetailContent
                play={play}
                editing={editing}
                onStartEdit={() => setEditing(true)}
                onCancelEdit={() => setEditing(false)}
                onSave={handleSave}
                onDelete={handleDelete}
                onLeave={handleLeave}
              />
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'flex-end' },
  card: {
    backgroundColor: COLORS.polaroidBg,
    borderTopLeftRadius: RADII.xl,
    borderTopRightRadius: RADII.xl,
    maxHeight: '88%',
    ...SHADOWS.lg,
  },
  close: { position: 'absolute', top: SPACING.md, right: SPACING.md, zIndex: 2, padding: 6 },
  scroll: { padding: SPACING.xl, paddingBottom: SPACING.xxl },
});

export default PlayDetailPopup;
