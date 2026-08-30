// BuddiesScreen — accepted buddies + incoming/outgoing requests +
// add-by-search + ghost-player housekeeping. Unfriend routes through the
// shared ConfirmModal.

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Search, Users } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Input, Row, Screen, Skeleton, Text } from '../ui';
import AppHeader from '../components/AppHeader';
import BuddyRow from '../components/BuddyRow';
import EmptyState from '../components/EmptyState';
import { confirm } from '../components/ConfirmModal';
import api from '../api/client';
import GhostPlayersSection from './buddies/GhostPlayersSection';

export default function BuddiesScreen({ navigation }) {
  const [buddies, setBuddies] = useState(null);
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [ghosts, setGhosts] = useState([]);
  const [q, setQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const reload = useCallback(async () => {
    const [b, r, g] = await Promise.all([
      api.buddies().catch(() => []),
      api.buddyRequests().catch(() => ({ incoming: [], outgoing: [] })),
      api.ghostPlayers().catch(() => []),
    ]);
    setBuddies(b || []);
    setRequests(r || { incoming: [], outgoing: [] });
    setGhosts(g || []);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.searchProfiles(term).then((res) => setSearchResults(res || []), () => setSearchResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function act(id, fn) {
    setBusyId(id);
    try {
      await fn();
      await reload();
    } catch {}
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
    act(buddy.id, () => api.unfriend(buddy.id));
  }

  if (buddies === null) {
    return (
      <Screen pad={false} edges={{ top: false, bottom: false }} header={<AppHeader title="Buddies" onBack={() => navigation.goBack()} />}>
        <View style={{ padding: SPACING.lg, gap: SPACING.sm }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} height={56} radius={12} />
          ))}
        </View>
      </Screen>
    );
  }

  const buddyIds = new Set(buddies.map((b) => b.other_user_id));
  const pendingIds = new Set([...requests.incoming, ...requests.outgoing].map((r) => r.other_user_id));

  return (
    <Screen pad={false} edges={{ top: false, bottom: false }} header={<AppHeader title="Buddies" onBack={() => navigation.goBack()} />}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Row gap="sm" style={styles.searchRow}>
          <Search size={18} color={COLORS.textMuted} />
          <Input
            placeholder="Find people by name…"
            value={q}
            onChangeText={setQ}
            autoCorrect={false}
            style={{ flex: 1 }}
            inputStyle={styles.bareInput}
          />
        </Row>

        {searchResults.length > 0 ? (
          <Section title="Search results">
            {searchResults.map((p) => (
              <BuddyRow
                key={p.id}
                buddy={{ display_name: p.display_name, username: p.username, avatar: p.avatar }}
                relation={buddyIds.has(p.id) ? 'buddies' : pendingIds.has(p.id) ? 'outgoing' : 'add'}
                busy={busyId === p.id}
                onPress={() => navigation.navigate('ProfileOther', { userId: p.id })}
                onPrimary={() => act(p.id, () => api.sendBuddyRequest(p.id))}
              />
            ))}
          </Section>
        ) : null}

        {requests.incoming.length > 0 ? (
          <Section title={`Requests (${requests.incoming.length})`}>
            {requests.incoming.map((r) => (
              <BuddyRow
                key={r.id}
                buddy={r}
                relation="incoming"
                busy={busyId === r.id}
                onPress={() => navigation.navigate('ProfileOther', { userId: r.other_user_id })}
                onPrimary={() => act(r.id, () => api.acceptBuddy(r.id))}
                onSecondary={() => act(r.id, () => api.rejectBuddy(r.id))}
              />
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
              <BuddyRow
                key={b.id}
                buddy={b}
                relation="buddies"
                busy={busyId === b.id}
                onPress={() => navigation.navigate('ProfileOther', { userId: b.other_user_id })}
                onSecondary={() => unfriend(b)}
              />
            ))
          )}
        </Section>

        <GhostPlayersSection ghosts={ghosts} onChanged={reload} />
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text variant="heading" style={{ fontSize: 18, marginBottom: SPACING.xs }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: SPACING.lg, paddingBottom: 40 },
  searchRow: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  bareInput: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, minHeight: 44 },
  section: { marginTop: SPACING.xl },
});
