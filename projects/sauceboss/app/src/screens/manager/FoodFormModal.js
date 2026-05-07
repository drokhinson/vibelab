// Add / edit form for a sauceboss_foods row. Used from the Ingredients tab.
// Add: any logged-in user. Edit: admin only (but the modal itself is the same).

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useAppActions } from '../../store/AppContext';
import { COLORS, SHADOWS } from '../../theme';

export default function FoodFormModal({ visible, mode, food, onClose }) {
  const actions = useAppActions();
  const [name, setName] = useState('');
  const [plural, setPlural] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!visible) return;
    if (mode === 'edit' && food) {
      setName(food.name || '');
      setPlural(food.plural || '');
    } else {
      setName('');
      setPlural('');
    }
    setError(null);
  }, [visible, mode, food]);

  async function handleSubmit() {
    const n = name.trim();
    if (!n) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { name: n, plural: plural.trim() || null };
      const res = mode === 'edit' && food
        ? await actions.updateFood(food.id, payload)
        : await actions.createFood(payload);
      if (!res.ok) setError(res.error || 'Could not save');
      else onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.kav}
          >
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
              <TouchableWithoutFeedback>
                <View style={styles.card}>
                  <View style={styles.headerRow}>
                    <Text style={styles.title}>{mode === 'edit' ? 'Edit ingredient' : 'New ingredient'}</Text>
                    <TouchableOpacity onPress={onClose} hitSlop={12}>
                      <X size={20} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.label}>Name</Text>
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="tomato"
                    placeholderTextColor={COLORS.textMuted}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />

                  <Text style={styles.label}>Plural (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={plural}
                    onChangeText={setPlural}
                    placeholder="tomatoes"
                    placeholderTextColor={COLORS.textMuted}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />

                  {error ? <Text style={styles.errorText}>{error}</Text> : null}

                  <TouchableOpacity
                    style={[styles.submit, saving && styles.submitDisabled]}
                    onPress={handleSubmit}
                    disabled={saving}
                    activeOpacity={0.85}
                  >
                    {saving ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.submitLabel}>{mode === 'edit' ? 'Save' : 'Add'}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </TouchableWithoutFeedback>
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  kav: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: COLORS.card, borderRadius: 18, padding: 22, ...SHADOWS.lg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: COLORS.text },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    marginBottom: 4,
    marginTop: 8,
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: COLORS.text,
  },
  errorText: {
    color: COLORS.dangerText,
    backgroundColor: COLORS.danger,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
  },
  submit: {
    marginTop: 16,
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.5 },
  submitLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
