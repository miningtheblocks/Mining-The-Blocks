import React, { useState, useMemo } from 'react';
import {
  View,
  Dimensions,
  PanResponder,
  StyleSheet,
  Text,
} from 'react-native';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

/**
 * Matemáticas para la Capa 100 real (199x199x199)
 */
class Layer100Math {
  static project3DTo2D(x, y, z, camera) {
    // Rotaciones de cámara
    const cosRotY = Math.cos(camera.rotY);
    const sinRotY = Math.sin(camera.rotY);
    const cosRotX = Math.cos(camera.rotX);
    const sinRotX = Math.sin(camera.rotX);

    // Transformar al espacio de cámara
    let px = x - camera.x;
    let py = y - camera.y;
    let pz = z - camera.z;

    // Aplicar rotaciones
    let tempX = px * cosRotY - pz * sinRotY;
    pz = px * sinRotY + pz * cosRotY;
    px = tempX;

    let tempY = py * cosRotX - pz * sinRotX;
    pz = py * sinRotX + pz * cosRotX;
    py = tempY;

    // Proyección perspectiva
    if (pz <= 1) return null;

    const scale = 800 / pz; // Escala para cubo masivo
    const screenX = px * scale + screenWidth / 2;
    const screenY = -py * scale + screenHeight / 2;

    return {
      x: screenX,
      y: screenY,
      z: pz,
      scale: Math.max(1, scale * 0.02) // Escala muy pequeña para cubos masivos
    };
  }
}

/**
 * Componente de cubo para la capa 100
 */
const Layer100Cube = React.memo(({ position, camera }) => {
  const projected = Layer100Math.project3DTo2D(
    position.x, 
    position.y, 
    position.z, 
    camera
  );

  if (!projected || 
      projected.x < -50 || projected.x > screenWidth + 50 || 
      projected.y < -50 || projected.y > screenHeight + 50) {
    return null;
  }

  const size = Math.max(0.5, projected.scale);
  const opacity = Math.max(0.3, Math.min(1, 200 / projected.z));

  return (
    <View
      style={[
        styles.cube,
        {
          left: projected.x - size / 2,
          top: projected.y - size / 2,
          width: size,
          height: size,
          opacity: opacity,
          zIndex: Math.round(1000 - projected.z),
        }
      ]}
    />
  );
});

/**
 * Generador de la CAPA 100 REAL - Muestra representativa
 */
function generateLayer100Positions() {
  const layer = 100;
  const sideLength = 2 * layer - 1; // 199 cubos por lado
  const halfSide = Math.floor(sideLength / 2); // 99
  const positions = [];

  // ESTRATEGIA: Muestreo inteligente para representar 199x199x199
  // Renderizar cada N cubos para mantener la forma pero reducir cantidad
  const samplingRate = 4; // Cada 4 cubos (199/4 ≈ 50 cubos por lado visible)
  

  for (let x = -halfSide; x <= halfSide; x += samplingRate) {
    for (let y = -halfSide; y <= halfSide; y += samplingRate) {
      for (let z = -halfSide; z <= halfSide; z += samplingRate) {
        // Solo superficie externa de la capa 100
        const isOnSurface = 
          Math.abs(x) >= halfSide - samplingRate || 
          Math.abs(y) >= halfSide - samplingRate || 
          Math.abs(z) >= halfSide - samplingRate;
        
        if (isOnSurface) {
          // Posiciones reales de la capa 100 - SIN SEPARACIÓN
          positions.push({ x: x, y: y, z: z });
        }
      }
    }
  }

  return positions;
}

/**
 * Renderizador de la Capa 100 completa
 */
export default function Layer100Renderer() {
  const [camera, setCamera] = useState({
    x: 0,
    y: 0,
    z: 200, // Cámara lejos para ver el cubo masivo
    rotX: 0.2,
    rotY: 0.3,
  });

  // Generar posiciones de la capa 100
  const cubePositions = useMemo(() => generateLayer100Positions(), []);

  // Filtrar cubos visibles con culling agresivo
  const visibleCubes = useMemo(() => {
    const maxDistance = 150;
    const maxCubes = 800; // Límite para rendimiento
    
    const filtered = cubePositions.filter(pos => {
      const distance = Math.sqrt(
        (pos.x - camera.x) ** 2 + 
        (pos.y - camera.y) ** 2 + 
        (pos.z - camera.z) ** 2
      );
      return distance <= maxDistance;
    });
    
    // Tomar muestra distribuida uniformemente
    const step = Math.max(1, Math.floor(filtered.length / maxCubes));
    return filtered.filter((_, index) => index % step === 0);
  }, [cubePositions, camera]);

  // Gestos de pan
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: () => true,
    onPanResponderMove: (evt, gestureState) => {
      setCamera(prev => ({
        ...prev,
        rotY: prev.rotY + gestureState.dx * 0.005,
        rotX: prev.rotX - gestureState.dy * 0.005,
      }));
    },
  }), []);

  // Calcular estadísticas reales
  const totalLayer100Cubes = 199 * 199 * 199 - 197 * 197 * 197;
  const surfaceCubes = 6 * (199 * 199) - 12 * 199 + 8; // Fórmula superficie cubo

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {/* Renderizar muestra de la capa 100 */}
      {visibleCubes.map((position, index) => (
        <Layer100Cube
          key={`${position.x}-${position.y}-${position.z}`}
          position={position}
          camera={camera}
        />
      ))}
      
      {/* Información de la capa 100 */}
      <View style={styles.infoPanel}>
        <Text style={styles.title}>CAPA 100 - CUBO MASIVO</Text>
        <Text style={styles.infoText}>
          Dimensión: 199×199×199 cubos
        </Text>
        <Text style={styles.infoText}>
          Total capa 100: {totalLayer100Cubes.toLocaleString()} cubos
        </Text>
        <Text style={styles.infoText}>
          Superficie: {surfaceCubes.toLocaleString()} cubos
        </Text>
        <Text style={styles.infoText}>
          Renderizando: {visibleCubes.length} cubos
        </Text>
        <Text style={styles.infoText}>
          Cámara Z: {camera.z.toFixed(0)}
        </Text>
        <View style={styles.indicator} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  cube: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderWidth: 0.2,
    borderColor: '#000',
  },
  infoPanel: {
    position: 'absolute',
    top: 40,
    left: 15,
    right: 15,
    backgroundColor: 'rgba(0,0,0,0.8)',
    padding: 10,
    borderRadius: 8,
    zIndex: 9999,
  },
  title: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 5,
    textAlign: 'center',
  },
  infoText: {
    color: '#fff',
    fontSize: 10,
    marginBottom: 2,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#00ff00',
    alignSelf: 'center',
    marginTop: 5,
  },
});
