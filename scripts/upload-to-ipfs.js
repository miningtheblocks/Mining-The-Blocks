/**
 * Sube las 9 imágenes de gemas a IPFS via Pinata.
 * Usa fetch y FormData nativos de Node.js 18+, sin dependencias externas.
 *
 * Uso:
 *   PINATA_API_KEY="xxx" PINATA_API_SECRET="xxx" node scripts/upload-to-ipfs.js
 */

const fs   = require('fs');
const path = require('path');

const API_KEY    = process.env.PINATA_API_KEY;
const API_SECRET = process.env.PINATA_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('ERROR: Necesitás PINATA_API_KEY y PINATA_API_SECRET.');
  process.exit(1);
}

const GEMS_DIR = path.join(__dirname, '..', 'assets', 'gems');

async function pinFile(filePath, name) {
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: 'image/png' });

  const form = new FormData();
  form.append('file', blob, name);
  form.append('pinataMetadata', JSON.stringify({ name }));
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      pinata_api_key: API_KEY,
      pinata_secret_api_key: API_SECRET,
    },
    body: form,
  });

  const json = await res.json();
  if (!json.IpfsHash) throw new Error(JSON.stringify(json));
  return json.IpfsHash;
}

async function main() {
  console.log('Subiendo imágenes a IPFS via Pinata...\n');
  const results = {};

  for (let tier = 1; tier <= 9; tier++) {
    const filePath = path.join(GEMS_DIR, `gem_${tier}.png`);
    if (!fs.existsSync(filePath)) {
      console.error(`No encontré ${filePath}. Corré generate-gems.js primero.`);
      process.exit(1);
    }
    try {
      const cid = await pinFile(filePath, `mtb_gem_${tier}.png`);
      results[tier] = cid;
      console.log(`✓ gem_${tier}.png → ipfs://${cid}`);
    } catch (e) {
      console.error(`✗ gem_${tier}.png → ERROR: ${e.message}`);
    }
  }

  console.log('\n─── Pegá esto en IMAGE_CIDS de generate-nft-metadata.js ───');
  console.log('const IMAGE_CIDS = {');
  for (let tier = 1; tier <= 9; tier++) {
    console.log(`  ${tier}: '${results[tier] || 'ERROR'}',`);
  }
  console.log('};');
}

main();
