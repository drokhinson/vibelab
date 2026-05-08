import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppActions } from '../store/AppContext';
import { validateGroupName } from '#shared/validation';
import ErrorBanner from '../components/ErrorBanner';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function CreateGroupScreen({ navigation }) {
  const { createGroup } = useAppActions();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onCreate = async () => {
    setError(null);
    const v = validateGroupName(name);
    if (!v.ok) { setError(v.error); return; }
    setBusy(true);
    try {
      await createGroup(name.trim());
      navigation.goBack();
    } catch (err) {
      setError(err?.message || 'Could not create group.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Create a Group</Text>
      <Text style={styles.body}>Give your group a name. Share the 4-letter code so friends can join.</Text>
      <Text style={styles.label}>Group Name</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. Weekend Warriors"
        placeholderTextColor={COLORS.textMuted}
        maxLength={40}
        value={name}
        onChangeText={setName}
        editable={!busy}
      />
      <ErrorBanner message={error} style={{ marginTop: SPACING.sm }} />
      <Pressable style={[styles.btn, busy && { opacity: 0.5 }]} onPress={onCreate} disabled={busy}>
        <Text style={styles.btnText}>{busy ? 'Creating…' : 'Create Group'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: SPACING.lg, backgroundColor: COLORS.background },
  title: { fontSize: FONT_SIZES.title, fontWeight: '800', color: COLORS.text, marginBottom: SPACING.sm },
  body: { color: COLORS.textSecondary, marginBottom: SPACING.lg, lineHeight: 22 },
  label: { fontSize: FONT_SIZES.small, color: COLORS.textSecondary, marginBottom: SPACING.xs },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.body,
    color: COLORS.text,
    backgroundColor: COLORS.surface,
  },
  btn: { backgroundColor: COLORS.primary, borderRadius: RADII.lg, paddingVertical: SPACING.md, alignItems: 'center', marginTop: SPACING.lg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: FONT_SIZES.card },
});
