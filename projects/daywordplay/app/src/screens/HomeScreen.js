import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAppActions, useAppState, getCachedToday } from '../store/AppContext';
import { validateSentence } from '#shared/validation';
import GroupSwitcher from '../components/GroupSwitcher';
import WordDisplay from '../components/WordDisplay';
import HighlightedSentence from '../components/HighlightedSentence';
import LoadingState from '../components/LoadingState';
import ErrorBanner from '../components/ErrorBanner';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function HomeScreen({ navigation }) {
  const state = useAppState();
  const { activeGroupId, todayLoading, reusableSentences, myGroups } = state;
  const { loadToday, loadReusableSentences, submitSentence } = useAppActions();
  const todayData = getCachedToday(state, activeGroupId);

  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!activeGroupId) return;
    loadToday(activeGroupId).catch(() => {});
    loadReusableSentences(activeGroupId).catch(() => {});
  }, [activeGroupId, loadToday, loadReusableSentences]);

  const wordText = todayData?.word?.word || '';
  const submitOk = useMemo(() => {
    if (!wordText) return false;
    return validateSentence(draft, wordText).ok;
  }, [draft, wordText]);

  const onSubmit = async () => {
    setError(null);
    const v = validateSentence(draft, wordText);
    if (!v.ok) { setError(v.error); return; }
    setSubmitting(true);
    try {
      await submitSentence(activeGroupId, draft.trim());
      setDraft('');
    } catch (err) {
      setError(err?.message || 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!activeGroupId) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Join a Group</Text>
        <Text style={styles.emptyText}>
          You haven't joined a group yet. Browse groups, enter a code, or create your own.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={() => navigation.navigate('Groups')}>
          <Text style={styles.primaryBtnText}>Find Groups</Text>
        </Pressable>
      </View>
    );
  }

  if (!todayData) {
    return <LoadingState label={todayLoading ? 'Loading today’s word…' : ''} />;
  }

  const { word, submitted, my_sentence, submission_count, member_count } = todayData;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <GroupSwitcher />
        <WordDisplay word={word} />

        <View style={styles.actionsRow}>
          <Pressable style={styles.secondaryBtn} onPress={() => navigation.navigate('Vote')}>
            <Text style={styles.secondaryBtnText}>Vote on yesterday’s sentences</Text>
          </Pressable>
        </View>

        {submitted && my_sentence ? (
          <View style={styles.submittedCard}>
            <Text style={styles.submittedTitle}>Your sentence for today</Text>
            <HighlightedSentence
              sentence={`"${my_sentence.sentence}"`}
              word={word.word}
              style={styles.submittedSentence}
            />
            <Text style={styles.submittedHint}>Come back tomorrow to vote!</Text>
          </View>
        ) : (
          <View style={styles.composeCard}>
            <Text style={styles.sectionTitle}>Write your sentence</Text>
            {reusableSentences.length > 0 ? (
              <ReusablePills
                sentences={reusableSentences}
                myGroups={myGroups}
                wordText={word.word}
                onPick={(s) => setDraft(s)}
              />
            ) : null}
            <TextInput
              style={styles.input}
              multiline
              placeholder={`Use "${word.word}" in a sentence…`}
              placeholderTextColor={COLORS.textMuted}
              value={draft}
              onChangeText={setDraft}
              editable={!submitting}
            />
            <ErrorBanner message={error} style={{ marginTop: SPACING.sm }} />
            <Pressable
              onPress={onSubmit}
              disabled={!submitOk || submitting}
              style={[styles.primaryBtn, (!submitOk || submitting) && styles.btnDisabled]}
            >
              <Text style={styles.primaryBtnText}>
                {submitting ? 'Submitting…' : 'Submit'}
              </Text>
            </Pressable>
          </View>
        )}

        <Text style={styles.statsLine}>
          {submission_count ?? 0} of {member_count ?? 0} members submitted today
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ReusablePills({ sentences, myGroups, wordText, onPick }) {
  const groupNames = useMemo(() => {
    const m = {};
    for (const g of myGroups) m[g.id] = g.name;
    return m;
  }, [myGroups]);
  const unique = useMemo(() => {
    const seen = new Map();
    for (const s of sentences) {
      const key = (s.sentence || '').toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, { sentence: s.sentence, groups: [] });
      }
      seen.get(key).groups.push(groupNames[s.group_id] || 'another group');
    }
    return [...seen.values()];
  }, [sentences, groupNames]);

  return (
    <View style={styles.reusableWrap}>
      <Text style={styles.reusableLabel}>Reuse from another group</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reusableRow}>
        {unique.map((entry, i) => (
          <Pressable key={i} style={styles.reusablePill} onPress={() => onPick(entry.sentence)}>
            <HighlightedSentence
              sentence={`"${entry.sentence}"`}
              word={wordText}
              style={styles.reusablePillText}
            />
            <Text style={styles.reusablePillSource}>from {entry.groups.join(', ')}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: SPACING.xxl },
  empty: { flex: 1, padding: SPACING.xl, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: COLORS.text, marginBottom: SPACING.md },
  emptyText: { color: COLORS.textSecondary, textAlign: 'center', marginBottom: SPACING.lg, lineHeight: 22 },
  actionsRow: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: SPACING.lg, marginBottom: SPACING.md },
  composeCard: {
    margin: SPACING.lg,
    padding: SPACING.lg,
    backgroundColor: COLORS.surface,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sectionTitle: { fontSize: FONT_SIZES.section, fontWeight: '700', color: COLORS.text, marginBottom: SPACING.md },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.body,
    color: COLORS.text,
    backgroundColor: COLORS.background,
    minHeight: 96,
    textAlignVertical: 'top',
  },
  primaryBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: RADII.lg,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: FONT_SIZES.card },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surface,
    borderRadius: RADII.pill,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
  },
  secondaryBtnText: { color: COLORS.text, fontWeight: '600', fontSize: FONT_SIZES.body },
  btnDisabled: { opacity: 0.5 },
  submittedCard: {
    margin: SPACING.lg,
    padding: SPACING.lg,
    backgroundColor: COLORS.success,
    borderRadius: RADII.lg,
    alignItems: 'center',
  },
  submittedTitle: { fontWeight: '700', fontSize: FONT_SIZES.body, color: COLORS.successText, marginBottom: SPACING.sm },
  submittedSentence: { fontSize: FONT_SIZES.card, color: COLORS.text, fontStyle: 'italic', textAlign: 'center', marginVertical: SPACING.sm, lineHeight: 24 },
  submittedHint: { fontSize: FONT_SIZES.small, color: COLORS.successText, marginTop: SPACING.sm },
  statsLine: { textAlign: 'center', color: COLORS.textMuted, fontSize: FONT_SIZES.small, marginTop: SPACING.md },
  reusableWrap: { marginBottom: SPACING.md },
  reusableLabel: { fontSize: FONT_SIZES.small, color: COLORS.textSecondary, marginBottom: SPACING.sm, fontWeight: '600' },
  reusableRow: { gap: SPACING.sm },
  reusablePill: {
    backgroundColor: COLORS.surfaceSubtle,
    borderRadius: RADII.md,
    padding: SPACING.sm,
    maxWidth: 240,
  },
  reusablePillText: { fontSize: FONT_SIZES.small, color: COLORS.text, lineHeight: 18 },
  reusablePillSource: { fontSize: FONT_SIZES.caption, color: COLORS.textMuted, marginTop: SPACING.xs },
});
