// BuddiesScreen — accepted buddies + incoming/outgoing requests + add-by-search.
// Mirrors web/views/buddies-view.js. All destructive actions (unfriend) route
// through the shared ConfirmModal.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, Users } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import BuddyRow from '../components/BuddyRow';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import { confirm } from '../components/ConfirmModal';
import api from '../api/client';

export default function BuddiesScreen({ navigation }) {
  const [buddies, setBuddies] = useState(null);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [q, setQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const reload = useCallback(async () => {
    const [b, r] = await Promise.all([api.buddies().catch(() => []), api.buddyRequests().catch(() => ({ incoming: [], outgoing: [] }))]);
    setBuddies(b || []);
    setRequests(r || { incoming: [], outgoing: [] });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setSearchResults([]); return; }
    const t = setTimeout(() => {
      api.searchProfiles(term).then((res) => setSearchResults(res || []), () => setSearchResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function sendRequest(userId) {
    setBusyId(userId);
    try { await api.sendBuddyRequest(userId); await reload(); } catch {}
    setBusyId(null);
  }
  async function accept(id) {
    setBusyId(id);
    try { await api.acceptBuddy(id); await reload(); } catch {}
    setBusyId(null);
  }
  async function reject(id) {
    setBusyId(id);
    try { await api.rejectBuddy(id); await reload(); } catch {}
    setBusyId(null);
  }
  async function unfriend(buddy) {
    const ok = await confirm({
      title: `Remove ${buddy.other_display_name || 'this buddy'}?`,
      body: 'You can send a new request later. This removes the mutual connection.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(buddy.id);
    try { await api.unfriend(buddy.id); await reload(); } catch {}
    setBusyId(null);
  }

  if (buddies === null) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader title="Buddies" onBack={() => navigation.goBack()} />
        <LoadingState label="Loading buddies…" />
      </SafeAreaView>
    );
  }

  const buddyIds = new Set(buddies.map((b) => b.other_user_id));
  const pendingIds = new Set([...requests.incoming, ...requests.outgoing].map((r) => r.other_user_id));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title="Buddies" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.searchRow}>
          <Search size={18} color={COLORS.textMuted} />
          <TextInput style={styles.input} placeholder="Find people by name…" placeholderTextColor={COLORS.textMuted} value={q} onChangeText={setQ} autoCorrect={false} />
        </View>

        {searchResults.length > 0 ? (
          <Section title="Search results">
            {searchResults.map((p) => (
              <BuddyRow
                key={p.id}
                buddy={{ display_name: p.display_name, username: p.username, avatar: p.avatar }}
                relation={buddyIds.has(p.id) ? 'buddies' : pendingIds.has(p.id) ? 'outgoing' : 'add'}
                busy={busyId === p.id}
                onPress={() => navigation.navigate('ProfileOther', { userId: p.id })}
                onPrimary={() => sendRequest(p.id)}
              />
            ))}
          </Section>
        ) : null}

        {requests.incoming.length > 0 ? (
          <Section title={`Requests (${requests.incoming.length})`}>
            {requests.incoming.map((r) => (
              <BuddyRow key={r.id} buddy={r} relation="incoming" busy={busyId === r.id} onPress={() => navigation.navigate('ProfileOther', { userId: r.other_user_id })} onPrimary={() => accept(r.id)} onSecondary={() => reject(r.id)} />
            ))}
          </Section>
        ) : null}

        {requests.outgoing.length > 0 ? (
          <Section title="Sent">
            {requests.outgoing.map((r) => (
              <BuddyRow key={r.id} buddy={r} relation="outgoing" onPress={() => navigation.navigate('ProfileOther', { userId: r.other_user_id })} />
            ))}
          </Section>
        ) : null}

        <Section title={`Your buddies (${buddies.length})`}>
          {buddies.length === 0 ? (
            <EmptyState icon={Users} title="No buddies yet" body="Search for friends above to send a buddy request." />
          ) : (
            buddies.map((b) => (
              <BuddyRow key={b.id} buddy={b} relation="buddies" busy={busyId === b.id} onPress={() => navigation.navigate('ProfileOther', { userId: b.other_user_id })} onSecondary={() => unfriend(b)} />
            ))
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, backgroundColor: COLORS.card, borderRadius: RADII.md, paddingHorizontal: SPACING.md, borderWidth: 1, borderColor: COLORS.border },
  input: { flex: 1, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, paddingVertical: 11 },
  section: { marginTop: SPACING.xl },
  sectionTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18, marginBottom: SPACING.xs },
});
