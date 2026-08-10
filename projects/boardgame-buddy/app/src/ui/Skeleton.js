// Loading shimmer blocks. Lists show skeletons in their real layout instead of
// a centered spinner, so loading never looks like an empty screen.

import React, { useEffect } from 'react';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated';
import { COLORS, RADII } from '../theme';

/**
 * @param {{ width?: number|string, height?: number, radius?: number, style?: any }} props
 */
export default function Skeleton({ width = '100%', height = 16, radius = RADII.sm, style }) {
  const pulse = useSharedValue(0.4);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [pulse]);
  const animStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View
      style={[{ width, height, borderRadius: radius, backgroundColor: COLORS.cardSoft }, animStyle, style]}
    />
  );
}
