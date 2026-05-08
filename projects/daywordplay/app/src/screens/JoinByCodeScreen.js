import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppActions } from '../store/AppContext';
import { normalizeGroupCode, validateGroupCode } from '#shared/validation';
import ErrorBanner from '../components/ErrorBanner';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function JoinByCodeScreen({ navigation }) {
  const { joinGroupByCode } = useAppActions();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onJoin = async () => {
    setError(null);
    const v = validateGroupCode(code);
    if (!v.ok) { setError(v.error); return; }
    setBusy(true);
    try {
      await joinGroupByCode(v.code);
      navigation.goBack();
    } catch (err) {
      setError(err?.message || 'Could not join group.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Join by Code</Text>
      <Text style={styles.body}>Enter the 4-letter code shown on your friend's group leaderboard.</Text>
      <Text style={styles.label}>Group Code</Text>
      <TextInput
        style={styles.input}
        placeholder="ABCD"
        placeholderTextColor={COLORS.textMuted}
        autoCapitalize="characters"
        maxLength={4}
        value={code}
        onChangeText={(t) => setCode(normalizeGroupCode(t))}
        editable={!busy}
      />
      <ErrorBanner message={error} style={{ marginTop: SPACING.sm }} />
      <Pressable style={[styles.btn, busy && { opacity: 0.5 }]} onPress={onJoin} disabled={busy}>
        <Text style={styles.btnText}>{busy ? 'Joining…' : 'Join Group'}</Text>
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
    fontSize: 24,
    letterSpacing: 4,
    textAlign: 'center',
    fontFamily: 'monospace',
    color: COLORS.text,
    backgroundColor: COLORS.surface,
  },
  btn: { backgroundColor: COLORS.primary, borderRadius: RADII.lg, paddingVertical: SPACING.md, alignItems: 'center', marginTop: SPACING.lg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: FONT_SIZES.card },
});
