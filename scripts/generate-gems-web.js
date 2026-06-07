/**
 * Genera PNGs transparentes de gemas para la web (sin fondo negro, sin grilla).
 * Output: docs/gems/gem_1.png ... gem_9.png
 */

const fs   = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

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
  { tier: 1, palette: [null, '#fff8e8', '#ff9955', '#ee2200', '#991100', '#440800'] },
  { tier: 2, palette: [null, '#fff5e0', '#ffcc88', '#cc7722', '#774400', '#331a00'] },
  { tier: 3, palette: [null, '#e8ffff', '#66ddcc', '#00aaaa', '#006666', '#002233'] },
  { tier: 4, palette: [null, '#eaffee', '#88ffaa', '#00cc44', '#007722', '#003311'] },
  { tier: 5, palette: [null, '#f5eaff', '#dd88ff', '#9933ee', '#5500aa', '#220044'] },
  { tier: 6, palette: [null, '#ffe8ee', '#ff8899', '#cc1144', '#880022', '#3d0011'] },
  { tier: 7, palette: [null, '#eef2ff', '#88aaff', '#2255ee', '#001199', '#000540'] },
  { tier: 8, palette: [null, '#fff0f8', '#ffaadd', '#ee3399', '#990055', '#440022'] },
  { tier: 9, palette: [null, '#eefff2', '#77cc88', '#009933', '#005517', '#001f08'] },
];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}

function fillRect(data, imgW, x0, y0, w, h, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * imgW + x) * 4;
      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = a;
    }
  }
}

const IMG_SIZE   = 200;
const GRID_ROWS  = GEM_SHAPE.length;
const GRID_COLS  = GEM_SHAPE[0].length;
const CELL_SIZE  = Math.floor(IMG_SIZE * 0.8 / GRID_COLS); // ~16px por celda
const PIXEL_ART_W = GRID_COLS * CELL_SIZE;
const PIXEL_ART_H = GRID_ROWS * CELL_SIZE;
const OFFSET_X   = Math.floor((IMG_SIZE - PIXEL_ART_W) / 2);
const OFFSET_Y   = Math.floor((IMG_SIZE - PIXEL_ART_H) / 2);

const OUT_DIR = path.join(__dirname, '..', 'docs', 'gems');
fs.mkdirSync(OUT_DIR, { recursive: true });

GEMS.forEach((gem) => {
  const png = new PNG({ width: IMG_SIZE, height: IMG_SIZE, filterType: -1 });

  // Fondo completamente transparente
  png.data.fill(0);

  // Pixel art sin grilla
  GEM_SHAPE.forEach((row, ri) => {
    row.forEach((paletteIdx, ci) => {
      if (paletteIdx === 0) return;
      const color = gem.palette[paletteIdx];
      if (!color) return;
      const { r, g, b } = hexToRgb(color);
      const px = OFFSET_X + ci * CELL_SIZE;
      const py = OFFSET_Y + ri * CELL_SIZE;
      fillRect(png.data, IMG_SIZE, px, py, CELL_SIZE, CELL_SIZE, r, g, b, 255);
    });
  });

  const outPath = path.join(OUT_DIR, `gem_${gem.tier}.png`);
  fs.writeFileSync(outPath, PNG.sync.write(png));
  console.log(`✓ gem_${gem.tier}.png`);
});

console.log('Listo en: ' + OUT_DIR);
