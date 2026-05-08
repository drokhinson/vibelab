import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppActions } from '../store/AppContext';
import { validateProposedWord } from '#shared/validation';
import ErrorBanner from '../components/ErrorBanner';
import SuccessBanner from '../components/SuccessBanner';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function ProposeWordScreen({ navigation }) {
  const { proposeWord } = useAppActions();
  const [word, setWord] = useState('');
  const [pos, setPos] = useState('');
  const [def, setDef] = useState('');
  const [etym, setEtym] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const onSubmit = async () => {
    setError(null); setSuccess(null);
    const v = validateProposedWord({ word, partOfSpeech: pos, definition: def });
    if (!v.ok) { setError(v.error); return; }
    setBusy(true);
    try {
      await proposeWord({
        word: word.trim().toLowerCase(),
        part_of_speech: pos.trim(),
        definition: def.trim(),
        etymology: etym.trim() || null,
      });
      setSuccess(`"${word.trim()}" submitted! An admin will review it.`);
      setWord(''); setPos(''); setDef(''); setEtym('');
    } catch (err) {
      setError(err?.message || 'Could not submit proposal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.wrap}>
        <Text style={styles.title}>Propose a Word</Text>
        <Text style={styles.body}>Suggest a word for the dictionary. An admin will review it before it enters rotation.</Text>

        <Text style={styles.label}>Word</Text>
        <TextInput style={styles.input} value={word} onChangeText={setWord} editable={!busy} autoCapitalize="none" />
        <Text style={styles.label}>Part of speech</Text>
        <TextInput style={styles.input} value={pos} onChangeText={setPos} editable={!busy} placeholder="noun, verb, …" placeholderTextColor={COLORS.textMuted} />
        <Text style={styles.label}>Definition</Text>
        <TextInput style={[styles.input, styles.multi]} value={def} onChangeText={setDef} multiline editable={!busy} />
        <Text style={styles.label}>Etymology (optional)</Text>
        <TextInput style={[styles.input, styles.multi]} value={etym} onChangeText={setEtym} multiline editable={!busy} />

        <ErrorBanner message={error} style={{ marginTop: SPACING.sm }} />
        <SuccessBanner message={success} style={{ marginTop: SPACING.sm }} />

        <Pressable style={[styles.btn, busy && { opacity: 0.5 }]} onPress={onSubmit} disabled={busy}>
          <Text style={styles.btnText}>{busy ? 'Submitting…' : 'Submit Proposal'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACING.lg, backgroundColor: COLORS.background, paddingBottom: SPACING.xxl },
  title: { fontSize: FONT_SIZES.title, fontWeight: '800', color: COLORS.text, marginBottom: SPACING.sm },
  body: { color: COLORS.textSecondary, marginBottom: SPACING.lg, lineHeight: 22 },
  label: { fontSize: FONT_SIZES.small, color: COLORS.textSecondary, marginBottom: SPACING.xs, marginTop: SPACING.sm },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.body,
    color: COLORS.text,
    backgroundColor: COLORS.surface,
  },
  multi: { minHeight: 72, textAlignVertical: 'top' },
  btn: { backgroundColor: COLORS.primary, borderRadius: RADII.lg, paddingVertical: SPACING.md, alignItems: 'center', marginTop: SPACING.lg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: FONT_SIZES.card },
});
