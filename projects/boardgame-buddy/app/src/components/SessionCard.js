// SessionCard — the canonical render for a joinable/live Session. Used on the
// Play tab's joinable list and anywhere a live session is surfaced. Shows the
// host badge, game, phase chip, and participant count; tap joins/opens.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Users, Radio } from 'lucide-react-native';
import { COLORS, RADII, SPACING, gameAccent } from '../theme';
import { Card, Row, Stack, Text } from '../ui';
import UserBadge from './UserBadge';

const PHASE_LABEL = {
  gather: 'Gathering',
  play: 'In play',
  settle: 'Wrapping up',
};

/**
 * @param {Object} props
 * @param {Object} props.session  JoinableSession shape
 * @param {() => void} [props.onPress]
 */
export default function SessionCard({ session, onPress, style }) {
  const game = session.game;
  const phase = PHASE_LABEL[session.phase] || session.phase;
  const joinable = session.phase === 'gather';
  return (
    <Card onPress={onPress} pad="md" style={style}>
      <Row gap="md">
        <UserBadge avatar={session.host_avatar} displayName={session.host_display_name} size="md" />
        <Stack gap={2} style={{ flex: 1 }}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {session.host_display_name}
            <Text variant="small"> is hosting</Text>
          </Text>
          <Text variant="heading" numberOfLines={1} color={game ? gameAccent(game) : COLORS.textSoft}>
            {game?.name || 'Picking a game…'}
          </Text>
        </Stack>
        <Stack gap={4} align="flex-end">
          <View style={[styles.phaseChip, joinable && styles.phaseLive]}>
            <Radio size={10} color={joinable ? COLORS.success : COLORS.textMuted} />
            <Text variant="caption" color={joinable ? COLORS.success : COLORS.textMuted}>
              {phase}
            </Text>
          </View>
          <Row gap={3}>
            <Users size={12} color={COLORS.textMuted} />
            <Text variant="caption">{session.participant_count}</Text>
          </Row>
        </Stack>
      </Row>
    </Card>
  );
}

const styles = StyleSheet.create({
  phaseChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.bgElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  phaseLive: { borderColor: COLORS.success },
});
