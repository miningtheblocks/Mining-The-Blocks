/**
 * _ipfs_pin.js — Multi-pin helper para IPFS (Pinata + Filebase).
 *
 * Agente #3 CRIT-5 del audit Round 2: Pinata era SPOF (single point of
 * failure) — cierre de cuenta / DMCA / outage = NFTs sin imagen para
 * siempre. Esta capa pinea a 2 proveedores en paralelo y devuelve ambos
 * CIDs para que el operador pueda verificar redundancia.
 *
 * Si los CIDs difieren, ambos son válidos pero apuntan a versiones
 * estructuralmente distintas del mismo contenido (Pinata y Filebase usan
 * chunkers IPFS levemente distintos). Por compatibilidad histórica, el
 * Pinata CID es el que se usa en metadata / contrato. El Filebase CID
 * es el plan B que se activa solo si Pinata cae.
 *
 * Env vars requeridas:
 *   PINATA_API_KEY, PINATA_API_SECRET
 *   FILEBASE_KEY, FILEBASE_SECRET, FILEBASE_BUCKET (default 'mtb-nfts')
 *
 * Si FILEBASE_* no están seteadas, el helper sube solo a Pinata (legacy
 * mode) con un warning. Eso permite correr scripts viejos sin romperse,
 * pero NO es lo que querés en producción — todos los uploads reales tienen
 * que ser multi-pin.
 */

const fs = require('fs');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const PINATA_KEY = process.env.PINATA_API_KEY;
const PINATA_SECRET = process.env.PINATA_API_SECRET;
const FILEBASE_KEY = process.env.FILEBASE_KEY;
const FILEBASE_SECRET = process.env.FILEBASE_SECRET;
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET || 'mtb-nfts';

if (!PINATA_KEY || !PINATA_SECRET) {
  console.error('ERROR: PINATA_API_KEY + PINATA_API_SECRET son requeridas.');
  process.exit(1);
}

const filebaseEnabled = !!(FILEBASE_KEY && FILEBASE_SECRET);
if (!filebaseEnabled) {
  console.warn('⚠ FILEBASE_KEY/FILEBASE_SECRET sin setear — corriendo en modo legacy single-pin (NO recomendado para producción).');
}

const s3 = filebaseEnabled
  ? new S3Client({
      endpoint: 'https://s3.filebase.io',
      region: 'auto',
      credentials: { accessKeyId: FILEBASE_KEY, secretAccessKey: FILEBASE_SECRET },
    })
  : null;

async function pinPinataFile(buffer, name, contentType) {
  const blob = new Blob([buffer], { type: contentType });
  const form = new FormData();
  form.append('file', blob, name);
  form.append('pinataMetadata', JSON.stringify({ name }));
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      pinata_api_key: PINATA_KEY,
      pinata_secret_api_key: PINATA_SECRET,
    },
    body: form,
  });
  const json = await res.json();
  if (!json.IpfsHash) throw new Error(`Pinata: ${JSON.stringify(json)}`);
  return json.IpfsHash;
}

async function pinPinataJSON(jsonObj, name) {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      pinata_api_key: PINATA_KEY,
      pinata_secret_api_key: PINATA_SECRET,
    },
    body: JSON.stringify({
      pinataContent: jsonObj,
      pinataMetadata: { name },
      pinataOptions: { cidVersion: 1 },
    }),
  });
  const json = await res.json();
  if (!json.IpfsHash) throw new Error(`Pinata: ${JSON.stringify(json)}`);
  return json.IpfsHash;
}

async function pinFilebase(buffer, name, contentType) {
  if (!s3) return null;
  // Upload to S3-compatible API. Filebase guarda el IPFS CID en el header
  // `x-amz-meta-cid` de la respuesta a HEAD subsiguiente.
  await s3.send(new PutObjectCommand({
    Bucket: FILEBASE_BUCKET,
    Key: name,
    Body: buffer,
    ContentType: contentType,
  }));
  const head = await s3.send(new HeadObjectCommand({ Bucket: FILEBASE_BUCKET, Key: name }));
  // Filebase devuelve el CID en Metadata.cid (lowercase x-amz-meta-cid).
  return head.Metadata && head.Metadata.cid;
}

/**
 * Pinea un archivo binario (Buffer) a Pinata + Filebase en paralelo.
 * Devuelve { primary, mirror, match } donde:
 *   - primary: CID de Pinata (canónico)
 *   - mirror: CID de Filebase (null si filebase deshabilitado)
 *   - match: true si los CIDs son iguales (mismo chunker)
 */
async function pinFile(buffer, name, contentType = 'application/octet-stream') {
  const [primary, mirror] = await Promise.all([
    pinPinataFile(buffer, name, contentType),
    pinFilebase(buffer, name, contentType).catch((e) => {
      console.warn(`  ⚠ Filebase pin failed for ${name}: ${e.message}`);
      return null;
    }),
  ]);
  return { primary, mirror, match: mirror && primary === mirror };
}

/**
 * Pinea un objeto JSON a Pinata + Filebase. Para Filebase, serializamos
 * el JSON nosotros (Pinata lo hace solo via pinJSONToIPFS).
 */
async function pinJSON(jsonObj, name) {
  const jsonBuffer = Buffer.from(JSON.stringify(jsonObj));
  const [primary, mirror] = await Promise.all([
    pinPinataJSON(jsonObj, name),
    pinFilebase(jsonBuffer, name, 'application/json').catch((e) => {
      console.warn(`  ⚠ Filebase pin failed for ${name}: ${e.message}`);
      return null;
    }),
  ]);
  return { primary, mirror, match: mirror && primary === mirror };
}

module.exports = { pinFile, pinJSON, filebaseEnabled };
