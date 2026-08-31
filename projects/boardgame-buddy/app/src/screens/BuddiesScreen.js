// BuddiesScreen — accepted buddies + incoming/outgoing requests + add-by-search.
// Mirrors web/views/buddies-view.js. All destructive actions (unfriend) route
// through the shared ConfirmModal.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Users } from 'lucide-react-native';
import { COLORS, FONTS, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import BuddyRow from '../components/BuddyRow';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import SearchField from '../components/SearchField';
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

  // Sending and cancelling paint first and reconcile behind — mirrors the
  // optimistic handlers in web/views/buddies-view.js. Awaiting the write and
  // then reloading both lists meant the row sat under a spinner for a full
  // round trip before anything moved.
  async function sendRequest(userId, person) {
    // A placeholder id until the echo brings the real edge id; the row's
    // Cancel stays inert for that window (see the `_pending` guard below).
    const temp = {
      id: `tmp:${userId}`,
      direction: 'outgoing',
      other_user_id: userId,
      other_display_name: (person && (person.display_name || person.other_display_name)) || 'Player',
      other_avatar: (person && (person.avatar || person.other_avatar)) || null,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setRequests((r) => ({ ...r, outgoing: [...r.outgoing, temp] }));
    try {
      const res = await api.sendBuddyRequest(userId);
      if (res && res.direction === 'incoming') {
        // Auto-accepted — they had already asked us, so we're buddies now.
        setRequests((r) => ({ ...r, outgoing: r.outgoing.filter((x) => x.id !== temp.id) }));
        await reload();
        return;
      }
      setRequests((r) => ({
        ...r,
        outgoing: r.outgoing.map((x) =>
          x.id === temp.id && res && res.id ? { ...x, id: res.id, _pending: false } : x),
      }));
    } catch {
      setRequests((r) => ({ ...r, outgoing: r.outgoing.filter((x) => x.id !== temp.id) }));
    }
  }
  // Withdraw a request we sent. One tap re-sends it, so it takes no confirm —
  // ConfirmModal is for the destructive gates (unfriend).
  async function cancelRequest(req) {
    if (req._pending) return;
    setRequests((r) => ({ ...r, outgoing: r.outgoing.filter((x) => x.id !== req.id) }));
    try {
      await api.cancelBuddyRequest(req.id);
    } catch {
      setRequests((r) => ({ ...r, outgoing: [...r.outgoing, req] }));
    }
  }
  async function accept(id) {
    setBusyId(id);
    try { await api.acceptBuddy(id); await reload(); } catch {}
    setBusyId(null);
  }
  async function reject(req) {
    setRequests((r) => ({ ...r, incoming: r.incoming.filter((x) => x.id !== req.id) }));
    try {
      await api.rejectBuddy(req.id);
    } catch {
      setRequests((r) => ({ ...r, incoming: [...r.incoming, req] }));
    }
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
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Find people by name…"
          clearLabel="Clear buddy search"
        />

        {searchResults.length > 0 ? (
          <Section title="Search results">
            {searchResults.map((p) => (
              <BuddyRow
                key={p.id}
                buddy={{ display_name: p.display_name, username: p.username, avatar: p.avatar }}
                relation={buddyIds.has(p.id) ? 'buddies' : pendingIds.has(p.id) ? 'outgoing' : 'add'}
                busy={busyId === p.id}
                onPress={() => navigation.navigate('ProfileOther', { userId: p.id })}
                onPrimary={() => sendRequest(p.id, p)}
              />
            ))}
          </Section>
        ) : null}

        {requests.incoming.length > 0 ? (
          <Section title={`Requests (${requests.incoming.length})`}>
            {requests.incoming.map((r) => (
              <BuddyRow key={r.id} buddy={r} relation="incoming" busy={busyId === r.id} onPress={() => navigation.navigate('ProfileOther', { userId: r.other_user_id })} onPrimary={() => accept(r.id)} onSecondary={() => reject(r)} />
            ))}
          </Section>
        ) : null}

        {requests.outgoing.length > 0 ? (
          <Section title="Sent">
            {requests.outgoing.map((r) => (
              <BuddyRow key={r.id} buddy={r} relation="outgoing" onPress={() => navigation.navigate('ProfileOther', { userId: r.other_user_id })} onSecondary={r._pending ? undefined : () => cancelRequest(r)} />
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
  section: { marginTop: SPACING.xl },
  sectionTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18, marginBottom: SPACING.xs },
});
