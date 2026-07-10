/**
 * Sube las 9 imágenes de gemas a IPFS via multi-pin (Pinata + Filebase).
 *
 * Uso:
 *   PINATA_API_KEY=xxx PINATA_API_SECRET=xxx \
 *   FILEBASE_KEY=xxx FILEBASE_SECRET=xxx \
 *   node scripts/upload-to-ipfs.js
 *
 * Si FILEBASE_* no están seteadas, corre legacy single-pin con warning.
 */

const fs = require('fs');
const path = require('path');
const { pinFile, filebaseEnabled } = require('./_ipfs_pin');

const GEMS_DIR = path.join(__dirname, '..', 'assets', 'gems');

async function main() {
  console.log(`Subiendo 9 imágenes de gemas a IPFS (multi-pin: ${filebaseEnabled ? 'Pinata + Filebase' : 'Pinata only — LEGACY'})...\n`);
  const results = {};

  for (let tier = 1; tier <= 9; tier++) {
    const filePath = path.join(GEMS_DIR, `gem_${tier}.png`);
    if (!fs.existsSync(filePath)) {
      console.error(`No encontré ${filePath}. Corré generate-gems.js primero.`);
      process.exit(1);
    }
    try {
      const buffer = fs.readFileSync(filePath);
      const { primary, mirror, match } = await pinFile(buffer, `mtb_gem_${tier}.png`, 'image/png');
      results[tier] = { primary, mirror, match };
      const status = mirror
        ? (match ? '✓ identical' : `⚠ different (mirror=${mirror})`)
        : '⚠ mirror skipped';
      console.log(`✓ gem_${tier}.png → ipfs://${primary}  [filebase: ${status}]`);
    } catch (e) {
      console.error(`✗ gem_${tier}.png → ERROR: ${e.message}`);
    }
  }

  console.log('\n─── Pegá esto en IMAGE_CIDS de generate-nft-metadata.js ───');
  console.log('const IMAGE_CIDS = {');
  for (let tier = 1; tier <= 9; tier++) {
    console.log(`  ${tier}: '${(results[tier] && results[tier].primary) || 'ERROR'}',`);
  }
  console.log('};');

  if (filebaseEnabled) {
    console.log('\n─── Filebase mirror CIDs (backup-only — no se ponen en metadata) ───');
    for (let tier = 1; tier <= 9; tier++) {
      const m = results[tier] && results[tier].mirror;
      console.log(`  ${tier}: ${m || 'FAILED'}`);
    }
  }
}

main();
