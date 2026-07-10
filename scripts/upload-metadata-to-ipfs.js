/**
 * Sube los 9 JSON de metadata NFT a IPFS via multi-pin (Pinata + Filebase).
 * Devuelve los CIDs finales para usar como tokenURI en el contrato.
 *
 * Uso:
 *   PINATA_API_KEY=xxx PINATA_API_SECRET=xxx \
 *   FILEBASE_KEY=xxx FILEBASE_SECRET=xxx \
 *   node scripts/upload-metadata-to-ipfs.js
 */

const fs = require('fs');
const path = require('path');
const { pinJSON, filebaseEnabled } = require('./_ipfs_pin');

const META_DIR = path.join(__dirname, '..', 'assets', 'gems', 'metadata');

async function main() {
  console.log(`Subiendo 9 metadata JSON a IPFS (multi-pin: ${filebaseEnabled ? 'Pinata + Filebase' : 'Pinata only — LEGACY'})...\n`);
  const results = {};

  for (let tier = 1; tier <= 9; tier++) {
    const filePath = path.join(META_DIR, `gem_${tier}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`No encontré ${filePath}. Corré generate-nft-metadata.js primero.`);
      process.exit(1);
    }
    try {
      const jsonObj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const { primary, mirror, match } = await pinJSON(jsonObj, `mtb_gem_metadata_${tier}.json`);
      results[tier] = { primary, mirror, match };
      const status = mirror
        ? (match ? '✓ identical' : `⚠ different (mirror=${mirror})`)
        : '⚠ mirror skipped';
      console.log(`✓ gem_${tier}.json → ipfs://${primary}  [filebase: ${status}]`);
    } catch (e) {
      console.error(`✗ gem_${tier}.json → ERROR: ${e.message}`);
    }
  }

  console.log('\n─── TOKEN URIs para el contrato MTBGems ───');
  console.log('// Guardá estos valores en el backend (functions/index.js o config)');
  console.log('const TOKEN_URIS = {');
  for (let tier = 1; tier <= 9; tier++) {
    console.log(`  ${tier}: 'ipfs://${(results[tier] && results[tier].primary) || 'ERROR'}',`);
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
