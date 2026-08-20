// ImportExpansionsSheet — the "Import expansions" surface, native port of
// web/widgets/import-expansions-modal.js.
//
// Lists the expansions BoardGameGeek links to a base game that BgB hasn't
// imported yet (GET /games/{id}/expansions/available — already-imported rows
// are filtered server-side and each name has the base game's name stripped
// off the front). A + per row imports it into the catalog and links it to
// this base game; the row then leaves the list.
//
// The whole list arrives in one response, so the filter is purely
// client-side — no debounce, no second request. It matches the displayed
// name and BGG's full name (so typing the base game's name still hits).
//
// Opened from both surfaces that own expansions:
//   - screens/gameDetail/ExpansionsSection.js (game page)
//   - screens/play/GatherStep.js              (host Gather screen)
//
// Since expansions are hidden from game search, this is the only path by
// which one enters the catalog. Import is catalog-only — it never touches
// the caller's collection.
//
// Ref API: sheetRef.current.present()

import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Plus, RotateCcw, Search } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Button, Input, Row, Sheet, Skeleton, Text } from '../ui';
import { matchesExpansionQuery } from '../domain/expansionName';
import api from '../api/client';

/** Render `text` with the first case-insensitive hit on `q` emphasized. */
function Highlighted({ text, query }) {
  const raw = String(text ?? '');
  const q = (query || '').trim();
  if (!q) return <>{raw}</>;
  const i = raw.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{raw}</>;
  return (
    <>
      {raw.slice(0, i)}
      <Text variant="bodyMedium" color={COLORS.accent}>
        {raw.slice(i, i + q.length)}
      </Text>
      {raw.slice(i + q.length)}
    </>
  );
}

const ImportExpansionsSheet = forwardRef(function ImportExpansionsSheet({ gameId, gameName, onImported }, ref) {
  const sheetRef = useRef(null);
  const [candidates, setCandidates] = useState(null); // null = not loaded yet
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [rowErrors, setRowErrors] = useState({});
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!gameId) return;
    const seq = ++seqRef.current;
    setCandidates(null);
    setError(null);
    setQuery('');
    setRowErrors({});
    try {
      const list = await api.availableExpansions(gameId);
      if (seq !== seqRef.current) return; // superseded by a newer open
      setCandidates(Array.isArray(list) ? list : []);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e.message || "Couldn't reach BoardGameGeek.");
      setCandidates([]);
    }
  }, [gameId]);

  useImperativeHandle(
    ref,
    () => ({
      present() {
        sheetRef.current?.present();
        load();
      },
      dismiss() {
        sheetRef.current?.dismiss();
      },
    }),
    [load],
  );

  async function importOne(candidate) {
    setBusyId(candidate.bgg_id);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[candidate.bgg_id];
      return next;
    });
    try {
      const expansion = await api.importExpansion(gameId, candidate.bgg_id);
      // Drop just this row — a sibling row that failed keeps its error.
      setCandidates((prev) => (prev || []).filter((c) => c.bgg_id !== candidate.bgg_id));
      onImported?.(expansion);
    } catch (e) {
      // Fail this row only; the rest of the list stays usable.
      setRowErrors((prev) => ({ ...prev, [candidate.bgg_id]: e.message || 'Import failed — tap to retry.' }));
    }
    setBusyId(null);
  }

  const q = query.trim();
  const visible = (candidates || []).filter((c) => matchesExpansionQuery(q, c.name, c.full_name));
  const loaded = candidates !== null;
  const hasCandidates = loaded && candidates.length > 0;

  return (
    <Sheet ref={sheetRef} title="Import expansions" snap="75%">
      <Text variant="small" style={{ marginTop: -SPACING.sm, marginBottom: SPACING.md }}>
        {gameName ? `Expansions BoardGameGeek lists for ${gameName}.` : 'Expansions BoardGameGeek lists for this game.'}
      </Text>

      {hasCandidates ? (
        <Row gap="sm" style={styles.searchRow}>
          <Search size={16} color={COLORS.textMuted} />
          <Input
            bottomSheet
            placeholder="Filter expansions…"
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            style={{ flex: 1 }}
            inputStyle={styles.bareInput}
          />
        </Row>
      ) : null}

      {!loaded ? (
        <View style={{ gap: SPACING.sm, marginTop: SPACING.sm }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={44} radius={RADII.md} />
          ))}
        </View>
      ) : error ? (
        <View style={styles.state}>
          <Text variant="small" center color={COLORS.rustText}>
            {error}
          </Text>
          <Button label="Retry" variant="outline" size="sm" onPress={load} style={{ marginTop: SPACING.md }} />
        </View>
      ) : !hasCandidates ? (
        <View style={styles.state}>
          <Text variant="small" center>
            No new expansions to import — BoardgameBuddy already has every expansion BoardGameGeek lists for this
            game.
          </Text>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.state}>
          <Text variant="small" center>
            No expansion matches “{q}”.
          </Text>
        </View>
      ) : (
        <>
          {visible.map((c) => {
            const rowError = rowErrors[c.bgg_id];
            return (
              <View key={c.bgg_id} style={[styles.row, rowError && styles.rowError]}>
                <Row gap="sm">
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyMedium" numberOfLines={2}>
                      <Highlighted text={c.name} query={q} />
                    </Text>
                    {rowError ? (
                      <Text variant="caption" color={COLORS.rustText}>
                        {rowError}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => importOne(c)}
                    disabled={busyId === c.bgg_id}
                    hitSlop={8}
                    style={styles.addBtn}
                    accessibilityLabel={`Import ${c.name}`}
                  >
                    {busyId === c.bgg_id ? (
                      <ActivityIndicator size="small" color={COLORS.accent} />
                    ) : rowError ? (
                      <RotateCcw size={17} color={COLORS.accent} />
                    ) : (
                      <Plus size={18} color={COLORS.accent} />
                    )}
                  </Pressable>
                </Row>
              </View>
            );
          })}
          <Text variant="caption" style={{ marginTop: SPACING.md }}>
            Imported expansions join the BoardgameBuddy catalog. Your collection isn't changed.
          </Text>
        </>
      )}
    </Sheet>
  );
});

const styles = StyleSheet.create({
  searchRow: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.sm,
  },
  bareInput: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, minHeight: 40 },
  state: { paddingVertical: SPACING.xl, alignItems: 'center' },
  row: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingVertical: SPACING.sm,
    minHeight: 48,
    justifyContent: 'center',
  },
  rowError: { borderTopColor: COLORS.rust },
  addBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.accent + '88',
  },
});

export default ImportExpansionsSheet;
