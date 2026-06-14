// Sistema de detección de caras corregido
// =====================================

import * as THREE from 'three';

// Variables globales para el sistema de detección
let lastDetectedFace = null;
let lastFaceChangeTime = 0;

// BAJO-ALTO-12: array de caras a nivel módulo (antes se creaba cada llamada
// = 18 Vector3 por call × 60Hz = ~1080/s de GC). Ahora reutilizamos.
const FACES_DET = [
  { name: 'front',  normal: new THREE.Vector3(0, 0, 1),  position: new THREE.Vector3(0, 0, 100),  index: 0 },
  { name: 'back',   normal: new THREE.Vector3(0, 0, -1), position: new THREE.Vector3(0, 0, -100), index: 1 },
  { name: 'right',  normal: new THREE.Vector3(1, 0, 0),  position: new THREE.Vector3(100, 0, 0),  index: 2 },
  { name: 'left',   normal: new THREE.Vector3(-1, 0, 0), position: new THREE.Vector3(-100, 0, 0), index: 3 },
  { name: 'top',    normal: new THREE.Vector3(0, 1, 0),  position: new THREE.Vector3(0, 100, 0),  index: 4 },
  { name: 'bottom', normal: new THREE.Vector3(0, -1, 0), position: new THREE.Vector3(0, -100, 0), index: 5 },
];
const _scratchCubeCenter = new THREE.Vector3();
const _scratchDir = new THREE.Vector3();

// Función corregida para encontrar la cara más paralela a la pantalla
export function findClosestFaceFixed(cameraPosition, cubePosition) {
  // Calcular dirección DESDE EL CUBO HACIA LA CÁMARA
  // (necesitamos encontrar la cara cuya normal apunta hacia la cámara)
  const cubeCenter = cubePosition || _scratchCubeCenter.set(0, 0, 0);
  const cameraDirection = _scratchDir.copy(cameraPosition).sub(cubeCenter).normalize();
  const faces = FACES_DET;
  
  let mostParallelFace = faces[0];
  let maxDotProduct = -Infinity;
  
  faces.forEach(face => {
    // Producto punto entre dirección de cámara y normal de cara
    // Más cercano a 1 = más paralelo (cara mirando hacia la cámara)
    const dotProduct = cameraDirection.dot(face.normal);
    if (dotProduct > maxDotProduct) {
      maxDotProduct = dotProduct;
      mostParallelFace = face;
    }
  });
  
  const currentTime = Date.now();
  
  // Sistema de estabilidad MEJORADO - evitar intercalado de caras
  if (lastDetectedFace) {
    // Si es la misma cara que antes, mantenerla
    if (lastDetectedFace.name === mostParallelFace.name) {
      return lastDetectedFace;
    }
    
    // Cooldown reducido a 500ms para mejor responsividad
    if (currentTime - lastFaceChangeTime < 500) {
      return lastDetectedFace;
    }
    
    // Calcular dot product de la cara actual para comparar
    const currentDotProduct = cameraDirection.dot(lastDetectedFace.normal);
    
    // REGLA 1: Solo cambiar si la nueva cara es significativamente mejor (umbral mínimo)
    const improvement = maxDotProduct - currentDotProduct;
    if (improvement < 0.15) {
      return lastDetectedFace;
    }
    
    // REGLA 2: EVITAR intercalado entre caras opuestas (requiere umbral más alto)
    const opposites = {
      'front': 'back', 'back': 'front',
      'right': 'left', 'left': 'right', 
      'top': 'bottom', 'bottom': 'top'
    };
    
    // Si la nueva cara es opuesta a la actual, requerir diferencia mayor
    if (opposites[lastDetectedFace.name] === mostParallelFace.name) {
      // Calcular segunda mejor opción para comparar
      let secondMaxDot = -Infinity;
      faces.forEach(face => {
        if (face.name !== mostParallelFace.name) {
          const dotProduct = cameraDirection.dot(face.normal);
          if (dotProduct > secondMaxDot) {
            secondMaxDot = dotProduct;
          }
        }
      });
      
      // Umbral reducido de 0.25 a 0.18 para permitir cambios a caras opuestas más fácilmente
      const dotDifference = maxDotProduct - secondMaxDot;
      if (dotDifference < 0.18) {
        return lastDetectedFace;
      }
    }
  }
  
  // Cambio confirmado o primera detección
  lastDetectedFace = mostParallelFace;
  lastFaceChangeTime = currentTime;
  
  return mostParallelFace;
}

// Función para resetear el estado de detección (útil cuando se presiona un botón de cara)
export function resetFaceDetection() {
  lastDetectedFace = null;
  lastFaceChangeTime = 0;
}

// Función para forzar una cara específica (cuando se presiona un botón)
export function setForcedFace(faceName) {
  const faces = [
    { name: 'front', normal: new THREE.Vector3(0, 0, 1), position: new THREE.Vector3(0, 0, 100), index: 0 },
    { name: 'back', normal: new THREE.Vector3(0, 0, -1), position: new THREE.Vector3(0, 0, -100), index: 1 },
    { name: 'right', normal: new THREE.Vector3(1, 0, 0), position: new THREE.Vector3(100, 0, 0), index: 2 },
    { name: 'left', normal: new THREE.Vector3(-1, 0, 0), position: new THREE.Vector3(-100, 0, 0), index: 3 },
    { name: 'top', normal: new THREE.Vector3(0, 1, 0), position: new THREE.Vector3(0, 100, 0), index: 4 },
    { name: 'bottom', normal: new THREE.Vector3(0, -1, 0), position: new THREE.Vector3(0, -100, 0), index: 5 }
  ];
  
  const face = faces.find(f => f.name === faceName);
  if (face) {
    lastDetectedFace = face;
    lastFaceChangeTime = Date.now();
    return face;
  }
  return null;
}
