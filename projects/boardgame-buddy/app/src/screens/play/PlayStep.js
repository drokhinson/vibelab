// PlayStep — scoring on top (RoundScoreGrid in host mode; joiner edits arrive
// live), reference display below. Co-op games swap the winner logic for a
// won/lost outcome bar.

import React, { useEffect } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { BookOpen, Trophy, Skull } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../../theme';
import { Button, Row, Text } from '../../ui';
import RoundScoreGrid from '../../widgets/RoundScoreGrid';
import ReferenceGuideScroll from '../../widgets/ReferenceGuideScroll';

export default function PlayStep({ session }) {
  const { draft, setRoundScore, addRound, removeRound, toggleWinner, resolvedScore, playerTotal, maxRoundCount } = session;

  // The grid needs at least one round row to type into.
  const rounds = maxRoundCount();
  useEffect(() => {
    if (draft && draft.phase === 'play' && rounds === 0 && draft.players.length > 0) addRound();
  }, [draft, rounds, addRound]);

  if (!draft) return null;
  const isCoop = draft.playMode === 'cooperative';
  const won = draft.players.length > 0 && draft.players.every((p) => p.is_winner);

  return (
    <View style={styles.wrap}>
      <Text variant="label">Scores</Text>
      {isCoop ? (
        <Row gap="sm">
          <Button
            label="We won!"
            icon={Trophy}
            variant={won ? 'primary' : 'outline'}
            size="sm"
            onPress={() => session.mutate((d) => d.players.forEach((p) => { p.is_winner = true; }))}
          />
          <Button
            label="The game won"
            icon={Skull}
            variant={!won ? 'secondary' : 'outline'}
            size="sm"
            onPress={() => session.mutate((d) => d.players.forEach((p) => { p.is_winner = false; }))}
          />
        </Row>
      ) : null}

      <RoundScoreGrid
        players={draft.players.map((p, i) => ({ key: `${p.name}-${i}`, name: p.name, user_id: p.user_id, avatar: p.avatar }))}
        rounds={Math.max(1, rounds)}
        getCell={(pi, ri) => {
          const v = resolvedScore(draft.players[pi], ri);
          // Preserve the in-progress "-" string from the local draft.
          const local = draft.players[pi].round_scores?.[ri];
          return local === '-' ? '-' : v == null ? '' : String(v);
        }}
        getTotal={(pi) => playerTotal(draft.players[pi])}
        isWinner={(pi) => !!draft.players[pi]?.is_winner}
        onSetCell={setRoundScore}
        onAddRound={addRound}
        onRemoveRound={removeRound}
        onToggleWinner={isCoop ? undefined : toggleWinner}
        editable
      />
      {!isCoop ? (
        <Text variant="caption" center>
          Tap a player's name to crown the winner — highest total is picked automatically.
        </Text>
      ) : null}

      <View style={{ marginTop: SPACING.lg, gap: SPACING.sm }}>
        <Text variant="label">Table reference</Text>
        {draft.game?.rulebook_url ? (
          <Button
            label="Open rulebook"
            icon={BookOpen}
            variant="outline"
            size="sm"
            onPress={() => Linking.openURL(draft.game.rulebook_url)}
            style={{ alignSelf: 'flex-start' }}
          />
        ) : null}
        {draft.game?.id ? (
          <ReferenceGuideScroll gameId={draft.game.id} expansionIds={draft.expansionIds || []} defaultOpen />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
});
