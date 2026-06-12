/**
 * Genera los 9 PNG de gemas para NFTs.
 * Usa exactamente el mismo GEM_SHAPE y paletas que el juego.
 * Output: assets/gems/gem_1.png ... gem_9.png (1000x1000px cada uno)
 *
 * Uso: node scripts/generate-gems.js
 */

const fs   = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// ─── Datos del juego (copiados de src/utils/gems.js) ─────────────────────────

const GEM_SHAPE = [
  [0, 0, 1, 2, 2, 2, 2, 1, 0, 0],
  [0, 1, 2, 3, 3, 3, 3, 2, 1, 0],
  [1, 2, 3, 3, 4, 4, 3, 3, 2, 1],
  [1, 2, 3, 4, 4, 5, 4, 3, 2, 1],
  [1, 2, 4, 4, 5, 5, 4, 4, 2, 1],
  [1, 2, 4, 4, 5, 5, 4, 4, 2, 1],
  [0, 1, 2, 4, 4, 4, 4, 2, 1, 0],
  [0, 0, 1, 2, 4, 4, 2, 1, 0, 0],
  [0, 0, 0, 1, 2, 2, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 0, 0, 0, 0],
];

const GEMS = [
  // SEC-B-2: precios sincronizados con backend GEM_PRICES.
  { tier: 1, name: 'Diamante rojo',         price: 100000, palette: [null, '#fff8e8', '#ff9955', '#ee2200', '#991100', '#440800'], glowColor: '#ff4400' },
  { tier: 2, name: 'Painita',               price: 50000,  palette: [null, '#fff5e0', '#ffcc88', '#cc7722', '#774400', '#331a00'], glowColor: '#cc7722' },
  { tier: 3, name: 'Musgravita',            price: 10000,  palette: [null, '#e8ffff', '#66ddcc', '#00aaaa', '#006666', '#002233'], glowColor: '#00aaaa' },
  { tier: 4, name: 'Jadeíta imperial',      price: 1000,   palette: [null, '#eaffee', '#88ffaa', '#00cc44', '#007722', '#003311'], glowColor: '#00cc44' },
  { tier: 5, name: 'Alejandrita',           price: 500,    palette: [null, '#f5eaff', '#dd88ff', '#9933ee', '#5500aa', '#220044'], glowColor: '#9933ee' },
  { tier: 6, name: 'Rubí sangre de paloma', price: 100,    palette: [null, '#ffe8ee', '#ff8899', '#cc1144', '#880022', '#3d0011'], glowColor: '#cc1144' },
  { tier: 7, name: 'Diamante azul',         price: 50,     palette: [null, '#eef2ff', '#88aaff', '#2255ee', '#001199', '#000540'], glowColor: '#2255ee' },
  { tier: 8, name: 'Diamante rosa',         price: 25,     palette: [null, '#fff0f8', '#ffaadd', '#ee3399', '#990055', '#440022'], glowColor: '#ee3399' },
  { tier: 9, name: 'Esmeralda colombiana',  price: 15,     palette: [null, '#eefff2', '#77cc88', '#009933', '#005517', '#001f08'], glowColor: '#009933' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// Dibuja un rectángulo sólido en el buffer RGBA
function fillRect(data, imgW, x0, y0, w, h, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * imgW + x) * 4;
      data[i]     = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
}

// Fondo degradado radial (aproximado con círculos concéntricos)
function drawRadialGlow(data, imgW, imgH, cx, cy, maxR, color) {
  const { r, g, b } = hexToRgb(color);
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist > maxR) continue;
      const t = 1 - dist / maxR;
      const alpha = Math.round(t * t * 80); // max 80 de opacidad para que no tape
      const i = (y * imgW + x) * 4;
      // Blend sobre fondo existente (ya negro)
      data[i]     = Math.min(255, data[i]     + Math.round(r * alpha / 255));
      data[i + 1] = Math.min(255, data[i + 1] + Math.round(g * alpha / 255));
      data[i + 2] = Math.min(255, data[i + 2] + Math.round(b * alpha / 255));
      data[i + 3] = 255;
    }
  }
}

// ─── Generador principal ──────────────────────────────────────────────────────

const IMG_SIZE  = 1000; // px total de la imagen
const GRID_ROWS = GEM_SHAPE.length;    // 10
const GRID_COLS = GEM_SHAPE[0].length; // 10
const CELL_SIZE = 68;  // px por celda del pixel art (10 * 68 = 680)
const PIXEL_ART_W = GRID_COLS * CELL_SIZE; // 680
const PIXEL_ART_H = GRID_ROWS * CELL_SIZE; // 680
const OFFSET_X = Math.floor((IMG_SIZE - PIXEL_ART_W) / 2); // 160
const OFFSET_Y = Math.floor((IMG_SIZE - PIXEL_ART_H) / 2); // 160

const OUT_DIR = path.join(__dirname, '..', 'assets', 'gems');

GEMS.forEach((gem) => {
  const png = new PNG({ width: IMG_SIZE, height: IMG_SIZE, filterType: -1 });

  // Fondo negro total
  fillRect(png.data, IMG_SIZE, 0, 0, IMG_SIZE, IMG_SIZE, 0, 0, 0, 255);

  // Glow radial centrado
  drawRadialGlow(
    png.data, IMG_SIZE, IMG_SIZE,
    IMG_SIZE / 2, IMG_SIZE / 2,
    IMG_SIZE * 0.52,
    gem.glowColor
  );

  // Pixel art de la gema
  GEM_SHAPE.forEach((row, ri) => {
    row.forEach((paletteIdx, ci) => {
      if (paletteIdx === 0) return; // transparente → fondo
      const color = gem.palette[paletteIdx];
      if (!color) return;
      const { r, g, b } = hexToRgb(color);
      const px = OFFSET_X + ci * CELL_SIZE;
      const py = OFFSET_Y + ri * CELL_SIZE;
      fillRect(png.data, IMG_SIZE, px, py, CELL_SIZE, CELL_SIZE, r, g, b, 255);
    });
  });

  // Borde sutil entre celdas (1px negro) para marcar el pixel art
  GEM_SHAPE.forEach((row, ri) => {
    row.forEach((paletteIdx, ci) => {
      if (paletteIdx === 0) return;
      const px = OFFSET_X + ci * CELL_SIZE;
      const py = OFFSET_Y + ri * CELL_SIZE;
      // Línea derecha
      fillRect(png.data, IMG_SIZE, px + CELL_SIZE - 1, py, 1, CELL_SIZE, 0, 0, 0, 180);
      // Línea abajo
      fillRect(png.data, IMG_SIZE, px, py + CELL_SIZE - 1, CELL_SIZE, 1, 0, 0, 0, 180);
    });
  });

  const outPath = path.join(OUT_DIR, `gem_${gem.tier}.png`);
  const buffer = PNG.sync.write(png);
  fs.writeFileSync(outPath, buffer);
  console.log(`✓ gem_${gem.tier}.png  —  ${gem.name}  ($${gem.price})`);
});

console.log(`\nGeneradas en: ${OUT_DIR}`);
