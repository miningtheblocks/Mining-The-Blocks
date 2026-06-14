/**
 * Genera los 9 archivos JSON de metadata NFT (estándar ERC-721/OpenSea)
 * y los guarda en assets/gems/metadata/
 *
 * Prerrequisito: subir las imágenes a IPFS primero con upload-to-ipfs.js
 * y pegar los CIDs en IMAGE_CIDS abajo.
 *
 * Uso: node scripts/generate-nft-metadata.js
 */

const fs   = require('fs');
const path = require('path');

// ── Pegar aquí los CIDs de IPFS luego de subir las imágenes ──────────────────
// Ejemplo: 'QmXxx...' o 'ipfs://QmXxx...'
// Mientras no tengas los CIDs, se usa un placeholder.
const IMAGE_CIDS = {
  1: 'bafkreigqqfdlr46soksipxtz3djod3wywv6y36jemkdfatnqpiofvmmovq',
  2: 'bafkreid7fwynp3wyxvaf5l3jtwz32o23ofvb4apyphpvelripcwvpd7rge',
  3: 'bafkreihyc5mqvtpwju2mkkpipklb3dckqwlmyymknj4k3n5j7v2uz4hnke',
  4: 'bafkreia3o3epebkwqdonia56drkfsjmibf3t643e6gqsnp74pv4bfrdu7u',
  5: 'bafkreicksqnirjzfblrqlfkfnu3tlv4yfffijomccbrdi5oyo6puvw5riq',
  6: 'bafkreiek5sw7p7ez3bnf7pfzegjukem5rx2lbz7gted3nucgv2wqpq3xv4',
  7: 'bafkreidhrtpdi66rykuqseg3i2cwd2e2eobsz4dy5iraiijzpkfoobwgbq',
  8: 'bafkreihfsqo66ssqmx2fimpk4eunamc5smajgp74x56pxoykarlnofa4ka',
  9: 'bafkreibfeahjeqaxywpmugojcpyvfruvnft3e2khfq5vclehxi6q2temr4',
};

// SEC-B-2: precios sincronizados con backend `functions/constants.js:GEM_PRICES`.
// Anterior tenía 200x menos lo que generaba inconsistencia legal grave.
const GEMS = [
  { tier: 1, name: 'Diamante rojo',         price: 100000, quantity: 1,     rarity: 'Mythic'    },
  { tier: 2, name: 'Painita',               price: 50000,  quantity: 1,     rarity: 'Legendary' },
  { tier: 3, name: 'Musgravita',            price: 10000,  quantity: 5,     rarity: 'Epic'      },
  { tier: 4, name: 'Jadeíta imperial',      price: 1000,   quantity: 50,    rarity: 'Rare'      },
  { tier: 5, name: 'Alejandrita',           price: 500,    quantity: 100,   rarity: 'Uncommon'  },
  { tier: 6, name: 'Rubí sangre de paloma', price: 100,    quantity: 500,   rarity: 'Common'    },
  { tier: 7, name: 'Diamante azul',         price: 50,     quantity: 1000,  rarity: 'Common'    },
  { tier: 8, name: 'Diamante rosa',         price: 25,     quantity: 4000,  rarity: 'Common'    },
  { tier: 9, name: 'Esmeralda colombiana',  price: 15,     quantity: 10000, rarity: 'Common'    },
];

const OUT_DIR = path.join(__dirname, '..', 'assets', 'gems', 'metadata');
fs.mkdirSync(OUT_DIR, { recursive: true });

GEMS.forEach((gem) => {
  const cid = IMAGE_CIDS[gem.tier];
  const imageUri = cid === 'PENDING'
    ? `PENDING_CID_gem_${gem.tier}`
    : (cid.startsWith('ipfs://') ? cid : `ipfs://${cid}`);

  const metadata = {
    name: `MTB ${gem.name} #${gem.tier}`,
    description:
      `Mining The Blocks — ${gem.name}. ` +
      `Tier ${gem.tier} gem discovered by mining the community cube. ` +
      `Fixed redemption value: $${gem.price} USD. ` +
      // CRIT-20: usar el dominio efectivamente poseído (github.io), no
      // miningtheblocks.com que podría no estar registrado por la empresa
      // (un atacante podría comprarlo y phishear holders del NFT desde
      // OpenSea via external_url).
      `Redeem your code at miningtheblocks.github.io or hold as NFT.`,
    image: imageUri,
    external_url: 'https://miningtheblocks.github.io/Mining-The-Blocks/',
    attributes: [
      { trait_type: 'Gem Name',        value: gem.name },
      { trait_type: 'Tier',            value: gem.tier,          display_type: 'number' },
      { trait_type: 'Rarity',          value: gem.rarity },
      { trait_type: 'Redemption Value',value: `$${gem.price} USD` },
      { trait_type: 'Quantity/Server', value: gem.quantity,      display_type: 'number' },
      { trait_type: 'Game',            value: 'Mining The Blocks' },
      { trait_type: 'Blockchain',      value: 'Polygon' },
    ],
  };

  const outPath = path.join(OUT_DIR, `gem_${gem.tier}.json`);
  fs.writeFileSync(outPath, JSON.stringify(metadata, null, 2));
  console.log(`✓ gem_${gem.tier}.json  —  ${gem.name}  ($${gem.price})`);
});

console.log(`\nMetadata generada en: ${OUT_DIR}`);
console.log('\nPróximo paso: subir imágenes a IPFS (scripts/upload-to-ipfs.js)');
console.log('Luego pegar los CIDs en IMAGE_CIDS de este archivo y volver a ejecutar.');
