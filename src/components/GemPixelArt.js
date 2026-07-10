import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Image } from 'react-native';
import { GEMS } from '../utils/gems';

const GRID_W = 190;
const GRID_H = 190;

// Assets reales por tier (reemplaza el grid de colores pixel-art anterior).
// Exportado para que otras pantallas (HUD del cubo) usen los mismos assets
// en vez de puntos de color.
export const GEM_IMAGES = {
  1: require('../../assets/gems/gem_1.png'),
  2: require('../../assets/gems/gem_2.png'),
  3: require('../../assets/gems/gem_3.png'),
  4: require('../../assets/gems/gem_4.png'),
  5: require('../../assets/gems/gem_5.png'),
  6: require('../../assets/gems/gem_6.png'),
  7: require('../../assets/gems/gem_7.png'),
  8: require('../../assets/gems/gem_8.png'),
  9: require('../../assets/gems/gem_9.png'),
};

// Five sparkle star positions around the gem
const SPARKLE_POS = [
  { top: 2, left: 14 },
  { top: 2, right: 14 },
  { top: '38%', right: -2 },
  { bottom: 30, left: 10 },
  { bottom: 20, right: 10 },
];

export default function GemPixelArt({ gemIndex }) {
  const tier = gemIndex ?? 1;
  const gem = GEMS[tier - 1];
  const image = GEM_IMAGES[tier];

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

  if (!gem || !image) return null;

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

      {/* Gema real con spring scale */}
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        <Image source={image} style={styles.gemImage} resizeMode="contain" />
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
  gemImage: {
    width: GRID_W,
    height: GRID_H,
  },
  sparkle: {
    position: 'absolute',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
