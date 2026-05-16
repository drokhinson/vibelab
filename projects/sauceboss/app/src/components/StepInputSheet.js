// Step-combine picker — mirrors web's _renderStepInputSheet (web/builder.js:480-520).
// Replaces @gorhom/bottom-sheet's BottomSheetModal with React Native's Modal
// after three failed attempts to make present() reliably surface the sheet.

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, X } from 'lucide-react-native';
import { COLORS } from '../theme';

export default function StepInputSheet({
  visible,
  priorSteps,
  draft,
  onToggle,
  onSave,
  onCancel,
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
    >
      <View style={styles.flex}>
        <Pressable style={styles.backdrop} onPress={onCancel} />
        <View style={styles.card}>
          <View style={styles.handle} />
          <View style={[styles.body, { paddingBottom: Math.max(28, insets.bottom + 12) }]}>
            <View style={styles.header}>
              <Text style={styles.title}>Combine Previous Steps</Text>
              <TouchableOpacity onPress={onCancel} hitSlop={10}>
                <X size={20} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>
              Pick the steps whose output flows into this one.
            </Text>

            {priorSteps && priorSteps.length > 0 ? (
              <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
                {priorSteps.map((s, ri) => {
                  const refOrder = ri + 1;
                  const on = (draft || []).includes(refOrder);
                  const tail = s.title ? ` — ${s.title.slice(0, 40)}` : '';
                  return (
                    <TouchableOpacity
                      key={refOrder}
                      onPress={() => onToggle(refOrder)}
                      style={[styles.row, on && styles.rowOn]}
                      activeOpacity={0.75}
                    >
                      <View style={[styles.checkbox, on && styles.checkboxOn]}>
                        {on ? <Check size={14} color="#fff" /> : null}
                      </View>
                      <Text
                        style={[styles.rowLabel, on && styles.rowLabelOn]}
                        numberOfLines={1}
                      >
                        Step {refOrder}{tail}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={styles.empty}>No earlier steps to combine yet.</Text>
            )}

            <View style={styles.footer}>
              <TouchableOpacity style={styles.btnSecondary} onPress={onCancel} activeOpacity={0.8}>
                <Text style={styles.btnSecondaryLabel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnPrimary} onPress={onSave} activeOpacity={0.85}>
                <Text style={styles.btnPrimaryLabel}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  // Sheet now grows freely up to the parent's height; the body's paddingBottom
  // (set inline with the safe-area inset) keeps content above the home indicator.
  card: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    flexShrink: 1,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderStrong,
    marginBottom: 6,
  },
  // paddingBottom is applied inline at render time to incorporate the
  // safe-area inset.
  body: {
    paddingHorizontal: 18,
    paddingTop: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
  },
  hint: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginBottom: 12,
  },
  list: {
    maxHeight: 320,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    marginVertical: 4,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  rowOn: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.highlightTint,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: COLORS.borderStrong,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  rowLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
    flex: 1,
  },
  rowLabelOn: {
    color: COLORS.primaryDark,
    fontWeight: '700',
  },
  empty: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 20,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  btnSecondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
  },
  btnSecondaryLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
  },
  btnPrimaryLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: '#fff',
  },
});
