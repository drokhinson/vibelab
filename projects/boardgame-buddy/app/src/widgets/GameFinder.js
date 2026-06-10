// GameFinder — search input + results: library/collection hits first, then a
// "Search BoardGameGeek" fallback that imports a game on tap. Debounced with a
// stale-response guard. Ported from web/widgets/game-finder.js.
// Props: onPick(game, { source }), includeRecentlyPlayed, placeholder.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Search, Plus, Download } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState } from '../store/AppContext';
import api from '../api/client';
import GameTile from '../components/GameTile';

export default function GameFinder({ onPick, includeRecentlyPlayed = false, placeholder = 'Search games…', autoFocus }) {
  const state = useAppState();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null); // {results, bgg_results}
  const [loading, setLoading] = useState(false);
  const [bggLoading, setBggLoading] = useState(false);
  const [importing, setImporting] = useState(null);
  const seqRef = useRef(0);
  const timer = useRef(null);

  const runSearch = useCallback((term, includeBgg) => {
    const seq = ++seqRef.current;
    if (includeBgg) setBggLoading(true);
    else setLoading(true);
    api.search(term, { includeBgg, limit: 20 }).then(
      (data) => {
        if (seq !== seqRef.current) return; // stale
        setResults(data);
        setLoading(false);
        setBggLoading(false);
      },
      () => {
        if (seq !== seqRef.current) return;
        setLoading(false);
        setBggLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      seqRef.current++;
      setResults(null);
      setLoading(false);
      return;
    }
    timer.current = setTimeout(() => runSearch(term, false), 280);
    return () => timer.current && clearTimeout(timer.current);
  }, [q, runSearch]);

  async function importAndPick(bggHit) {
    setImporting(bggHit.bgg_id);
    try {
      const game = await api.importBgg(bggHit.bgg_id);
      onPick && onPick(game, { source: 'bgg' });
    } catch {}
    setImporting(null);
  }

  const libraryHits = (results && results.results) || [];
  const bggHits = (results && results.bgg_results) || [];
  const showRecent = includeRecentlyPlayed && q.trim().length < 2 && state.recentlyPlayedGames.length > 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <Search size={18} color={COLORS.textMuted} />
        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={COLORS.textMuted}
          value={q}
          onChangeText={setQ}
          autoFocus={autoFocus}
          autoCorrect={false}
        />
        {loading ? <ActivityIndicator color={COLORS.accent} /> : null}
      </View>

      {showRecent ? (
        <>
          <Text style={styles.sectionLabel}>Recently played</Text>
          {state.recentlyPlayedGames.map((g) => (
            <ResultRow key={g.id} game={g} onPress={() => onPick && onPick(g, { source: 'recent' })} />
          ))}
        </>
      ) : null}

      {libraryHits.map((g) => (
        <ResultRow key={g.id} game={g} onPress={() => onPick && onPick(g, { source: 'library' })} />
      ))}

      {q.trim().length >= 2 ? (
        <View style={styles.bggSection}>
          {!results || !results.bgg_searched ? (
            <Pressable style={styles.bggBtn} onPress={() => runSearch(q.trim(), true)} disabled={bggLoading}>
              {bggLoading ? <ActivityIndicator color={COLORS.accent} /> : <Search size={15} color={COLORS.accent} />}
              <Text style={styles.bggBtnLabel}>Search BoardGameGeek</Text>
            </Pressable>
          ) : null}
          {bggHits.map((h) => (
            <Pressable key={h.bgg_id} style={styles.bggRow} onPress={() => importAndPick(h)} disabled={importing === h.bgg_id}>
              <View style={{ flex: 1 }}>
                <Text style={styles.bggName} numberOfLines={1}>{h.name}</Text>
                <Text style={styles.bggMeta}>{[h.year_published, h.is_expansion ? 'expansion' : null].filter(Boolean).join(' · ')}</Text>
              </View>
              {importing === h.bgg_id ? <ActivityIndicator color={COLORS.accent} /> : <Download size={18} color={COLORS.accent} />}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ResultRow({ game, onPress }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <GameTile game={game} variant="thumb" onPress={onPress} showStatus={false} />
      <Plus size={20} color={COLORS.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, backgroundColor: COLORS.card, borderRadius: RADII.md, paddingHorizontal: SPACING.md, borderWidth: 1, borderColor: COLORS.border },
  input: { flex: 1, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, paddingVertical: 11 },
  sectionLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: SPACING.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.md, paddingVertical: SPACING.sm },
  bggSection: { marginTop: SPACING.sm },
  bggBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: RADII.md, borderWidth: 1, borderColor: COLORS.accent + '66', borderStyle: 'dashed' },
  bggBtnLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.accent, fontSize: 14 },
  bggRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm },
  bggName: { fontFamily: FONTS.sansSemibold, color: COLORS.text, fontSize: 14 },
  bggMeta: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 12, marginTop: 1 },
});
