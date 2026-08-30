// AdminScreen — moderation + catalog housekeeping: open chapter reports
// (resolve, optionally delete the chapter) and games with missing box art
// (per-game or bulk refresh from BGG).

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Flag, ImageOff, Trash2 } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Button, Row, Screen, Skeleton, Text } from '../ui';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import { alert as alertModal, confirm } from '../components/ConfirmModal';
import api from '../api/client';

export default function AdminScreen({ navigation }) {
  const [reports, setReports] = useState(null);
  const [missing, setMissing] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const reload = useCallback(async () => {
    const [r, m] = await Promise.all([
      api.adminChapterReports('open').catch(() => []),
      api.adminMissingImages().catch(() => []),
    ]);
    setReports(r || []);
    setMissing(m || []);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function resolve(report) {
    setBusyId(report.id);
    try {
      await api.adminResolveReport(report.id);
      await reload();
    } catch (e) {
      await alertModal({ title: 'Resolve failed', body: e.message });
    }
    setBusyId(null);
  }

  async function deleteChapter(report) {
    const ok = await confirm({
      title: 'Delete this chapter?',
      body: `“${report.chapter_title}” is removed from every player's guide. This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(report.id);
    try {
      await api.deleteChapter(report.chapter_id);
      await api.adminResolveReport(report.id).catch(() => {});
      await reload();
    } catch (e) {
      await alertModal({ title: 'Delete failed', body: e.message });
    }
    setBusyId(null);
  }

  async function refreshImage(game) {
    setBusyId(game.id);
    try {
      await api.adminRefreshGameImages(game.id);
      await reload();
    } catch (e) {
      await alertModal({ title: 'Refresh failed', body: e.message });
    }
    setBusyId(null);
  }

  async function refreshAll() {
    setBusyId('all');
    try {
      const r = await api.adminRefreshAllImages();
      await alertModal({ title: 'Refresh queued', body: `${r?.refreshed ?? 'All'} games refreshed.` });
      await reload();
    } catch (e) {
      await alertModal({ title: 'Refresh failed', body: e.message });
    }
    setBusyId(null);
  }

  const loading = reports === null || missing === null;

  return (
    <Screen pad={false} edges={{ top: false, bottom: false }} header={<AppHeader title="Admin tools" onBack={() => navigation.goBack()} />}>
      <ScrollView contentContainerStyle={styles.body}>
        {loading ? (
          <View style={{ gap: SPACING.sm }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={72} radius={12} />
            ))}
          </View>
        ) : (
          <>
            <Row gap="xs" style={{ marginBottom: SPACING.sm }}>
              <Flag size={16} color={COLORS.accent} />
              <Text variant="heading" style={{ fontSize: 18 }}>
                Chapter reports ({reports.length})
              </Text>
            </Row>
            {reports.length === 0 ? (
              <Text variant="small" style={{ marginBottom: SPACING.md }}>
                Nothing reported. The table is friendly today.
              </Text>
            ) : (
              reports.map((r) => (
                <View key={r.id} style={styles.card}>
                  <Text variant="bodyMedium">{r.chapter_title}</Text>
                  <Text variant="caption">
                    {r.game_name} · {r.chapter_type_label || r.chapter_type} · reported by {r.reporter_name || 'someone'}
                  </Text>
                  {r.reason ? (
                    <Text variant="small" style={{ marginTop: 4 }}>
                      “{r.reason}”
                    </Text>
                  ) : null}
                  <Text variant="small" color={COLORS.textMuted} numberOfLines={3} style={{ marginTop: SPACING.xs }}>
                    {r.chapter_content_preview}
                  </Text>
                  <Row gap="sm" justify="flex-end" style={{ marginTop: SPACING.sm }}>
                    <Button label="Delete chapter" variant="destructive" size="sm" icon={Trash2} onPress={() => deleteChapter(r)} busy={busyId === r.id} />
                    <Button label="Dismiss report" variant="outline" size="sm" onPress={() => resolve(r)} disabled={busyId === r.id} />
                  </Row>
                </View>
              ))
            )}

            <Row gap="xs" justify="space-between" style={{ marginTop: SPACING.lg, marginBottom: SPACING.sm }}>
              <Row gap="xs">
                <ImageOff size={16} color={COLORS.accent} />
                <Text variant="heading" style={{ fontSize: 18 }}>
                  Missing box art ({missing.length})
                </Text>
              </Row>
              {missing.length > 0 ? (
                <Button label="Refresh all" variant="secondary" size="sm" onPress={refreshAll} busy={busyId === 'all'} />
              ) : null}
            </Row>
            {missing.length === 0 ? (
              <Text variant="small">Every game has its art.</Text>
            ) : (
              missing.map((g) => (
                <Row key={g.id} gap="md" style={styles.gameRow}>
                  <View style={{ flex: 1 }}>
                    <GameTile
                      game={g}
                      variant="thumb"
                      showStatus={false}
                      onPress={() => navigation.navigate('GameDetail', { gameId: g.id, gameName: g.name })}
                    />
                  </View>
                  <Button label="Refresh" variant="outline" size="sm" onPress={() => refreshImage(g)} busy={busyId === g.id} />
                </Row>
              ))
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: SPACING.lg, paddingBottom: 40 },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    marginBottom: SPACING.sm,
  },
  gameRow: { paddingVertical: SPACING.xs, minHeight: 56 },
});
