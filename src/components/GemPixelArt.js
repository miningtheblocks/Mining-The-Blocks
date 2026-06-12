import React, { useEffect, useRef } from 'react';
import { View, Animated, Text, StyleSheet } from 'react-native';
import { GEM_SHAPE, GEMS } from '../utils/gems';

const CELL = 19; // screen px per pixel

const GRID_COLS = GEM_SHAPE[0].length; // 10
const GRID_ROWS = GEM_SHAPE.length;    // 10
const GRID_W = GRID_COLS * CELL;       // 190
const GRID_H = GRID_ROWS * CELL;       // 190

// Five sparkle star positions around the gem
const SPARKLE_POS = [
  { top: 2, left: 14 },
  { top: 2, right: 14 },
  { top: '38%', right: -2 },
  { bottom: 30, left: 10 },
  { bottom: 20, right: 10 },
];

export default function GemPixelArt({ gemIndex }) {
  const gem = GEMS[(gemIndex ?? 1) - 1];

  const scaleAnim = useRef(new Animated.Value(0)).current;
  const glowAnim  = useRef(new Animated.Value(0.3)).current;
  // One Animated.Value per sparkle
  const sparkleAnims = useRef(SPARKLE_POS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (!gem) return;
    const running = [];

    // Pop-in with spring
    const spring = Animated.spring(scaleAnim, {
      toValue: 1,
      tension: 70,
      friction: 6,
      useNativeDriver: true,
    });
    spring.start();

    // Breathing glow loop
    const glow = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1,   duration: 900, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0.25, duration: 900, useNativeDriver: true }),
      ])
    );
    glow.start();
    running.push(glow);

    // Staggered sparkle loops
    const stagger = [0, 350, 700, 200, 550];
    sparkleAnims.forEach((anim, i) => {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.delay(stagger[i]),
          Animated.timing(anim, { toValue: 1,   duration: 300, useNativeDriver: true }),
          Animated.delay(400),
          Animated.timing(anim, { toValue: 0,   duration: 300, useNativeDriver: true }),
          Animated.delay(600),
        ])
      );
      loop.start();
      running.push(loop);
    });

    return () => running.forEach(a => a.stop());
  }, [gem]);

  if (!gem) return null;

  return (
    <View style={styles.container}>
      {/* Pulsing background glow */}
      <Animated.View style={[
        styles.glow,
        {
          width:  GRID_W + 50,
          height: GRID_H + 50,
          borderRadius: (GRID_W + 50) / 2,
          backgroundColor: gem.glowColor,
          opacity: glowAnim,
        },
      ]} />

      {/* Pixel art grid with spring scale */}
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        {GEM_SHAPE.map((row, ri) => (
          <View key={ri} style={styles.row}>
            {row.map((ci, cj) => (
              <View
                key={cj}
                style={[
                  styles.cell,
                  ci !== 0 && { backgroundColor: gem.palette[ci] },
                ]}
              />
            ))}
          </View>
        ))}
      </Animated.View>

      {/* Sparkle stars */}
      {SPARKLE_POS.map((pos, i) => (
        <Animated.Text
          key={i}
          style={[styles.sparkle, { color: gem.sparkleColor, opacity: sparkleAnims[i] }, pos]}
        >
          ✦
        </Animated.Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width:  GRID_W + 60,
    height: GRID_H + 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
  },
  row: {
    flexDirection: 'row',
  },
  cell: {
    width:  CELL,
    height: CELL,
  },
  sparkle: {
    position: 'absolute',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
