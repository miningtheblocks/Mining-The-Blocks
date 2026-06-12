// MinedCellIndicators.js - USA EXACTAMENTE LA MISMA FUENTE BITMAP 5x7 QUE LOS NÚMEROS
import * as THREE from 'three';

// Cache para evitar recrear texturas
const indicatorCache = new Map();

/**
 * Dibuja texto usando la MISMA función que los números (fuente bitmap 5x7)
 * COPIA EXACTA de drawTextOnTexture de DynamicCube201.js
 */
function drawTextOnTexture(data, size, text, rgba = [0,0,0,255]) {
  if (!data || !(data instanceof Uint8Array)) return;
  if (typeof size !== 'number' || size <= 0) return;
  if (typeof text !== 'string') return;
  if (!Array.isArray(rgba) || rgba.length !== 4) return;
  
  // Fuente bitmap 5x7 - MISMA que en DynamicCube201.js
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
    'X': [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],  // X igual que números
    'P': [0x04, 0x0E, 0x15, 0x04, 0x04, 0x04, 0x04]   // Flecha: | → ||| → |_|_| (punta arriba, palito abajo)
  };
  
  const charWidth = 6;
  const charHeight = 7;
  const totalWidth = text.length * charWidth;
  
  const startX = Math.max(0, Math.floor((size - totalWidth) / 2));
  const startY = Math.floor((size - charHeight) / 2);
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const charData = font[char];
    if (!charData || !Array.isArray(charData)) continue;
    
    const charX = startX + i * charWidth;
    
    for (let row = 0; row < charHeight; row++) {
      const rowData = charData[row];
      if (typeof rowData !== 'number') continue;
      
      for (let col = 0; col < 5; col++) {
        if (rowData & (1 << (4 - col))) {
          const x = charX + col;
          const y = startY + (charHeight - 1 - row);
          
          if (x >= 0 && x < size && y >= 0 && y < size) {
            const pixelIndex = (y * size + x) * 4;
            if (pixelIndex >= 0 && pixelIndex + 3 < data.length) {
              data[pixelIndex] = rgba[0];
              data[pixelIndex + 1] = rgba[1];
              data[pixelIndex + 2] = rgba[2];
              data[pixelIndex + 3] = rgba[3];
            }
          }
        }
      }
    }
  }
}

/**
 * Crea textura de indicador EXACTAMENTE como createNumberTexture
 */
function createIndicatorTexture(text, color = [120, 120, 120, 255]) {
  const cacheKey = `${text}_${color.join(',')}`;
  if (indicatorCache.has(cacheKey)) {
    return indicatorCache.get(cacheKey);
  }
  
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  
  // Fondo transparente
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i+1] = 0;
    data[i+2] = 0;
    data[i+3] = 0;
  }
  
  // Dibujar usando la MISMA función bitmap
  drawTextOnTexture(data, size, text, color);
  
  // Crear textura igual que números
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  
  indicatorCache.set(cacheKey, texture);
  return texture;
}

/**
 * Crea sprite de indicador
 */
export function createRewardIndicatorSprite(rewardAmount, localPosition, color = [120, 120, 120, 255]) {
  // Convertir a texto usando caracteres de la fuente bitmap
  let text;
  if (rewardAmount === 0) {
    text = 'X';  // Una X del mismo tamaño que los números
  } else {
    // 1-5 picos = 1-5 caracteres 'P'
    const pickCount = Math.min(Math.max(rewardAmount, 1), 5);
    text = 'P'.repeat(pickCount);
  }
  
  const texture = createIndicatorTexture(text, color);
  
  // USAR SPRITE con la misma configuración que los números
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  
  const sprite = new THREE.Sprite(material);
  sprite.position.copy(localPosition);
  sprite.scale.set(0.7, 0.7, 1); // EXACTAMENTE el mismo tamaño que números grises
  sprite.renderOrder = 10002; // Mayor que números (10001) para renderizar encima
  sprite.visible = true; // SIEMPRE VISIBLE - Controlado por render loop después
  
  sprite.userData = {
    type: 'rewardIndicator',
    rewardAmount: rewardAmount,
    text: text
  };
  
  return sprite;
}

/**
 * Store de recompensas
 */
export class MinedCubesRewardStore {
  constructor() {
    this.rewards = new Map();
  }
  
  set(layer, faceIndex, gridX, gridY, rewardAmount) {
    const key = `${layer}:${faceIndex}:${gridX}:${gridY}`;
    this.rewards.set(key, rewardAmount);
  }
  
  get(layer, faceIndex, gridX, gridY) {
    const key = `${layer}:${faceIndex}:${gridX}:${gridY}`;
    return this.rewards.get(key) || 0;
  }
  
  has(layer, faceIndex, gridX, gridY) {
    const key = `${layer}:${faceIndex}:${gridX}:${gridY}`;
    return this.rewards.has(key);
  }
  
  clear() {
    this.rewards.clear();
  }
}
