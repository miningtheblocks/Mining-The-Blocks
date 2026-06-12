/**
 * Configuración y utilidades para Three.js en React Native
 */

import * as THREE from 'three';

// Configuraciones globales de Three.js para React Native
export function setupThreeJS() {
  // Configurar el color space por defecto
  THREE.ColorManagement.enabled = true;
  
  // Configuraciones de rendimiento
  THREE.Object3D.DefaultUp.set(0, 1, 0);
  
}

/**
 * Utilidades matemáticas para el cubo masivo
 */
export class CubeMath {
  /**
   * Calcula el número de cubos en la superficie de una capa específica
   * @param {number} layer - Número de capa (1-100)
   * @returns {number} Número de cubos en la superficie de esa capa
   */
  static getSurfaceCubesCount(layer) {
    if (layer === 1) return 1;
    
    const sideLength = 2 * layer - 1;
    const totalCubes = sideLength ** 3;
    
    if (layer > 1) {
      const innerSideLength = 2 * (layer - 1) - 1;
      const innerCubes = innerSideLength ** 3;
      return totalCubes - innerCubes;
    }
    
    return totalCubes;
  }

  /**
   * Verifica si una posición está en la superficie externa de una capa
   * @param {number} x - Coordenada X
   * @param {number} y - Coordenada Y  
   * @param {number} z - Coordenada Z
   * @param {number} layer - Número de capa
   * @returns {boolean} True si está en la superficie
   */
  static isOnSurface(x, y, z, layer) {
    const halfSide = Math.floor((2 * layer - 1) / 2);
    return Math.abs(x) === halfSide || Math.abs(y) === halfSide || Math.abs(z) === halfSide;
  }

  /**
   * Calcula la distancia desde el centro
   * @param {number} x - Coordenada X
   * @param {number} y - Coordenada Y
   * @param {number} z - Coordenada Z
   * @returns {number} Distancia desde el origen
   */
  static distanceFromCenter(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z);
  }
}

/**
 * Configuraciones de rendimiento para diferentes dispositivos
 */
export const PerformanceConfig = {
  // Configuración para dispositivos de alta gama
  HIGH_END: {
    maxRenderDistance: 200,
    instanceCount: 50000,
    antialias: true,
    pixelRatio: 2
  },
  
  // Configuración para dispositivos de gama media
  MID_RANGE: {
    maxRenderDistance: 150,
    instanceCount: 30000,
    antialias: true,
    pixelRatio: 1.5
  },
  
  // Configuración para dispositivos de gama baja
  LOW_END: {
    maxRenderDistance: 100,
    instanceCount: 15000,
    antialias: false,
    pixelRatio: 1
  }
};

/**
 * Detecta automáticamente la configuración de rendimiento apropiada
 * @returns {Object} Configuración de rendimiento
 */
export function getOptimalPerformanceConfig() {
  // En React Native, podríamos usar DeviceInfo para detectar el dispositivo
  // Por ahora, usamos una configuración conservadora
  return PerformanceConfig.MID_RANGE;
}
