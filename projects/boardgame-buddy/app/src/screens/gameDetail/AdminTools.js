// AdminTools — admin-only affordances on game detail: set/clear the rulebook
// URL, refresh box art from BGG, override an expansion's dot color. Entry
// happens in a bottom sheet, keeping the detail screen display-only.

import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { Wrench, BookOpen, RefreshCw } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../../theme';
import { Button, Row, Text } from '../../ui';
import api from '../../api/client';
import { alert } from '../../components/ConfirmModal';

export default function AdminTools({ game, onChanged }) {
  const sheetRef = useRef(null);
  const [rulebookUrl, setRulebookUrl] = useState(game.rulebook_url || '');
  const [busy, setBusy] = useState(null);

  async function run(kind, fn) {
    setBusy(kind);
    try {
      await fn();
      onChanged && onChanged();
    } catch (e) {
      alert({ title: 'Admin action failed', body: e.message });
    }
    setBusy(null);
  }

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.openBtn} onPress={() => sheetRef.current?.present()}>
        <Wrench size={14} color={COLORS.textMuted} />
        <Text variant="caption">Admin tools</Text>
      </Pressable>

      <BottomSheetModal
        ref={sheetRef}
        snapPoints={['52%']}
        enablePanDownToClose
        keyboardBehavior="interactive"
        android_keyboardInputMode="adjustResize"
        backdropComponent={(p) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} />}
        backgroundStyle={{ backgroundColor: COLORS.bgElevated, borderRadius: RADII.xl }}
        handleIndicatorStyle={{ backgroundColor: COLORS.textMuted }}
      >
        <BottomSheetView style={styles.sheetBody}>
          <Text variant="title" style={{ marginBottom: SPACING.md }}>
            Admin · {game.name}
          </Text>

          <Row gap="xs" style={{ marginBottom: SPACING.xs }}>
            <BookOpen size={14} color={COLORS.textSoft} />
            <Text variant="caption">RULEBOOK URL</Text>
          </Row>
          <BottomSheetTextInput
            value={rulebookUrl}
            onChangeText={setRulebookUrl}
            placeholder="https://…  (empty clears)"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
            style={styles.input}
          />
          <Button
            label="Save rulebook URL"
            size="sm"
            busy={busy === 'rulebook'}
            onPress={() => run('rulebook', () => api.adminSetRulebookUrl(game.id, rulebookUrl.trim() || null))}
            style={{ marginTop: SPACING.sm, alignSelf: 'flex-start' }}
          />

          <Row gap="xs" style={{ marginTop: SPACING.lg, marginBottom: SPACING.xs }}>
            <RefreshCw size={14} color={COLORS.textSoft} />
            <Text variant="caption">BOX ART</Text>
          </Row>
          <Button
            label="Refresh images from BGG"
            variant="outline"
            size="sm"
            busy={busy === 'images'}
            onPress={() => run('images', () => api.adminRefreshGameImages(game.id))}
            style={{ alignSelf: 'flex-start' }}
          />

          {/* The expansion dot-colour override is gone: the backend dropped
              PATCH /games/admin/{id}/expansion-color. Colours are auto-assigned
              at import. */}
        </BottomSheetView>
      </BottomSheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  openBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: SPACING.md,
    paddingVertical: 8,
    minHeight: 36,
  },
  sheetBody: { padding: SPACING.lg, paddingBottom: SPACING.xxl },
  input: {
    backgroundColor: COLORS.bg,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: 11,
    color: COLORS.text,
    fontFamily: FONTS.sans,
    fontSize: 14,
  },
});
