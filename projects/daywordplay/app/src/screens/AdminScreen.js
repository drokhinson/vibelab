import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import { adminApi } from '../api/client';
import LoadingState from '../components/LoadingState';
import ErrorBanner from '../components/ErrorBanner';
import SuccessBanner from '../components/SuccessBanner';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function AdminScreen() {
  const { adminAuthed, proposals, adminGroups } = useAppState();
  const { authenticateAdmin, clearAdmin, loadAdminProposals, loadAdminGroups } = useAppActions();
  const [keyInput, setKeyInput] = useState('');
  const [authError, setAuthError] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);

  // Add Word
  const [w, setW] = useState('');
  const [pos, setPos] = useState('');
  const [def, setDef] = useState('');
  const [etym, setEtym] = useState('');
  const [addMsg, setAddMsg] = useState(null);
  const [addError, setAddError] = useState(null);
  const [addBusy, setAddBusy] = useState(false);

  useEffect(() => {
    if (!adminAuthed) return;
    loadAdminProposals().catch(() => {});
    loadAdminGroups().catch(() => {});
  }, [adminAuthed, loadAdminProposals, loadAdminGroups]);

  const onAuth = async () => {
    setAuthError(null);
    if (!keyInput.trim()) { setAuthError('Enter the admin key.'); return; }
    setAuthBusy(true);
    const r = await authenticateAdmin(keyInput.trim());
    setAuthBusy(false);
    if (!r.ok) setAuthError(r.error);
  };

  const onAddWord = async () => {
    setAddError(null); setAddMsg(null);
    if (!w.trim() || !pos.trim() || !def.trim()) {
      setAddError('Word, part of speech, and definition are required.');
      return;
    }
    setAddBusy(true);
    try {
      await adminApi.adminAddWord({
        word: w.trim().toLowerCase(),
        part_of_speech: pos.trim(),
        definition: def.trim(),
        etymology: etym.trim() || null,
      });
      setAddMsg(`"${w.trim()}" added to word bank.`);
      setW(''); setPos(''); setDef(''); setEtym('');
    } catch (err) {
      setAddError(err?.message || 'Could not add word.');
    } finally {
      setAddBusy(false);
    }
  };

  const onApprove = (id, word) => {
    Alert.alert(`Approve "${word}"?`, '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        onPress: async () => {
          try { await adminApi.adminApproveProposal(id); await loadAdminProposals(); } catch (e) { Alert.alert('Error', e.message || 'Failed'); }
        },
      },
    ]);
  };
  const onReject = (id, word) => {
    Alert.alert(`Reject "${word}"?`, '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject', style: 'destructive',
        onPress: async () => {
          try { await adminApi.adminRejectProposal(id); await loadAdminProposals(); } catch (e) { Alert.alert('Error', e.message || 'Failed'); }
        },
      },
    ]);
  };
  const onDeleteGroup = (g) => {
    Alert.alert(`Delete "${g.name}"?`, 'This deletes the group and all its data.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await adminApi.adminDeleteGroup(g.id); await loadAdminGroups(); } catch (e) { Alert.alert('Error', e.message || 'Failed'); }
        },
      },
    ]);
  };

  if (!adminAuthed) {
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <Text style={styles.title}>Admin</Text>
        <Text style={styles.body}>Enter the admin key to access tools.</Text>
        <TextInput
          style={styles.input}
          placeholder="Admin key"
          placeholderTextColor={COLORS.textMuted}
          value={keyInput}
          onChangeText={setKeyInput}
          secureTextEntry
          autoCapitalize="none"
          editable={!authBusy}
        />
        <ErrorBanner message={authError} style={{ marginTop: SPACING.sm }} />
        <Pressable style={[styles.btn, authBusy && { opacity: 0.5 }]} onPress={onAuth} disabled={authBusy}>
          <Text style={styles.btnText}>{authBusy ? 'Verifying…' : 'Continue'}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Admin</Text>
        <Pressable onPress={clearAdmin}><Text style={styles.signOut}>Sign out</Text></Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Add Word</Text>
        <TextInput style={styles.input} placeholder="Word" placeholderTextColor={COLORS.textMuted} value={w} onChangeText={setW} editable={!addBusy} autoCapitalize="none" />
        <TextInput style={styles.input} placeholder="Part of speech" placeholderTextColor={COLORS.textMuted} value={pos} onChangeText={setPos} editable={!addBusy} />
        <TextInput style={[styles.input, styles.multi]} placeholder="Definition" placeholderTextColor={COLORS.textMuted} value={def} onChangeText={setDef} multiline editable={!addBusy} />
        <TextInput style={[styles.input, styles.multi]} placeholder="Etymology (optional)" placeholderTextColor={COLORS.textMuted} value={etym} onChangeText={setEtym} multiline editable={!addBusy} />
        <ErrorBanner message={addError} style={{ marginTop: SPACING.sm }} />
        <SuccessBanner message={addMsg} style={{ marginTop: SPACING.sm }} />
        <Pressable style={[styles.btn, addBusy && { opacity: 0.5 }]} onPress={onAddWord} disabled={addBusy}>
          <Text style={styles.btnText}>{addBusy ? 'Adding…' : 'Add Word'}</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Proposed Words</Text>
      {proposals.length === 0 ? (
        <Text style={styles.body}>No pending proposals.</Text>
      ) : proposals.map((p) => (
        <View key={p.id} style={styles.card}>
          <Text style={styles.proposalTitle}>{p.word}</Text>
          <Text style={styles.proposalMeta}>{p.part_of_speech} · proposed by {p.proposer_display_name || 'unknown'}</Text>
          <Text style={styles.proposalDef}>{p.definition}</Text>
          {p.etymology ? <Text style={styles.proposalEtym}>Origin: {p.etymology}</Text> : null}
          <View style={styles.actionRow}>
            <Pressable style={[styles.btn, { flex: 1 }]} onPress={() => onApprove(p.id, p.word)}>
              <Text style={styles.btnText}>Approve</Text>
            </Pressable>
            <Pressable style={[styles.btnDanger, { flex: 1 }]} onPress={() => onReject(p.id, p.word)}>
              <Text style={styles.btnText}>Reject</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <Text style={styles.section}>All Groups</Text>
      {adminGroups.length === 0 ? <LoadingState /> : adminGroups.map((g) => (
        <View key={g.id} style={styles.card}>
          <Text style={styles.proposalTitle}>{g.name}</Text>
          <Text style={styles.proposalMeta}>{g.code} · {g.member_count} member{g.member_count === 1 ? '' : 's'}</Text>
          <Pressable style={styles.btnDanger} onPress={() => onDeleteGroup(g)}>
            <Text style={styles.btnText}>Delete</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACING.lg, paddingBottom: SPACING.xxl, backgroundColor: COLORS.background },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.lg },
  title: { fontSize: FONT_SIZES.title, fontWeight: '800', color: COLORS.text },
  body: { color: COLORS.textSecondary, marginBottom: SPACING.md, lineHeight: 22 },
  signOut: { color: COLORS.textMuted },
  section: { fontSize: FONT_SIZES.section, fontWeight: '700', color: COLORS.text, marginBottom: SPACING.sm, marginTop: SPACING.lg },
  card: { backgroundColor: COLORS.surface, borderRadius: RADII.lg, padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, marginBottom: SPACING.md, gap: SPACING.sm },
  input: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: RADII.md,
    padding: SPACING.md, fontSize: FONT_SIZES.body, color: COLORS.text, backgroundColor: COLORS.background,
  },
  multi: { minHeight: 64, textAlignVertical: 'top' },
  btn: { backgroundColor: COLORS.primary, borderRadius: RADII.lg, paddingVertical: SPACING.md, alignItems: 'center' },
  btnDanger: { backgroundColor: COLORS.dangerText, borderRadius: RADII.lg, paddingVertical: SPACING.md, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700' },
  actionRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  proposalTitle: { fontSize: FONT_SIZES.section, fontWeight: '800', color: COLORS.text },
  proposalMeta: { color: COLORS.textMuted, fontSize: FONT_SIZES.small },
  proposalDef: { color: COLORS.text, lineHeight: 20 },
  proposalEtym: { color: COLORS.textMuted, fontStyle: 'italic', fontSize: FONT_SIZES.small },
});
