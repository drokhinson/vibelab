// React Native port of web/meal.js::potSVG(). Steam circles + trails animate
// continuously via Animated.loop. Used on the home hero and the loading state.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Ellipse, Path, Rect, Circle } from 'react-native-svg';

const AnimatedG = Animated.createAnimatedComponent(View);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export default function PotIllustration({ width = 180, height = 140, animated = true }) {
  const steam1 = useRef(new Animated.Value(0)).current;
  const steam2 = useRef(new Animated.Value(0)).current;
  const steam3 = useRef(new Animated.Value(0)).current;
  const steam4 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animated) return undefined;
    const make = (val, duration, delay) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: false,
          }),
          Animated.timing(val, {
            toValue: 0,
            duration,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: false,
          }),
        ]),
      );
    const animations = [
      make(steam1, 1400, 0),
      make(steam2, 1600, 250),
      make(steam3, 1500, 500),
      make(steam4, 1200, 100),
    ];
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [animated, steam1, steam2, steam3, steam4]);

  const op1 = steam1.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0.4] });
  const op2 = steam2.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.45] });
  const op3 = steam3.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0.4] });
  const op4 = steam4.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.5] });

  const dy1 = steam1.interpolate({ inputRange: [0, 1], outputRange: [0, -8] });
  const dy2 = steam2.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });
  const dy3 = steam3.interpolate({ inputRange: [0, 1], outputRange: [0, -7] });
  const dy4 = steam4.interpolate({ inputRange: [0, 1], outputRange: [0, -6] });

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height} viewBox="0 0 180 140">
        {/* Floor shadow */}
        <Ellipse cx="90" cy="130" rx="62" ry="8" fill="#1A1A2E" opacity="0.06" />
        {/* Pot body */}
        <Path d="M28 68 Q28 112 90 112 Q152 112 152 68 Z" fill="#FFF3E6" />
        {/* Lip */}
        <Rect x="20" y="60" width="140" height="14" rx="7" fill="#E85D04" />
        <Path d="M28 68 Q28 112 90 112 Q152 112 152 68" stroke="#C94E02" strokeWidth="2" fill="none" />
        {/* Inner sauce */}
        <Ellipse cx="90" cy="96" rx="40" ry="10" fill="#E85D04" opacity="0.1" />
        {/* Bubble swirl */}
        <Path
          d="M58 76 Q72 62 88 76 Q104 90 118 74"
          stroke="#E85D04"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.5"
        />
        {/* Steam trails (static path lines) */}
        <Path
          d="M62 56 Q66 44 62 34 Q58 24 62 14"
          stroke="#D1D5DB"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.5"
        />
        <Path
          d="M90 53 Q94 41 90 31 Q86 21 90 11"
          stroke="#D1D5DB"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.5"
        />
        <Path
          d="M118 56 Q122 44 118 34 Q114 24 118 14"
          stroke="#D1D5DB"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.5"
        />
      </Svg>
      {/* Animated steam circles overlaid on the SVG. We use absolute positioning so
          opacity + translateY can be interpolated without re-rendering the static SVG. */}
      <AnimatedG style={{ position: 'absolute', left: 0, top: 0, width, height, transform: [{ translateY: dy1 }], opacity: op1 }}>
        <Svg width={width} height={height} viewBox="0 0 180 140">
          <Circle cx="70" cy="91" r="9" fill="#E85D04" />
        </Svg>
      </AnimatedG>
      <AnimatedG style={{ position: 'absolute', left: 0, top: 0, width, height, transform: [{ translateY: dy2 }], opacity: op2 }}>
        <Svg width={width} height={height} viewBox="0 0 180 140">
          <Circle cx="93" cy="84" r="7" fill="#F48C06" />
        </Svg>
      </AnimatedG>
      <AnimatedG style={{ position: 'absolute', left: 0, top: 0, width, height, transform: [{ translateY: dy3 }], opacity: op3 }}>
        <Svg width={width} height={height} viewBox="0 0 180 140">
          <Circle cx="114" cy="93" r="8" fill="#C94E02" />
        </Svg>
      </AnimatedG>
      <AnimatedG style={{ position: 'absolute', left: 0, top: 0, width, height, transform: [{ translateY: dy4 }], opacity: op4 }}>
        <Svg width={width} height={height} viewBox="0 0 180 140">
          <Circle cx="82" cy="103" r="5" fill="#FAA307" />
        </Svg>
      </AnimatedG>
    </View>
  );
}
