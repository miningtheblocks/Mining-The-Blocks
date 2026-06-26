// Performance tier detection para adaptar el render a la capacidad del device.
//
// Tier auto-detectado leyendo gl.RENDERER (la única señal fuerte sin agregar
// deps nuevas). El user puede forzar "low" desde Config si la auto detección
// se equivoca o si quiere ahorrar batería en un mid/high.
//
// Presets:
//   high → comportamiento original (60 fps activos, anim de cámara x1.0)
//   mid  → 45 fps activos, anim x0.85
//   low  → 30 fps activos, anim x0.7
//
// FPS más bajos en devices low-end NO se ven peor: la Mali-G52 y similares
// no llegan a 60 fps reales en three.js de todas formas, así que capear a 30
// evita que la GPU intente y desincronice el JS thread → input se siente más
// fluido aunque la imagen actualice "más despacio".

import AsyncStorage from '@react-native-async-storage/async-storage';

const TIER_HIGH = 'high';
const TIER_MID = 'mid';
const TIER_LOW = 'low';

// textureCacheMax + lookaheadRows: el cache se sube para que entren las
// texturas pre-cargadas del ring alrededor del viewport. El lookahead es
// asíncrono incremental — procesa 1-2 texturas por frame en idle, en lugar
// de TODAS al cambiar el viewport (eso saturaba el JS thread en Mali-G52).
const PRESETS = {
  high: { activeFps: 60, idleFps: 30, deepIdleFps: 15, animFactor: 1.0, textureCacheMax: 500, lookaheadRows: 4, lookaheadCapacity: 2500 },
  mid:  { activeFps: 45, idleFps: 20, deepIdleFps: 12, animFactor: 0.85, textureCacheMax: 400, lookaheadRows: 3, lookaheadCapacity: 1500 },
  low:  { activeFps: 30, idleFps: 15, deepIdleFps: 10, animFactor: 0.7, textureCacheMax: 300, lookaheadRows: 3, lookaheadCapacity: 800 },
};

// Estado en memoria — se hidrata al primer detect/load.
let detectedTier = TIER_MID;     // del gl.RENDERER
let userOverride = 'auto';        // 'auto' | 'low'
let activeTier = TIER_MID;        // tier efectivo (override si !== auto, else detectedTier)
let lastRenderer = '';

function classifyRenderer(renderer) {
  if (!renderer) return TIER_MID;
  const r = String(renderer).toLowerCase();

  // LOW — GPUs débiles típicas de gama baja
  if (/mali-?g5[0-9]/.test(r)) return TIER_LOW;            // Mali-G51..G59
  if (/mali-?g6[0-7]/.test(r)) return TIER_LOW;            // Mali-G60..G67
  if (/adreno[^0-9]*?6(0[0-9]|1[0-3])\b/.test(r)) return TIER_LOW;  // Adreno 600..613
  if (/adreno[^0-9]*?5[0-9]{2}\b/.test(r)) return TIER_LOW;          // Adreno 5xx (viejas)
  if (/powervr[^a-z]*rogue/.test(r)) return TIER_LOW;
  if (/mali-?[34][0-9]{2}/.test(r)) return TIER_LOW;        // Mali-3xx/4xx legacy

  // HIGH — flagship o casi
  if (/apple/.test(r)) return TIER_HIGH;
  if (/mali-?g7[8-9]/.test(r)) return TIER_HIGH;            // Mali-G78, G79
  if (/mali-?g[89][0-9]/.test(r)) return TIER_HIGH;         // Mali-G8x, G9x
  if (/mali-?g6[1-9][0-9]/.test(r)) return TIER_HIGH;       // Mali-G610, G615, G715...
  if (/adreno[^0-9]*?(6[3-9][0-9]|7[0-9]{2}|8[0-9]{2})\b/.test(r)) return TIER_HIGH;

  // MID — todo lo demás (Mali-G7[0-7], Adreno 614..629, etc.)
  return TIER_MID;
}

function recompute() {
  activeTier = userOverride === 'low' ? TIER_LOW : detectedTier;
}

async function init() {
  try {
    const [savedOverride, savedDetected, savedRenderer] = await Promise.all([
      AsyncStorage.getItem('@perfTier:override'),
      AsyncStorage.getItem('@perfTier:detected'),
      AsyncStorage.getItem('@perfTier:renderer'),
    ]);
    userOverride = savedOverride === 'low' ? 'low' : 'auto';
    detectedTier = savedDetected || TIER_MID;
    lastRenderer = savedRenderer || '';
    recompute();
  } catch {}
}

async function detectFromGL(gl) {
  if (!gl) return { tier: activeTier, renderer: lastRenderer };
  let renderer = '';
  try {
    const ext = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
    }
    if (!renderer && typeof gl.RENDERER === 'number') {
      try { renderer = gl.getParameter(gl.RENDERER) || ''; } catch {}
    }
  } catch {}
  detectedTier = classifyRenderer(renderer);
  lastRenderer = String(renderer || '');
  recompute();
  try {
    await AsyncStorage.setItem('@perfTier:detected', detectedTier);
    await AsyncStorage.setItem('@perfTier:renderer', lastRenderer);
  } catch {}
  return { tier: activeTier, renderer: lastRenderer, detected: detectedTier };
}

async function setOverride(value) {
  userOverride = value === 'low' ? 'low' : 'auto';
  recompute();
  try {
    await AsyncStorage.setItem('@perfTier:override', userOverride);
  } catch {}
}

function getPreset() {
  return PRESETS[activeTier] || PRESETS.mid;
}

function getTier() { return activeTier; }
function getDetectedTier() { return detectedTier; }
function getOverride() { return userOverride; }
function getRenderer() { return lastRenderer; }

export default {
  init,
  detectFromGL,
  setOverride,
  getPreset,
  getTier,
  getDetectedTier,
  getOverride,
  getRenderer,
  TIER_LOW,
  TIER_MID,
  TIER_HIGH,
};
