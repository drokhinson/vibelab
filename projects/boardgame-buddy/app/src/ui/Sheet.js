// Bottom-sheet wrapper around @gorhom/bottom-sheet. Focused data entry
// (filters, avatar editor, ghost linking) happens in sheets so dense display
// screens never host inline forms. Imperative: ref.present() / ref.dismiss().

import React, { forwardRef, useMemo } from 'react';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { COLORS, RADII, SPACING } from '../theme';
import Text from './Text';

const Sheet = forwardRef(function Sheet({ title, snap = '60%', children, onDismiss }, ref) {
  const snapPoints = useMemo(() => [snap], [snap]);
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      onDismiss={onDismiss}
      enablePanDownToClose
      // Keyboard-safe: the sheet resizes instead of letting the keyboard
      // cover its inputs.
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} />
      )}
      backgroundStyle={{ backgroundColor: COLORS.bgElevated, borderRadius: RADII.xl }}
      handleIndicatorStyle={{ backgroundColor: COLORS.textMuted }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ padding: SPACING.lg, paddingBottom: SPACING.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        {title ? (
          <Text variant="title" style={{ marginBottom: SPACING.lg }}>
            {title}
          </Text>
        ) : null}
        {children}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});

export default Sheet;
