// GameFinder — the one game-search surface (Search screen, Gather step,
// LogPlay quick-pick). Three tiers via domain/gameSearch:
//   1. your collection — instant, synchronous, works offline
//   2. the BGB catalog — debounced backend search
//   3. BoardGameGeek — explicit fallback that imports on pick
// Props: onPick(game, { source }), includeRecentlyPlayed, placeholder.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Search, Plus, Download, WifiOff } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Input, Row, Text } from '../ui';
import { useAppState } from '../store/AppContext';
import { searchLocal, searchRemote, resolveBggGame } from '../domain/gameSearch';
import GameTile from '../components/GameTile';

export default function GameFinder({ onPick, includeRecentlyPlayed = false, includeExpansions = false, placeholder = 'Search games…', autoFocus }) {
  const state = useAppState();
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState(null); // { results, bggResults, bggSearched }
  const [loading, setLoading] = useState(false);
  const [bggLoading, setBggLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [importing, setImporting] = useState(null);
  const seqRef = useRef(0);
  const timer = useRef(null);

  // Tier 1 — synchronous, recomputed every keystroke. Zero latency.
  const localHits = useMemo(
    () => searchLocal(q, { limit: 6, includeExpansions }),
    [q, includeExpansions],
  );
  const localIds = useMemo(() => new Set(localHits.map((g) => g.id)), [localHits]);

  const runRemote = useCallback(
    (term, includeBgg) => {
      const seq = ++seqRef.current;
      if (includeBgg) setBggLoading(true);
      else setLoading(true);
      searchRemote(term, { includeBgg, limit: 20, localIds }).then(
        (data) => {
          if (seq !== seqRef.current) return; // stale
          setRemote(data);
          setOffline(false);
          setLoading(false);
          setBggLoading(false);
        },
        () => {
          if (seq !== seqRef.current) return;
          // Network down — the local tier keeps working; say so instead of
          // failing silently.
          setOffline(true);
          setLoading(false);
          setBggLoading(false);
        },
      );
    },
    [localIds],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      seqRef.current++;
      setRemote(null);
      setLoading(false);
      setOffline(false);
      return;
    }
    timer.current = setTimeout(() => runRemote(term, false), 280);
    return () => timer.current && clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function importAndPick(bggHit) {
    setImporting(bggHit.bgg_id);
    try {
      const game = await resolveBggGame(bggHit.bgg_id);
      onPick && onPick(game, { source: 'bgg' });
    } catch {}
    setImporting(null);
  }

  const remoteHits = (remote?.results || []).map((r) => r.game || r);
  const bggHits = remote?.bggResults || [];
  const searching = q.trim().length >= 2;
  const showRecent = includeRecentlyPlayed && !searching && state.recentlyPlayedGames.length > 0;

  return (
    <View style={styles.wrap}>
      <Row gap="sm" style={styles.inputRow}>
        <Search size={18} color={COLORS.textMuted} />
        <Input
          placeholder={placeholder}
          value={q}
          onChangeText={setQ}
          autoFocus={autoFocus}
          autoCorrect={false}
          style={{ flex: 1 }}
          inputStyle={styles.bareInput}
        />
        {loading ? <ActivityIndicator color={COLORS.accent} /> : null}
      </Row>

      {showRecent ? (
        <>
          <Text variant="label">Recently played</Text>
          {state.recentlyPlayedGames.map((g) => (
            <ResultRow key={g.id} game={g} onPress={() => onPick && onPick(g, { source: 'recent' })} />
          ))}
        </>
      ) : null}

      {searching && localHits.length > 0 ? (
        <>
          <Text variant="label">In your collection</Text>
          {localHits.map((g) => (
            <ResultRow key={g.id} game={g} onPress={() => onPick && onPick(g, { source: 'collection' })} />
          ))}
        </>
      ) : null}

      {searching && remoteHits.length > 0 ? (
        <>
          {localHits.length > 0 ? <Text variant="label">More games</Text> : null}
          {remoteHits.map((g) => (
            <ResultRow key={g.id} game={g} onPress={() => onPick && onPick(g, { source: 'library' })} />
          ))}
        </>
      ) : null}

      {searching && offline ? (
        <Row gap="xs" justify="center" style={{ paddingVertical: SPACING.sm }}>
          <WifiOff size={13} color={COLORS.textMuted} />
          <Text variant="caption">Offline — showing your collection only</Text>
        </Row>
      ) : null}

      {searching && !offline ? (
        <View style={styles.bggSection}>
          {!remote?.bggSearched ? (
            <Pressable style={styles.bggBtn} onPress={() => runRemote(q.trim(), true)} disabled={bggLoading}>
              {bggLoading ? <ActivityIndicator color={COLORS.accent} /> : <Search size={15} color={COLORS.accent} />}
              <Text variant="bodyMedium" color={COLORS.accent}>
                Search BoardGameGeek
              </Text>
            </Pressable>
          ) : null}
          {bggHits.map((h) => (
            <Pressable key={h.bgg_id} style={styles.bggRow} onPress={() => importAndPick(h)} disabled={importing === h.bgg_id}>
              <View style={{ flex: 1 }}>
                <Text variant="bodyMedium" numberOfLines={1}>
                  {h.name}
                </Text>
                <Text variant="caption">
                  {[h.year_published, h.is_expansion ? 'expansion' : null].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {importing === h.bgg_id ? <ActivityIndicator color={COLORS.accent} /> : <Download size={18} color={COLORS.accent} />}
            </Pressable>
          ))}
          {remote?.bggSearched && !bggHits.length ? (
            <Text variant="caption" center style={{ paddingVertical: SPACING.sm }}>
              Nothing on BGG for “{q.trim()}”.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ResultRow({ game, onPress }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <GameTile game={game} variant="thumb" onPress={onPress} showStatus={false} />
      </View>
      <Plus size={20} color={COLORS.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
  inputRow: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  bareInput: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm },
  bggSection: { marginTop: SPACING.sm },
  bggBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.accent + '66',
    borderStyle: 'dashed',
  },
  bggRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm, minHeight: 44 },
});
