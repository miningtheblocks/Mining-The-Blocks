import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createRealisticPickaxeTexture, getHighDefinitionPickaxeTexture } from './PickaxeFromPNG';
import { findClosestFaceFixed, resetFaceDetection, setForcedFace } from './FaceDetection';
import { View, PanResponder, Dimensions, Text, TouchableOpacity, Modal, StyleSheet, Alert, TouchableWithoutFeedback, PixelRatio, Image, AppState, ScrollView, Platform } from 'react-native';
import { GLView } from 'expo-gl';
import { Renderer } from 'expo-three';
import * as THREE from 'three';
import { ensureAnonLogin } from '../firebase/client';
import { callMineCube } from '../firebase/functions';
import { auth, db } from '../firebase/client';
import { doc, onSnapshot, collection, query, where, setDoc, addDoc, serverTimestamp, increment, runTransaction } from 'firebase/firestore';
import { useNavigation, useFocusEffect, useIsFocused } from '@react-navigation/native';
import { signOut, onAuthStateChanged } from 'firebase/auth';
import { useI18n } from '../utils/i18n';
import { useOverlayModals } from './OverlayModalsProvider';
import { useServer } from '../utils/serverContext';
import { useAuth } from '../utils/authContext';
import { GEMS, GEM_SHAPE } from '../utils/gems';
import GemPixelArt from './GemPixelArt';
import { createRewardIndicatorSprite, MinedCubesRewardStore } from './MinedCellIndicators';
import audioManager from '../utils/audioManager';

// Suprimir warnings conocidos de expo-gl que no afectan la funcionalidad
const originalConsoleLog = console.log;
console.log = (...args) => {
  const message = args[0];
  if (typeof message === 'string' && message.includes('gl.pixelStorei() doesn\'t support this parameter yet')) {
    return; // Silenciar este warning específico
  }
  originalConsoleLog.apply(console, args);
};

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

// Sistema de 100 capas completas (K=100 a K=1)
// Capa 100 (mas externa): 201x201x6 = 242,406 cubos
// Capa 99: 199x199x6 = 237,606 cubos  
// Capa 1 (mas interna): 3x3x6 = 54 cubos
// Capa 0 (centro): 1 cubo solo
// La capa economica actual - iniciar en 100 (mas externa) y bajar progresivamente
const CURRENT_ECON_LAYER = 100;

// Funcion para obtener el tamano de grilla de una capa K
function getLayerGridSize(K) {
  return 2 * K + 1; // K=100 -> 201, K=99 -> 199, K=1 -> 3
}

const FACE_GRID_SIZE = getLayerGridSize(CURRENT_ECON_LAYER); // 201 para capa 100
const CUBES_PER_FACE = FACE_GRID_SIZE * FACE_GRID_SIZE; // 40401
const TOTAL_FACE_CUBES = CUBES_PER_FACE * 6; // 242406
// Numeracion de visualizacion global descendente (requerimiento):
// La capa externa inicia en 8,120,610 y va bajando.
// El cubo central (K=0) seria 1 en ascendente, por lo que en descendente seria DISPLAY_START - (ascend - 1)
const DISPLAY_START = 8120610;


function faceGridToCubeNumber(faceIndex, gridX, gridY) {
  // Valida limites por seguridad
  if (faceIndex < 0 || faceIndex >= 6) return null;
  if (gridX < 0 || gridX >= FACE_GRID_SIZE) return null;
  if (gridY < 0 || gridY >= FACE_GRID_SIZE) return null;
  return faceIndex * CUBES_PER_FACE + (gridY * FACE_GRID_SIZE + gridX) + 1;
}

// GLOBAL PATCH: Protect Image.getSize from invalid (non-string) URIs to avoid RN HostFunction crashes
// This crash appears after mining due to some internal or library call passing an object instead of a string.
// Guarding here ensures the app won't crash even if a bad call happens elsewhere.
(() => {
  try {
    if (Image && typeof Image.getSize === 'function' && !Image.__getSizePatched) {
      const originalGetSize = Image.getSize.bind(Image);
      Image.getSize = (uri, success, failure) => {
        if (typeof uri !== 'string') {
          console.warn('PATCH ACTIVADO - Image.getSize: expected string URI, got', typeof uri, 'value:', uri);
          if (typeof failure === 'function') {
            try { failure(new Error('Invalid Image.getSize URI')); } catch (e) {
              console.error('Image.getSize failure handler failed', e);
            }
          }
          return;
        }
        return originalGetSize(uri, success, failure);
      };
      Image.__getSizePatched = true;
    }
  } catch (e) {
    // noop
  }
})();

// Helpers para mapear shell K (100..1) a capa econÃƒÂ³mica (100..1) - MAPEO DIRECTO
function econIdFromK(K) {
  return Math.max(1, Math.min(100, K));
}
function kFromEconId(id) {
  return Math.max(1, Math.min(100, Number(id) || 1));
}

function cubeNumberToFaceGrid(cubeNumber) {
  const n = Number(cubeNumber);
  if (!Number.isFinite(n) || n < 1 || n > TOTAL_FACE_CUBES) return null;
  const zero = n - 1;
  const faceIndex = Math.floor(zero / CUBES_PER_FACE);
  const idx = zero % CUBES_PER_FACE;
  const gridY = Math.floor(idx / FACE_GRID_SIZE);
  const gridX = idx % FACE_GRID_SIZE;
  return { faceIndex, gridX, gridY };
}

// Cache de objetos intersectables para raycast (reconstruir al cambiar capa)
let _intersectablesCache = null;
function invalidateIntersectablesCache() { _intersectablesCache = null; }
function getIntersectables(scene) {
  if (_intersectablesCache) return _intersectablesCache;
  const list = [];
  scene.traverse((child) => {
    if (child.isMesh && child.userData && child.userData.faceIndex !== undefined) {
      list.push(child);
    }
  });
  _intersectablesCache = list;
  return list;
}

// CACHE DE TEXTURAS PARA EVITAR RECREACIÃƒâ€œN CONSTANTE
// LRU simple: máximo MAX_TEXTURE_CACHE entradas; cuando se supera se elimina la más antigua
const MAX_TEXTURE_CACHE = 500;
const textureCacheOrder = []; // keys en orden de inserción (FIFO para LRU simple)
const textureCache = new Map();

// Store global para recompensas de cubos minados
const minedRewardsStore = new MinedCubesRewardStore();

// Geometría compartida para todos los number meshes (evita crear/destruir PlaneGeometry cada frame)
const sharedNumberPlaneGeo = new THREE.PlaneGeometry(0.8, 0.8);

// Raycaster singleton para findCubeAtScreenPosition (evita allocations en cada tap)
const _moduleRaycaster = new THREE.Raycaster();

// Scratch objects pre-allocated para el render loop (evita GC pressure de new THREE.*)
const _sv1 = new THREE.Vector3();
const _sv2 = new THREE.Vector3();
const _sv3 = new THREE.Vector3();
const _sv4 = new THREE.Vector3();
const _sv5 = new THREE.Vector3();
const _sv6 = new THREE.Vector3();
const _sv7 = new THREE.Vector3();
const _sv8 = new THREE.Vector3();
const _sv9 = new THREE.Vector3();
const _sv10 = new THREE.Vector3();
const _sv11 = new THREE.Vector3();
const _sv12 = new THREE.Vector3();
const _sEuler = new THREE.Euler();
const _sMat4 = new THREE.Matrix4();
const _sCorners = [
  new THREE.Vector3(-1, -1, 0.5),
  new THREE.Vector3( 1, -1, 0.5),
  new THREE.Vector3(-1,  1, 0.5),
  new THREE.Vector3( 1,  1, 0.5),
];

// Pool de meshes para números: reutiliza en lugar de dispose+create en cada viewport change
const _numMeshPool = {
  pool: [],
  acquire() {
    if (this.pool.length > 0) return this.pool.pop();
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    return new THREE.Mesh(sharedNumberPlaneGeo, mat);
  },
  release(mesh) {
    if (mesh.parent) mesh.parent.remove(mesh);
    this.pool.push(mesh);
  },
};

// SISTEMA DE TEXTURAS: Crear textura con nÃƒÂºmero usando pÃƒÂ­xeles
// options: { transparentBackground?: boolean, digitColor?: [r,g,b,a] }
function createNumberTexture(number, options = {}) {
  // PROTECCIÃƒâ€œN ANTI-CRASH: Validar entrada antes de crear cacheKey
  if (typeof number !== 'number' || !isFinite(number) || isNaN(number)) {
    console.error('createNumberTexture: number invÃ¡lido:', typeof number, number);
    return null;
  }
  
  // USAR CACHE PARA EVITAR RECREAR TEXTURAS CONSTANTEMENTE
  const safeNumber = String(Math.floor(Math.abs(number))); // Asegurar string vÃƒÂ¡lido
  const cacheKey = `${safeNumber}_${!!options.transparentBackground}_${JSON.stringify(options.digitColor || [0,0,0,255])}`;
  if (textureCache.has(cacheKey)) {
    return textureCache.get(cacheKey);
  }
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const transparentBg = !!options.transparentBackground;
  const digitColor = options.digitColor || [0, 0, 0, 255]; // negro por defecto

  // Fondo: blanco opaco por defecto, o transparente si se pide
  for (let i = 0; i < data.length; i += 4) {
    if (transparentBg) {
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; // transparente
    } else {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; // blanco opaco
    }
  }

  // Dibujar nÃƒÂºmero usando pÃƒÂ­xeles (fuente bitmap simple) - USAR safeNumber ya validado
  drawTextOnTexture(data, size, safeNumber, digitColor);

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  
  // Guardar en cache con evicción LRU
  if (textureCache.size >= MAX_TEXTURE_CACHE) {
    const oldest = textureCacheOrder.shift();
    if (oldest) {
      const old = textureCache.get(oldest);
      if (old && old.dispose) old.dispose();
      textureCache.delete(oldest);
    }
  }
  textureCache.set(cacheKey, texture);
  textureCacheOrder.push(cacheKey);
  return texture;
}

// Convertir coordenadas 3D (ix,iy,iz) del shell K a (gridX,gridY) para una cara dada
function coordToGrid(K, faceIndex, ix, iy, iz){
  const face = FACES[faceIndex];
  let a=0,b=0;
  switch(face.name){
    case 'front':  // iz = +K
      a = ix; b = iy; break;
    case 'back':   // iz = -K
      a = -ix; b = iy; break;
    case 'right':  // ix = +K
      a = -iz; b = iy; break;
    case 'left':   // ix = -K
      a = iz; b = iy; break;
    case 'top':    // iy = +K
      a = ix; b = -iz; break;
    case 'bottom': // iy = -K
      a = ix; b = iz; break;
  }
  return { gridX: a + K, gridY: b + K };
}

// Asegurar luces mÃƒÂ­nimas para materiales Lambert/Phong (fragmentos, etc.)
function ensureLights(scene) {
  if (!scene) return;
  if (!scene.getObjectByName('MiningAmbient')) {
    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    amb.name = 'MiningAmbient';
    scene.add(amb);
  }
  if (!scene.getObjectByName('MiningDir')) {
    const dir = new THREE.DirectionalLight(0xffffff, 0.45);
    dir.position.set(3, 5, 2);
    dir.name = 'MiningDir';
    scene.add(dir);
  }
}

// Cambiar el color del cubo minado a gris oscuro (visible en todos los zooms y ángulos)
function setMinedCubeColor(faceIndex, gridX, gridY, faceGroupsRef) {
  try {
    const faceGroupEntry = faceGroupsRef.current?.[faceIndex];
    if (!faceGroupEntry) return;
    let instanced = null;
    let indexByGrid = null;
    const simpleRoot = faceGroupEntry.userData?.simpleMesh || faceGroupEntry.simpleMesh;
    if (simpleRoot && simpleRoot.traverse) {
      simpleRoot.traverse((o) => {
        if (o.isInstancedMesh) instanced = o;
      });
    }
    // Intentar leer indexByGrid del mesh de cubos (hijo [1])
    try {
      const cubesMesh = faceGroupEntry.userData?.simpleMesh?.children?.[1] || faceGroupEntry.children?.[1]?.children?.[1];
      if (cubesMesh?.userData?.indexByGrid) indexByGrid = cubesMesh.userData.indexByGrid;
      if (!instanced && cubesMesh?.isInstancedMesh) instanced = cubesMesh;
    } catch {}
    if (!instanced) return;
    let idx = -1;
    if (indexByGrid) {
      const GRID_SIZE = Math.max(1, Math.floor(Math.sqrt(indexByGrid.length)));
      idx = indexByGrid[gridY * GRID_SIZE + gridX] ?? -1;
    } else {
      const GRID_SIZE = Math.max(1, Math.floor(Math.sqrt(instanced.count)));
      idx = gridY * GRID_SIZE + gridX;
    }
    if (idx < 0 || idx >= instanced.count) return;
    // Cambiar color de la instancia a gris oscuro/negro (#1a1a1a)
    const darkColor = new THREE.Color(0x1a1a1a); // Gris muy oscuro, casi negro
    instanced.setColorAt(idx, darkColor);
    if (instanced.instanceColor) {
      instanced.instanceColor.needsUpdate = true;
    }
  } catch (e) {
    console.warn('setMinedCubeColor failed', e);
  }
}

// FunciÃƒÂ³n para dibujar texto usando pÃƒÂ­xeles (fuente bitmap 5x7)
function drawTextOnTexture(data, size, text, rgba = [0,0,0,255]) {
  // VALIDACIÃƒâ€œN ESTRICTA PARA EVITAR CRASH getSize
  if (!data || !Array.isArray(data) && !(data instanceof Uint8Array)) {
    console.error('drawTextOnTexture: data invÃƒÂ¡lida');
    return;
  }
  if (typeof size !== 'number' || size <= 0) {
    console.error('drawTextOnTexture: size invÃ¡lido');
    return;
  }
  if (typeof text !== 'string') {
    console.error('drawTextOnTexture: text debe ser string, recibido:', typeof text, text);
    return;
  }
  if (!Array.isArray(rgba) || rgba.length !== 4) {
    console.error('drawTextOnTexture: rgba invÃ¡lido');
    return;
  }
  
  // Fuente bitmap simple 5x7 para dÃƒÂ­gitos
  const font = {
    '0': [0x1F, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1F],
    '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    '2': [0x1F, 0x01, 0x01, 0x1F, 0x10, 0x10, 0x1F],
    '3': [0x1F, 0x01, 0x01, 0x0F, 0x01, 0x01, 0x1F],
    '4': [0x11, 0x11, 0x11, 0x1F, 0x01, 0x01, 0x01],
    '5': [0x1F, 0x10, 0x10, 0x1F, 0x01, 0x01, 0x1F],
    '6': [0x1F, 0x10, 0x10, 0x1F, 0x11, 0x11, 0x1F],
    '7': [0x1F, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01],
    '8': [0x1F, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x1F],
    '9': [0x1F, 0x11, 0x11, 0x1F, 0x01, 0x01, 0x1F],
    ',': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x08],
    '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
    'X': [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],  // X grande y clara
    'P': [0x0E, 0x04, 0x0E, 0x04, 0x04, 0x00, 0x00]   // Pico (pickaxe simple)
  };
  
  const charWidth = 6; // 5 + 1 espacio
  const charHeight = 7;
  const totalWidth = text.length * charWidth;
  
  // Centrar el texto
  const startX = Math.max(0, Math.floor((size - totalWidth) / 2));
  const startY = Math.floor((size - charHeight) / 2);
  
  // Dibujar cada caracter con validaciÃƒÂ³n adicional
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const charData = font[char];
    if (!charData || !Array.isArray(charData)) continue;
    
    const charX = startX + i * charWidth;
    
    // Dibujar el caracter pÃƒÂ­xel por pÃƒÂ­xel (volteado verticalmente para corregir espejo)
    for (let row = 0; row < charHeight; row++) {
      const rowData = charData[row];
      if (typeof rowData !== 'number') continue;
      
      for (let col = 0; col < 5; col++) {
        if (rowData & (1 << (4 - col))) {
          const x = charX + col;
          const y = startY + (charHeight - 1 - row); // Voltear verticalmente
          
          if (x >= 0 && x < size && y >= 0 && y < size) {
            const pixelIndex = (y * size + x) * 4;
            if (pixelIndex >= 0 && pixelIndex + 3 < data.length) {
              data[pixelIndex] = rgba[0];     // R
              data[pixelIndex + 1] = rgba[1]; // G
              data[pixelIndex + 2] = rgba[2]; // B
              data[pixelIndex + 3] = rgba[3]; // A
            }
          }
        }
      }
    }
  }
}

// FunciÃƒÂ³n para calcular lÃƒÂ­mites de pan en modo grilla
function calculateGridPanLimits(distance, fov, screenWidth, screenHeight, faceGridSize) {
  const fovRad = (fov || 60) * Math.PI / 180;
  const unitsPerPixelY = 2 * distance * Math.tan(fovRad / 2) / screenHeight;
  const unitsPerPixelX = unitsPerPixelY * (screenWidth / screenHeight);
  
  // Calcular cuÃƒÂ¡ntas celdas de grilla caben en la pantalla
  const cellSize = 200 / faceGridSize; // TamaÃƒÂ±o de cada celda (cubo de 200 dividido por grilla)
  const visibleCellsX = (screenWidth * unitsPerPixelX) / cellSize;
  const visibleCellsY = (screenHeight * unitsPerPixelY) / cellSize;
  
  // MEJORADO: Asegurar que siempre quede al menos 1 fila/columna visible
  // Calcular el mÃƒÂ¡ximo desplazamiento permitido manteniendo contenido siempre visible
  const halfGridSize = faceGridSize / 2;
  const gridTotalSizeX = faceGridSize * cellSize;
  const gridTotalSizeY = faceGridSize * cellSize;
  
  // ÃƒÂrea visible en unidades del mundo
  const visibleAreaX = visibleCellsX * cellSize;
  const visibleAreaY = visibleCellsY * cellSize;
  
  // LÃƒÂ­mite mÃ¡s restrictivo: asegurar que al menos 1 celda completa siempre estÃƒÂ© visible
  // El centro de la grilla puede moverse hasta que el borde de la grilla estÃƒÂ© a 1 celda del borde de pantalla
  const maxPanX = (gridTotalSizeX / 2) + (visibleAreaX / 2) - cellSize; // Permitir sobresalir manteniendo 1 celda
  const maxPanY = (gridTotalSizeY / 2) + (visibleAreaY / 2) - cellSize; // Permitir sobresalir manteniendo 1 celda
  
  return {
    minX: -maxPanX,
    maxX: maxPanX,
    minY: -maxPanY,
    maxY: maxPanY
  };
}

// FunciÃƒÂ³n para aplicar lÃƒÂ­mites a la posiciÃƒÂ³n de grilla
function clampGridPosition(newPos, limits) {
  const clampedPos = {
    x: THREE.MathUtils.clamp(newPos.x, limits.minX, limits.maxX),
    y: THREE.MathUtils.clamp(newPos.y, limits.minY, limits.maxY)
  };
  
  // Log cuando se aplican lÃƒÂ­mites - ahora permite sobresalir mÃ¡s
  if (newPos.x !== clampedPos.x || newPos.y !== clampedPos.y) {
  }
  
  return clampedPos;
}

// Funciones auxiliares para sistema de minado
function screenToNDC(screenX, screenY, screenWidth, screenHeight) {
  return {
    x: (screenX / screenWidth) * 2 - 1,
    y: -(screenY / screenHeight) * 2 + 1
  };
}

function findCubeAtScreenPosition(screenX, screenY, camera, scene, screenWidth, screenHeight, layerK, offsetX = 0, offsetY = 0) {
  const raycaster = _moduleRaycaster;
  // Convertir a coordenadas relativas al GLView si hay offset
  const localX = screenX - (offsetX || 0);
  const localY = screenY - (offsetY || 0);
  const mouse = screenToNDC(localX, localY, screenWidth, screenHeight);
  
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld();
  raycaster.setFromCamera(mouse, camera);

  // Usar cache de intersectables (reconstruido en buildLayer, no en cada tap)
  const intersectableObjects = getIntersectables(scene);
  const intersects = raycaster.intersectObjects(intersectableObjects);
  
  if (intersects.length > 0) {
    const intersection = intersects[0];
    const faceIndex = intersection.object.userData.faceIndex;
    const face = FACES[faceIndex];
    
    // Calcular posiciÃƒÂ³n del cubito en la grilla en espacio LOCAL de la cara
    // El objeto intersectado estÃƒÂ¡ dentro de simpleMesh -> faceGroup
    let faceGroup = null;
    try {
      // backgroundMesh/cubesMesh estÃƒÂ¡n bajo simpleMesh (Group) que estÃƒÂ¡ bajo faceGroup
      faceGroup = intersection.object.parent?.parent || null;
    } catch {}
    const inv = new THREE.Matrix4();
    const localPoint = intersection.point.clone();
    if (faceGroup) {
      inv.copy(faceGroup.matrixWorld).invert();
      localPoint.applyMatrix4(inv);
    }
    
    // Convertir punto 3D a coordenadas de grilla 2D de la cara
    let gridX, gridY;
    
    const K = Math.max(0, Math.floor(layerK || 0));
    // Importante: los grupos de cara ya estÃƒÂ¡n ROTADOS en buildLayer(K),
    // por lo que su espacio local siempre tiene la grilla en XY.
    // Usar redondeo al centro de celda para evitar sesgo hacia los bordes
    gridX = Math.round(localPoint.x) + K;
    gridY = Math.round(localPoint.y) + K;
    
    // Validar que estÃƒÂ© dentro de los lÃƒÂ­mites
    const GRID_SIZE = 2 * K + 1;
    if (gridX >= 0 && gridX < GRID_SIZE && gridY >= 0 && gridY < GRID_SIZE) {
      const cubeIndex = gridY * GRID_SIZE + gridX;
      // Intentar obtener nÃƒÂºmeros del mesh (opcional), pero priorizar numeraciÃƒÂ³n global por cara consistente con backend
      let cubeNumbers = intersection.object.userData.cubeNumbers;
      if (!cubeNumbers && faceGroup) {
        try {
          const cubesMesh = faceGroup.userData?.simpleMesh?.children?.[1];
          cubeNumbers = cubesMesh?.userData?.cubeNumbers;
        } catch {}
      }

      // Calcular ÃƒÂ­ndice de instancia real y recuperar el nÃƒÂºmero ascendente, luego convertir a descendente DISPLAY
      if (faceGroup) {
        try {
          const cubesMesh = faceGroup.userData?.simpleMesh?.children?.[1];
          const indexByGrid = cubesMesh?.userData?.indexByGrid;
          const GRID_SIZE_FACE = cubesMesh?.userData?.GRID_SIZE || GRID_SIZE;
          let idxInst = -1;
          if (indexByGrid) {
            idxInst = indexByGrid[gridY * GRID_SIZE_FACE + gridX] ?? -1;
          } else {
            idxInst = gridY * GRID_SIZE_FACE + gridX;
          }
          const numbers = cubesMesh?.userData?.cubeNumbers;
          // PROTECCIÃƒâ€œN ANTI-CRASH: Validar numbers[idxInst] antes de usar
          let ascend = null;
          try {
            if (idxInst >= 0 && numbers && idxInst < numbers.length) {
              const rawNumber = numbers[idxInst];
              if (typeof rawNumber === 'number' && isFinite(rawNumber) && !isNaN(rawNumber)) {
                ascend = rawNumber;
              }
            }
          } catch (numberError) {
            console.warn('Error accessing cube number:', numberError.message);
            ascend = null;
          }
          if (typeof ascend === 'number') {
            return {
              cubeNumber: ascend,
              apiCubeNumber: faceGridToCubeNumber(faceIndex, gridX, gridY),
              faceIndex: faceIndex,
              gridX: gridX,
              gridY: gridY,
              coords: (function(){
                const a = gridX - K;
                const b = gridY - K;
                let ix=0,iy=0,iz=0;
                const fname = face.name;
                if (fname === 'front') { iz = K; ix = a; iy = b; }
                else if (fname === 'back') { iz = -K; ix = -a; iy = b; }
                else if (fname === 'right') { ix = K; iz = -a; iy = b; }
                else if (fname === 'left') { ix = -K; iz = a; iy = b; }
                else if (fname === 'top') { iy = K; ix = a; iz = -b; }
                else { iy = -K; ix = a; iz = b; }
                return { ix, iy, iz, K };
              })(),
              worldPosition: (function(){
                const a = gridX - K;
                const b = gridY - K;
                const zOffsetCubes = 0.4;
                const centerLocal = new THREE.Vector3(a, b, zOffsetCubes);
                const centerWorld = centerLocal.clone();
                if (faceGroup) centerWorld.applyMatrix4(faceGroup.matrixWorld);
                return centerWorld;
              })(),
              screenPosition: { x: screenX, y: screenY },
              screenX,
              screenY
            };
          }
        } catch {}
      }
      return null;
    }
  }
  
  return null;
}

// Sistema de animaciÃƒÂ³n de minado
function createCrackGeometry(position, faceNormal) {
  // Grietas tipo roca. Cada camino completo se convierte en UN solo LineSegments
  // (en lugar de uno por par de puntos) → reduce draw calls de ~70 a ~5.
  const segs = [];
  const faceSize = 1.0;
  const n = faceNormal.clone().normalize();
  const upRef = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = upRef.clone().cross(n).normalize();
  const up = n.clone().cross(right).normalize();
  const offsetN = 0.002;

  const jitter = (s) => (Math.random() - 0.5) * s;

  const makePath = (fromEdge) => {
    const pts = [];
    const steps = 8; // reducido de 16 → menos vértices, misma apariencia en mobile
    const half = faceSize / 2;
    let x = fromEdge === 'L' ? -half : fromEdge === 'R' ? half : (Math.random() * faceSize - half);
    let y = fromEdge === 'T' ? half : fromEdge === 'B' ? -half : (Math.random() * faceSize - half);
    for (let i = 0; i <= steps; i++) {
      const tx = fromEdge === 'L' ? half : fromEdge === 'R' ? -half : (Math.random() * faceSize - half);
      const ty = fromEdge === 'T' ? -half : fromEdge === 'B' ? half : (Math.random() * faceSize - half);
      x = THREE.MathUtils.damp(x, tx, 5.5, 0.016) + jitter(0.06);
      y = THREE.MathUtils.damp(y, ty, 5.5, 0.016) + jitter(0.06);
      pts.push(new THREE.Vector2(x, y));
    }
    return pts;
  };

  // Convertir un array de Vector2 en un único LineSegments (pares p[i-1]→p[i])
  const pathToLineSegments = (path, delay) => {
    const verts = [];
    for (let i = 1; i < path.length; i++) {
      const p0 = path[i - 1];
      const p1 = path[i];
      verts.push(
        position.clone().add(right.clone().multiplyScalar(p0.x)).add(up.clone().multiplyScalar(p0.y)).add(n.clone().multiplyScalar(offsetN)),
        position.clone().add(right.clone().multiplyScalar(p1.x)).add(up.clone().multiplyScalar(p1.y)).add(n.clone().multiplyScalar(offsetN))
      );
    }
    if (!verts.length) return null;
    const geo = new THREE.BufferGeometry().setFromPoints(verts);
    const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0, depthWrite: false, depthTest: false });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 10000;
    line.userData = { delay };
    return line;
  };

  const mainCount = 2 + Math.floor(Math.random() * 2); // 2-3 caminos (antes 3-4)
  const edges = ['L', 'R', 'T', 'B'];
  for (let i = 0; i < mainCount; i++) {
    const path = makePath(edges[(Math.random() * 4) | 0]);
    const line = pathToLineSegments(path, i * 60);
    if (line) segs.push(line);

    // Una ramificación por camino (15% prob), también como LineSegments único
    if (Math.random() < 0.15 && path.length >= 4) {
      const mid = Math.floor(path.length / 2);
      const p0 = path[mid];
      const p1 = path[mid + 1];
      const dir = new THREE.Vector2().subVectors(p1, p0);
      const side = Math.random() < 0.5 ? 1 : -1;
      const branch = new THREE.Vector2(-dir.y, dir.x).setLength(dir.length() * (0.4 + Math.random() * 0.3) * side);
      const q = new THREE.Vector2().addVectors(p0.clone().lerp(p1, 0.5), branch);
      const branchPath = [p0.clone().lerp(p1, 0.5), q];
      const bl = pathToLineSegments(branchPath, i * 60 + 30);
      if (bl) segs.push(bl);
    }
  }
  return segs;
}

function createFragments(position, faceNormal, cubeSize = 1.0) {
  const fragments = [];
  // Reducir fragmentos en pantallas pequeÃƒÂ±as para evitar presiÃƒÂ³n de GPU/driver mÃƒÂ³vil
  const smallScreen = (screenWidth * screenHeight) <= (1080 * 1920 * 0.75);
  const fragmentsPerSide = smallScreen ? 4 : 6; // 4x4=16 en low/med, 6x6=36 en high
  const fragmentSize = cubeSize / fragmentsPerSide;
  
  try {
    for (let x = 0; x < fragmentsPerSide; x++) {
      for (let y = 0; y < fragmentsPerSide; y++) {
        const geometry = new THREE.BoxGeometry(
          fragmentSize * 0.9,
          fragmentSize * 0.9,
          fragmentSize * 0.3
        );
        // Material bÃƒÂ¡sico con transparencia real habilitada (se modifica opacity durante la animaciÃƒÂ³n)
        const material = new THREE.MeshBasicMaterial({ 
          color: 0xffffff, 
          transparent: true, 
          opacity: 1.0, 
          depthWrite: false 
        });
        const fragment = new THREE.Mesh(geometry, material);
        
        // Contorno negro para mayor contraste - con manejo de errores
        try {
          const edgeGeom = new THREE.EdgesGeometry(geometry);
          const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000 });
          const edges = new THREE.LineSegments(edgeGeom, edgeMat);
          fragment.add(edges);
        } catch (edgeError) {
          console.warn('Error creating fragment edges:', edgeError.message);
          // Continuar sin edges si hay error
        }
        
        const offsetX = (x - fragmentsPerSide / 2 + 0.5) * fragmentSize;
        const offsetY = (y - fragmentsPerSide / 2 + 0.5) * fragmentSize;
        fragment.position.copy(position);
        fragment.position.x += offsetX;
        fragment.position.y += offsetY;
        // Empuje inicial hacia fuera de la cara + ruido
        const outward = faceNormal.clone().multiplyScalar(0.6 + Math.random() * 1.0);
        const jitter = new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6);
        fragment.userData = {
          velocity: outward.add(jitter),
          angularVelocity: new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3),
          life: 1.0,
        };
        fragments.push(fragment);
      }
    }
  } catch (fragmentError) {
    console.error('Error creating fragments:', fragmentError.message);
    // Retornar fragmentos creados hasta ahora, o array vacÃƒÂ­o si no hay ninguno
  }
  
  return fragments;
}

function animateFragments(fragments, scene, duration = 1800, cancelRef = null) {
  const startTime = Date.now();
  const gravity = -0.02;

  return new Promise((resolve) => {
  const cleanup = () => {
    fragments.forEach(fragment => {
      try {
        scene.remove(fragment);
        if (fragment.geometry?.dispose) fragment.geometry.dispose();
        if (fragment.material?.dispose) fragment.material.dispose();
        fragment.children?.forEach(child => {
          if (child.geometry?.dispose) child.geometry.dispose();
          if (child.material?.dispose) child.material.dispose();
        });
      } catch {}
    });
    resolve();
  };

  const animate = () => {
    try {
      if (!scene || !scene.children || (cancelRef && cancelRef.current)) {
        cleanup();
        return;
      }
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;
      
      if (progress >= 1.0) {
        cleanup();
        return;
      }

      fragments.forEach(fragment => {
        try {
          const userData = fragment.userData;
          if (!userData) return;
          userData.velocity.y += gravity;
          fragment.position.add(userData.velocity);
          fragment.rotation.x += userData.angularVelocity.x;
          fragment.rotation.y += userData.angularVelocity.y;
          fragment.rotation.z += userData.angularVelocity.z;
          userData.life = 1.0 - progress;
          if (fragment.material && fragment.material.opacity !== undefined) {
            fragment.material.opacity = userData.life;
          }
          const scale = 0.5 + userData.life * 0.5;
          fragment.scale.setScalar(scale);
        } catch {}
      });

      requestAnimationFrame(animate);
    } catch {
      try { fragments.forEach(f => scene.remove(f)); } catch {}
      resolve();
    }
  };

  animate();
  }); // end Promise
}

// (removed) createLayerSystem: no longer used

// (removed) computeCubeNumber: no longer used

// (removed) revealNextLayerCube: no longer used

// (removed) createMinedHole: no longer used

// PICO NÃƒÂTIDO 64Ãƒâ€”64 Ã¢â‚¬â€œ contorno negro 1px interno, interior blanco, NearestFilter
// ====================
// Pico blanco con borde negro (64x64) â€“ textura programÃ¡tica
// ====================

function createPickaxeTexture(THREE) {
  const size = 64;
  const data = new Uint8Array(size * size * 4);

  const setPixel = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };

  // --- utilitario para trazar lÃ­neas duras (Bresenham)
  const drawLine = (x0, y0, x1, y1, r, g, b, a) => {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, e2;
    while (true) {
      setPixel(x0, y0, r, g, b, a);
      if (x0 === x1 && y0 === y1) break;
      e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };

  // --- rellenar polÃ­gono blanco (scanline simplificado)
  const fillPolygon = (points, r, g, b, a) => {
    const ys = points.map(p => p[1]);
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(...ys)));
    for (let y = minY; y <= maxY; y++) {
      const nodes = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
          const xInt = xi + ((y - yi) / (yj - yi)) * (xj - xi);
          nodes.push(xInt);
        }
      }
      nodes.sort((a, b) => a - b);
      for (let k = 0; k < nodes.length; k += 2) {
        const xStart = Math.max(0, Math.floor(nodes[k]));
        const xEnd = Math.min(size - 1, Math.ceil(nodes[k + 1]));
        for (let x = xStart; x <= xEnd; x++) {
          setPixel(x, y, r, g, b, a);
        }
      }
    }
  };

  // --- Centro del lienzo ---
  const cx = 32;
  const cy = 32;

  // =====================
  // 1ï¸âƒ£ MANGO
  // =====================
  const handleW = 8;
  const handleH = 26;
  const handleX = cx + 4;
  const handleY = cy + 5;
  const handle = [
    [handleX, handleY],
    [handleX + handleW, handleY],
    [handleX + handleW, handleY - handleH],
    [handleX, handleY - handleH],
  ];
  fillPolygon(handle, 255, 255, 255, 255);
  // contorno negro
  for (let i = 0; i < handle.length; i++) {
    const p1 = handle[i];
    const p2 = handle[(i + 1) % handle.length];
    drawLine(p1[0], p1[1], p2[0], p2[1], 0, 0, 0, 255);
  }

  // =====================
  // 2ï¸âƒ£ CABEZA
  // =====================
  const head = [
    [cx + 8, cy - 14],
    [cx - 2, cy - 26],
    [cx - 10, cy - 28],
    [cx - 20, cy - 24],
    [cx - 28, cy - 16],
    [cx - 24, cy - 18],
    [cx - 14, cy - 20],
    [cx - 4, cy - 18],
    [cx + 6, cy - 12],
  ];
  fillPolygon(head, 255, 255, 255, 255);
  for (let i = 0; i < head.length; i++) {
    const p1 = head[i];
    const p2 = head[(i + 1) % head.length];
    drawLine(p1[0], p1[1], p2[0], p2[1], 0, 0, 0, 255);
  }

  // =====================
  // 3ï¸âƒ£ CREAR TEXTURA
  // =====================
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.magFilter = THREE.NearestFilter; // sin suavizado
  texture.minFilter = THREE.NearestFilter;
  texture.flipY = true;
  texture.transparent = true;

  return { texture };
}

// Animación X roja pixel-art para cubo ya minado
function showXAnimation(scene, worldPosition, THREE, color = [220, 40, 40]) {
  if (!scene || !worldPosition) return;
  try {
    const size = 32;
    const data = new Uint8Array(size * size * 4);
    const thickness = 3;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const onDiag1 = Math.abs(x - y) < thickness;
        const onDiag2 = Math.abs(x - (size - 1 - y)) < thickness;
        if (onDiag1 || onDiag2) {
          const idx = (y * size + x) * 4;
          data[idx] = color[0]; data[idx + 1] = color[1]; data[idx + 2] = color[2]; data[idx + 3] = 255;
        }
      }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;

    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 1.0, depthWrite: false, depthTest: false });
    const sprite = new THREE.Sprite(material);
    const pos = worldPosition.clone ? worldPosition.clone() : new THREE.Vector3(worldPosition.x, worldPosition.y, worldPosition.z);
    sprite.position.copy(pos);
    sprite.renderOrder = 999999;
    const initialSize = 0.3;
    const maxScale = 1.8;
    sprite.scale.setScalar(initialSize);
    scene.add(sprite);

    let t = 0;
    const duration = 0.5;
    const step = () => {
      t += 0.016;
      if (t >= duration) {
        scene.remove(sprite);
        sprite.material.dispose();
        if (sprite.material.map) sprite.material.map.dispose();
        return;
      }
      const progress = t / duration;
      sprite.scale.setScalar(initialSize + (maxScale - initialSize) * (1 - Math.pow(1 - progress, 2)));
      sprite.material.opacity = progress > 0.6 ? 1 - (progress - 0.6) / 0.4 : 1.0;
      requestAnimationFrame(step);
    };
    step();
  } catch (e) {
    console.error('Error in showXAnimation:', e);
  }
}

// Animación pixel-art de gema preciosa
function showGemAnimation(scene, worldPosition, THREE, gemDef) {
  if (!scene || !worldPosition || !gemDef) return;
  try {
    const scale = 3;
    const size = 32;
    const data = new Uint8Array(size * size * 4);
    const hexToRgb = (hex) => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
    const colors = gemDef.palette.map(c => c ? hexToRgb(c) : null);
    const gemW = 10 * scale;
    const gemH = 10 * scale;
    const offX = Math.floor((size - gemW) / 2);
    const offY = Math.floor((size - gemH) / 2);

    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        const palIdx = GEM_SHAPE[row][col];
        if (palIdx === 0) continue;
        const color = colors[palIdx];
        if (!color) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = offX + col * scale + dx;
            const py = offY + row * scale + dy;
            if (px < 0 || px >= size || py < 0 || py >= size) continue;
            const idx = (py * size + px) * 4;
            data[idx] = color[0]; data[idx+1] = color[1]; data[idx+2] = color[2]; data[idx+3] = 255;
          }
        }
      }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;

    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 1.0, depthWrite: false, depthTest: false });
    const sprite = new THREE.Sprite(material);
    const pos = worldPosition.clone ? worldPosition.clone() : new THREE.Vector3(worldPosition.x, worldPosition.y, worldPosition.z);
    sprite.position.copy(pos);
    sprite.renderOrder = 999999;
    const initialSize = 0.3;
    const maxScale = 2.2;
    sprite.scale.setScalar(initialSize);
    scene.add(sprite);

    let t = 0;
    const duration = 0.8;
    const step = () => {
      t += 0.016;
      if (t >= duration) {
        scene.remove(sprite);
        sprite.material.dispose();
        if (sprite.material.map) sprite.material.map.dispose();
        return;
      }
      const progress = t / duration;
      sprite.scale.setScalar(initialSize + (maxScale - initialSize) * (1 - Math.pow(1 - progress, 2)));
      sprite.material.opacity = progress > 0.6 ? 1 - (progress - 0.6) / 0.4 : 1.0;
      requestAnimationFrame(step);
    };
    step();
  } catch (e) {
    console.error('Error in showGemAnimation:', e);
  }
}

// Animación profesional de recompensa: pico verde con efectos
function showRewardAnimation(scene, modalData, reward, THREE) {
  return new Promise((resolve) => {
    if (!reward || reward <= 0) {
      return resolve();
    }
    
    try {
      if (!scene || !modalData || !modalData.position) {
        return resolve();
      }
      
      // Crear sprite del pico nítido (NearestFilter)
      const { texture: pickaxeTexture } = getHighDefinitionPickaxeTexture(THREE, 'high');
      
      const material = new THREE.SpriteMaterial({ 
        map: pickaxeTexture,
        transparent: true, 
        opacity: 1.0,
        depthWrite: false,
        depthTest: false, // Asegurar que se vea por encima de todo
        sizeAttenuation: true // El sprite respeta la distancia de la cámara
      });
      
      const sprite = new THREE.Sprite(material);
      
      // CENTRADO PERFECTO: Usar la posición exacta del cubo minado
      const position = modalData.position.clone();
      sprite.position.copy(position);
      
      // RenderOrder MUY ALTO para que aparezca delante de TODO
      sprite.renderOrder = 999999;
      
      // NO rotar sprite: los píxeles ya vienen rotados 90° derecha desde PickaxeFromPNG.js
      
      // Tamaño inicial: mitad de un cubito (0.5x0.5)
      const initialSize = 0.5; // Mitad de un cubito
      sprite.scale.set(initialSize, initialSize, initialSize);
      scene.add(sprite);
      
      // Animación simple y directa (reducida a la mitad)
      const duration = 0.5; // 0.5 segundos (antes 1.0)
      const maxScale = 2.0; // Crecer hasta 2 cubos (2x2)
      let t = 0;
      
      const animate = () => {
        t += 0.016; // ~60fps
        if (t >= duration) {
          scene.remove(sprite);
          sprite.material.dispose();
          if (sprite.material.map) sprite.material.map.dispose();
          return resolve();
        }
        
        const progress = t / duration;
        
        // Crecimiento suave y directo
        const easeOut = 1 - Math.pow(1 - progress, 2); // Suavizado simple
        const currentScale = initialSize + (maxScale - initialSize) * easeOut;
        sprite.scale.set(currentScale, currentScale, currentScale);
        
        // Sin rotaciÃ³n ni efectos complejos - solo crecimiento simple
        sprite.material.opacity = 1.0;
        
        // Fade out solo en el ÃƒÂºltimo 20%
        if (progress > 0.8) {
          const fadeProgress = (progress - 0.8) / 0.2;
          sprite.material.opacity = 1.0 - fadeProgress;
        }
        
        // Mantener posiciÃƒÂ³n fija - sin movimiento
        sprite.position.copy(position);
        
        requestAnimationFrame(animate);
      };
      
      animate();
      
    } catch (error) {
      console.error('Error in showRewardAnimation:', error);
      resolve();
    }
  });
}

// Face data structure (positions are computed per layer K)
const FACES = [
  { name: 'front',  normal: new THREE.Vector3(0, 0, 1)  },
  { name: 'back',   normal: new THREE.Vector3(0, 0, -1) },
  { name: 'right',  normal: new THREE.Vector3(1, 0, 0)  },
  { name: 'left',   normal: new THREE.Vector3(-1, 0, 0) },
  { name: 'top',    normal: new THREE.Vector3(0, 1, 0)  },
  { name: 'bottom', normal: new THREE.Vector3(0, -1, 0) },
];

// TamaÃƒÂ±o del shell
function shellSize(K){
  if (K<=0) return 1;
  return 24*K*K + 2;
}

// DueÃƒÂ±o ÃƒÂºnico de una celda del shell (evita duplicados en aristas/esquinas)
function ownerFaceIndex(ix,iy,iz,K){
  if (Math.max(Math.abs(ix),Math.abs(iy),Math.abs(iz)) !== K) return -1;
  // Prioridad: front(z=+K), right(x=+K), back(z=-K), left(x=-K), top(y=+K), bottom(y=-K)
  if (iz === K) return 0;
  if (ix === K) return 2;
  if (iz === -K) return 1;
  if (ix === -K) return 3;
  if (iy === K) return 4;
  if (iy === -K) return 5;
  return -1;
}

// Crear una cara de la capa K con ownership ÃƒÂºnico
function createFaceInstancesForLayer(K, faceIndex){
  const GRID_SIZE = 2*K + 1;
  const gridSpacing = 1.0;
  const cubeSize = 0.88;
  const zOffsetCubes = 0.4;

  // Plano negro de fondo del tamaÃƒÂ±o de la grilla de esta capa
  const backgroundPlane = new THREE.PlaneGeometry(GRID_SIZE * gridSpacing, GRID_SIZE * gridSpacing);
  const backgroundMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.FrontSide, depthTest: true });
  const backgroundMesh = new THREE.Mesh(backgroundPlane, backgroundMaterial);
  backgroundMesh.position.set(0,0,0);
  backgroundMesh.userData = backgroundMesh.userData || {};
  backgroundMesh.userData.faceIndex = faceIndex;
  backgroundMesh.userData.kind = 'bg';

  const cubeGeometry = new THREE.BoxGeometry(cubeSize, cubeSize, 0.01);
  const cubeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });

  // Pre-coleccionar posiciones y nÃƒÂºmeros con ownership
  const positions = [];
  const indexByGrid = new Int32Array(GRID_SIZE * GRID_SIZE).fill(-1);

  // EnumeraciÃƒÂ³n global de la capa K: calcularemos el nÃƒÂºmero mÃ¡s tarde por continuidad; aquÃƒÂ­ guardamos el orden por cara
  for (let gy=0; gy<GRID_SIZE; gy++){
    for (let gx=0; gx<GRID_SIZE; gx++){
      // Mapeo grid -> coords del shell segÃºn la cara
      const a = gx - K; // en [-K..K]
      const b = gy - K; // en [-K..K]
      let ix=0, iy=0, iz=0;
      const face = FACES[faceIndex];
      switch(face.name){
        case 'front':  iz = K;    ix = a; iy = b; break;
        case 'back':   iz = -K;   ix = -a; iy = b; break; // orientaciÃƒÂ³n espejo para back
        case 'right':  ix = K;    iz = -a; iy = b; break;
        case 'left':   ix = -K;   iz = a;  iy = b; break;
        case 'top':    iy = K;    ix = a;  iz = -b; break;
        case 'bottom': iy = -K;   ix = a;  iz = b;  break;
      }
      const owner = ownerFaceIndex(ix,iy,iz,K);
      if (owner === faceIndex){
        // posiciÃƒÂ³n local de la celda en la cara
        const x = a * gridSpacing;
        const y = b * gridSpacing;
        positions.push({gx,gy,x,y});
        indexByGrid[gy*GRID_SIZE + gx] = positions.length - 1;
      }
    }
  }

  const count = positions.length;
  const cubesMesh = new THREE.InstancedMesh(cubeGeometry, cubeMaterial, count);
  
  // Habilitar instanceColor para poder colorear cubos minados individualmente
  cubesMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  
  const matrix = new THREE.Matrix4();
  const whiteColor = new THREE.Color(0xffffff);
  for (let i=0;i<count;i++){
    const p = positions[i];
    matrix.setPosition(p.x, p.y, zOffsetCubes);
    cubesMesh.setMatrixAt(i, matrix);
    // Inicializar todos los cubos como blancos
    cubesMesh.setColorAt(i, whiteColor);
  }
  cubesMesh.instanceMatrix.needsUpdate = true;
  cubesMesh.instanceColor.needsUpdate = true;

  let startN = 1;
  if (K===0){ startN = 1; }
  else {
    let sum = 1; // capa 0
    for (let k=1;k<K;k++) sum += shellSize(k);
    startN = sum + 1;
  }
  // AsignaciÃƒÂ³n continua segÃºn orden de caras con offset ÃƒÂºnico por cara
  const numbers = new Uint32Array(count);
  // Cada cara tiene un offset ÃƒÂºnico basado en faceIndex para evitar duplicados
  const faceOffset = faceIndex * 1000000; // Offset grande para separar caras
  let cursor = startN + faceOffset;
  for (let i=0;i<count;i++) numbers[i] = cursor++;

  cubesMesh.userData = {
    cubeNumbers: numbers,
    materialPlain: cubeMaterial,
    showingNumbers: false,
    faceIndex: faceIndex,
    GRID_SIZE,
    indexByGrid,
    kind: 'cubes',
    // Bloque de numeraciÃƒÂ³n descendente visible por cara: empieza en DISPLAY_START y baja por instancias
    faceBlockStart: DISPLAY_START - (faceIndex * CUBES_PER_FACE),
    faceCount: count
  };

  const faceRoot = new THREE.Group();
  faceRoot.add(backgroundMesh);
  faceRoot.add(cubesMesh);
  return { simpleMesh: faceRoot, borderMesh: new THREE.Group(), createDetailedMesh: () => [], faceIndex };
}

// Agregar parche gris oscuro en la celda minada (cara local)
function addDarkPatch(faceIndex, gridX, gridY, faceGroupsRef, K, rewardPicks = 0) {
  try {
    const faceGroupEntry = faceGroupsRef.current?.[faceIndex];
    if (!faceGroupEntry) {
      return false; // escena aún no lista, el caller no debe marcar la key como aplicada
    }
    const cubeSize = 0.88;
    const zOffsetCubes = 0.4;
    const a = gridX - K;
    const b = gridY - K;
    const planeGeo = new THREE.PlaneGeometry(cubeSize, cubeSize);
    // Render overlay fully on top of the cube face to cover it completely
    const mat = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.FrontSide, depthTest: false, depthWrite: false, transparent: true, opacity: 1.0 });
    const patch = new THREE.Mesh(planeGeo, mat);
    patch.position.set(a, b, zOffsetCubes + 0.006);
    patch.renderOrder = 9999;
    patch.visible = true;
    faceGroupEntry.add(patch);
    
    if (!faceGroupEntry.userData.minedPatches) faceGroupEntry.userData.minedPatches = new Map();
    const patchKey = `${gridX},${gridY}`;
    faceGroupEntry.userData.minedPatches.set(patchKey, patch);

    // Crear sprite del nÃƒÂºmero en gris y guardarlo para control de visibilidad en el render loop
    try {
      // localizar el InstancedMesh para obtener el nÃƒÂºmero de esta celda
      const cubesMesh = faceGroupEntry.userData?.simpleMesh?.children?.[1] || faceGroupEntry.children?.[1]?.children?.[1] || null;
      if (cubesMesh && cubesMesh.userData) {
        const GRID_SIZE = cubesMesh.userData.GRID_SIZE || (2 * K + 1);
        const indexByGrid = cubesMesh.userData.indexByGrid;
        let idx = -1;
        if (indexByGrid) idx = indexByGrid[gridY * GRID_SIZE + gridX] ?? -1; else idx = gridY * GRID_SIZE + gridX;
        const numbers = cubesMesh.userData.cubeNumbers;
        const ascend = (idx >= 0 && numbers && numbers[idx] != null) ? numbers[idx] : null;
        
        // CREAR NÚMERO (si hay número válido)
        if (typeof ascend === 'number' && isFinite(ascend) && !isNaN(ascend)) {
          const tex = createNumberTexture(ascend, { transparentBackground: true, digitColor: [120, 120, 120, 255] });
          
          if (tex) {
            // Si se crea una textura, usar sprite
            const numMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 1.0, depthTest: false, depthWrite: false });
            const sprite = new THREE.Sprite(numMat);
            const s = cubeSize * 0.7;
            sprite.scale.set(s, s, 1);
            sprite.position.set(a, b, zOffsetCubes + 0.008);
            sprite.renderOrder = 10001;
            sprite.visible = true; // VISIBLE INMEDIATAMENTE - render loop controla después
            faceGroupEntry.add(sprite);
            // Guardar referencia estructurada
            if (!faceGroupEntry.userData.minedNumberSprites) faceGroupEntry.userData.minedNumberSprites = new Map();
            const key = `${gridX},${gridY}`;
            faceGroupEntry.userData.minedNumberSprites.set(key, sprite);
          } else {
            // Usar cubo de color sólido en lugar de sprite
            const colorGeo = new THREE.BoxGeometry(cubeSize * 0.3, cubeSize * 0.3, 0.05);
            const colorMat = new THREE.MeshBasicMaterial({ 
              color: 0x888888, // gris
              transparent: true, 
              opacity: 0.8,
              depthTest: false, 
              depthWrite: false 
            });
            const colorCube = new THREE.Mesh(colorGeo, colorMat);
            colorCube.position.set(a, b, zOffsetCubes + 0.008);
            colorCube.renderOrder = 10001;
            colorCube.visible = true; // VISIBLE INMEDIATAMENTE - render loop controla después
            faceGroupEntry.add(colorCube);
            // Guardar referencia
            if (!faceGroupEntry.userData.minedNumberSprites) faceGroupEntry.userData.minedNumberSprites = new Map();
            const key = `${gridX},${gridY}`;
            faceGroupEntry.userData.minedNumberSprites.set(key, colorCube);
          }
        }
        
        // SIEMPRE CREAR INDICADOR DE RECOMPENSA (X o picos) - FUERA del if del número
        try {
          const rewardSprite = createRewardIndicatorSprite(
            rewardPicks,
            new THREE.Vector3(a, b - 0.25, zOffsetCubes + 0.012),
            [120, 120, 120, 255]
          );
          rewardSprite.visible = true;
          faceGroupEntry.add(rewardSprite);
          if (!faceGroupEntry.userData.rewardIndicators) faceGroupEntry.userData.rewardIndicators = new Map();
          const key = `${gridX},${gridY}`;
          faceGroupEntry.userData.rewardIndicators.set(key, rewardSprite);
        } catch (rewardErr) {
          console.warn('addDarkPatch: error agregando indicador:', rewardErr?.message);
        }
      }
    } catch {}
    return true;
  } catch (e) {
    console.warn('addDarkPatch failed', e);
    return false;
  }
}

export default function DynamicCube201() {
  const navigation = useNavigation && typeof useNavigation === 'function' ? useNavigation() : null;
  const { t, language } = useI18n();
  const { openModal } = useOverlayModals ? useOverlayModals() : { openModal: () => {} };
  const { activeServer } = useServer ? useServer() : { activeServer: null };
  const { isGuest } = useAuth();
  const serverId = activeServer?.id || null;
  const glRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const cubeGroupRef = useRef(new THREE.Group());
  const glSizeRef = useRef({ width: screenWidth, height: screenHeight });
  const animRef = useRef(0);
  const faceGroupsRef = useRef([]);

  // Sincroniza tamaños de renderer/cámara/viewport usando drawingBuffer (YA escalado por expo-gl)
  const syncRendererSize = useCallback(() => {
    try {
      const gl = glRef.current;
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      if (!gl || !renderer || !camera) return;
      
      // CRÍTICO: drawingBuffer YA tiene el pixel ratio aplicado por expo-gl
      const w = gl.drawingBufferWidth || screenWidth;
      const h = gl.drawingBufferHeight || screenHeight;
      
      // NO aplicar pixel ratio adicional - solo usar el buffer real
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      
      // CRÍTICO: Resetear viewport de Three.js a toda la pantalla
      renderer.setViewport(0, 0, w, h);
      
      // Sincronizar viewport de WebGL con el buffer
      gl.viewport(0, 0, w, h);
      
      // Aspect ratio basado en el buffer real
      camera.aspect = Math.max(0.0001, w / h);
      camera.updateProjectionMatrix();
    } catch (e) {
      console.warn('syncRendererSize error:', e?.message);
    }
  }, []);
  const camStateRef = useRef();
  // Track active touches to distinguish pinch vs long-press
  const activeTouchesRef = useRef(0);
  // Rango descendente cacheado por cara (se calcula una sola vez tras construir la capa)
  const faceRangesRef = useRef(Array(6).fill(null));
  // Profundidad minada por celda (por capa): faceIndex_gridX_gridY -> depth (0..)
  const minedDepthRef = useRef(new Map());
  // Mesh oscuro de la siguiente capa por celda, para actualizar/remover
  const nextLayerCubesRef = useRef(new Map());

  const [camState, setCamState] = useState({
    distance: 800, // 5 zooms alejada del predeterminado (300 * 1.05^5 Ã¢â€°Ë† 800)
    rotX: 0.3,
    rotY: 0.6,
    tx: 0,
    ty: 0,
  });
// Botones de ZOOM (+/-) ademÃ¡s del pinch
const gridExitPressRef = useRef(0);
const [showGridExitHint, setShowGridExitHint] = useState(false);
const gridExitTimerRef = useRef(null);

const handleZoomButton = useCallback((direction) => {
  const isZoomOut = direction === -1;
  if (isZoomOut && cameraModeRef.current === 'grid') {
    // Umbral donde termina el modo grilla (tempDist=dist-100 <= 255.2 → dist <= 355.2)
    const GRID_EXIT_THRESHOLD = 355.2;
    const currentDist = camStateRef.current?.distance ?? 300;
    const step = currentDist < 150 ? 5 : 25;
    const nextDist = currentDist + step;

    if (nextDist >= GRID_EXIT_THRESHOLD) {
      // En el límite exterior del pan: activar mecanismo de salida (doble press)
      const now = Date.now();
      if (now - gridExitPressRef.current < 1500) {
        // Segundo press: salir a modo cubo
        gridExitPressRef.current = 0;
        if (gridExitTimerRef.current) {
          clearTimeout(gridExitTimerRef.current);
          gridExitTimerRef.current = null;
        }
        setShowGridExitHint(false);
        cameraModeRef.current = 'cube';
        setCameraMode('cube');
        setRequestedFace(null);
        requestedFaceRef.current = null;
        resetFaceDetection();
        setCamState((prev) => {
          const jumpOut = Math.max(prev.distance + 100, 350);
          return { ...prev, distance: THREE.MathUtils.clamp(jumpOut, 106.6, 3000) };
        });
      } else {
        // Primer press: mostrar hint
        gridExitPressRef.current = now;
        setShowGridExitHint(true);
        if (gridExitTimerRef.current) clearTimeout(gridExitTimerRef.current);
        gridExitTimerRef.current = setTimeout(() => {
          gridExitPressRef.current = 0;
          setShowGridExitHint(false);
          gridExitTimerRef.current = null;
        }, 1500);
      }
      return;
    }
    // No está en el límite → zoom out normal (continúa abajo)
  }
  setCamState((prev) => {
    const minDist = 106.6;
    const maxDist = 3000;
    const step = prev.distance < 150 ? 5 : 25;
    const next = THREE.MathUtils.clamp(prev.distance - direction * step, minDist, maxDist);
    return { ...prev, distance: next };
  });
}, []);

  // Capa actual (shell) 0..100; 100 = externa
  const [currentLayer, setCurrentLayer] = useState(activeServer?.currentLayer ?? 100);

  // Keep ref updated
  camStateRef.current = camState;

  const [visibleFaces, setVisibleFaces] = useState([]);
  const [renderCount, setRenderCount] = useState(0);
  const [cullingMode, setCullingMode] = useState('dynamic'); // 'dynamic' o 'all'
  const [realDistance, setRealDistance] = useState(0); // Distancia real al cubito
  const [cameraMode, setCameraMode] = useState('cube'); // 'cube' o 'grid'
  const [requestedFace, setRequestedFace] = useState(null); // 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom'
  const requestedFaceRef = useRef(null);
  // Estado previo de la cÃ¡mara, para restaurar al volver de modo grid a modo cube
  const prevCamBeforeGridRef = useRef(null);
  // Keep requestedFace updated in ref for render loop
  requestedFaceRef.current = requestedFace;
  // Focus handling to remount GLView and reset timers
  const isFocused = useIsFocused && typeof useIsFocused === 'function' ? useIsFocused() : true;
  const [focusKey, setFocusKey] = useState(0);
  
  // Estados para sistema de minado
  const [miningModal, setMiningModal] = useState(null); // { cubeNumber, position, screenPos }
  const [minedCubes, setMinedCubes] = useState(new Set()); // Cubitos ya minados
  const [rewardModal, setRewardModal] = useState(null); // { title, message, reward }
  const [episodeCompleteModal, setEpisodeCompleteModal] = useState(null); // { episodeNumber, totalMined }
  
  const [miningAnimations, setMiningAnimations] = useState(new Map()); // Animaciones activas
  const [longPressActive, setLongPressActive] = useState(false); // Indicador visual de long press
  const longPressInitiatedRef = useRef(false); // Flag para bloquear pan durante TODO el proceso de long press
  const visibleNumbersRef = useRef([]); // Números visibles — ref para evitar re-renders en render loop
  const [selectedCube, setSelectedCube] = useState(null); // { cubeNumber, screenX, screenY, worldPosition, faceIndex, gridX, gridY }
  const [authReady, setAuthReady] = useState(false);
  const [picks, setPicks] = useState(null); // null: loading, number otherwise
  const [cash, setCash] = useState(0); // balance en efectivo
  const [totalMinedCount, setTotalMinedCount] = useState(0); // contador local de minados
  const minedPollRef = useRef(null);
  const camAnimRef = useRef(null);
  // EstadÃƒÂ­stica global de la capa econÃƒÂ³mica ACTUAL (econIdFromK(currentLayer))
  const [globalMinedCurrentLayer, setGlobalMinedCurrentLayer] = useState(0);
  const [layerMinedCount, setLayerMinedCount] = useState(0); // mined en capa actual
  const [totalMinedAllLayers, setTotalMinedAllLayers] = useState(0); // suma de mined en todas las capas
  // Menú hamburguesa
  const [menuOpen, setMenuOpen] = useState(false);
  // Modal "Cómo se juega?"
  const [howToPlayVisible, setHowToPlayVisible] = useState(false);
  // UI de progreso de minado dentro del modal
  const [miningProgress, setMiningProgress] = useState(0);
  const miningProgressTimerRef = useRef(null);
  // Suprimir cambio automÃƒÂ¡tico a modo grid por un corto perÃƒÂ­odo (usado cuando se presiona un botÃƒÂ³n de cara)
  const suppressAutoGridRef = useRef(0);
  // Marca de tiempo de la ÃƒÂºltima rotaciÃ³n libre para evitar que el render loop anule con modo grid
  const lastRotateTsRef = useRef(0);
  // Flag de rotaciÃ³n activa mientras el dedo estÃƒÂ¡ arrastrando
  const isRotatingRef = useRef(false);
  // Toast de feedback de premios / estados
  const [hudToast, setHudToast] = useState(null); // string | null
  const hudToastTimerRef = useRef(null);

  // Gestures - Sistema simple y Funcional
  const pinchRef = useRef(null);
  const panStartRef = useRef({ rotX: 0, rotY: 0 });
  // Timestamp de última rotación manual para detectar cuando usuario gira el cubo
  const lastManualRotationRef = useRef(0);
  // Timestamp de última rotación para permitir detección de cara
  const lastRotationTimeRef = useRef(0);
  
  // Referencias para sistema de minado
  const longPressTimer = useRef(null);
  const preHoldTimerRef = useRef(null); // indicador temprano de hold (~300ms)
  const modalTimerRef = useRef(null);
  const longPressStartPos = useRef(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const buildLayerRef = useRef(null);
  // PosiciÃƒÂ³n del ÃƒÂºltimo toque de 1 dedo para rotaciÃ³n incremental
  const lastTouchPosRef = useRef(null);
  // Flag: si durante el gesto hubo 2 dedos (zoom), deshabilitar minado
  const gestureZoomingRef = useRef(false);
  const minedByLayerRef = useRef(new Map()); // K -> Set of 'ix,iy,iz'
  const minedAppliedRef = useRef(new Set()); // keys: `${faceIndex}:${gridX}:${gridY}` para evitar duplicados
  // Celdas con animaciÃƒÂ³n local en curso para no aplicar parche por realtime antes de tiempo
  const pendingAnimCellsRef = useRef(new Set()); // keys: `${K}:${faceIndex}:${gridX}:${gridY}`
  const mouseRef = useRef(new THREE.Vector2());
  // Fuente de verdad para la posición de la grilla — sólo ref, sin estado React
  const gridPositionRef = useRef({ x: 0, y: 0 });
  // Histeresis y cache para modo grilla
  const lastGridModeRef = useRef(false);
  const gridFaceRef = useRef(null);
  // Timestamp del ÃƒÂºltimo pan en modo grilla para fijar modo durante el gesto
  const lastGridPanTsRef = useRef(0);
  const panVelocityRef = useRef({ x: 0, y: 0 });
  const lastPanMoveTimeRef = useRef(0);
  const inertiaAnimRef = useRef(null);
  // Para dos dedos: recordar el punto medio previo para pan de grilla
  const lastTwoFingerMidRef = useRef(null);
  // Cara activa detectada (para suscripciÃƒÂ³n granular de minados)
  // Inicializar con 0 (cara frontal) para que los números aparezcan por defecto
  const [activeFaceIndex, setActiveFaceIndex] = useState(0);
  // Sistema de estabilización de detección de cara para evitar intercalado
  const lastDetectedFaceIndexRef = useRef(0);
  const lastFaceChangeTimeRef = useRef(0);
  const faceStabilityCounterRef = useRef(0);
  // Audio settings
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const roturaPlayedRef = useRef(false);
  // Throttle para state updates en render loop
  const lastStateUpdate = useRef(0);
  // Throttle para setCamState durante gestos (~15fps en lugar de 60)
  const lastCamStateReactUpdate = useRef(0);
  // Contador de frames para viewport culling optimizado
  const cullingFrameCounter = useRef(0);
  // Refs que replican estado para el render loop (evita stale closures y setState frecuentes)
  const cameraModeRef = useRef('cube');
  const lastSetActiveFaceRef = useRef(-1);
  const currentLayerRef = useRef(activeServer?.currentLayer ?? 100);
  currentLayerRef.current = currentLayer;

  // Referencia para las grietas (cracks) mostradas durante la minería
  const cracksRef = useRef(null);
  // Promise que se resuelve cuando las grietas terminan (para coordinar con startMining)
  const cracksPromiseRef = useRef(null);
  // Watchdog para evitar modal congelado en 'working/mining'
  const miningWatchdogRef = useRef(null);
  // Cancelación de animaciones de fragmentos al desmontar
  const fragmentsCancelRef = useRef(false);
  // Nombre de usuario cacheado para historial de cadena
  const userDisplayNameRef = useRef('Jugador');

  // Inicializar sistema de audio
  useEffect(() => {
    const initAudio = async () => {
      try {
        await audioManager.init();
        await audioManager.loadSounds();
        // Arrancar música ahora que el sistema está listo
        await audioManager.playBackgroundMusic();
      } catch (error) {
        console.error('Error inicializando audio:', error);
      }
    };
    initAudio();

    return () => {
      audioManager.cleanup();
      if (inertiaAnimRef.current) { cancelAnimationFrame(inertiaAnimRef.current); inertiaAnimRef.current = null; }
    };
  }, []);

  // Pausar/reanudar música cuando la app se minimiza/abre
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        // App minimizada - pausar música
        audioManager.pauseBackgroundMusic();
      } else if (nextAppState === 'active') {
        // App abierta - reanudar música
        audioManager.resumeBackgroundMusic();
      }
    });

    return () => {
      subscription?.remove();
    };
  }, []);

  // Reset layer when the active server changes (user switches servers)
  useEffect(() => {
    if (activeServer?.currentLayer != null) {
      setCurrentLayer(activeServer.currentLayer);
      setMinedCubes(new Set());
      setLayerMinedCount(0);
      setTotalMinedAllLayers(0);
      try { minedAppliedRef.current.clear(); } catch {}
    }
  }, [serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Guard y helper de transiciÃƒÂ³n de capa (elimina capa actual y construye la siguiente)
  const transitioningRef = useRef(false);
  const transitionToLayer = useCallback((nextK) => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    try {
      setCurrentLayer(nextK);
      visibleNumbersRef.current = [];
      setSelectedCube(null);
      setMiningModal(null);
      // Limpiar cache de celdas aplicadas
      try { minedAppliedRef.current.clear(); } catch {}
      // Reconstruir capa
      if (buildLayerRef.current) {
        buildLayerRef.current(nextK);
      }
      // Recalcular rangos para HUD/nÃƒÂºmeros
      try { recomputeFaceRanges(); } catch {}
      try { showHudToast && showHudToast(`Capa ${nextK} lista`); } catch {}
    } finally {
      transitioningRef.current = false;
    }
  }, [recomputeFaceRanges, showHudToast]);

  // Recalcular rangos descendentes por cara con los nÃƒÂºmeros reales de la capa construida
  const recomputeFaceRanges = React.useCallback(() => {
    try {
      for (let fIdx = 0; fIdx < FACES.length; fIdx++) {
        const faceGroupEntry = faceGroupsRef.current?.[fIdx];
        if (!faceGroupEntry) continue;
        const cubesMesh = faceGroupEntry.userData?.simpleMesh?.children?.[1]
          || faceGroupEntry.children?.[1]?.children?.[1];
        const numbers = cubesMesh?.userData?.cubeNumbers;
        if (!numbers || !numbers.length) continue;
        let minAsc = Infinity;
        let maxAsc = -Infinity;
        for (let i = 0; i < numbers.length; i++) {
          const v = numbers[i];
          if (typeof v !== 'number') continue;
          if (v < minAsc) minAsc = v;
          if (v > maxAsc) maxAsc = v;
        }
        if (isFinite(minAsc) && isFinite(maxAsc)) {
          const start = DISPLAY_START - minAsc + 1;
          const end = DISPLAY_START - maxAsc + 1;
          faceRangesRef.current[fIdx] = { start, end };
        }
      }
    } catch {}
  }, []);

  // Aplica visualmente una celda minada (parche + ocultar instancia) una sola vez
  const applyMinedCell = useCallback((faceIndex, gridX, gridY, rewardPicks = 0) => {
    try {
      if (typeof faceIndex !== 'number') return;
      const key = `${currentLayer}:${faceIndex}:${gridX}:${gridY}`;
      if (minedAppliedRef.current.has(key)) return;
      const K = currentLayer;
      const patched = addDarkPatch(faceIndex, gridX, gridY, faceGroupsRef, K, rewardPicks);
      if (!patched) return; // escena no lista aún, no marcar como aplicada para poder reintentar
      setMinedCubeColor(faceIndex, gridX, gridY, faceGroupsRef);
      minedAppliedRef.current.add(key);
    } catch (e) {
      console.warn('applyMinedCell error', e);
    }
  }, [currentLayer]);

  // Rehidratación + realtime de minados globales (todos los usuarios)
  // CRÍTICO: Suscribirse a TODA la capa, no solo activeFaceIndex
  // En modo cubo se ven múltiples caras simultáneamente
  useEffect(() => {
    if (!serverId) return;
    let unsub = null;
    try {
      const col = collection(db, 'servers', serverId, 'mined');
      // Query simplificado: solo filtrar por capa actual, cargar TODAS las caras
      const q = query(
        col,
        where('K', '==', currentLayer)
      );
      unsub = onSnapshot(q, (snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type !== 'added') return; // en primera carga llegan todos como added
          const id = ch.doc.id;
          const docData = ch.doc.data();
          const rewardPicksFromDB = Number(docData?.rewardPicks || 0);
          const map = cubeNumberToFaceGrid(id);
          if (!map) return;
          const { faceIndex, gridX, gridY } = map;
          // Aplicar sólo si corresponde a la capa actual
          try {
            const key = `${currentLayer}:${faceIndex}:${gridX}:${gridY}`;
            if (pendingAnimCellsRef.current.has(key)) return;
            
            const rewardPicks = minedRewardsStore.has(currentLayer, faceIndex, gridX, gridY)
              ? minedRewardsStore.get(currentLayer, faceIndex, gridX, gridY)
              : rewardPicksFromDB;
            
            if (!minedRewardsStore.has(currentLayer, faceIndex, gridX, gridY)) {
              minedRewardsStore.set(currentLayer, faceIndex, gridX, gridY, rewardPicks);
            }
            
            applyMinedCell(faceIndex, gridX, gridY, rewardPicks);
            setMinedCubes(prev => { const s = new Set(prev); s.add(id); return s; });
          } catch {}
        });
      });
    } catch (e) {
      console.warn('mined realtime subscribe error', e);
    }
    return () => {
      try { unsub && unsub(); } catch {}
    };
  }, [db, serverId, currentLayer, applyMinedCell]);

  // Suscripción a estadísticas de la capa actual (una sola suscripción para layerMinedCount Y globalMinedCurrentLayer)
  // + suscripción a todas las capas para totalMinedAllLayers
  useEffect(() => {
    if (!serverId) return;
    let unsubCurrentLayer = null;
    let unsubAllLayers = null;
    try {
      const layerDocRef = doc(db, 'servers', serverId, 'layers', String(currentLayer));
      unsubCurrentLayer = onSnapshot(layerDocRef, (snap) => {
        const mined = snap.exists() ? (snap.data()?.stats?.mined ?? 0) : 0;
        const n = Number(mined) || 0;
        setLayerMinedCount(n);
        setGlobalMinedCurrentLayer(n);
      });
    } catch (e) {
      console.warn('subscribe current layer stats error', e);
    }
    try {
      const colRef = collection(db, 'servers', serverId, 'layers');
      unsubAllLayers = onSnapshot(colRef, (snapshot) => {
        let sum = 0;
        snapshot.forEach((docSnap) => {
          sum += Number(docSnap.data()?.stats?.mined || 0);
        });
        setTotalMinedAllLayers(sum);
      });
    } catch (e) {
      console.warn('subscribe all layers stats error', e);
    }
    return () => {
      try { unsubCurrentLayer && unsubCurrentLayer(); } catch {}
      try { unsubAllLayers && unsubAllLayers(); } catch {}
    };
  }, [db, serverId, currentLayer]);

  // Transición global: si las estadísticas del backend indican que la capa actual está completa, avanzar a la siguiente
  useEffect(() => {
    try {
      const need = shellSize(currentLayer);
      if (Number(layerMinedCount) >= need && currentLayer > 0) {
        transitionToLayer(currentLayer - 1);
      }
    } catch {}
  }, [layerMinedCount, currentLayer, transitionToLayer]);

  // Utilidad para mostrar un toast breve en HUD
  const showHudToast = useCallback((msg, duration = 1800) => {
    try { if (hudToastTimerRef.current) { clearTimeout(hudToastTimerRef.current); hudToastTimerRef.current = null; } } catch {}
    setHudToast(String(msg || ''));
    hudToastTimerRef.current = setTimeout(() => {
      setHudToast(null);
      hudToastTimerRef.current = null;
    }, Math.max(800, duration));
  }, []);
  // Función para encontrar el número más cercano al toque
  const findClosestVisibleNumber = useCallback((touchX, touchY) => {
    let closestNumber = null;
    let minDistance = Infinity;

    visibleNumbersRef.current.forEach(numberData => {
      // Ignorar cubitos ya minados para interacción - USAR apiCubeNumber único
      const apiId = numberData.apiCubeNumber || faceGridToCubeNumber(numberData.faceIndex, numberData.gridX, numberData.gridY);
      if (apiId && minedCubes.has(apiId)) return;
      const dx = touchX - numberData.screenX;
      const dy = touchY - numberData.screenY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < minDistance) {
        minDistance = distance;
        closestNumber = numberData;
      }
    });

    return closestNumber;
  }, [minedCubes]);

  // Animar cámara hacia una cara específica con easing suave (rotación y distancia)
  const goToFaceCenter = useCallback((faceName, forceGridMode = false) => {
    // Configuración para ambos modos
    // FIX: Usar distancia dentro del rango de números visibles (6.6-31.1)
    // Calcular distancia desde superficie: 106.6 = distToCenter, 106.6 - 100 = 6.6 desde superficie
    // Para estar en medio del rango: (6.6 + 31.1) / 2 = 18.85 desde superficie
    // Distancia al centro: 18.85 + 100 = 118.85
    const targetDistance = forceGridMode ? 118.85 : 398.5;
    
    // Mapear caras a orientaciones (rotX, rotY)
    const faceAngles = {
      front:  { rotX: 0.0,          rotY: 0.0           },
      back:   { rotX: 0.0,          rotY: Math.PI       },
      right:  { rotX: 0.0,          rotY: -Math.PI / 2  },
      left:   { rotX: 0.0,          rotY: Math.PI / 2   },
      top:    { rotX: -Math.PI / 2, rotY: 0.0           },
      bottom: { rotX:  Math.PI / 2, rotY: 0.0           },
    };
    const target = faceAngles[faceName] || faceAngles.front;
    const start = camStateRef.current || camState;

    // Forzar modo grid si se solicita
    if (forceGridMode) {
      setRequestedFace(faceName);
      requestedFaceRef.current = faceName;
      cameraModeRef.current = 'grid';
      setCameraMode('grid');
      gridPositionRef.current = { x: 0, y: 0 };

      // CRITICAL: Actualizar activeFaceIndex INMEDIATAMENTE al hacer clic en botón
      const faceIndex = FACES.findIndex(f => f.name === faceName);
      if (faceIndex >= 0) {
        lastSetActiveFaceRef.current = faceIndex;
        setActiveFaceIndex(faceIndex);
        // Sincronizar con el sistema de detección externo
        setForcedFace(faceName);
      }
    }

    // Cancelar animación previa si existe
    if (camAnimRef.current) cancelAnimationFrame(camAnimRef.current);

    // Normalizar delta de ángulos para tomar el camino más corto
    const normAngle = (a) => {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };
    const dRotX = normAngle(target.rotX - start.rotX);
    const dRotY = normAngle(target.rotY - start.rotY);

    // ── Animación 3 fases: zoom out → rotar → zoom in ──────────────────────
    const ZOOM_OUT_DIST = 650;                          // distancia de vista completa del cubo
    const needsZoomOut = start.distance < ZOOM_OUT_DIST;
    const zoomOutDist = needsZoomOut ? ZOOM_OUT_DIST : start.distance;
    const DUR_1 = needsZoomOut ? 300 : 0;               // fase 1: zoom out
    const DUR_2 = 520;                                   // fase 2: rotación
    const DUR_3 = 420;                                   // fase 3: zoom in
    const TOTAL_DUR = DUR_1 + DUR_2 + DUR_3;

    suppressAutoGridRef.current = Date.now() + TOTAL_DUR + 700;
    lastRotationTimeRef.current = Date.now();

    const easeOut  = (t) => 1 - Math.pow(1 - t, 3);
    const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // fase actual: 1 = zoom out, 2 = rotación, 3 = zoom in
    let phase = needsZoomOut ? 1 : 2;
    let phaseStart = Date.now();

    const step = () => {
      const now = Date.now();
      const dur = phase === 1 ? DUR_1 : phase === 2 ? DUR_2 : DUR_3;
      const t = dur > 0 ? Math.min(1, (now - phaseStart) / dur) : 1;

      if (phase === 1) {
        // Zoom out + centrar pan
        const e = easeOut(t);
        setCamState((prev) => ({
          ...prev,
          distance: start.distance + (ZOOM_OUT_DIST - start.distance) * e,
          tx: start.tx * (1 - e),
          ty: start.ty * (1 - e),
        }));
      } else if (phase === 2) {
        // Rotar a la cara destino manteniendo distancia alejada
        const e = easeInOut(t);
        setCamState((prev) => ({
          ...prev,
          rotX: start.rotX + dRotX * e,
          rotY: start.rotY + dRotY * e,
          distance: zoomOutDist,
          tx: 0,
          ty: 0,
        }));
      } else {
        // Zoom in a la cara destino
        const e = easeOut(t);
        setCamState((prev) => ({
          ...prev,
          rotX: target.rotX,
          rotY: target.rotY,
          distance: zoomOutDist + (targetDistance - zoomOutDist) * e,
          tx: 0,
          ty: 0,
        }));
      }

      if (t < 1) {
        camAnimRef.current = requestAnimationFrame(step);
      } else if (phase < 3) {
        phase++;
        phaseStart = Date.now();
        camAnimRef.current = requestAnimationFrame(step);
      } else {
        camAnimRef.current = null;
      }
    };
    step();
  }, [camState, setCamState]);
  
  // Función para manejar long press
  const handleLongPress = useCallback((screenX, screenY) => {

    if (!cameraRef.current || !sceneRef.current) return;

    const sz = glSizeRef.current || { width: screenWidth, height: screenHeight };

    // PRIORIDAD 1: RAYCAST 3D (preciso al cubo tocado)
    let selectedCube = null;
    try {
      const picked = findCubeAtScreenPosition(
        screenX,
        screenY,
        cameraRef.current,
        sceneRef.current,
        sz.width,
        sz.height,
        currentLayer,
        0,
        0
      );
      const pickedApiId = picked ? (picked.apiCubeNumber || faceGridToCubeNumber(picked.faceIndex, picked.gridX, picked.gridY)) : null;
      if (picked && pickedApiId && !minedCubes.has(pickedApiId)) {
        selectedCube = picked;
      } else if (picked && pickedApiId && minedCubes.has(pickedApiId)) {
        showHudToast(t('cube.alreadyMined') || 'Ya minado');
        if (sceneRef.current && picked.worldPosition) showXAnimation(sceneRef.current, picked.worldPosition, THREE);
        return;
      }
    } catch (e) {
      console.warn('Raycast falló, usando fallback:', e.message);
    }

    // PRIORIDAD 2: Fallback con número visible más cercano (solo si raycast falló)
    const closest = findClosestVisibleNumber(screenX, screenY);
    let closestNumber = selectedCube || closest;

    // Normalizar a la cara dueña para evitar misalign en bordes/esquinas
    if (closestNumber && closestNumber.coords) {
      const c = closestNumber.coords;
      const owner = ownerFaceIndex(c.ix, c.iy, c.iz, c.K);
      if (owner >= 0) {
        // Si la cara del pick no es la dueña, recalcular grid y worldPosition
        if (closestNumber.faceIndex !== owner) {
          const { gridX: ogx, gridY: ogy } = coordToGrid(c.K, owner, c.ix, c.iy, c.iz);
          // Recalcular worldPosition en la cara dueña
          const faceGroup = faceGroupsRef.current?.[owner];
          if (faceGroup) {
            const zOffsetCubes = 0.4;
            const centerLocal = new THREE.Vector3();
            const a = ogx - c.K;
            const b = ogy - c.K;
            const fname = FACES[owner].name;
            if (fname === 'front' || fname === 'back') centerLocal.set(a, b, zOffsetCubes);
            else if (fname === 'left' || fname === 'right') centerLocal.set(zOffsetCubes, b, a);
            else centerLocal.set(a, zOffsetCubes, b);
            const centerWorld = centerLocal.clone().applyMatrix4(faceGroup.matrixWorld);
            closestNumber = {
              ...closestNumber,
              faceIndex: owner,
              gridX: ogx,
              gridY: ogy,
              worldPosition: centerWorld,
              coords: { ...c },
            };
          }
        }
      }
    }

    // USAR apiCubeNumber único para verificar si está minado
    const closestApiId = closestNumber ? (closestNumber.apiCubeNumber || faceGridToCubeNumber(closestNumber.faceIndex, closestNumber.gridX, closestNumber.gridY)) : null;
    if (closestNumber && closestApiId && !minedCubes.has(closestApiId)) {
      
      // Mostrar modal de minado
      setMiningModal({
        cubeNumber: closestNumber.cubeNumber,
        position: closestNumber.worldPosition,
        screenPos: { x: screenX, y: screenY },
        faceIndex: closestNumber.faceIndex,
        gridX: closestNumber.gridX,
        gridY: closestNumber.gridY,
        coords: closestNumber.coords,
        status: 'idle'
      });
      setSelectedCube(null);
      
      // Ya no necesitamos raycast de refinamiento porque se hizo PRIMERO
    } else if (closestNumber && closestApiId && minedCubes.has(closestApiId)) {
      showHudToast(t('cube.alreadyMined') || 'Ya minado');
      if (sceneRef.current && closestNumber.worldPosition) showXAnimation(sceneRef.current, closestNumber.worldPosition, THREE);
    } else {
        
        // Fallback: usar el primer número visible NO minado si existe
        if (!closestNumber) {
          let firstNumber = visibleNumbersRef.current.find(n => {
            const apiId = n.apiCubeNumber || faceGridToCubeNumber(n.faceIndex, n.gridX, n.gridY);
            return apiId && !minedCubes.has(apiId);
          });
          if (firstNumber) {
          } else {
          }
          
          // Normalizar también el fallback a cara dueña
          if (firstNumber && firstNumber.coords) {
            const c = firstNumber.coords;
            const owner = ownerFaceIndex(c.ix, c.iy, c.iz, c.K);
            if (owner >= 0 && owner !== firstNumber.faceIndex) {
              const { gridX: ogx, gridY: ogy } = coordToGrid(c.K, owner, c.ix, c.iy, c.iz);
              const faceGroup = faceGroupsRef.current?.[owner];
              if (faceGroup) {
                const zOffsetCubes = 0.4;
                const centerLocal = new THREE.Vector3();
                const a = ogx - c.K;
                const b = ogy - c.K;
                const fname = FACES[owner].name;
                if (fname === 'front' || fname === 'back') centerLocal.set(a, b, zOffsetCubes);
                else if (fname === 'left' || fname === 'right') centerLocal.set(zOffsetCubes, b, a);
                else centerLocal.set(a, zOffsetCubes, b);
                const centerWorld = centerLocal.clone().applyMatrix4(faceGroup.matrixWorld);
                firstNumber = { ...firstNumber, faceIndex: owner, gridX: ogx, gridY: ogy, worldPosition: centerWorld };
              }
            }
          }
          if (firstNumber) {
            setMiningModal({
              cubeNumber: firstNumber.cubeNumber,
              position: firstNumber.worldPosition,
              screenPos: { x: screenX, y: screenY },
              faceIndex: firstNumber.faceIndex,
              gridX: firstNumber.gridX,
              gridY: firstNumber.gridY,
              coords: firstNumber.coords,
              status: 'idle'
            });
          } else {
            // Fallback definitivo: raycast preciso al cubito bajo el toque
            try {
              const sz = glSizeRef.current || { width: screenWidth, height: screenHeight };
              // Usamos coordenadas locales al GLView, por lo que offset debe ser 0
              const picked = findCubeAtScreenPosition(
                screenX,
                screenY,
                cameraRef.current,
                sceneRef.current,
                sz.width,
                sz.height,
                currentLayer,
                0,
                0
              );
              if (picked) {
                setMiningModal({
                  cubeNumber: picked.cubeNumber,
                  position: picked.worldPosition,
                  screenPos: { x: screenX, y: screenY },
                  faceIndex: picked.faceIndex,
                  gridX: picked.gridX,
                  gridY: picked.gridY,
                  coords: picked.coords,
                  apiCubeNumber: picked.apiCubeNumber,
                  status: 'idle'
                });
              } else {
                console.warn('🚫 TOAST: fallback raycast also returned null');
                try { showHudToast && showHudToast(t('cube.noVisibleNumbers') || 'No visible numbers at this zoom/angle'); } catch {}
              }
            } catch (e2) {
              console.warn('🚫 TOAST (catch): fallback raycast threw', e2?.message);
              try { showHudToast && showHudToast(t('cube.noVisibleNumbers') || 'No visible numbers at this zoom/angle'); } catch {}
            }
          }
        }
      }

    // Limpiar referencias
    longPressTimer.current = null;
    longPressStartPos.current = null;
  }, [minedCubes, findClosestVisibleNumber]);
  
  // Suscripción unificada al documento del usuario: picks, cash y configuración de audio
  useEffect(() => {
    let unsubUser = null;
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      if (unsubUser) { try { unsubUser(); } catch {} unsubUser = null; }
      setAuthReady(true);
      if (!u) return;
      try {
        const ref = doc(db, 'users', u.uid);
        unsubUser = onSnapshot(ref, (snap) => {
          const data = snap.exists() ? snap.data() : {};
          setPicks(data?.picks ?? 0);
          const walletData = data && data.wallet;
          if (snap.exists() && (!walletData || walletData.balance === undefined)) {
            setDoc(ref, { wallet: { balance: 0 } }, { merge: true }).catch(() => {});
          }
          setCash(Number((walletData && walletData.balance) || 0));
          const settings = data?.settings || {};
          const music = settings.musicEnabled ?? true;
          const sound = settings.soundEnabled ?? true;
          setMusicEnabled(music);
          setSoundEnabled(sound);
          audioManager.updateSettings(music, sound);
          // Cachear nombre de usuario para historial
          const p = data?.profile || {};
          const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim()
            || p.username
            || (u.isAnonymous ? 'Jugador Anónimo' : (u.email?.split('@')[0] || 'Jugador'));
          userDisplayNameRef.current = name;
        });
      } catch (e) {
        console.warn('subscribe user doc error', e);
      }
    });
    return () => {
      try { unsubAuth(); } catch {}
      if (unsubUser) { try { unsubUser(); } catch {} }
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      miningAnimations.forEach((anim) => {
        if (anim && typeof anim.cleanup === 'function') anim.cleanup();
      });
      if (minedPollRef.current) {
        clearInterval(minedPollRef.current);
        minedPollRef.current = null;
      }
    };
  }, [miningAnimations]);
  
  // Función para mostrar solo las grietas (llamada al 50% de la barra)
  const showCracksAnimation = useCallback(async (modalData) => {
    if (!modalData || !sceneRef.current) {
      cracksPromiseRef.current = null;
      return;
    }
    
    const scene = sceneRef.current;
    const face = FACES[modalData.faceIndex];
    
    // Crear Promise que se resuelve cuando las grietas terminan
    const cracksPromise = new Promise(async (resolve) => {
      try {
        const cracks = createCrackGeometry(modalData.position, face.normal);
        
        // Agregar grietas a la escena
        const crackGroup = new THREE.Group();
        cracks.forEach(crack => {
          crackGroup.add(crack);
        });
        scene.add(crackGroup);
        cracksRef.current = { crackGroup, cracks }; // Guardar para limpieza posterior
        
        // Animar propagación de grietas
        await new Promise(resolveAnim => {
          const dur = 500;
          const start = Date.now();
          const step = () => {
            const elapsed = Date.now() - start;
            let allDone = true;
            cracks.forEach(seg => {
              const dt = Math.max(0, elapsed - (seg.userData?.delay || 0));
              const tt = Math.min(dt / dur, 1);
              seg.material.opacity = 0.3 + 0.7 * tt;
              if (!(seg.isLine || seg.isLineSegments)) {
                seg.scale.y = Math.max(0.01, tt);
              }
              if (tt < 1) allDone = false;
            });
            if (!allDone) requestAnimationFrame(step); else setTimeout(resolveAnim, 150);
          };
          step();
        });
        
        resolve();
      } catch (error) {
        console.error('Error mostrando grietas:', error);
        resolve();
      }
    });
    
    // Almacenar Promise para que startMining pueda esperarla
    cracksPromiseRef.current = cracksPromise;
    await cracksPromise;
  }, []);

  // Función para iniciar el minado (usa snapshot del modal)
  const startMining = useCallback(async (modalData, reward = 0, gem = null) => {
    if (!modalData) {
      console.warn('startMining sin modalData');
      return;
    }
    const cubeNumber = modalData.cubeNumber;
    if (!sceneRef.current) return;
    const scene = sceneRef.current;
    // Asegurar iluminación básica para materiales Lambert
    ensureLights(scene);
    
    try {
      const face = FACES[modalData.faceIndex];
      
      // FASE 0: ESPERAR a que terminen las grietas antes de limpiarlas
      if (cracksPromiseRef.current) {
        await cracksPromiseRef.current;
        cracksPromiseRef.current = null; // Limpiar referencia
      }
      
      // FASE 1: Limpiar grietas previas (ahora que terminaron)
      if (cracksRef.current) {
        const { crackGroup, cracks } = cracksRef.current;
        if (crackGroup && scene) {
          scene.remove(crackGroup);
        }
        if (cracks) {
          cracks.forEach(crack => {
            if (crack.geometry) crack.geometry.dispose();
            if (crack.material) crack.material.dispose();
          });
        }
        cracksRef.current = null;
      }
      
      // FASE 3: Aplicar parche y explotar simultáneamente
      const K = currentLayerRef.current; // usar ref para evitar closure estale
      const cellKey = `${K}:${modalData.faceIndex}:${modalData.gridX}:${modalData.gridY}`;
      try {
        if (typeof addDarkPatch === 'function') {
          minedRewardsStore.set(K, modalData.faceIndex, modalData.gridX, modalData.gridY, reward);
          addDarkPatch(modalData.faceIndex, modalData.gridX, modalData.gridY, faceGroupsRef, K, reward);
          if (typeof setMinedCubeColor === 'function') {
            setMinedCubeColor(modalData.faceIndex, modalData.gridX, modalData.gridY, faceGroupsRef);
          }
          minedAppliedRef.current.add(cellKey);
        }
      } catch (patchError) {
        console.error('Error in patch operations:', patchError.message);
      }

      // FASE 5: Explosión + pico aparecen al mismo tiempo cuando se rompe el bloque
      const hasPickReward = reward > 0;
      const hasGemReward = !!gem;

      const gemDef = hasGemReward ? GEMS[gem - 1] : null;

      try {
        audioManager.playSound('explosion', 1.0);
        if (hasPickReward || hasGemReward) audioManager.playSound('win', 1.0);
        else audioManager.playSound('lose', 1.0);
        const fragments = createFragments(modalData.position, face.normal, 1.0);
        fragments.forEach(fragment => scene.add(fragment));
        if (hasGemReward && gemDef) showGemAnimation(scene, modalData.position, THREE, gemDef);
        await Promise.all([
          animateFragments(fragments, scene, 1000, fragmentsCancelRef),
          hasPickReward
            ? showRewardAnimation(scene, modalData, reward, THREE)
            : !hasGemReward
              ? (showXAnimation(scene, modalData.position, THREE, [255, 255, 255]), Promise.resolve())
              : Promise.resolve(),
        ]);
      } catch (fragmentError) {
        console.error('Error with fragments, skipping animation:', fragmentError.message);
        await new Promise(resolve => setTimeout(resolve, 750));
      }

      if (hasPickReward || hasGemReward) {
        try {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (hasGemReward) {
            const picksLine = hasPickReward
              ? '\n' + (t('gems.picksAlso') || '+{n} picks').replace('{n}', String(reward))
              : '';
            setRewardModal({
              title: gemDef?.name ?? t('cube.congratTitle'),
              message: t('gems.found') + picksLine,
              reward,
              gem,
            });
          } else {
            const won = (t('cube.wonPicks') || '').replace('{n}', String(reward));
            setRewardModal({ title: t('cube.congratTitle'), message: won, reward, gem: null });
          }
        } catch (rewardError) {
          console.error('Error in reward animation:', rewardError.message);
        }
      }
      
      // PROTECCIÓN ANTI-CRASH: Esperar un momento antes de actualizar estado
      setTimeout(() => {
        try {
          // USAR apiCubeNumber (único) en lugar de cubeNumber (puede repetirse entre caras)
          const apiId = faceGridToCubeNumber(modalData.faceIndex, modalData.gridX, modalData.gridY);
          if (apiId) {
            // CRITICAL: Marcar como minado INMEDIATAMENTE para prevenir doble minado
            setMinedCubes(prev => { const s = new Set(prev); s.add(apiId); return s; });
          }
        } catch (stateError) {
          console.error('Error updating mined cubes state:', stateError.message);
        }
      }, 250); // Esperar 250ms para que termine la animación
      
      // NO EJECUTAR MÁS CÓDIGO DESPUÉS DE ESTE PUNTO
      return;
      
    } catch (error) {
      console.error('Error durante el minado:', error);
    }
  }, [sceneRef, rendererRef]);
  
  // FunciÃƒÂ³n para cancelar el minado
  const cancelMining = useCallback(() => {
    setMiningModal(null);
    setSelectedCube(null);
  }, []);
  
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (evt) => evt.nativeEvent.touches.length <= 2,
        onPanResponderGrant: (evt) => {
          const t = evt.nativeEvent.touches;
          if (t.length === 2) {
            // ZOOM: Guardar distancia inicial entre dedos
            const dx = t[1].pageX - t[0].pageX;
            const dy = t[1].pageY - t[0].pageY;
            pinchRef.current = Math.hypot(dx, dy);
            // Registrar cantidad de dedos activos inmediatamente
            activeTouchesRef.current = 2;
            
            // Cancelar long press si hay dos dedos
            if (longPressTimer.current) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
              longPressInitiatedRef.current = false; // Liberar bloqueo de pan
            }
            gestureZoomingRef.current = true;
          } else {
            // ROTACIÃƒâ€œN: Guardar rotaciÃ³n inicial
            pinchRef.current = null;
            // Reiniciar flag de zoom para permitir long-press en gesto de 1 dedo
            gestureZoomingRef.current = false;
            // Registrar cantidad de dedos activos inmediatamente (necesario para validaciones del long-press)
            activeTouchesRef.current = 1;
            panStartRef.current = { 
              rotX: camStateRef.current.rotX, 
              rotY: camStateRef.current.rotY 
            };
            // Cancelar inercia pendiente al iniciar nuevo gesto
            if (inertiaAnimRef.current) { cancelAnimationFrame(inertiaAnimRef.current); inertiaAnimRef.current = null; }
            panVelocityRef.current = { x: 0, y: 0 };
            lastPanMoveTimeRef.current = Date.now();
            // Inicializar última posición de toque para deltas incrementales (coordenadas locales al target)
            lastTouchPosRef.current = { x: t[0].locationX, y: t[0].locationY };
            // Empezamos rotaciÃ³n libre: asegurarnos de no forzar modo grid ni cara solicitada
            lastRotateTsRef.current = Date.now();
            // CRÍTICO: Si estamos en modo cubo, limpiar cara solicitada para permitir detección automática
            if (cameraMode === 'cube' && requestedFaceRef.current) {
              requestedFaceRef.current = null;
              setRequestedFace(null);
            }
            // No forzar modo 'cube' aquÃƒÂ­; mantener el modo actual hasta decidir por gesto/mÃƒÂ©trica
            // Extender supresiÃƒÂ³n de auto-grid mientras comienza la rotaciÃ³n
            suppressAutoGridRef.current = Date.now() + 2000;
            
            // INICIAR DETECCIÃƒâ€œN DE LONG PRESS
            const touch = t[0];
            longPressStartPos.current = {
              x: touch.locationX,
              y: touch.locationY,
              timestamp: Date.now()
            };
            // BLOQUEAR PAN INMEDIATAMENTE al iniciar detecciÃƒÂ³n de long press
            longPressInitiatedRef.current = true;
            
            // Solo detectar long press si estamos en rango de nÃƒÂºmeros (6.6-19.6 cubitos)
            const currentDistance = camStateRef.current?.distance || camState.distance;
            const tempEye = new THREE.Vector3(0, 0, currentDistance)
              .applyEuler(new THREE.Euler(camStateRef.current?.rotX || camState.rotX, -(camStateRef.current?.rotY || camState.rotY), 0));
            const tempDist = Math.max(0, tempEye.length() - 100);
            const inRange = tempDist >= (6.6 - 0.12) && tempDist <= (19.6 + 0.12 * 0.5);
            // Permitir long-press en cualquier zoom; si no hay nÃƒÂºmeros visibles, se usarÃƒÂ¡ raycast en handleLongPress
            {
              // No seleccionar aÃƒÂºn ningÃƒÂºn cubo para evitar UI de minado prematura.
              setSelectedCube(null);
              // Definir punto inicial y registrar inicio antes de programar timers
              const start = { x: touch.locationX, y: touch.locationY };
              longPressStartPos.current = start;
              // Indicador visual temprano (~250ms) para feedback inmediato de "hold"
              if (preHoldTimerRef.current) { clearTimeout(preHoldTimerRef.current); preHoldTimerRef.current = null; }
              preHoldTimerRef.current = setTimeout(() => {
                try {
                  // Only show early indicator if still exactly one finger and not zooming
                  if (gestureZoomingRef.current) return;
                  if (activeTouchesRef.current !== 1) return;
                  const curr = lastTouchPosRef.current || start;
                  const dx = (curr.x || 0) - start.x;
                  const dy = (curr.y || 0) - start.y;
                  const moved = Math.hypot(dx, dy);
                  if (moved > 18) return; // umbral ligeramente mayor para el indicador
                  setLongPressActive(true);
                } catch {}
              }, 250);
              // Iniciar long press con requisito de quietud 0.5s
              longPressTimer.current = setTimeout(() => {
                try {
                  // Verificar que no se haya convertido en gesto de zoom
                  if (gestureZoomingRef.current) return;
                  if (activeTouchesRef.current !== 1) return;
                  // Verificar que el dedo permaneció quieto dentro de un umbral pequeño
                  const curr = lastTouchPosRef.current || start;
                  const dx = (curr.x || 0) - start.x;
                  const dy = (curr.y || 0) - start.y;
                  const moved = Math.hypot(dx, dy);
                  if (moved > 16) return;

                  // Detener animación de cámara para que las coordenadas del toque sean válidas
                  if (camAnimRef.current) {
                    cancelAnimationFrame(camAnimRef.current);
                    camAnimRef.current = null;
                  }

                  // PRIORIDAD: Raycast 3D primero (preciso), luego fallback con número cercano
                  let selectedCubeData = null;
                  try {
                    const sz = glSizeRef.current || { width: screenWidth, height: screenHeight };
                    const picked = findCubeAtScreenPosition(
                      start.x,
                      start.y,
                      cameraRef.current,
                      sceneRef.current,
                      sz.width,
                      sz.height,
                      currentLayer,
                      0,
                      0
                    );
                    if (picked && picked.worldPosition && cameraRef.current) {
                      const wp = picked.worldPosition.clone();
                      const sp = wp.project(cameraRef.current);
                      const sx = (sp.x * 0.5 + 0.5) * (sz.width || screenWidth);
                      const sy = (-sp.y * 0.5 + 0.5) * (sz.height || screenHeight);
                      selectedCubeData = {
                        cubeNumber: picked.cubeNumber,
                        screenX: sx,
                        screenY: sy,
                        worldPosition: picked.worldPosition,
                        faceIndex: picked.faceIndex,
                        gridX: picked.gridX,
                        gridY: picked.gridY,
                        coords: picked.coords,
                      };
                      setSelectedCube(selectedCubeData);
                    }
                  } catch {}
                  // Fallback: número más cercano (solo si raycast falló)
                  if (!selectedCubeData) {
                    try {
                      const nearest = findClosestVisibleNumber(start.x, start.y);
                      if (nearest) {
                        setSelectedCube(nearest);
                      }
                    } catch {}
                  }
                  
                  // Asegurar indicador activo si aún no se activó por el preHold
                  setLongPressActive((v) => v || true);
                  // Programar apertura de modal 1 segundo después del long press
                  if (modalTimerRef.current) { clearTimeout(modalTimerRef.current); modalTimerRef.current = null; }
                  modalTimerRef.current = setTimeout(() => {
                    if (gestureZoomingRef.current) return; // cancelar si se convirtió en zoom
                    // Se termina la fase de long press activo al abrir el modal
                    setLongPressActive(false);
                    handleLongPress(touch.locationX, touch.locationY);
                    modalTimerRef.current = null;
                  }, 1000);
                } finally {
                  longPressTimer.current = null;
                }
              }, 500);
            }
          }
        },
        onPanResponderMove: (evt, gestureState) => {
          const t = evt.nativeEvent.touches;
          // Update touches count continuously
          activeTouchesRef.current = t.length;
          if (t.length === 2) {
            // ZOOM/PAN con 2 dedos
            const dx = t[1].pageX - t[0].pageX;
            const dy = t[1].pageY - t[0].pageY;
            const d = Math.hypot(dx, dy);
            // Marcar que este gesto es de zoom para bloquear minado
            gestureZoomingRef.current = true;
            // Cancelar cualquier long press pendiente
            if (longPressTimer.current) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
              setLongPressActive(false);
              longPressInitiatedRef.current = false; // Liberar bloqueo de pan
            }
            // Cancelar indicador temprano si existÃƒÂ­a
            if (preHoldTimerRef.current) {
              clearTimeout(preHoldTimerRef.current);
              preHoldTimerRef.current = null;
            }
            // Cancelar apertura diferida del modal si existÃƒÂ­a
            if (modalTimerRef.current) {
              clearTimeout(modalTimerRef.current);
              modalTimerRef.current = null;
            }
            setSelectedCube(null);
            // Midpoint actual de los 2 dedos
            const midX = (t[0].pageX + t[1].pageX) * 0.5;
            const midY = (t[0].pageY + t[1].pageY) * 0.5;
            const prevMid = lastTwoFingerMidRef.current || { x: midX, y: midY };
            const midDX = midX - prevMid.x;
            const midDY = midY - prevMid.y;
            lastTwoFingerMidRef.current = { x: midX, y: midY };
            
            // Si el gesto comenzÃƒÂ³ con 1 dedo y se agregÃƒÂ³ el segundo, inicializar pinchRef la primera vez
            if (pinchRef.current == null) {
              pinchRef.current = d;
              isRotatingRef.current = false; // no rotar con 2 dedos
              // Reset tracker de 1 dedo para evitar saltos al volver
              lastTouchPosRef.current = null;
            }
            const last = pinchRef.current;
            const ratio = d / last;
            
            // Zoom por pellizco
            if (Math.abs(ratio - 1) > 0.005) {
              {
                const minDist = 106.6;
                const maxDist = 3000;
                const zoomFactor = ratio > 1 ? 0.95 : 1.05;
                const nextDist = THREE.MathUtils.clamp((camStateRef.current?.distance || 300) * zoomFactor, minDist, maxDist);
                const newCamState = { ...(camStateRef.current || {}), distance: nextDist };
                camStateRef.current = newCamState;
                const _now = Date.now();
                if (_now - lastCamStateReactUpdate.current > 66) {
                  lastCamStateReactUpdate.current = _now;
                  setCamState(() => camStateRef.current);
                }
              }
              pinchRef.current = d;
              lastRotationTimeRef.current = Date.now(); // Actualizar timestamp para permitir detección de cara durante zoom
              
              // En modo grilla (<=255.2), acercar el foco hacia el centro del pellizco
              try {
                const currentDistance = camStateRef.current?.distance || camState.distance;
                const tempEye = new THREE.Vector3(0, 0, currentDistance)
                  .applyEuler(new THREE.Euler(camStateRef.current?.rotX || camState.rotX, -(camStateRef.current?.rotY || camState.rotY), 0));
                const tempDist = Math.max(0, tempEye.length() - 100);
                const inGrid = tempDist <= 255.2;
                if (inGrid && cameraRef.current) {
                  const camera = cameraRef.current;
                  const fovRad = (camera.fov || 60) * Math.PI / 180;
                  const dist = camStateRef.current?.distance || currentDistance;
                  const unitsPerPixelY = 2 * dist * Math.tan(fovRad / 2) / screenHeight;
                  const unitsPerPixelX = unitsPerPixelY * (screenWidth / screenHeight);
                  const k = Math.min(3.0, Math.abs(ratio - 1));
                  
                  // Calcular lÃƒÂ­mites para el pan durante zoom
                  const limits = calculateGridPanLimits(
                    dist, 
                    camera.fov, 
                    screenWidth, 
                    screenHeight, 
                    FACE_GRID_SIZE
                  );
                  
                  {
                    const newPos = clampGridPosition({
                      x: gridPositionRef.current.x - midDX * unitsPerPixelX * 0.5,
                      y: gridPositionRef.current.y + midDY * unitsPerPixelY * 0.5,
                    }, limits);
                    gridPositionRef.current = newPos;
                  }
                }
              } catch {}
            }
            
            // Sin pan con 2 dedos: el pan en modo grilla es con 1 dedo
            try {
              // no-op
            } catch {}
            
          } else {
            // Gesto de 1 dedo
            const touch = t[0];
            if (!touch) return;
            // Usar coordenadas locales al target para consistencia con cÃƒÂ¡lculo de nÃƒÂºmeros visibles
            const prevPos = lastTouchPosRef.current || { x: touch.locationX, y: touch.locationY };
            const dxPix = touch.locationX - prevPos.x;
            const dyPix = touch.locationY - prevPos.y;

            // CANCELAR LONG PRESS SI HAY MOVIMIENTO (umbrales mÃ¡s laxos)
            if ((longPressTimer.current || modalTimerRef.current) && longPressStartPos.current) {
              const moved = Math.hypot(dxPix, dyPix);
              if (moved > 12) {
                clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
                setLongPressActive(false);
                longPressInitiatedRef.current = false; // Liberar bloqueo de pan
                if (modalTimerRef.current) { clearTimeout(modalTimerRef.current); modalTimerRef.current = null; }
                setSelectedCube(null);
              }
              if (moved > 28) {
                clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
                longPressStartPos.current = null;
                setLongPressActive(false);
                longPressInitiatedRef.current = false; // Liberar bloqueo de pan
                setSelectedCube(null);
                if (modalTimerRef.current) { clearTimeout(modalTimerRef.current); modalTimerRef.current = null; }
              }
            }

            // 1 dedo: decidir entre pan (grilla) o rotaciÃ³n (cubo) segÃºn distancia actual (suelta lo antes posible)
            lastTouchPosRef.current = { x: touch.locationX, y: touch.locationY };
            const deadzone = 3; // px
            if (Math.abs(dxPix) + Math.abs(dyPix) < deadzone) return;
            
            // BLOQUEAR MOVIMIENTO si se inició detección de long press O si está activo
            if (longPressActive || longPressInitiatedRef.current) {
              return; // No permitir pan durante todo el proceso de long press
            }
            if (camAnimRef.current) {
              cancelAnimationFrame(camAnimRef.current);
              camAnimRef.current = null;
            }
            
            // Recalcular estado de grilla por distancia actual (usar umbral de salida para soltar rÃƒÂ¡pido)
            let isInGridMode = false;
            try {
              const cs = camStateRef.current || camState;
              const tempEye = new THREE.Vector3(0, 0, cs.distance)
                .applyEuler(new THREE.Euler(cs.rotX, -cs.rotY, 0));
              const tempDist = Math.max(0, tempEye.length() - 100);
              const EXIT_GRID_DIST = 275.0; // mismo umbral de salida que en render loop
              isInGridMode = tempDist <= EXIT_GRID_DIST;
              // Si ya estamos fuera del umbral de grilla pero cameraMode quedÃƒÂ³ pegado, soltarlo ya
              if (!isInGridMode && cameraMode === 'grid') {
                setCameraMode('cube');
                // Limpiar cara solicitada al salir de modo grid
                setRequestedFace(null);
                requestedFaceRef.current = null;
                resetFaceDetection();
              }
            } catch {}
            
            if (isInGridMode && cameraRef.current) {
              // Pan con 1 dedo sobre grilla
              // Forzar habilitaciÃƒÂ³n inmediata de grid mode durante el pan
              suppressAutoGridRef.current = 0;
              const camera = cameraRef.current;
              const fovRad = (camera.fov || 60) * Math.PI / 180;
              const dist = (camStateRef.current && camStateRef.current.distance) || camState.distance;
              const sz = glSizeRef.current || { width: screenWidth, height: screenHeight };
              const unitsPerPixelY = 2 * dist * Math.tan(fovRad / 2) / (sz.height || screenHeight);
              const unitsPerPixelX = unitsPerPixelY * ((sz.width || screenWidth) / (sz.height || screenHeight));
              const panK = 1.0; // factor de sensibilidad de pan con 1 dedo en grilla (natural como Google Maps)
              
              // Calcular lÃƒÂ­mites de pan para evitar que el cubo se vaya fuera de pantalla
              const limits = calculateGridPanLimits(
                dist, 
                camera.fov, 
                sz.width || screenWidth, 
                sz.height || screenHeight, 
                FACE_GRID_SIZE
              );
              
              {
                const nowPan = Date.now();
                const dtPan = Math.max(8, nowPan - lastPanMoveTimeRef.current);
                lastPanMoveTimeRef.current = nowPan;
                const wdx = -dxPix * unitsPerPixelX * panK;
                const wdy = dyPix * unitsPerPixelY * panK;
                // Suavizar velocidad con un promedio exponencial para evitar spikes
                panVelocityRef.current = {
                  x: panVelocityRef.current.x * 0.4 + (wdx / dtPan) * 0.6,
                  y: panVelocityRef.current.y * 0.4 + (wdy / dtPan) * 0.6,
                };
                const newPos = clampGridPosition({
                  x: gridPositionRef.current.x + wdx,
                  y: gridPositionRef.current.y + wdy,
                }, limits);
                gridPositionRef.current = newPos;
              }
              isRotatingRef.current = false;
              lastGridPanTsRef.current = Date.now();
              lastRotationTimeRef.current = Date.now(); // Actualizar timestamp para permitir detección de cara durante pan
            } else {
              // Rotación con 1 dedo — sensibilidad adaptativa según distancia de cámara
              // A mayor zoom (menor dist) la rotación se hace más precisa proporcionalmente
              const baseSensitivity = 0.008;
              const distNorm = THREE.MathUtils.clamp((camStateRef.current?.distance || 300) / 300, 0.3, 4.0);
              const sensitivity = baseSensitivity * distNorm;
              const deltaX = -dyPix * sensitivity;
              const deltaY = dxPix * sensitivity;
              lastRotateTsRef.current = Date.now();
              lastManualRotationRef.current = Date.now(); // CRÍTICO: Marcar rotación manual para limpiar requestedFace
              lastRotationTimeRef.current = Date.now(); // Actualizar timestamp para detección de cara
              isRotatingRef.current = true;
              suppressAutoGridRef.current = Date.now() + 2000;
              {
                const prev = camStateRef.current || {};
                const targetRotX = prev.rotX + deltaX;
                let targetRotY = prev.rotY + deltaY;
                targetRotY = THREE.MathUtils.euclideanModulo(targetRotY + Math.PI, Math.PI * 2) - Math.PI;
                const alpha = 0.5;
                const newCamState = {
                  ...prev,
                  rotX: prev.rotX + (targetRotX - prev.rotX) * alpha,
                  rotY: prev.rotY + (targetRotY - prev.rotY) * alpha,
                };
                camStateRef.current = newCamState;
                const _now4 = Date.now();
                if (_now4 - lastCamStateReactUpdate.current > 66) {
                  lastCamStateReactUpdate.current = _now4;
                  setCamState(() => camStateRef.current);
                }
              }
            }
          }
        },
        onPanResponderRelease: (evt) => {
          // Siempre cancelar timers de long press y modal diferido al soltar
          // Resetear indicadores de gesto y conteo de dedos activos
          try { gestureZoomingRef.current = false; } catch {}
          try { activeTouchesRef.current = 0; } catch {}
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
          if (modalTimerRef.current) {
            clearTimeout(modalTimerRef.current);
            modalTimerRef.current = null;
          }
          if (preHoldTimerRef.current) {
            clearTimeout(preHoldTimerRef.current);
            preHoldTimerRef.current = null;
          }
          longPressStartPos.current = null;
          setLongPressActive(false);
          longPressInitiatedRef.current = false; // Liberar bloqueo de pan al soltar
          setSelectedCube(null);
          
          // Actualizar referencia para prÃƒÂ³ximo gesto
          setCamState((prev) => {
            panStartRef.current = {
              rotX: prev.rotX,
              rotY: prev.rotY
            };
            return prev;
          });
          isRotatingRef.current = false;
          lastGridPanTsRef.current = 0;

          // Inercia estilo Google Maps al soltar en modo grilla
          const _inertiaInGrid = (() => {
            try {
              const cs = camStateRef.current || {};
              const eye = new THREE.Vector3(0, 0, cs.distance || 300).applyEuler(new THREE.Euler(cs.rotX || 0, -(cs.rotY || 0), 0));
              return Math.max(0, eye.length() - 100) <= 275.0;
            } catch { return false; }
          })();

          if (_inertiaInGrid) {
            if (inertiaAnimRef.current) { cancelAnimationFrame(inertiaAnimRef.current); inertiaAnimRef.current = null; }
            let vx = panVelocityRef.current.x;
            let vy = panVelocityRef.current.y;
            if (Math.hypot(vx, vy) > 0.0002) {
              const _cam = cameraRef.current;
              const _dist = camStateRef.current?.distance || 300;
              const _sz = glSizeRef.current || { width: screenWidth, height: screenHeight };
              const _limits = calculateGridPanLimits(_dist, _cam?.fov || 60, _sz.width || screenWidth, _sz.height || screenHeight, FACE_GRID_SIZE);
              let _lastT = Date.now();
              const DECAY = 0.88; // por frame a 60fps (~1.2s hasta detenerse)
              const MIN_SPEED = 0.00008;
              const inertiaStep = () => {
                const _now = Date.now();
                const _dt = Math.min(50, _now - _lastT);
                _lastT = _now;
                const decay = Math.pow(DECAY, _dt / 16.67);
                vx *= decay; vy *= decay;
                if (Math.hypot(vx, vy) < MIN_SPEED) { inertiaAnimRef.current = null; return; }
                const np = clampGridPosition({ x: gridPositionRef.current.x + vx * _dt, y: gridPositionRef.current.y + vy * _dt }, _limits);
                // Frenar al llegar a los bordes
                if (np.x === gridPositionRef.current.x) vx = 0;
                if (np.y === gridPositionRef.current.y) vy = 0;
                gridPositionRef.current = np;
                inertiaAnimRef.current = requestAnimationFrame(inertiaStep);
              };
              inertiaAnimRef.current = requestAnimationFrame(inertiaStep);
            }
          }
        },
        onPanResponderTerminate: () => {
          if (inertiaAnimRef.current) { cancelAnimationFrame(inertiaAnimRef.current); inertiaAnimRef.current = null; }
          try { activeTouchesRef.current = 0; } catch {}
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
          if (modalTimerRef.current) {
            clearTimeout(modalTimerRef.current);
            modalTimerRef.current = null;
          }
          if (preHoldTimerRef.current) {
            clearTimeout(preHoldTimerRef.current);
            preHoldTimerRef.current = null;
          }
          setLongPressActive(false);
          setSelectedCube(null);
          setCamState((prev) => {
            panStartRef.current = {
              rotX: prev.rotX,
              rotY: prev.rotY
            };
            return prev;
          });
        },
      }),
    [cameraMode, handleLongPress]
    // gridPosition eliminado: el panResponder lee gridPositionRef directamente,
    // evitando recreación del gesto 15 veces/seg durante el pan en modo grilla
  );

  // Start render loop when context is ready
  useEffect(() => {
    const startRenderLoop = () => {
      if (!rendererRef.current || !sceneRef.current || !cameraRef.current) {
        // Retry after a short delay if context isn't ready
        setTimeout(startRenderLoop, 100);
        return;
      }
      // Cancel previous animation frame
      if (animRef.current) {
        cancelAnimationFrame(animRef.current);
      }
      
      // Optimización: Throttling moderado del render loop (60 FPS máximo)
      let lastRenderTime = 0;
      const RENDER_THROTTLE_MS = 16; // 60 FPS para mayor fluidez

      // Start new render loop with updated state
      const renderLoop = () => {
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current) {
          animRef.current = requestAnimationFrame(renderLoop);
          return;
        }

        // THROTTLING: Renderizar a 60 FPS para fluidez óptima
        const now = performance.now();
        if (now - lastRenderTime < RENDER_THROTTLE_MS) {
          animRef.current = requestAnimationFrame(renderLoop);
          return;
        }
        lastRenderTime = now;
        
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        const cubeGroup = cubeGroupRef.current;
        
        // Get current camera state from ref to ensure latest values
        let { distance, rotX, rotY, tx, ty } = camStateRef.current || camState;
        const target = _sv1.set(0, 0, 0);

        // Calcular posiciÃƒÂ³n inicial de la cÃ¡mara
        let eye;

        // Calcular distancia al cubito mÃ¡s cercano ANTES de calcular eye
        const tempEye = _sv2.set(0, 0, distance)
          .applyEuler(_sEuler.set(rotX, -rotY, 0))
          .add(target);
        const tempCollisionDistance = tempEye.distanceTo(target);
        const tempDistanceToNearestCube = Math.max(0, tempCollisionDistance - 100); // 100 = radio del cubo
        // HISTERESIS de modo grilla para evitar vibraciÃƒÂ³n
        // Histeresis ajustada: entrar a grilla cuando muy cerca y salir apenas te alejas un poco
        // Estos valores estÃƒÂ¡n en "cubitos desde la superficie" (distanceToNearestCube)
        // Entrar: ~255 cubitos, Salir: ~275 cubitos (mantiene pequeÃƒÂ±a histÃƒÂ©resis de 20)
        const ENTER_GRID_DIST = 255.0;
        const EXIT_GRID_DIST = 275.0;
        let inGridByDist = false;
        if (lastGridModeRef.current) {
          inGridByDist = tempDistanceToNearestCube <= EXIT_GRID_DIST;
        } else {
          inGridByDist = tempDistanceToNearestCube <= ENTER_GRID_DIST;
        }
        lastGridModeRef.current = inGridByDist;
        const shouldUseCameraModeForCalc = inGridByDist;
        
        // NO calcular cÃ¡mara de grilla aquÃƒÂ­ para evitar duplicidad y jitter; sÃƒÂ³lo usar tempEye
        eye = tempEye;
        
        // Calcular distancia al cubito mÃ¡s cercano (superficie del cubo)
        const collisionDistance = eye.distanceTo(target);
        const distanceToNearestCube = Math.max(0, collisionDistance - 100); // 100 = radio del cubo
        
        // ELIMINAR ajuste automÃƒÂ¡tico que causaba pantalla negra
        // La cÃ¡mara puede acercarse hasta 2 cubitos sin restricciones adicionales
        
        // DecisiÃƒÂ³n de modo: en rango de grilla usar SIEMPRE grilla (pegajoso).
        // Forzar grilla durante pan activo para eliminar jitter.
        const nowTs = Date.now();
        // Extender ventana de gesto activo para mantener modo grilla estable durante el pan
        // Reducir la ventana de pegajosidad de pan en grilla para que suelte mÃ¡s rÃƒÂ¡pido
        const panActive = nowTs - (lastGridPanTsRef.current || 0) < 800;
        // CRÃƒÂTICO: Eliminar requestedFaceRef.current para evitar loop infinito
        const shouldUseCameraMode = shouldUseCameraModeForCalc || panActive;
        const stickyGrid = (cameraModeRef.current === 'grid') && shouldUseCameraModeForCalc;
        const effectiveUseCameraMode = shouldUseCameraMode || stickyGrid;

        if (effectiveUseCameraMode && cameraModeRef.current === 'cube') {
          // Guardar estado previo de la cÃ¡mara para restaurar luego
          if (!prevCamBeforeGridRef.current) {
            prevCamBeforeGridRef.current = { ...camStateRef.current };
          }
          cameraModeRef.current = 'grid';
          setCameraMode('grid');
          // Al entrar a grilla: NO recentrar pan automÃƒÂ¡ticamente para evitar "volver al inicio" mientras el usuario navega
          // CRÍTICO: Capturar la cara que estaba mirando ANTES del zoom para mantenerla en modo grilla
          if (!requestedFaceRef.current) {
            // Usar la última cara detectada como la cara "solicitada" durante el modo grilla
            const faceToKeep = lastDetectedFaceIndexRef.current ?? 0;
            const faceName = FACES[faceToKeep]?.name || 'front';
            requestedFaceRef.current = faceName;
            setRequestedFace(faceName);
            // ✅ ACTUALIZAR activeFaceIndex al entrar a modo grilla para sincronizar botones
            if (faceToKeep !== lastSetActiveFaceRef.current) {
              lastSetActiveFaceRef.current = faceToKeep;
              setActiveFaceIndex(faceToKeep);
            }
          }
        } else if (!shouldUseCameraModeForCalc && !panActive && cameraModeRef.current === 'grid') {
          cameraModeRef.current = 'cube';
          setCameraMode('cube');
          // Limpiar cara solicitada y detectada al salir de modo grilla
          // Esto permite que en el próximo zoom se detecte automáticamente la nueva cara
          setRequestedFace(null);
          requestedFaceRef.current = null;
          gridFaceRef.current = null;
          // Resetear el sistema de detección externo para permitir nueva detección
          resetFaceDetection();
          // Restaurar estado previo si existe
          if (prevCamBeforeGridRef.current) {
            const prev = prevCamBeforeGridRef.current;
            prevCamBeforeGridRef.current = null;
            setCamState((cs) => ({
              ...cs,
              rotX: prev.rotX ?? cs.rotX,
              rotY: prev.rotY ?? cs.rotY,
              distance: prev.distance ?? cs.distance,
              tx: prev.tx ?? cs.tx,
              ty: prev.ty ?? cs.ty,
            }));
          }
        }
        
        // Aplicar posiciÃƒÂ³n de cÃ¡mara segÃºn el modo actual
        if (effectiveUseCameraMode) {
          // MODO GRILLA (perpendicular a cara). Si el usuario eligiÃƒÂ³ una cara, usarla.
          const cubeCenter = _sv6.set(tx, ty, 0); // target es (0,0,0), cubeCenter = cubePosition
          let activeFace;
          if (requestedFaceRef.current) {
            activeFace = FACES.find(f => f.name === requestedFaceRef.current) || FACES[0];
            gridFaceRef.current = activeFace; // persist while en grilla
          } else {
            // Siempre detectar la cara mÃ¡s paralela a la pantalla para vista grilla Ã³ptima
            // Solo usar cara ya establecida o fallback a front
            const fallbackFace = FACES.find(f => f.name === (requestedFaceRef.current || 'front')) || FACES[0];
            activeFace = fallbackFace;
            gridFaceRef.current = activeFace;
          }

          // PROTECCIÃƒâ€œN ANTI-CRASH: Validar activeFace antes de usar
          if (!activeFace || !activeFace.normal || typeof activeFace.normal.clone !== 'function') {
            console.warn('activeFace invÃ¡lido, usando fallback');
            activeFace = FACES[0]; // Usar cara front como fallback
          }

          // Colocar la cámara en la dirección de la normal de la cara
          const cameraOffset = _sv7.copy(activeFace.normal).multiplyScalar(distance);
          // Vectores right/up en funciÃƒÂ³n de la cara para desplazar sobre la superficie (grid pan)
          const rightVector = _sv8.set(0, 0, 0);
          const upVector = _sv9.set(0, 0, 0);
          if (Math.abs(activeFace.normal.y) > 0.9) {
            // top/bottom
            rightVector.set(1, 0, 0);  // derecha = X
            upVector.set(0, 0, 1);     // arriba = Z
          } else if (Math.abs(activeFace.normal.x) > 0.9) {
            // left/right - FIX: intercambiar para que X sea horizontal, Y sea vertical
            rightVector.set(0, 0, 1);  // FIX: derecha = Z (perpendicular a la cara X)
            upVector.set(0, 1, 0);     // FIX: arriba = Y
          } else {
            // front/back
            rightVector.set(1, 0, 0);  // derecha = X
            upVector.set(0, 1, 0);     // arriba = Y
          }
          // Usar gridPositionRef para evitar valores obsoletos
          const gp = gridPositionRef.current || { x: 0, y: 0 };
          const gridOffset = _sv10.copy(rightVector).multiplyScalar(gp.x)
            .addScaledVector(upVector, gp.y);

          const eyeGrid = _sv11.copy(cubeCenter).add(cameraOffset).add(gridOffset);
          const lookTarget = _sv12.copy(cubeCenter).add(gridOffset);
          camera.position.copy(eyeGrid);
          camera.lookAt(lookTarget);
        } else {
          // MODO CUBO: Aplicar posiciÃƒÂ³n esfÃƒÂ©rica normal
          camera.position.copy(eye);
          camera.lookAt(target);
        }

        // Aplicar pan: en modo grilla, mover el cubo bajo la cÃ¡mara para recorrer la cara completa
        const clampPan = (v) => THREE.MathUtils.clamp(v, -2000, 2000);
        // En modo grilla NO movemos el cubo; la cÃ¡mara se desplaza con gridOffset
        cubeGroup.position.set(clampPan(tx), clampPan(ty), 0);

        // DYNAMIC FACE CULLING + LOD: Only show faces that point toward camera
        const camDir = _sv3.subVectors(camera.position, target).normalize();
        const currentlyVisible = [];
        let totalCubes = 0;
        
        // Calcular distancia para LOD (Level of Detail)
        const distanceFromCenter = camera.position.distanceTo(target);
        
        // Detectar si debe mostrar números entre 6.6 y 100 de zoom
        const EPS = 0.12; // ~12cm de tolerancia en unidades de cubito
        const minZoom = 6.6; // Solo mostrar desde zoom 6.6 (cerca)
        const maxZoom = 25;
        // PROTECCIÃƒâ€œN ANTI-CRASH: No crear números si hay animaciones de minado activas
        const hasActiveAnimations = miningAnimations && miningAnimations.size > 0;
        // IMPORTANTE: NO forzar números fuera del rango de zoom, incluso si hay cara seleccionada
        const shouldShowNumbers = !hasActiveAnimations && (distanceToNearestCube >= (minZoom - EPS) && distanceToNearestCube <= (maxZoom + EPS));
        
        // Optimización: Logs eliminados del render loop para mejor rendimiento
        
        // Array para almacenar números visibles
        const currentVisibleNumbers = [];
        
        // PRIMERA PASADA: Detectar cara más visible usando findClosestFaceFixed
        // Usar sistema único y robusto que ya tiene estabilización
        const detectedFace = findClosestFaceFixed(camera.position, cubeGroup.position);
        const mostVisibleFaceIndex = detectedFace.index;

        // SEGUNDA PASADA: Guardar estado de face culling para cada cara
        for (let faceIndex = 0; faceIndex < faceGroupsRef.current.length; faceIndex++) {
          const faceGroup = faceGroupsRef.current[faceIndex];
          const faceData = FACES[faceIndex];
          
          // Face culling - calcular dot product para determinar visibilidad
          const faceNormal = _sv4.copy(faceData.normal).applyMatrix4(cubeGroup.matrixWorld).normalize();
          const cameraDirection = _sv5.subVectors(camera.position, cubeGroup.position).normalize();
          const dotProduct = faceNormal.dot(cameraDirection);
          
          // Umbral más estricto: solo caras directamente enfrentadas
          const shouldShow = dotProduct > 0.5;
          // FIX: NO ocultar faceGroup completo - los cubos (blancos/negros) deben verse SIEMPRE
          faceGroup.visible = true; // SIEMPRE visible para que los cubos se vean
          
          // Guardar estado de face culling en userData para usarlo en control de sprites
          faceGroup.userData.facingCamera = shouldShow;
        }
        
        // Determinar cara final (detectedFace ya tiene estabilización integrada)
        let finalFaceIndex = mostVisibleFaceIndex;
        const currentTime = Date.now();
        
        // CRÍTICO: Solo usar cara forzada si estamos EN MODO GRID
        // En modo cubo, SIEMPRE usar la cara detectada automáticamente
        if (requestedFaceRef.current && cameraModeRef.current === 'grid') {
          const requestedIndex = FACES.findIndex(f => f.name === requestedFaceRef.current);
          if (requestedIndex >= 0) {
            finalFaceIndex = requestedIndex;
          }
        }
        
        // Sincronizar lastDetectedFaceIndexRef para sistema de zoom (CRÍTICO para entrar a modo grid con la cara correcta)
        lastDetectedFaceIndexRef.current = finalFaceIndex;
        
        // ⚠️ CRÍTICO: SIEMPRE sincronizar activeFaceIndex con finalFaceIndex
        // finalFaceIndex ya tiene la lógica correcta:
        // - En modo grid con botón: usa requestedFaceRef (línea 2875)
        // - En otros casos: usa detección automática (línea 2867)
        if (finalFaceIndex !== lastSetActiveFaceRef.current) {
          lastSetActiveFaceRef.current = finalFaceIndex;
          setActiveFaceIndex(finalFaceIndex);
        }
        
        // USAR finalFaceIndex para renderizar
        // finalFaceIndex ya contiene la cara correcta:
        // - Si hay requestedFaceRef: fue establecido en línea 2875
        // - Si no hay requestedFaceRef: es la cara detectada automáticamente
        const stableMostVisibleFaceIndex = finalFaceIndex;
        
        // SEGUNDA PASADA: Renderizar números y controlar visibilidad
        for (let faceIndex = 0; faceIndex < faceGroupsRef.current.length; faceIndex++) {
          const faceGroup = faceGroupsRef.current[faceIndex];
          const faceData = FACES[faceIndex];
          const shouldShow = faceGroup.userData.facingCamera || false;
          
          if (shouldShow) {
            const cubesMesh = faceGroup.userData.simpleMesh.children[1];
            const cubeNumbers = cubesMesh.userData.cubeNumbers;
            const GRID_SIZE = cubesMesh.userData?.GRID_SIZE || (2*currentLayerRef.current+1);
            const indexByGrid = cubesMesh.userData?.indexByGrid;
            currentlyVisible.push(faceGroup.userData.name);
            totalCubes += (cubeNumbers?.length || 0);

            // SISTEMA OPTIMIZADO: Solo renderizar números de la CARA ACTIVA
            // No renderizar números de caras secundarias aunque sean visibles
            // FIX: Usar stableMostVisibleFaceIndex (estabilizado) en lugar de cambiar entre caras
            const isActiveFace = (stableMostVisibleFaceIndex === faceIndex);
            
            // 🔍 DEBUG: Log para cada cara
            if (isActiveFace) {
            }
            
            if (shouldShowNumbers && isActiveFace && cubeNumbers && indexByGrid) {
              if (!faceGroup.userData.numberMeshes) {
                faceGroup.userData.numberMeshes = [];
              }

              // Calcular regiÃƒÂ³n visible en la grilla 2D a partir de esquinas de pantalla
              const corners = _sCorners; // pre-allocated, no modificar los vectores
              const faceInverse = _sMat4.copy(faceGroup.matrixWorld).invert();
              let minX = GRID_SIZE, maxX = -1, minY = GRID_SIZE, maxY = -1;

              // SISTEMA DE FRANJAS DE ZOOM: Configuración dinámica de ventana según distancia
              // Cada franja define: [zoomMax, ancho, alto]
              // Se aplica la configuración cuyo rango incluye la distancia actual
              const zoomBands = [
                { maxZoom: 11.8, width: 4, height: 7 },      // 6.6 → 11.8
                { maxZoom: 23.0, width: 8, height: 15 },     // 11.8 → 23
                { maxZoom: 35.0, width: 12, height: 26 },    // 23 → 35
                { maxZoom: 50.0, width: 24, height: 50 },    // 35 → 50 (24×50 completo)
                { maxZoom: 70.0, width: 32, height: 64 },    // 50 → 70 (32×64 completo)
                { maxZoom: 999, width: 40, height: 60 }      // 70 → 100+ (espaciados)
              ];
              
              // Encontrar la configuración de ventana para este zoom
              let windowConfig = zoomBands[zoomBands.length - 1]; // Default: más lejano
              for (const band of zoomBands) {
                if (distanceToNearestCube <= band.maxZoom) {
                  windowConfig = band;
                  break;
                }
              }
              
              const halfWidth = Math.floor(windowConfig.width / 2);
              const halfHeight = Math.floor(windowConfig.height / 2);
              
              const mid = currentLayerRef.current + 0.5;
              corners.forEach(corner => {
                _sv1.copy(corner).unproject(camera).applyMatrix4(faceInverse);
                const gridX = Math.floor(_sv1.x + mid);
                const gridY = Math.floor(_sv1.y + mid);
                // Ventana dinámica según franja de zoom
                minX = Math.min(minX, gridX - halfWidth);
                maxX = Math.max(maxX, gridX + halfWidth);
                minY = Math.min(minY, gridY - halfHeight);
                maxY = Math.max(maxY, gridY + halfHeight);
              });

              // Clamp a límites válidos
              minX = Math.max(0, minX);
              maxX = Math.min(GRID_SIZE - 1, maxX);
              minY = Math.max(0, minY);
              maxY = Math.min(GRID_SIZE - 1, maxY);

              // Step: densidad basada en distancia de zoom
              // Hasta zoom 70: mostrar TODOS (step=1)
              // Zoom 70-100: empezar a espaciar gradualmente
              const step = distanceToNearestCube > 70 ? Math.max(1, Math.floor(distanceToNearestCube / 25)) : 1;
              
              // LÍMITE DINÁMICO: Calcular cuántos números caben realmente en la ventana visible
              const visibleWidth = (maxX - minX + 1);
              const visibleHeight = (maxY - minY + 1);
              const numbersPerRow = Math.ceil(visibleWidth / step);
              const numbersPerCol = Math.ceil(visibleHeight / step);
              const maxNumbers = Math.min(2000, numbersPerRow * numbersPerCol + 50); // +50 margen de seguridad

              // OPTIMIZACIÓN: Saltar reconstrucción si viewport no cambió
              const minedCount = minedCubes ? minedCubes.size : 0;
              const vpKey = `${minX}_${maxX}_${minY}_${maxY}_${step}_${minedCount}`;
              if (faceGroup.userData.lastVpKey === vpKey && faceGroup.userData.numberMeshes.length > 0) {
                // Viewport idéntico y ya hay meshes — no reconstruir, pero reusar números cacheados
                if (faceGroup.userData.cachedVisibleNumbers) {
                  for (const n of faceGroup.userData.cachedVisibleNumbers) currentVisibleNumbers.push(n);
                }
              } else {
              const faceNumbers = [];
              faceGroup.userData.lastVpKey = vpKey;
              // Limpiar meshes anteriores antes de reconstruir (pool: sin dispose)
              faceGroup.userData.numberMeshes.forEach(mesh => _numMeshPool.release(mesh));
              faceGroup.userData.numberMeshes = [];

              let numbersCreated = 0;

              // Iterar por región visible en 2D (no secuencial)
              for (let gridY = minY; gridY <= maxY && numbersCreated < maxNumbers; gridY += step) {
                for (let gridX = minX; gridX <= maxX && numbersCreated < maxNumbers; gridX += step) {
                  const inst = indexByGrid[gridY * GRID_SIZE + gridX];
                  if (inst < 0) continue; // celda no pertenece a esta cara (arista/esquina de otra cara)
                  const rawCubeNumber = cubeNumbers[inst];
                  // PROTECCIÃƒâ€œN ANTI-CRASH EXTREMA: Validar y convertir a nÃƒÂºmero seguro
                  let cubeNumberAsc;
                  try {
                    if (typeof rawCubeNumber === 'number' && isFinite(rawCubeNumber) && !isNaN(rawCubeNumber)) {
                      cubeNumberAsc = rawCubeNumber;
                    } else if (typeof rawCubeNumber === 'string' && rawCubeNumber.trim() !== '') {
                      cubeNumberAsc = parseFloat(rawCubeNumber);
                      if (!isFinite(cubeNumberAsc) || isNaN(cubeNumberAsc)) {
                        continue; // Saltar si no se puede convertir
                      }
                    } else {
                      continue; // Saltar cualquier otro tipo (object, null, undefined, etc.)
                    }
                  } catch (conversionError) {
                    console.warn('Error converting cube number:', rawCubeNumber, conversionError.message);
                    continue;
                  }
                  // USAR apiCubeNumber (ÃƒÂºnico por cara) para verificar si estÃƒÂ¡ minado
                  const apiId = faceGridToCubeNumber(faceIndex, gridX, gridY);
                  const isMined = apiId ? minedCubes.has(apiId) : false;
                  
                  // DEBUG: Logging para verificar independencia de caras
                  if (isMined && (faceIndex === 0 || faceIndex === 1)) {
                  }

                  // PosiciÃƒÂ³n 3D del cubito (centro local)
                  const _cl2 = currentLayerRef.current;
                  const x = (gridX - _cl2) * 1.0;
                  const y = (gridY - _cl2) * 1.0;
                  _sv1.set(x, y, 0.5).applyMatrix4(faceGroup.matrixWorld);
                  const worldPos = _sv1;

                  // Verificar si realmente estÃƒÂ¡ en pantalla
                  _sv2.copy(worldPos).project(camera);
                  const screenPos = _sv2;
                  // NDC visible si x,y en [-1,1] y z en [-1,1]
                  const isVisible = screenPos.z >= -1 && screenPos.z <= 1 &&
                                    screenPos.x >= -1.0 && screenPos.x <= 1.0 &&
                                    screenPos.y >= -1.0 && screenPos.y <= 1.0;

                  if (isVisible) {
                    // Convertir a coordenadas de pantalla relativas a GLView y luego sumar offset de GLView
                    const szNow = glSizeRef.current || { width: screenWidth, height: screenHeight, x: 0, y: 0 };
                    // Coordenadas de pantalla relativas al GLView (locales), sin sumar offsets globales
                    const screenX = (screenPos.x * 0.5 + 0.5) * szNow.width;
                    const screenY = (-screenPos.y * 0.5 + 0.5) * szNow.height;

                    // Guardar informaciÃƒÂ³n del nÃƒÂºmero visible (incluir coords 3D para normalizaciÃƒÂ³n)
                    const coords = (()=>{
                      // Inferir coords desde face y grid
                      const a = gridX - _cl2;
                      const b = gridY - _cl2;
                      let ix=0,iy=0,iz=0;
                      switch(faceData.name){
                        case 'front':  iz = _cl2; ix = a; iy = b; break;
                        case 'back':   iz = -_cl2; ix = -a; iy = b; break;
                        case 'right':  ix = _cl2; iz = -a; iy = b; break;
                        case 'left':   ix = -_cl2; iz = a; iy = b; break;
                        case 'top':    iy = _cl2; ix = a; iz = -b; break;
                        case 'bottom': iy = -_cl2; ix = a; iz = b; break;
                      }
                      return { ix, iy, iz, K: _cl2 };
                    })();
                    const visEntry = {
                      cubeNumber: cubeNumberAsc,
                      apiCubeNumber: apiId,
                      screenX,
                      screenY,
                      worldPosition: new THREE.Vector3().copy(worldPos),
                      faceIndex,
                      gridX,
                      gridY,
                      coords
                    };
                    currentVisibleNumbers.push(visEntry);
                    faceNumbers.push(visEntry);

                    // PROTECCIÃƒâ€œN ANTI-CRASH: Validar completamente antes de crear textura
                    let numberTexture = null;
                    try {
                      // ValidaciÃƒÂ³n exhaustiva del nÃƒÂºmero
                      if (typeof cubeNumberAsc === 'number' && isFinite(cubeNumberAsc) && !isNaN(cubeNumberAsc)) {
                        const safeNumber = Math.floor(Math.abs(cubeNumberAsc));
                        if (safeNumber >= 0 && safeNumber <= 999999999) { // LÃƒÂ­mite razonable
                          numberTexture = isMined
                            ? createNumberTexture(safeNumber, { transparentBackground: true, digitColor: [200,200,200,255] })
                            : createNumberTexture(safeNumber, { transparentBackground: false, digitColor: [0,0,0,255] });
                        }
                      }
                    } catch (textureError) {
                      console.warn('Error creating number texture:', textureError.message);
                      numberTexture = null;
                    }
                    
                    // 🔍 DEBUG: Verificar si la textura se creó correctamente (solo primera vez)
                    if (numbersCreated === 0) {
                    }
                    
                    const numberMesh = _numMeshPool.acquire();
                    const _nm = numberMesh.material;
                    _nm.map = numberTexture || null;
                    _nm.color.setHex(numberTexture ? 0xffffff : (isMined ? 0x888888 : 0x000000));
                    _nm.opacity = isMined ? 0.9 : 1.0;
                    _nm.depthTest = !isMined;
                    _nm.depthWrite = !isMined;
                    _nm.needsUpdate = true;
                    numberMesh.renderOrder = isMined ? 10001 : 0;
                    numberMesh.position.set(x, y, isMined ? 0.505 : 0.5);
                    numberMesh.visible = true;
                    faceGroup.add(numberMesh);
                    faceGroup.userData.numberMeshes.push(numberMesh);
                    numbersCreated++;
                  }
                }
              }
              faceGroup.userData.cachedVisibleNumbers = faceNumbers;
              } // fin else (viewport cambió)

            } else {
              // Limpiar números cuando no se deben mostrar (fuera de zoom o cara no activa)
              if (faceGroup.userData.numberMeshes && faceGroup.userData.numberMeshes.length > 0) {
                faceGroup.userData.numberMeshes.forEach(mesh => _numMeshPool.release(mesh));
                faceGroup.userData.numberMeshes = [];
                faceGroup.userData.lastVpKey = null; // forzar rebuild al volver
                faceGroup.userData.cachedVisibleNumbers = null;
              }
            }
          } else {
            // Si la cara no es visible, también limpiar sus números
            if (faceGroup.userData.numberMeshes && faceGroup.userData.numberMeshes.length > 0) {
              faceGroup.userData.numberMeshes.forEach(mesh => _numMeshPool.release(mesh));
              faceGroup.userData.numberMeshes = [];
              faceGroup.userData.lastVpKey = null;
              faceGroup.userData.cachedVisibleNumbers = null;
            }
          }
        }
        
        // Optimización: Viewport culling solo cada 3 frames para mejor rendimiento
        cullingFrameCounter.current++;
        const shouldDoCulling = cullingFrameCounter.current % 3 === 0;
        
        if (shouldDoCulling) {
          // Controlar visibilidad de sprites SOLO EN CARA ACTIVA
          for (let faceIndex = 0; faceIndex < faceGroupsRef.current.length; faceIndex++) {
          const faceGroup = faceGroupsRef.current[faceIndex];
          const isActiveFace = (stableMostVisibleFaceIndex === faceIndex);
          const isFacingCamera = faceGroup.userData.facingCamera || false;
          const shouldShowSprites = shouldShowNumbers && isFacingCamera && isActiveFace;
          
          // OPTIMIZACIÓN: Para caras inactivas, ocultar todos los sprites de una vez SIN iterar
          if (!isActiveFace || !shouldShowSprites) {
            // Ocultar todos los sprites de esta cara sin procesamiento individual
            if (faceGroup.userData.minedPatches) {
              faceGroup.userData.minedPatches.forEach(patch => {
                if (patch && typeof patch.visible !== 'undefined') patch.visible = false;
              });
            }
            if (faceGroup.userData.minedNumberSprites) {
              faceGroup.userData.minedNumberSprites.forEach(sprite => {
                if (sprite && typeof sprite.visible !== 'undefined') sprite.visible = false;
              });
            }
            if (faceGroup.userData.rewardIndicators) {
              faceGroup.userData.rewardIndicators.forEach(sprite => {
                if (sprite && typeof sprite.visible !== 'undefined') sprite.visible = false;
              });
            }
            continue; // ✅ Saltar al siguiente faceIndex sin hacer culling costoso
          }
          
          // SOLO PARA CARA ACTIVA: Hacer viewport culling preciso (usa scratch para evitar allocations)
          // Controlar parches grises oscuros de celdas minadas
          if (faceGroup.userData.minedPatches) {
            faceGroup.userData.minedPatches.forEach((patch) => {
              if (patch && typeof patch.visible !== 'undefined') {
                patch.getWorldPosition(_sv3);
                _sv4.copy(_sv3).project(camera);
                patch.visible = _sv4.z >= -1 && _sv4.z <= 1 &&
                                _sv4.x >= -1.1 && _sv4.x <= 1.1 &&
                                _sv4.y >= -1.1 && _sv4.y <= 1.1;
              }
            });
          }

          // Controlar números grises de celdas minadas
          if (faceGroup.userData.minedNumberSprites) {
            faceGroup.userData.minedNumberSprites.forEach((sprite) => {
              if (sprite && typeof sprite.visible !== 'undefined') {
                sprite.getWorldPosition(_sv3);
                _sv4.copy(_sv3).project(camera);
                sprite.visible = _sv4.z >= -1 && _sv4.z <= 1 &&
                                 _sv4.x >= -1.1 && _sv4.x <= 1.1 &&
                                 _sv4.y >= -1.1 && _sv4.y <= 1.1;
              }
            });
          }

          // Controlar indicadores de premio (X y picos)
          if (faceGroup.userData.rewardIndicators) {
            faceGroup.userData.rewardIndicators.forEach((sprite) => {
              if (sprite && typeof sprite.visible !== 'undefined') {
                sprite.getWorldPosition(_sv3);
                _sv4.copy(_sv3).project(camera);
                sprite.visible = _sv4.z >= -1 && _sv4.z <= 1 &&
                                 _sv4.x >= -1.1 && _sv4.x <= 1.1 &&
                                 _sv4.y >= -1.1 && _sv4.y <= 1.1;
              }
            });
          }
        }
        }
        
        // Debug: log caras visibles si hay cambios
        if (currentlyVisible.length !== visibleFaces.length) {
        }
        
        // Actualizar ref de números visibles cada frame (sin re-render)
        visibleNumbersRef.current = currentVisibleNumbers;

        // Actualizar estado de UI a ~2fps (solo lo que la UI necesita renderizar)
        try {
          const now = Date.now();
          if (!lastStateUpdate.current || now - lastStateUpdate.current > 500) {
            if (Array.isArray(currentlyVisible) && typeof totalCubes === 'number' &&
                typeof distanceToNearestCube === 'number') {
              if (currentlyVisible.length !== visibleFaces.length ||
                  Math.abs(distanceToNearestCube - realDistance) > 0.5) {
                setVisibleFaces([...currentlyVisible]);
                setRenderCount(Math.floor(totalCubes));
                setRealDistance(parseFloat(distanceToNearestCube));
              }
              lastStateUpdate.current = now;
            }
          }
        } catch (stateError) {
          console.warn('Error updating UI state:', stateError.message);
        }

        // PROTECCIÃƒâ€œN ANTI-CRASH: Verificar que el componente sigue montado
        if (!rendererRef.current || !sceneRef.current || !cameraRef.current) {
          console.warn('Render loop stopped: component unmounted');
          return;
        }

        try {
          // CRÍTICO: Forzar viewport correcto ANTES de cada render
          // Three.js puede sobrescribir el viewport, así que lo forzamos aquí
          const gl = glRef.current;
          if (gl && gl.viewport) {
            const w = gl.drawingBufferWidth || screenWidth;
            const h = gl.drawingBufferHeight || screenHeight;
            
            // Forzar viewport de Three.js Y de WebGL
            renderer.setViewport(0, 0, w, h);
            gl.viewport(0, 0, w, h);
          }
          
          renderer.render(scene, camera);
          if (glRef.current) {
            glRef.current.endFrameEXP();
          }
        } catch (renderError) {
          console.error('Render error:', renderError.message);
          return; // Detener render loop si hay error
        }

        // PROTECCIÃƒâ€œN: Solo continuar si no hay errores crÃƒÂ­ticos
        animRef.current = requestAnimationFrame(renderLoop);
      };
      
      renderLoop();
    };
    
    startRenderLoop();
    
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      fragmentsCancelRef.current = true;
    };
  }, []); // Solo ejecutar una vez, usar camStateRef para valores actuales

  const onContextCreate = async (gl) => {
    try {
      glRef.current = gl;
      
      const renderer = new Renderer({ gl, antialias: false }); // Desactivar antialiasing para mejor rendimiento
      
      // Pixel ratio fijo: expo-three ya trabaja en coordenadas del drawing buffer
      renderer.setPixelRatio(1);
      
      // Usar el drawing buffer para el tamaño interno inicial del renderer (evita offsets)
      const rbw = gl.drawingBufferWidth || screenWidth;
      const rbh = gl.drawingBufferHeight || screenHeight;
      
      renderer.setSize(rbw, rbh, false);
      
      // CRÍTICO: Configurar viewport de Three.js para que use toda la pantalla
      renderer.setViewport(0, 0, rbw, rbh);
      renderer.setClearColor(0x000000, 1);
      
      
      // Configuraciones de rendimiento para móvil
      if (gl && gl.getParameter) {
        try {
          gl.disable(gl.DITHER); // Desactivar dithering
        } catch {}
      }
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000); // Fondo negro para integrarse con pantalla completa
      sceneRef.current = scene;

      // IMPORTANTE: Usar drawing buffer para el aspect ratio de la cámara
      const camera = new THREE.PerspectiveCamera(45, Math.max(0.0001, rbw / rbh), 1, 5000);
      camera.position.set(0, 0, camState.distance);
      camera.lookAt(0, 0, 0); // CRÍTICO: La cámara debe mirar al centro del cubo
      camera.updateProjectionMatrix();
      cameraRef.current = camera;
      
      // CRÍTICO: Establecer viewport inicial con el drawing buffer (YA escalado)
      gl.viewport(0, 0, rbw, rbh);

      const light = new THREE.AmbientLight(0xffffff, 1.0);
      scene.add(light);

      const cubeGroup = cubeGroupRef.current;
      scene.add(cubeGroup);

      // Creador de capa K
      const buildLayer = (K) => {
        // Limpiar capa anterior e invalidar cache de raycast
        invalidateIntersectablesCache();
        while (cubeGroup.children.length) {
          const ch = cubeGroup.children.pop();
          cubeGroup.remove(ch);
        }
        const faceGroups = [];
        for (let faceIndex=0; faceIndex<FACES.length; faceIndex++){
          const faceInfo = FACES[faceIndex];
          const { simpleMesh, borderMesh, createDetailedMesh, faceIndex: idx } = createFaceInstancesForLayer(K, faceIndex);
          const faceGroup = new THREE.Group();
          faceGroup.add(borderMesh);
          faceGroup.add(simpleMesh);

          // PosiciÃƒÂ³n: +/-K segÃºn normal
          const n = faceInfo.normal.clone();
          const pos = n.clone().multiplyScalar(K);
          faceGroup.position.copy(pos);
          // RotaciÃƒÂ³n para mirar hacia fuera
          if (faceInfo.name === 'front') {
            // +Z
          } else if (faceInfo.name === 'back') {
            faceGroup.rotation.y = Math.PI;
          } else if (faceInfo.name === 'right') {
            faceGroup.rotation.y = Math.PI / 2;
          } else if (faceInfo.name === 'left') {
            faceGroup.rotation.y = -Math.PI / 2;
          } else if (faceInfo.name === 'top') {
            faceGroup.rotation.x = -Math.PI / 2;
          } else if (faceInfo.name === 'bottom') {
            faceGroup.rotation.x = Math.PI / 2;
          }

          faceGroup.userData = {
            name: faceInfo.name,
            normal: faceInfo.normal.clone(),
            simpleMesh,
            borderMesh,
            createDetailedMesh,
            detailedMesh: null,
            isDetailed: false,
            layerK: K,
          };
          cubeGroup.add(faceGroup);
          faceGroups.push(faceGroup);
        }
        faceGroupsRef.current = faceGroups;
        // NumeraciÃƒÂ³n global por shell K (continua y sin duplicados)
        const shellBelow = (k) => {
          let s = 0;
          for (let t=0; t<k; t++) s += shellSize(t);
          return s;
        };
        let cursor = shellBelow(K) + 1;
        const faceOrder = ['front','right','back','left','top','bottom'];
        for (const faceName of faceOrder){
          const faceGroup = faceGroups.find(g => g.userData.name === faceName);
          if (!faceGroup) continue;
          // cubes mesh es el hijo [1] de simpleMesh
          let cubesMesh = null;
          try { cubesMesh = faceGroup.userData?.simpleMesh?.children?.[1] || faceGroup.children?.[1]?.children?.[1]; } catch {}
          if (!cubesMesh) continue;
          const GRID_SIZE = cubesMesh.userData?.GRID_SIZE || (2*K+1);
          const indexByGrid = cubesMesh.userData?.indexByGrid;
          const numbers = cubesMesh.userData?.cubeNumbers;
          if (!indexByGrid || !numbers) continue;
          for (let gy=0; gy<GRID_SIZE; gy++){
            for (let gx=0; gx<GRID_SIZE; gx++){
              const inst = indexByGrid[gy*GRID_SIZE + gx];
              if (inst >= 0) {
                numbers[inst] = cursor++;
              }
            }
          }
          // guardar de nuevo
          cubesMesh.userData.cubeNumbers = numbers;
        }
      };

      // Construir capa inicial
      buildLayer(currentLayer);
      buildLayerRef.current = buildLayer;

      // Calcular y cachear rangos descendentes por cara de la capa actual
      try { recomputeFaceRanges(); } catch {}

      // Obtener rango descendente por cara (usar cache real si estÃƒÂ¡ disponible; si no, fallback fijo por cara externa)
      const CUBES_PER_FACE = 40401;
      const getFaceRange = (faceIndex) => {
        const cached = faceRangesRef.current?.[faceIndex];
        if (cached && typeof cached.start === 'number' && typeof cached.end === 'number') return cached;
        const faceStart = DISPLAY_START - (faceIndex * CUBES_PER_FACE);
        const faceEnd = faceStart - (CUBES_PER_FACE - 1);
        return { start: faceStart, end: faceEnd };
      };

      // Initial render will be handled by useEffect
    } catch (error) {
      console.error('Error creating 3D scene:', error);
    }
  };

  // Función para posicionar cámara perpendicular a una cara CON ANIMACIÓN
  const viewFace = (faceName) => {
    // Limpiar cara anterior si existe para permitir cambio
    if (requestedFaceRef.current && requestedFaceRef.current !== faceName) {
      setRequestedFace(null);
      requestedFaceRef.current = null;
    }
    // Usar goToFaceCenter con modo grid activado para animación suave
    goToFaceCenter(faceName, true); // true = forceGridMode
  };

  // Obtener rango ACTUAL por cara en numeraciÃƒÂ³n ascendente directamente desde la escena
  const getFaceRange = (faceIndex) => {
    try {
      const faceGroupEntry = faceGroupsRef.current?.[faceIndex];
      if (!faceGroupEntry) return { start: 0, end: 0 };
      const cubesMesh = faceGroupEntry.userData?.simpleMesh?.children?.[1]
        || faceGroupEntry.children?.[1]?.children?.[1];
      const numbers = cubesMesh?.userData?.cubeNumbers;
      if (!numbers || !numbers.length) return { start: 0, end: 0 };
      let minAsc = Infinity;
      let maxAsc = -Infinity;
      for (let i = 0; i < numbers.length; i++) {
        const v = numbers[i];
        if (typeof v !== 'number') continue;
        if (v < minAsc) minAsc = v;
        if (v > maxAsc) maxAsc = v;
      }
      if (!isFinite(minAsc) || !isFinite(maxAsc)) return { start: 0, end: 0 };
      return { start: minAsc, end: maxAsc };
    } catch {
      return { start: 0, end: 0 };
    }
  };

  return (
    <View style={styles.container}>
      {isFocused && (
      <GLView
        key={`gl-${focusKey}`}
        style={styles.gl}
        onContextCreate={onContextCreate}
        {...panResponder.panHandlers}
        onLayout={(e) => {
          try {
            const { width, height, x = 0, y = 0 } = e.nativeEvent.layout;
            glSizeRef.current = { width, height, x, y };
            
            // Sincronizar renderer/viewport/cámara con el drawing buffer actual
            if (width > 0 && height > 0) {
              syncRendererSize();
            }
          } catch {}
        }}
      />)}

      {/* overlay de debug eliminado */}

      {/* Indicador gris flotante del cubito seleccionado antes del modal */}
      {selectedCube && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: Math.round(selectedCube.screenX) - 14,
            top: Math.round(selectedCube.screenY) - 14,
            width: 28,
            height: 28,
            borderRadius: 6,
            backgroundColor: 'rgba(128,128,128,0.35)',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.6)'
          }}
        />
      )}

      
      
      {/* Panel de control de caras - esquina superior derecha */}
      <View style={styles.facePanel}>
        {[
          ['front', 'back'],
          ['left', 'right'],
          ['top', 'bottom'],
        ].map((row, rIdx) => (
          <View key={`row-${rIdx}`} style={styles.faceRow}>
            {row.map((fname) => {
              const index = FACES.findIndex(f => f.name === fname);
              const range = getFaceRange(index);
              const isActiveFace = activeFaceIndex === index;
              return (
                <TouchableOpacity
                  key={fname}
                  style={[
                    styles.faceButton,
                    isActiveFace && styles.activeFaceButton
                  ]}
                  onPress={() => viewFace(fname)}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.faceName, isActiveFace && styles.activeFaceName]}>{fname.toUpperCase()}</Text>
                  <Text style={styles.faceRange}>{range.start.toLocaleString()}</Text>
                  <Text style={styles.faceRange}>{range.end.toLocaleString()}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      <View style={styles.hud} pointerEvents="box-none">
        {/* Barra superior: Hamburguesa + Picos */}
        <View style={styles.topRow}>
          <TouchableOpacity style={styles.hamburgerBtn} onPress={() => setMenuOpen(true)}>
            <Text style={styles.hamburgerTxt}>☰</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.picksWrap} onPress={() => { try { openModal('peaks'); } catch(e) {} }} activeOpacity={0.8}>
            <Text style={styles.picksTxt}>⛏ x {typeof picks === 'number' ? picks : '...'}</Text>
          </TouchableOpacity>
          <View style={styles.moneyWrap}>
            <Text style={styles.moneyTxt}>${(Number(cash) || 0).toFixed(2)}</Text>
          </View>
        </View>
        {/* HUD minimal: Distance, Layer, Mined */}
        <Text style={styles.stats}>{t('cube.hudDistance')}: {realDistance.toFixed(1)}</Text>
        <Text style={styles.stats}>{t('cube.hudLayer')}: {currentLayer}</Text>
        <Text style={styles.stats}>{t('cube.hudMined')}: {minedCubes.size}</Text>
        <Text style={styles.stats}>{t('cube.hudRemaining')}: {Math.max(0, shellSize(currentLayer) - Number(layerMinedCount || 0))}</Text>
        <Text style={styles.stats}>{t('cube.hudLayerMined')}: {layerMinedCount}</Text>
        <Text style={styles.stats}>{t('cube.hudTotalMined')}: {totalMinedAllLayers}</Text>
        {hudToast && (
          <Text style={[styles.stats, { color: '#0a84ff', fontWeight: 'bold' }]}>
            {hudToast}
          </Text>
        )}
        {longPressActive && (
          <Text style={[styles.stats, { color: '#ff6600', fontWeight: 'bold' }]}> 
            {t('cube.longPressActive')}
          </Text>
        )}
        
        {/* Botones de control */}
        <View style={styles.controlsRow}>
          {/* Controles opcionales eliminados segÃºn pedido: Test Call y mÃƒÂ©tricas visuales */}
        </View>
        {/* Leyenda de premios iniciados removida por requerimiento */}
      </View>

      {/* MenÃƒÂº Modal */}
      <Modal transparent visible={menuOpen} animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableWithoutFeedback onPress={() => setMenuOpen(false)}>
          <View style={styles.menuOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.menuCard}>
                <Text style={styles.menuTitle}>{t('cube.menuTitle')}</Text>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    try { openModal('profile'); } catch { Alert.alert(t('cube.errorTitle'), t('cube.menuProfile')); }
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.menuItemTxt}>{t('cube.menuProfile')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    try { openModal('peaks'); } catch { Alert.alert(t('cube.errorTitle'), t('cube.menuPeaks')); }
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.menuItemTxt}>{t('cube.menuPeaks')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    setHowToPlayVisible(true);
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.menuItemTxt}>{t('cube.menuHowToPlay')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    try { openModal('config'); } catch { Alert.alert(t('cube.errorTitle'), t('cube.menuConfig')); }
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.menuItemTxt}>{t('cube.menuConfig')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuItem}
                  onPress={async () => {
                    try {
                      setMenuOpen(false);
                      await signOut(auth);
                    } catch (e) {
                      Alert.alert(t('cube.signOutErrorTitle'), t('cube.signOutErrorBody'));
                    }
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.menuItemTxt}>{t('cube.menuSignOut')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.menuItem, { marginTop: 8 }]} onPress={() => setMenuOpen(false)} activeOpacity={0.8}>
                  <Text style={[styles.menuItemTxt, { color: '#666' }]}>{t('cube.menuClose')}</Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
      
      {/* Modal "Cómo se juega?" */}
      <Modal
        transparent={true}
        visible={howToPlayVisible}
        animationType="fade"
        onRequestClose={() => setHowToPlayVisible(false)}
      >
        <View style={styles.menuOverlay}>
          <View style={styles.howToPlayWrapper}>
            <ScrollView 
              style={styles.howToPlayContainer}
              contentContainerStyle={styles.howToPlayContent}
              showsVerticalScrollIndicator={true}
              scrollEnabled={true}
              bounces={true}
            >
                <Text style={styles.howToPlayTitle}>{t('cube.howToPlayTitle')}</Text>
                
                <Text style={styles.howToPlayWelcome}>{t('cube.howToPlayWelcome')}</Text>
                <Text style={styles.howToPlayText}>{t('cube.howToPlayCubeSize')}</Text>
                
                <Text style={styles.howToPlaySubtitle}>{t('cube.howToPlayHowTitle')}</Text>
                
                <Text style={styles.howToPlayText}>{t('cube.howToPlayDaily')}</Text>
                <Text style={styles.howToPlayText}>{t('cube.howToPlayPick')}</Text>
                
                <Text style={styles.howToPlayTextBold}>{t('cube.howToPlayChooseFace')}</Text>
                <Text style={styles.howToPlayText}>{t('cube.howToPlaySlide')}</Text>
                <Text style={styles.howToPlayText}>{t('cube.howToPlayChangeFace')}</Text>
                <Text style={styles.howToPlayText}>{t('cube.howToPlayButtons')}</Text>
                
                <Text style={styles.howToPlayTextBold}>{t('cube.howToPlayMining')}</Text>

                {/* ===== PYRAMID ===== */}
                <Text style={styles.howToPlaySubtitle}>{t('cube.howToPlayPyramidTitle')}</Text>
                <View style={{ alignItems: 'flex-start', marginBottom: 8 }}>
                  {[
                  { layers: '100–98', widthPct: '100%', bg: '#1c1200', border: '#8B6914', color: '#f0c040', prize: '⛏️ 283,241 picks' },
                  { layers: '97–0',  widthPct: '88%',  bg: '#0a1a0a', border: '#2e7d32', color: '#6dbf67', prize: '$15 · $25 · $50 · $100 · $500 + picks' },
                  { layers: '80–60', widthPct: '73%',  bg: '#090920', border: '#1a3a9f', color: '#6699ff', prize: '$1,000 ×50' },
                  { layers: '60–50', widthPct: '57%',  bg: '#130920', border: '#6611bb', color: '#bb77ff', prize: '$10,000 ×5' },
                  { layers: '50–30', widthPct: '40%',  bg: '#1f0808', border: '#aa1133', color: '#ff6688', prize: '$50,000 ×1' },
                  { layers: '30–0',  widthPct: '24%',  bg: '#2a0000', border: '#ff2200', color: '#ff6633', prize: '$100,000 ×1' },
                ].map((z, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
                      <Text style={{ width: 44, color: '#777', fontSize: 9, fontWeight: '700', textAlign: 'right', marginRight: 6 }}>{z.layers}</Text>
                      <View style={{ width: z.widthPct, backgroundColor: z.bg, borderWidth: 1, borderColor: z.border, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 6 }}>
                        <Text style={{ color: z.color, fontSize: 10, fontWeight: '700' }}>{z.prize}</Text>
                      </View>
                    </View>
                  ))}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
                    <Text style={{ width: 44, color: '#777', fontSize: 9, fontWeight: '700', textAlign: 'right', marginRight: 6 }}>0</Text>
                    <View style={{ width: '10%', backgroundColor: '#0a0005', borderWidth: 1, borderColor: '#440088', borderRadius: 5, paddingVertical: 5, paddingHorizontal: 6, alignItems: 'center' }}>
                      <Text style={{ color: '#8833cc', fontSize: 9, fontWeight: '900' }}>◆ CORE</Text>
                    </View>
                  </View>
                </View>

                {/* ===== GEMS ===== */}
                <Text style={styles.howToPlaySubtitle}>{t('cube.howToPlayGemsTitle')}</Text>
                <Text style={styles.howToPlayText}>{t('cube.howToPlayGemsSub')}</Text>
                {(() => {
                  const GEM_PRIZES = [100000, 50000, 10000, 1000, 500, 100, 50, 25, 15];
                  return GEMS.map((gem) => (
                    <View key={gem.tier} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a1a', borderRadius: 10, borderWidth: 1, borderColor: gem.borderColor + '66', padding: 8, marginBottom: 6, gap: 8 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 7, backgroundColor: gem.glowColor + '33', borderWidth: 1, borderColor: gem.borderColor + '88', alignItems: 'center', justifyContent: 'center' }}>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 20, height: 20 }}>
                          {gem.palette.slice(1).map((col, ci) => (
                            <View key={ci} style={{ width: 4, height: 4, backgroundColor: col, opacity: 1 - ci * 0.15 }} />
                          ))}
                        </View>
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                          <Text style={{ color: gem.sparkleColor, fontWeight: '800', fontSize: 12 }}>{language === 'en' ? gem.nameEn : gem.name}</Text>
                          <View style={{ borderRadius: 5, borderWidth: 1, borderColor: gem.borderColor + '88', backgroundColor: gem.glowColor + '22', paddingHorizontal: 4, paddingVertical: 1 }}>
                            <Text style={{ color: gem.sparkleColor, fontSize: 9, fontWeight: '800' }}>${GEM_PRIZES[gem.tier - 1].toLocaleString()}</Text>
                          </View>
                        </View>
                        <Text style={{ color: '#888', fontSize: 10 }}>×{gem.quantityPerServer.toLocaleString()} / server</Text>
                      </View>
                    </View>
                  ));
                })()}

                <Text style={styles.howToPlayText}>{t('cube.howToPlayShuffle')}</Text>
                <Text style={styles.howToPlayLuck}>{t('cube.howToPlayLuck')}</Text>
                
                <TouchableOpacity 
                  style={[styles.menuItem, { marginTop: 16, backgroundColor: '#1a1a1a' }]} 
                  onPress={() => setHowToPlayVisible(false)} 
                  activeOpacity={0.8}
                >
                  <Text style={[styles.menuItemTxt, { color: '#666' }]}>{t('cube.menuClose')}</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
      </Modal>
      
      {/* Modal de minado - 3 píldoras flotantes */}
      {miningModal && (
        <Modal
          transparent={true}
          visible={true}
          animationType="none"
          onRequestClose={cancelMining}
        >
          <View style={styles.modalOverlay}>
            {/* PÃƒÂ­ldora principal */}
            <View
              style={[
                styles.pill,
                styles.mainPill,
                {
                  left: Math.max(16, Math.min(screenWidth - 200, miningModal.screenPos.x - 100)),
                  top: Math.max(64, Math.min(screenHeight - 180, miningModal.screenPos.y - 70))
                }
              ]}
            >
              <Text style={styles.pillTitle}>
                {miningModal.status === 'mining' ? t('cube.miningTitle') : t('cube.mineQuestion')}
              </Text>
              <Text style={styles.pillSubtitle}>#{miningModal.cubeNumber}</Text>
              {miningModal.status === 'mining' && (
                <View style={{ width: 160, height: 8, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.12)', marginTop: 10, overflow: 'hidden' }}>
                  <View style={{ width: Math.max(8, Math.min(160, 160 * miningProgress)), height: 8, backgroundColor: '#22c55e' }} />
                </View>
              )}
            </View>

            {/* Píldora NO */}
            <TouchableOpacity
              style={[
                styles.pill,
                styles.noPill,
                {
                  left: Math.max(10, Math.min(screenWidth - 100, miningModal.screenPos.x - 130)),
                  top: Math.max(120, Math.min(screenHeight - 120, miningModal.screenPos.y + 16))
                }
              ]}
              onPress={miningModal.status === 'mining' ? undefined : cancelMining}
              activeOpacity={0.85}
            >
              <Text style={styles.noText}>{t('cube.no')}</Text>
            </TouchableOpacity>

            {/* Píldora YES */}
            <TouchableOpacity
              style={[
                styles.pill,
                styles.yesPill,
                {
                  left: Math.max(10, Math.min(screenWidth - 100, miningModal.screenPos.x + 30)),
                  top: Math.max(120, Math.min(screenHeight - 120, miningModal.screenPos.y + 16))
                }
              ]}
              onPress={async () => {
                // CRÍTICO: Bloquear si ya está minando para evitar doble click
                if (miningModal.status === 'mining') {
                  return;
                }
                
                if (isGuest) {
                  openModal('registration');
                  return;
                }
                if (!authReady) {
                  Alert.alert(t('cube.waitTitle'), t('cube.connectingBody'));
                  showHudToast(t('cube.toastConnecting'));
                  return;
                }
                if (typeof picks === 'number' && picks <= 0) {
                  Alert.alert(t('cube.noPicksTitle'), t('cube.noPicksBody'));
                  showHudToast(t('cube.toastNoPicks'));
                  return;
                }
                // Capturar snapshot del modal para usarlo en la animaciÃƒÂ³n
                const modalData = miningModal ? { ...miningModal } : null;
                // Marcar celda en animación local
                try {
                  if (modalData && typeof modalData.faceIndex === 'number' && typeof modalData.gridX === 'number' && typeof modalData.gridY === 'number') {
                    const key = `${currentLayer}:${modalData.faceIndex}:${modalData.gridX}:${modalData.gridY}`;
                    pendingAnimCellsRef.current.add(key);
                  }
                } catch {}
                // Iniciar UI de Mining...
                setMiningProgress(0);
                if (miningProgressTimerRef.current) {
                  clearInterval(miningProgressTimerRef.current);
                  miningProgressTimerRef.current = null;
                }
                setMiningModal((prev) => prev ? { ...prev, status: 'mining' } : prev);
                // Iniciar watchdog para evitar que el modal quede congelado
                if (miningWatchdogRef.current) {
                  clearTimeout(miningWatchdogRef.current);
                  miningWatchdogRef.current = null;
                }
                miningWatchdogRef.current = setTimeout(() => {
                  try {
                    console.warn('⏰ Watchdog: forzando cierre del modal de minado por timeout');
                    setMiningModal(null);
                  } catch {}
                }, 30000); // 30s de seguridad
                roturaPlayedRef.current = false; // Reset flag para rotura
                miningProgressTimerRef.current = setInterval(() => {
                  setMiningProgress((p) => {
                    const np = p + 0.06;

                    // Reproducir rotura.m4a a la mitad de la barra (50%), cerrar modal 150ms después, luego iniciar grietas
                    if (np >= 0.5 && !roturaPlayedRef.current) {
                      roturaPlayedRef.current = true;
                      audioManager.playSound('rotura', 1.0);

                      // Cerrar modal 150ms después para transición suave y que se vean las grietas
                      setTimeout(async () => {
                        try { setMiningModal(null); } catch {}
                        // Guardar contra doble llamado si la API ya inició las grietas primero
                        if (!cracksPromiseRef.current && !cracksRef.current) {
                          await showCracksAnimation(modalData);
                        }
                      }, 150);
                    }

                    return np >= 0.95 ? 0.95 : np;
                  });
                  return;
                }, 120);
                try {
                  // Asegurar apiCubeNumber vÃƒÂ¡lido (derivar si falta)
                  let apiId = modalData?.apiCubeNumber;
                  if (apiId == null && typeof modalData?.faceIndex === 'number' && typeof modalData?.gridX === 'number' && typeof modalData?.gridY === 'number') {
                    apiId = faceGridToCubeNumber(modalData.faceIndex, modalData.gridX, modalData.gridY);
                  }
                  if (apiId == null) {
                    throw new Error('Invalid cube selection (missing apiCubeNumber)');
                  }

                  // Llamar API con timeout de seguridad (8s)
                  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
                    const to = setTimeout(() => reject(new Error('timeout')), ms);
                    p.then((v) => { clearTimeout(to); resolve(v); }).catch((e) => { clearTimeout(to); reject(e); });
                  });

                  // SOLUCIÓN EFICIENTE: Marcar como minado ANTES de llamar API
                  // Esto previene doble-clic/race condition sin cargar todas las caras
                  if (minedCubes.has(apiId)) {
                    console.warn('⛔ YA MINADO (cache local) - apiId:', apiId);
                    throw new Error('Cube already mined');
                  }
                  
                  // MARCAR COMO MINADO INMEDIATAMENTE (antes de API)
                  setMinedCubes(prev => { const s = new Set(prev); s.add(apiId); return s; });
                  
                  const resp = await withTimeout(callMineCube(apiId, serverId), 30000); // 30 segundos para operaciones lentas
                  
                  if (resp && resp.alreadyMined === true) {
                    setMiningModal(null);
                    showHudToast(t('cube.alreadyMined') || 'Ya minado');
                  } else if (resp && resp.ok === true) {
                    let finalReward = Number(resp?.reward || 0);
                    const finalGem = resp?.gem || null; // null or 1-9

                    // CRÍTICO: Si finalReward es NaN, forzar a 0
                    if (isNaN(finalReward)) {
                      finalReward = 0;
                    }
                    
                    const newTotalMined = totalMinedCount + 1;
                    setTotalMinedCount(newTotalMined);
                    
                    // Recompensas ahora vienen del backend (1-5 picos según capa)
                    // No generar recompensas locales - confiar 100% en el backend
                    
                    // Detener barra y forzar a 100%
                    if (miningProgressTimerRef.current) { clearInterval(miningProgressTimerRef.current); miningProgressTimerRef.current = null; }
                    setMiningProgress(1);
                    // Siempre cerrar el modal aquí (cubre el caso donde la API retornó rápido
                    // antes de que la barra llegara al 50% y el 50%-handler nunca se disparó)
                    setMiningModal(null);
                    // Si las grietas todavía no arrancaron (API retornó antes del 50%), iniciarlas ahora
                    if (!cracksPromiseRef.current && !cracksRef.current) {
                      showCracksAnimation(modalData); // sin await — startMining esperará la Promise
                    }
                    // Esperar un momento para que las grietas sean visibles antes de la explosión
                    await new Promise((r) => setTimeout(r, 250));
                    await startMining(modalData, finalReward, finalGem);
                    // Liberar pendingAnimCells para que Firestore pueda aplicar el parche si startMining falló
                    try {
                      if (modalData && typeof modalData.faceIndex === 'number') {
                        const ck = `${currentLayer}:${modalData.faceIndex}:${modalData.gridX}:${modalData.gridY}`;
                        pendingAnimCellsRef.current.delete(ck);
                      }
                    } catch {}
                    // Guardar en Firestore: stats del usuario, registro del minado y recompensas
                    try {
                      const uid = auth?.currentUser?.uid;
                      if (uid) {
                        const minesCol = collection(db, 'users', uid, 'mines');
                        const mineDoc = {
                          apiCubeNumber: apiId,
                          cubeNumber: modalData?.cubeNumber ?? null,
                          faceIndex: modalData?.faceIndex ?? null,
                          gridX: modalData?.gridX ?? null,
                          gridY: modalData?.gridY ?? null,
                          layerK: modalData?.coords?.K ?? null,
                          rewardPicks: Number(finalReward || 0), // CRÍTICO: Usar finalReward calculado localmente, no el del backend
                          rewardCash: Number(resp?.cash || resp?.rewardCash || 0),
                          alreadyMined: !!resp?.alreadyMined,
                          minedAt: serverTimestamp(),
                        };
                        // Crear registro individual del minado
                        try { await addDoc(minesCol, mineDoc); } catch {}

                        // Actualizar agregados del usuario
                        const userRef = doc(db, 'users', uid);
                        const updates = {
                          updatedAt: serverTimestamp(),
                          'stats.totalMined': increment(1),
                          'stats.totalRewardPicks': increment(Number(resp?.reward || 0)),
                          'stats.totalRewards': increment(Number(resp?.cash || resp?.rewardCash || 0)),
                          'stats.lastMine': { apiCubeNumber: apiId, cubeNumber: modalData?.cubeNumber ?? null },
                        };
                        // Contadores por capa/cara
                        if (typeof mineDoc.layerK === 'number') {
                          updates['stats.lastReward'] = { type: 'cash', amount: rewardCash, at: serverTimestamp() };
                        }
                        await setDoc(userRef, updates, { merge: true });

                        // Registrar entrada de rewards (picks/cash) si hubo
                        const rewardsCol = collection(db, 'users', uid, 'rewards');
                        if ((Number(finalReward || 0) > 0) || (rewardCash > 0)) {
                          const rewardDoc = {
                            apiCubeNumber: apiId,
                            cubeNumber: mineDoc.cubeNumber,
                            picks: Number(finalReward || 0), // CRÍTICO: Usar finalReward para consistencia
                            cash: rewardCash,
                            createdAt: serverTimestamp(),
                            source: 'mineCube',
                          };
                          try { await addDoc(rewardsCol, rewardDoc); } catch {}
                        }
                      }
                    } catch (e) {
                      console.warn('Failed to persist mine to Firestore', e);
                    }

                    // Escribir en historial de la cadena con número secuencial permanente
                    try {
                      const chainId = resp?.chainId || activeServer?.chainId || null;
                      if (chainId) {
                        const uid = auth?.currentUser?.uid;
                        // Contador en subcol separada para no tocar el doc principal (bloqueado por reglas)
                        const counterRef = doc(db, 'serverChains', chainId, 'meta', 'counter');
                        const historyColRef = collection(db, 'serverChains', chainId, 'history');

                        // Evento de minado — transacción atómica garantiza seq único y continuo
                        try {
                          await runTransaction(db, async (tx) => {
                            const counterSnap = await tx.get(counterRef);
                            const seq = ((counterSnap.exists() ? counterSnap.data()?.seq : 0) || 0) + 1;
                            const histRef = doc(historyColRef);
                            tx.set(histRef, {
                              type: 'mine',
                              seq,
                              ts: serverTimestamp(),
                              uid: uid || null,
                              displayName: userDisplayNameRef.current,
                              cubeNumber: modalData?.cubeNumber ?? null,
                              apiCubeNumber: apiId ?? null,
                              layerK: modalData?.coords?.K ?? currentLayer,
                              episodeNumber: resp?.episodeNumber ?? null,
                              serverId: serverId ?? null,
                              rewardPicks: Number(finalReward || 0),
                              rewardCash: Number(resp?.cash || resp?.rewardCash || 0),
                            });
                            tx.set(counterRef, { seq }, { merge: true });
                          });
                        } catch (e) {
                          console.warn('Failed to write mine history entry', e);
                        }

                        // Si el episodio terminó, registrar cierre con el siguiente número
                        if (resp?.episodeComplete) {
                          try {
                            await runTransaction(db, async (tx) => {
                              const counterSnap = await tx.get(counterRef);
                              const seq = ((counterSnap.exists() ? counterSnap.data()?.seq : 0) || 0) + 1;
                              const histRef = doc(historyColRef);
                              tx.set(histRef, {
                                type: 'episode_complete',
                                seq,
                                ts: serverTimestamp(),
                                uid: uid || null,
                                displayName: userDisplayNameRef.current,
                                episodeNumber: resp?.episodeNumber ?? null,
                                serverId: serverId ?? null,
                                totalMined: totalMinedCount + 1,
                              });
                              tx.set(counterRef, { seq }, { merge: true });
                            });
                          } catch (e) {
                            console.warn('Failed to write episode_complete history entry', e);
                          }
                        }
                      }
                    } catch (e) {
                      console.warn('Failed to write chain history', e);
                    }

                    // Actualizar picos si hay premio local
                    if (finalReward > 0 && Number(resp?.reward || 0) === 0) {
                      try {
                        const uid = auth?.currentUser?.uid;
                        if (uid) {
                          const userRef = doc(db, 'users', uid);
                          await setDoc(userRef, { picks: increment(finalReward) }, { merge: true });
                        }
                      } catch (e) {
                        console.warn('Error updating local reward:', e);
                      }
                    }

                    if (finalReward > 0) {
                      const msg = (t('cube.toastReward') || '').replace('{n}', String(finalReward));
                      showHudToast(msg);
                    } else {
                      showHudToast(t('cube.toastMinedOk'));
                    }

                    if (resp?.episodeComplete) {
                      setTimeout(() => {
                        setEpisodeCompleteModal({
                          episodeNumber: resp.episodeNumber ?? null,
                          totalMined: newTotalMined,
                        });
                      }, 1200);
                    }
                  } else {
                    console.warn('mineCube returned not ok', resp);
                    const msg = (t('cube.invalidResponse') || '').replace('{msg}', JSON.stringify(resp));
                    Alert.alert(t('cube.errorTitle'), msg);
                    showHudToast(t('cube.serverErrorToast'));
                  }
                } catch (e) {
                  console.error('❌ ERROR calling mineCube:', e);
                  console.error('❌ Error details:', { 
                    message: e?.message, 
                    code: e?.code, 
                    stack: e?.stack?.substring(0, 200) 
                  });
                  try {
                    const code = e?.code || (e?.message === 'timeout' ? 'timeout' : 'unknown');
                    const msg = e?.message || String(e);
                    if (String(msg).startsWith('rate_limited:')) {
                      const secs = String(msg).split(':')[1] || '2';
                      showHudToast((t('cube.rateLimitToast') || 'Esperá {s}s').replace('{s}', secs));
                    } else if (String(code).includes('permission-denied')) {
                      openModal('registration');
                    } else {
                      const human = code === 'timeout' ? (t('cube.timeoutBody') || 'Network timeout. Please try again.') : `${code}: ${msg}`;
                      Alert.alert(t('cube.serverErrorTitle'), human);
                      if (String(code).includes('No picks')) {
                        showHudToast(t('cube.toastNoPicks'));
                      } else if (code === 'timeout') {
                        showHudToast(t('cube.timeoutToast') || 'Request timed out');
                      } else {
                        showHudToast(t('cube.serverErrorToast'));
                      }
                    }
                  } catch {
                    Alert.alert(t('cube.serverErrorTitle'), t('cube.serverErrorToast'));
                    showHudToast(t('cube.serverErrorToast'));
                  }
                  // Solo liberar pendingAnimCellsRef en caso de ERROR (para permitir reintentos)
                  try {
                    if (modalData && typeof modalData.faceIndex === 'number' && typeof modalData.gridX === 'number' && typeof modalData.gridY === 'number') {
                      const key = `${currentLayer}:${modalData.faceIndex}:${modalData.gridX}:${modalData.gridY}`;
                      pendingAnimCellsRef.current.delete(key);
                    }
                  } catch {}
                } finally {
                  if (miningProgressTimerRef.current) {
                    clearInterval(miningProgressTimerRef.current);
                    miningProgressTimerRef.current = null;
                  }
                  // pendingAnimCellsRef se elimina tras startMining (caso exitoso) o aquí (caso error)
                }
              }}
              activeOpacity={0.85}
            >
              <Text style={[styles.yesText, (typeof picks === 'number' && picks <= 0) ? { opacity: 0.5 } : null]}>
                {miningModal.status === 'mining' ? 'Working...' : 'YES ⛏'}
              </Text>
            </TouchableOpacity>
          </View>
        </Modal>
      )}

      {/* Modal de Recompensa */}
      {rewardModal && (
        <Modal
          transparent={true}
          visible={true}
          animationType="fade"
          onRequestClose={() => setRewardModal(null)}
        >
          <View style={styles.rewardOverlay}>
            <View style={[
              styles.rewardModal,
              rewardModal.gem && {
                borderColor: GEMS[rewardModal.gem - 1]?.borderColor ?? 'rgba(255,255,255,0.25)',
                borderWidth: 2,
              },
            ]}>
              {rewardModal.gem ? (
                <>
                  <GemPixelArt gemIndex={rewardModal.gem} />
                  <Text style={styles.rewardTitle}>{rewardModal.title}</Text>
                  {rewardModal.message ? (
                    <Text style={styles.rewardMessage}>{rewardModal.message}</Text>
                  ) : null}
                </>
              ) : (
                <>
                  <Text style={styles.rewardTitle}>🎉 {rewardModal.title}</Text>
                  <Text style={styles.rewardMessage}>{rewardModal.message}</Text>
                  <View style={styles.rewardPicksContainer}>
                    <Text style={styles.rewardPicksText}>⛏ +{rewardModal.reward}</Text>
                  </View>
                </>
              )}
              <TouchableOpacity
                style={styles.rewardButton}
                onPress={() => setRewardModal(null)}
                activeOpacity={0.8}
              >
                <Text style={styles.rewardButtonText}>OK</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
      
      {/* Modal: Episodio completado */}
      {episodeCompleteModal && (
        <Modal
          transparent
          visible
          animationType="fade"
          onRequestClose={() => setEpisodeCompleteModal(null)}
        >
          <View style={styles.rewardOverlay}>
            <View style={[styles.rewardModal, { borderColor: '#ffd700', borderWidth: 2 }]}>
              <Text style={{ fontSize: 48, textAlign: 'center', marginBottom: 8 }}>🏆</Text>
              <Text style={[styles.rewardTitle, { color: '#ffd700' }]}>
                {t('cube.episodeCompleteTitle')}
              </Text>
              {episodeCompleteModal.episodeNumber != null && (
                <Text style={styles.rewardMessage}>
                  {t('cube.episodeCompleteMsg').replace('{n}', episodeCompleteModal.episodeNumber)}
                </Text>
              )}
              <Text style={[styles.rewardMessage, { color: '#888', marginTop: 4 }]}>
                {t('cube.episodeMined').replace('{n}', (episodeCompleteModal.totalMined || 0).toLocaleString())}
              </Text>
              <TouchableOpacity
                style={[styles.rewardButton, { backgroundColor: '#ffd700', marginTop: 18 }]}
                onPress={() => {
                  setEpisodeCompleteModal(null);
                  try { navigation.navigate('ServerList'); } catch {}
                }}
                activeOpacity={0.85}
              >
                <Text style={[styles.rewardButtonText, { color: '#000' }]}>
                  {t('cube.nextChainBtn')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.rewardButton, { backgroundColor: 'transparent', marginTop: 8 }]}
                onPress={() => setEpisodeCompleteModal(null)}
                activeOpacity={0.8}
              >
                <Text style={[styles.rewardButtonText, { color: '#666' }]}>
                  {t('cube.menuClose')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* Botones de Zoom - parte inferior central */}
      {showGridExitHint && (
        <View style={styles.gridExitHintBox} pointerEvents="none">
          <Text style={styles.gridExitHintTxt}>Presioná − de nuevo para salir</Text>
        </View>
      )}
      <View style={styles.zoomPanel}>
        <TouchableOpacity
          style={[styles.zoomButton, showGridExitHint && styles.zoomButtonHighlight]}
          onPress={() => handleZoomButton(-1)}
          activeOpacity={0.75}
        >
          <Text style={styles.zoomButtonText}>-</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.zoomButton}
          onPress={() => handleZoomButton(1)}
          activeOpacity={0.75}
        >
          <Text style={styles.zoomButtonText}>+</Text>
        </TouchableOpacity>
      </View>
      
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#000' },
  gl: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hud: { position: 'absolute', left: 12, right: 12, top: 28, zIndex: 10 },
  label: { color: '#000', fontSize: 12, marginBottom: 4 },
  stats: { color: '#666', fontSize: 13, fontWeight: '700', marginBottom: 2 },
  hamburgerBtn: { alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 6, marginBottom: 6 },
  hamburgerTxt: { fontSize: 22, fontWeight: '900', color: '#666' },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  picksWrap: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.06)' },
  picksTxt: { fontSize: 14, fontWeight: '900', color: '#666' },
  moneyWrap: { marginLeft: 6, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.06)' },
  moneyTxt: { fontSize: 14, fontWeight: '900', color: '#666' },
  // MenÃƒÂº hamburguesa
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuCard: {
    width: 220,
    backgroundColor: '#333333',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  menuTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#666',
    marginBottom: 10,
    textAlign: 'center',
  },
  menuItem: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#333333',
    marginTop: 8,
  },
  menuItemTxt: {
    fontSize: 15,
    fontWeight: '700',
    color: '#666',
    textAlign: 'center',
  },
  
  // Controles mejorados
  controlsRow: {
    position: 'absolute', 
    right: 14, 
    bottom: 18,
    flexDirection: 'row',
    gap: 8
  },
  controlBtn: {
    backgroundColor: 'rgba(0,0,0,0.06)', 
    paddingHorizontal: 12, 
    paddingVertical: 8,
    borderRadius: 14, 
    borderWidth: 1, 
    borderColor: 'rgba(0,0,0,0.2)'
  },
  controlBtnActive: {
    backgroundColor: 'rgba(100,200,255,0.3)',
    borderColor: 'rgba(0,100,200,0.4)'
  },
  controlTxt: { 
    color: '#000', 
    fontSize: 12, 
    fontWeight: '600',
    textAlign: 'center'
  },
  controlTxtActive: {
    color: '#0066cc'
  },
  
  // Botones de zoom - parte inferior central
  zoomPanel: {
    position: 'absolute',
    bottom: 18,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
  },
  zoomButton: {
    backgroundColor: '#333333',
    borderColor: '#333333',
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 6,
    minWidth: 83,
    alignItems: 'center',
  },
  zoomButtonHighlight: {
    borderColor: '#ff9900',
    borderWidth: 2,
  },
  gridExitHintBox: {
    position: 'absolute',
    bottom: 72,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 12,
  },
  gridExitHintTxt: {
    color: '#ff9900',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
  },
  zoomButtonText: {
    color: '#666',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
  },
  
  // Zoom bar inferior, centrada (legacy - puede ser removido si no se usa)
  zoomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 18,
    alignItems: 'center',
    zIndex: 12,
  },
  zoomInner: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: 'transparent',
  },
  zoomBtn: {
    backgroundColor: '#333333',
    borderColor: '#333333',
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 52,
    alignItems: 'center',
  },
  zoomTxt: {
    color: '#666',
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
  },
  

  // Panel de caras - esquina superior derecha (compacto)
  facePanel: {
    position: 'absolute',
    top: 40,
    right: 12,
    backgroundColor: 'transparent',
    borderRadius: 8,
    paddingHorizontal: 4,
    borderWidth: 0,
    borderColor: 'transparent',
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
    alignItems: 'flex-end',
    zIndex: 20
  },
  faceRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 6,
    justifyContent: 'flex-end'
  },
  faceButton: {
    flexShrink: 1,
    backgroundColor: '#333333',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#333333',
    minWidth: 78,
    alignItems: 'center',
  },
  activeFaceButton: {
    borderColor: '#888888', // Marco gris claro sutil para cara activa
    borderWidth: 2,
    backgroundColor: '#3a3a3a', // Ligeramente mÃ¡s claro
  },
  faceName: {
    fontSize: 12,
    fontWeight: '800',
    color: '#666',
    textAlign: 'center',
    marginBottom: 2
  },
  faceRange: {
    fontSize: 8,
    color: '#666',
    textAlign: 'center',
    fontFamily: 'monospace'
  },
  activeFaceName: {
    color: '#aaa',
  },
  // Estilos del modal de minado
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  modalContainer: {
    position: 'absolute',
    backgroundColor: 'rgba(20, 20, 20, 0.95)',
    borderRadius: 15,
    padding: 20,
    width: 200,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 10
  },
  modalText: {
    color: '#ccc',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20
  },
  modalButtons: {
    flexDirection: 'column',
    gap: 10
  },
  modalButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center'
  },
  mineButton: {
    backgroundColor: 'rgba(34, 197, 94, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 1)'
  },
  cancelButton: {
    backgroundColor: 'rgba(239, 68, 68, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 1)'
  },
  mineButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold'
  },
  cancelButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold'
  },
  // Pills modal styles
  pill: {
    position: 'absolute',
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    borderRadius: 22,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    alignItems: 'center'
  },
  mainPill: {
    backgroundColor: 'rgba(35, 35, 35, 0.95)',
    minWidth: 180,
    paddingVertical: 14
  },
  yesPill: {
    backgroundColor: 'rgba(34, 197, 94, 0.92)',
    borderColor: 'rgba(34, 197, 94, 1)',
    minWidth: 90
  },
  noPill: {
    backgroundColor: 'rgba(239, 68, 68, 0.92)',
    borderColor: 'rgba(239, 68, 68, 1)',
    minWidth: 90
  },
  pillTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center'
  },
  pillSubtitle: {
    color: '#ccc',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4
  },
  yesText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold'
  },
  noText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold'
  },
  // Estilos del modal de recompensa
  rewardOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  rewardModal: {
    backgroundColor: 'rgba(35, 35, 35, 0.95)',
    borderRadius: 16,
    padding: 24,
    minWidth: 280,
    maxWidth: 320,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center'
  },
  rewardTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 12
  },
  rewardMessage: {
    color: '#ccc',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 22
  },
  rewardPicksContainer: {
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.5)'
  },
  rewardPicksText: {
    color: '#22c55e',
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center'
  },
  rewardButton: {
    backgroundColor: 'rgba(55, 55, 55, 0.9)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    minWidth: 100
  },
  rewardButtonText: {
    color: '#ccc',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center'
  },
  // Estilos para modal "Cómo se juega?"
  howToPlayWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  howToPlayContainer: {
    backgroundColor: '#333333',
    borderRadius: 14,
    maxWidth: '90%',
    maxHeight: '85%',
    marginHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  howToPlayContent: {
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  howToPlayTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 16,
  },
  howToPlayWelcome: {
    fontSize: 18,
    fontWeight: '800',
    color: '#22c55e',
    marginBottom: 8,
    lineHeight: 24,
  },
  howToPlaySubtitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#fff',
    marginTop: 12,
    marginBottom: 8,
    lineHeight: 24,
  },
  howToPlayText: {
    fontSize: 14,
    fontWeight: '400',
    color: '#ccc',
    marginBottom: 8,
    lineHeight: 20,
  },
  howToPlayTextBold: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
    lineHeight: 20,
  },
  howToPlayPrize: {
    fontSize: 13,
    fontWeight: '400',
    color: '#aaa',
    marginBottom: 4,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  howToPlayLuck: {
    fontSize: 16,
    fontWeight: '700',
    color: '#22c55e',
    marginTop: 8,
    marginBottom: 12,
    textAlign: 'center',
  },
});





