/**
 * Sube los 9 JSON de metadata NFT a IPFS via Pinata.
 * Devuelve los CIDs finales para usar como tokenURI en el contrato.
 *
 * Uso:
 *   PINATA_API_KEY="xxx" PINATA_API_SECRET="xxx" node scripts/upload-metadata-to-ipfs.js
 */

const fs   = require('fs');
const path = require('path');

const API_KEY    = process.env.PINATA_API_KEY;
const API_SECRET = process.env.PINATA_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('ERROR: Necesitás PINATA_API_KEY y PINATA_API_SECRET.');
  process.exit(1);
}

const META_DIR = path.join(__dirname, '..', 'assets', 'gems', 'metadata');

async function pinJSON(jsonObj, name) {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      pinata_api_key: API_KEY,
      pinata_secret_api_key: API_SECRET,
    },
    body: JSON.stringify({
      pinataContent: jsonObj,
      pinataMetadata: { name },
      pinataOptions: { cidVersion: 1 },
    }),
  });

  const json = await res.json();
  if (!json.IpfsHash) throw new Error(JSON.stringify(json));
  return json.IpfsHash;
}

async function main() {
  console.log('Subiendo metadata JSON a IPFS via Pinata...\n');
  const results = {};

  for (let tier = 1; tier <= 9; tier++) {
    const filePath = path.join(META_DIR, `gem_${tier}.json`);
    if (!fs.existsSync(filePath)) {
      console.error(`No encontré ${filePath}. Corré generate-nft-metadata.js primero.`);
      process.exit(1);
    }
    try {
      const jsonObj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const cid = await pinJSON(jsonObj, `mtb_gem_metadata_${tier}.json`);
      results[tier] = cid;
      console.log(`✓ gem_${tier}.json → ipfs://${cid}`);
    } catch (e) {
      console.error(`✗ gem_${tier}.json → ERROR: ${e.message}`);
    }
  }

  console.log('\n─── TOKEN URIs para el contrato MTBGems ───');
  console.log('// Guardá estos valores en el backend (functions/index.js o config)');
  console.log('const TOKEN_URIS = {');
  for (let tier = 1; tier <= 9; tier++) {
    console.log(`  ${tier}: 'ipfs://${results[tier] || 'ERROR'}',`);
  }
  console.log('};');
}

main();
