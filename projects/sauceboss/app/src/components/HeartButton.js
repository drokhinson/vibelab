// Favorite toggle. Spring-scales on press to give haptic feedback even
// without the haptics module wired. Calls actions.toggleFavorite which
// is optimistic.

import React, { useEffect, useRef } from 'react';
import { Animated, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Heart } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import { COLORS } from '../theme';

export default function HeartButton({ sauceId, size = 22, onUnauthenticated }) {
  const state = useAppState();
  const actions = useAppActions();
  const favored = state.favorites.has(sauceId);
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 1.18, duration: 80, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 4, useNativeDriver: true }),
    ]).start();
  }, [favored, scale]);

  async function onPress() {
    const res = await actions.toggleFavorite(sauceId);
    if (!res.ok && res.reason === 'unauthenticated') {
      if (onUnauthenticated) onUnauthenticated();
      else Alert.alert('Sign in to favorite', 'Sign in from the home screen to mark recipes you love.');
    }
  }

  return (
    <TouchableOpacity onPress={onPress} hitSlop={14} activeOpacity={0.7}>
      <Animated.View style={[styles.wrap, { transform: [{ scale }] }]}>
        <Heart
          size={size}
          color={favored ? COLORS.primary : COLORS.textMuted}
          fill={favored ? COLORS.primary : 'transparent'}
          strokeWidth={2}
        />
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 4,
  },
});
