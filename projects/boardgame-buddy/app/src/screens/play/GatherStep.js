// GatherStep — entry-only surface: invite code, game pick, play mode,
// expansions, player list. No dense data display here (D6); Continue lives in
// the cascade FooterBar.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { ArrowUpRight, Dice6, Plus, Search, Share2, UserPlus, WifiOff, X } from 'lucide-react-native';
import { COLORS, RADII, SPACING, gameAccent } from '../../theme';
import { Button, Card, Input, Row, Text } from '../../ui';
import UserBadge from '../../components/UserBadge';
import GameFinder from '../../widgets/GameFinder';
import ImportExpansionsSheet from '../../widgets/ImportExpansionsSheet';
import { matchesExpansionQuery, stripBaseGameName } from '../../domain/expansionName';
import { PLAY_MODES, PLAY_MODE_LABELS } from '../../domain/playMode';
import api from '../../api/client';
import { useAppState } from '../../store/AppContext';

// Past this many expansions the list gets a filter field above it.
const EXPANSION_FILTER_THRESHOLD = 5;

const MODES = PLAY_MODES.map((key) => ({ key, label: PLAY_MODE_LABELS[key] }));

export default function GatherStep({ session, navigation }) {
  const { playPartners } = useAppState();
  const { draft, lobby, mutate, pickGame, addPlayer, removePlayer } = session;
  const [playerInput, setPlayerInput] = useState('');
  const [expansions, setExpansions] = useState([]);
  const [expansionQuery, setExpansionQuery] = useState('');
  const [pickError, setPickError] = useState('');
  const importRef = useRef(null);

  const game = draft?.game;

  const visibleExpansions = useMemo(
    () =>
      expansions.filter((e) => matchesExpansionQuery(expansionQuery, stripBaseGameName(e.name, game?.name), e.name)),
    [expansions, expansionQuery, game?.name],
  );

  // Every expansion linked to this base game — not just the enabled ones.
  // The host picks which were in THIS play; a freshly imported one has to
  // show up here immediately.
  const loadExpansions = useCallback(async () => {
    // A filter typed for the previous pick would silently hide everything.
    setExpansionQuery('');
    if (!game?.id || game.is_expansion) {
      setExpansions([]);
      return;
    }
    try {
      const rows = await api.expansions(game.id);
      setExpansions(Array.isArray(rows) ? rows : []);
    } catch {
      setExpansions([]);
    }
  }, [game?.id, game?.is_expansion]);

  useEffect(() => {
    loadExpansions();
  }, [loadExpansions]);

  // A session's main game is always a base game. /search excludes expansions
  // from every source, but the recently-played seed isn't filtered — a host
  // who once logged an expansion as the main game can still surface one.
  function handlePick(picked, ctx) {
    if (picked?.is_expansion) {
      setPickError('Pick a base game — expansions attach in the Expansions card.');
      return;
    }
    setPickError('');
    pickGame(picked, ctx);
  }

  const suggestions = useMemo(() => {
    const q = playerInput.trim().toLowerCase();
    const taken = new Set((draft?.players || []).map((p) => p.name.toLowerCase()));
    const pool = [
      ...(playPartners.accounts || []).map((b) => ({
        name: b.other_display_name || b.display_name,
        user_id: b.other_user_id || b.user_id,
        avatar: b.other_avatar || b.avatar || null,
        kind: 'buddy',
      })),
      ...(playPartners.recent || []).map((u) => ({ name: u.display_name, user_id: u.user_id || u.id, avatar: u.avatar || null, kind: 'recent' })),
      ...(playPartners.ghosts || []).map((g) => ({ name: g.display_name, user_id: null, avatar: null, kind: 'ghost' })),
    ];
    const seen = new Set();
    return pool
      .filter((c) => c.name && !taken.has(c.name.toLowerCase()))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .filter((c) => {
        const k = c.name.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 5);
  }, [playerInput, playPartners, draft?.players]);

  function submitFreeText() {
    if (!playerInput.trim()) return;
    addPlayer({ name: playerInput });
    setPlayerInput('');
  }

  if (!draft) return null;

  return (
    <View style={styles.wrap}>
      {/* Invite — or the offline-table notice when no lobby could be opened */}
      {draft.offlineTable ? (
        <Card pad="md">
          <Row gap="md">
            <WifiOff size={20} color={COLORS.textSoft} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyMedium">Offline table</Text>
              <Text variant="caption">
                No connection — scores stay on this phone and the play uploads when you're back online. Add
                everyone as players below.
              </Text>
            </View>
          </Row>
        </Card>
      ) : (
        <Card pad="md">
          <Row justify="space-between">
            <View>
              <Text variant="caption">INVITE CODE</Text>
              <Text variant="scoreBig" color={COLORS.accent} style={{ letterSpacing: 4, fontSize: 26 }}>
                {lobby?.code || draft.code || '·····'}
              </Text>
            </View>
            <Pressable
              style={styles.shareBtn}
              onPress={() =>
                Share.share({ message: `Join my game on Boardgame Buddy — code ${lobby?.code || draft.code}` }).catch(() => {})
              }
              hitSlop={6}
            >
              <Share2 size={18} color={COLORS.accent} />
            </Pressable>
          </Row>
          <Text variant="caption" style={{ marginTop: 4 }}>
            Buddies can join from the Play tab and type their own scores.
          </Text>
        </Card>
      )}

      {/* Game */}
      <Text variant="label" style={styles.sectionLabel}>
        Game
      </Text>
      {game ? (
        <Card pad="md">
          <Row gap="md">
            {game.thumbnail_url ? (
              <Image source={{ uri: game.thumbnail_url }} style={styles.gameThumb} />
            ) : (
              <View style={[styles.gameThumb, { backgroundColor: gameAccent(game) + '33', alignItems: 'center', justifyContent: 'center' }]}>
                <Dice6 size={22} color={gameAccent(game)} />
              </View>
            )}
            <Text variant="heading" numberOfLines={2} style={{ flex: 1 }}>
              {game.name}
            </Text>
            <Pressable onPress={() => navigation.navigate('GameDetail', { gameId: game.id, gameName: game.name })} hitSlop={8} style={styles.chipBtn}>
              <ArrowUpRight size={16} color={COLORS.textSoft} />
            </Pressable>
            <Pressable onPress={() => mutate((d) => { d.game = null; d.expansionIds = []; })} hitSlop={8} style={styles.chipBtn}>
              <X size={16} color={COLORS.textSoft} />
            </Pressable>
          </Row>
        </Card>
      ) : (
        <>
          <GameFinder onPick={handlePick} includeRecentlyPlayed placeholder="Search your shelf, BGB, or BGG…" />
          {pickError ? (
            <Text variant="small" color={COLORS.rustText}>
              {pickError}
            </Text>
          ) : null}
        </>
      )}

      {/* Mode */}
      <Text variant="label" style={styles.sectionLabel}>
        Scoring style
      </Text>
      <Row gap="xs">
        {MODES.map((m) => (
          <Pressable
            key={m.key}
            onPress={() => mutate((d) => { d.playMode = m.key; })}
            style={[styles.modePill, draft.playMode === m.key && styles.modePillOn]}
          >
            <Text variant="bodyMedium" style={{ fontSize: 13 }} color={draft.playMode === m.key ? COLORS.bg : COLORS.textSoft}>
              {m.label}
            </Text>
          </Pressable>
        ))}
      </Row>

      {/* Expansions — shown for any base game, even with none imported yet:
          expansions are hidden from search, so importing here is the only
          way to attach one mid-setup. */}
      {game && !game.is_expansion ? (
        <>
          <Text variant="label" style={styles.sectionLabel}>
            Expansions in this play
          </Text>

          {expansions.length === 0 ? (
            <Text variant="caption">No expansions in BoardgameBuddy yet.</Text>
          ) : (
            <>
              {/* Past a handful, a filter beats scrolling — matched against
                  both the shortened label and the stored name, so typing the
                  base game's name still hits. */}
              {expansions.length > EXPANSION_FILTER_THRESHOLD ? (
                <Row gap="sm" style={styles.expFilterRow}>
                  <Search size={15} color={COLORS.textMuted} />
                  <Input
                    placeholder="Filter expansions…"
                    value={expansionQuery}
                    onChangeText={setExpansionQuery}
                    autoCorrect={false}
                    style={{ flex: 1 }}
                    inputStyle={styles.bareFilterInput}
                  />
                  {expansionQuery ? (
                    <Pressable onPress={() => setExpansionQuery('')} hitSlop={8} style={styles.filterClear}>
                      <X size={14} color={COLORS.textMuted} />
                    </Pressable>
                  ) : null}
                </Row>
              ) : null}

              {visibleExpansions.length === 0 ? (
                <Text variant="caption">No expansion matches “{expansionQuery.trim()}”.</Text>
              ) : (
                // Capped so a big expansion list can't push the rest of the
                // cascade off screen; the cap leaves a sliver of the next row
                // showing so it reads as scrollable.
                <ScrollView
                  style={styles.expScroll}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                >
                  <Row gap="xs" wrap>
                    {visibleExpansions.map((exp) => {
                      const on = (draft.expansionIds || []).includes(exp.expansion_game_id);
                      return (
                        <Pressable
                          key={exp.expansion_game_id}
                          onPress={() =>
                            mutate((d) => {
                              d.expansionIds = on
                                ? d.expansionIds.filter((id) => id !== exp.expansion_game_id)
                                : [...(d.expansionIds || []), exp.expansion_game_id];
                            })
                          }
                          style={[styles.expChip, on && { borderColor: exp.color || COLORS.accent, backgroundColor: (exp.color || COLORS.accent) + '22' }]}
                        >
                          {exp.color ? <View style={[styles.expDot, { backgroundColor: exp.color }]} /> : null}
                          <Text variant="small" color={on ? COLORS.text : COLORS.textMuted}>
                            {stripBaseGameName(exp.name, game.name)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </Row>
                </ScrollView>
              )}
            </>
          )}

          {/* Below the scroll box, so it stays reachable however far down
              the list you are. */}
          <Button
            label="Import expansions"
            icon={Plus}
            variant="outline"
            size="sm"
            onPress={() => importRef.current?.present()}
            style={{ alignSelf: 'flex-start', marginTop: SPACING.xs }}
          />
          <ImportExpansionsSheet
            ref={importRef}
            gameId={game.id}
            gameName={game.name}
            onImported={loadExpansions}
          />
        </>
      ) : null}

      {/* Players */}
      <Text variant="label" style={styles.sectionLabel}>
        Players ({draft.players.length})
      </Text>
      {draft.players.map((p, i) => (
        <Row key={`${p.name}-${i}`} gap="md" style={styles.playerRow}>
          <UserBadge avatar={p.avatar} displayName={p.name} size="sm" isGhost={!p.user_id} />
          <Text variant="bodyMedium" style={{ flex: 1 }} numberOfLines={1}>
            {p.name}
            {p.user_id ? '' : '  ·  guest'}
          </Text>
          {draft.playMode === 'team' ? (
            <Input
              placeholder="team"
              value={p.team || ''}
              onChangeText={(v) => mutate((d) => { d.players[i].team = v; })}
              style={{ width: 88 }}
              inputStyle={{ minHeight: 36, paddingVertical: 6, fontSize: 13 }}
            />
          ) : null}
          <Pressable onPress={() => removePlayer(i)} hitSlop={10} style={styles.chipBtn}>
            <X size={16} color={COLORS.textMuted} />
          </Pressable>
        </Row>
      ))}

      <Row gap="sm" style={{ marginTop: SPACING.xs }}>
        <Input
          placeholder="Add a player…"
          value={playerInput}
          onChangeText={setPlayerInput}
          onSubmitEditing={submitFreeText}
          autoCorrect={false}
          style={{ flex: 1 }}
        />
        <Pressable style={styles.addBtn} onPress={submitFreeText} hitSlop={6}>
          <UserPlus size={18} color={COLORS.bg} />
        </Pressable>
      </Row>
      {suggestions.map((c) => (
        <Pressable
          key={c.name}
          style={styles.suggestRow}
          onPress={() => {
            addPlayer({ name: c.name, user_id: c.user_id, avatar: c.avatar });
            setPlayerInput('');
          }}
        >
          <UserBadge avatar={c.avatar} displayName={c.name} size="xs" isGhost={!c.user_id} />
          <Text variant="body" style={{ flex: 1 }}>
            {c.name}
          </Text>
          <Text variant="caption">{c.kind === 'buddy' ? 'buddy' : c.kind === 'recent' ? 'played with' : 'guest'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
  sectionLabel: { marginTop: SPACING.md },
  shareBtn: {
    width: 44,
    height: 44,
    borderRadius: RADII.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent + '1c',
  },
  gameThumb: { width: 52, height: 52, borderRadius: RADII.sm },
  chipBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  modePill: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 8,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    minHeight: 36,
  },
  modePillOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  expFilterRow: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.xs,
  },
  bareFilterInput: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, minHeight: 38 },
  filterClear: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  // ~4 chip rows plus a sliver of the next, so the box reads as scrollable.
  expScroll: { maxHeight: 168 },
  expChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 7,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    minHeight: 34,
  },
  expDot: { width: 8, height: 8, borderRadius: 4 },
  playerRow: { paddingVertical: 6, minHeight: 44 },
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: RADII.md,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 8,
    paddingHorizontal: SPACING.sm,
    minHeight: 44,
  },
});
