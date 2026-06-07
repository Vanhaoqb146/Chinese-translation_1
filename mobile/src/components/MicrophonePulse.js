// mobile/src/components/MicrophonePulse.js
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View, Animated, Easing } from 'react-native';

export default function MicrophonePulse({ isRecording, color, size = 76 }) {
  const pulse1 = useMemo(() => new Animated.Value(0), []);
  const pulse2 = useMemo(() => new Animated.Value(0), []);
  const breathing = useMemo(() => new Animated.Value(1), []);

  useEffect(() => {
    let animPulse1, animPulse2, animBreathing;

    if (isRecording) {
      // Setup concurrent staggered pulsing waves
      animPulse1 = Animated.loop(
        Animated.timing(pulse1, {
          toValue: 1,
          duration: 2000,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        })
      );

      animPulse2 = Animated.loop(
        Animated.sequence([
          Animated.delay(800),
          Animated.timing(pulse2, {
            toValue: 1,
            duration: 2000,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );

      // Breathing effect for the main core
      animBreathing = Animated.loop(
        Animated.sequence([
          Animated.timing(breathing, {
            toValue: 1.08,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(breathing, {
            toValue: 1.0,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );

      animPulse1.start();
      animPulse2.start();
      animBreathing.start();
    } else {
      pulse1.setValue(0);
      pulse2.setValue(0);
      breathing.setValue(1);
    }

    return () => {
      if (animPulse1) animPulse1.stop();
      if (animPulse2) animPulse2.stop();
      if (animBreathing) animBreathing.stop();
    };
  }, [breathing, isRecording, pulse1, pulse2]);

  if (!isRecording) return null;

  // Interlopations for scale and opacity
  const scale1 = pulse1.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 2.2],
  });

  const opacity1 = pulse1.interpolate({
    inputRange: [0, 0.8, 1],
    outputRange: [0.6, 0.3, 0],
  });

  const scale2 = pulse2.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 2.2],
  });

  const opacity2 = pulse2.interpolate({
    inputRange: [0, 0.8, 1],
    outputRange: [0.6, 0.3, 0],
  });

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {/* Outer Pulse 1 */}
      <Animated.View
        style={[
          styles.pulseRing,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            transform: [{ scale: scale1 }],
            opacity: opacity1,
          },
        ]}
      />
      {/* Outer Pulse 2 */}
      <Animated.View
        style={[
          styles.pulseRing,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            transform: [{ scale: scale2 }],
            opacity: opacity2,
          },
        ]}
      />
      {/* Glow highlight */}
      <Animated.View
        style={[
          styles.glowCore,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            transform: [{ scale: breathing }],
            opacity: 0.12,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 0,
  },
  pulseRing: {
    position: 'absolute',
  },
  glowCore: {
    position: 'absolute',
  },
});
