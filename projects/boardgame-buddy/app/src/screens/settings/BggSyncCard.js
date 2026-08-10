// BggSyncCard — link/unlink a BoardGameGeek account and run syncs with live
// "Importing X of Y" progress (2s status poll while a session is running).
// A finished sync refreshes the offline collection store so the shelf and
// game search pick up the imports immediately.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Link2, RefreshCw } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../../theme';
import { Button, Input, Row, Text } from '../../ui';
import { alert as alertModal, confirm } from '../../components/ConfirmModal';
import api from '../../api/client';
import cache from '../../store/cache';
import { refreshCollection } from '../../offline/collectionStore';

export default function BggSyncCard() {
  const [status, setStatus] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.bggStatus());
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    return () => pollRef.current && clearInterval(pollRef.current);
  }, [refresh]);

  function startPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.bggStatus();
        setStatus(s);
        if (s.session_total > 0 && s.session_done + s.session_errored >= s.session_total) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // Imports landed — the offline shelf and grids must not go stale.
          cache.invalidate('collection');
          refreshCollection();
        }
      } catch {}
    }, 2000);
  }

  async function link() {
    if (!username.trim() || !password) return;
    setBusy(true);
    try {
      await api.bggLink(username.trim(), password);
      setPassword('');
      await refresh();
    } catch (e) {
      await alertModal({ title: 'Link failed', body: e.message });
    }
    setBusy(false);
  }

  async function sync() {
    setBusy(true);
    try {
      const summary = await api.bggSync();
      if (summary.warm_up_retry_pending) {
        await alertModal({ title: 'BGG is warming up', body: 'BoardGameGeek is still preparing your data — try again in a minute.' });
      }
      startPoll();
      await refresh();
      cache.invalidate('collection');
      refreshCollection();
    } catch (e) {
      await alertModal({ title: 'Sync failed', body: e.message });
    }
    setBusy(false);
  }

  async function processPending() {
    setBusy(true);
    try {
      await api.bggProcessPending();
      startPoll();
    } catch (e) {
      await alertModal({ title: 'Import failed', body: e.message });
    }
    setBusy(false);
  }

  async function unlink() {
    const ok = await confirm({
      title: 'Unlink BoardGameGeek?',
      body: 'Your imported games stay; future syncs stop.',
      confirmLabel: 'Unlink',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.bggUnlink();
      await refresh();
    } catch {}
  }

  const linked = status && status.auth_state && status.auth_state !== 'unlinked';
  const importing = status && status.session_total > 0 && status.session_done + status.session_errored < status.session_total;

  return (
    <View>
      {status?.auth_state === 'relink_required' ? (
        <Text variant="small" color={COLORS.rustText} style={{ marginBottom: SPACING.sm }}>
          Your BGG login expired — re-link to sync again.
        </Text>
      ) : null}

      {linked ? (
        <View style={{ gap: SPACING.sm }}>
          <Text variant="bodyMedium">Linked as {status.bgg_username}</Text>
          {importing ? (
            <View style={{ gap: 4 }}>
              <Text variant="score" color={COLORS.accent} style={{ fontSize: 13 }}>
                Importing {status.session_done} of {status.session_total}…
              </Text>
              <View style={{ height: 6, backgroundColor: COLORS.bgElevated, borderRadius: RADII.pill, overflow: 'hidden' }}>
                <View
                  style={{
                    height: 6,
                    width: `${Math.round((status.session_done / Math.max(1, status.session_total)) * 100)}%`,
                    backgroundColor: COLORS.accent,
                  }}
                />
              </View>
              {status.session_game_names?.length ? (
                <Text variant="caption" numberOfLines={1}>
                  Latest: {status.session_game_names[0]}
                </Text>
              ) : null}
            </View>
          ) : null}
          <Row gap="sm">
            <Button label="Sync now" icon={RefreshCw} variant="secondary" size="sm" onPress={sync} busy={busy} disabled={!!importing} />
            {!importing && status.pending_count > 0 ? (
              <Button label={`Import ${status.pending_count} pending`} variant="outline" size="sm" onPress={processPending} disabled={busy} />
            ) : null}
            <Button label="Unlink" variant="outline" size="sm" onPress={unlink} />
          </Row>
        </View>
      ) : (
        <View style={{ gap: SPACING.sm }}>
          <Text variant="small" style={{ lineHeight: 19 }}>
            Link your BGG account to import your collection and play history.
          </Text>
          <Input value={username} onChangeText={setUsername} placeholder="BGG username" autoCapitalize="none" autoCorrect={false} />
          <Input value={password} onChangeText={setPassword} placeholder="BGG password" secureTextEntry />
          <Button label="Link account" icon={Link2} onPress={link} busy={busy} full />
        </View>
      )}
    </View>
  );
}
