// SettleStep — entry-only wrap-up: date, photo, key moments. Save lives in
// the cascade FooterBar. Photo is resized in-place (~1600px / 0.8 jpeg) and
// kept in memory on the draft; upload happens after the play is saved.

import React from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Camera, X } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../../theme';
import { Input, Row, Text } from '../../ui';
import UserBadge from '../../components/UserBadge';

export default function SettleStep({ session }) {
  const { draft, mutate, playerTotal } = session;
  if (!draft) return null;

  async function pickPhoto() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      const resized = await ImageManipulator.manipulateAsync(
        asset.uri,
        [{ resize: { width: 1600 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
      );
      mutate((d) => {
        d.photo = { uri: resized.uri, name: 'play.jpg', type: 'image/jpeg' };
      });
    } catch {}
  }

  const winners = draft.players.filter((p) => p.is_winner);

  return (
    <View style={styles.wrap}>
      {/* Result recap — display only, edits happen back on the Play step. */}
      <View style={styles.recap}>
        {winners.length ? (
          <Row gap="sm" wrap justify="center">
            {winners.map((p, i) => (
              <Row key={i} gap="xs">
                <UserBadge avatar={p.avatar} displayName={p.name} size="xs" isGhost={!p.user_id} />
                <Text variant="polaroid" color={COLORS.polaroidAccent}>
                  {p.name} · {playerTotal(p)}
                </Text>
              </Row>
            ))}
          </Row>
        ) : (
          <Text variant="polaroidItalic" center>
            No winner crowned yet — that's fine too.
          </Text>
        )}
      </View>

      <Input
        label="Played on"
        value={draft.playedAt || new Date().toISOString().slice(0, 10)}
        onChangeText={(v) => mutate((d) => { d.playedAt = v; })}
        placeholder="YYYY-MM-DD"
      />

      <Text variant="caption" style={{ marginTop: SPACING.sm }}>
        TABLE PHOTO
      </Text>
      {draft.photo ? (
        <View>
          <Image source={{ uri: draft.photo.uri }} style={styles.photo} resizeMode="cover" />
          <Pressable style={styles.clearPhoto} onPress={() => mutate((d) => { d.photo = null; })} hitSlop={8}>
            <X size={16} color={COLORS.polaroidBg} />
          </Pressable>
        </View>
      ) : (
        <Pressable style={styles.photoPick} onPress={pickPhoto}>
          <Camera size={22} color={COLORS.textSoft} />
          <Text variant="small">Tap to add a photo (optional)</Text>
        </Pressable>
      )}

      <Input
        label="Key moments"
        value={draft.notes || ''}
        onChangeText={(v) => mutate((d) => { d.notes = v; })}
        placeholder="A clutch play, a surprise comeback, anything worth remembering."
        multiline
        inputStyle={{ minHeight: 90, textAlignVertical: 'top' }}
        style={{ marginTop: SPACING.sm }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
  recap: {
    backgroundColor: COLORS.polaroidBg,
    borderRadius: RADII.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.polaroidLine,
  },
  photo: { width: '100%', height: 200, borderRadius: RADII.md },
  clearPhoto: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPick: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: SPACING.xl,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.border,
  },
});
