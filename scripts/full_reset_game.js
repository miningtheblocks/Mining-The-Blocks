/**
 * full_reset_game.js
 * Reset completo del juego:
 *   1. Borra todos los usuarios (Firebase Auth + Firestore /users/*)
 *   2. Resetea todos los servidores: borra mined, layers, history, episodes
 *      y los vuelve a capa 100, episodio 1
 *
 * El documento del servidor y la cadena se MANTIENEN, solo se resetea su estado.
 *
 * Uso: node scripts/full_reset_game.js
 */

const admin = require('../functions/node_modules/firebase-admin');
const https = require('https');
const fs = require('fs');
const { confirmDestructive } = require('./_confirm');

const config = JSON.parse(fs.readFileSync('/home/code/.config/configstore/firebase-tools.json', 'utf8'));
const accessToken = config.tokens.access_token;
const PROJECT = 'miningtheblocks-669f6';
const BASE_PATH = `/v1/projects/${PROJECT}/databases/(default)/documents`;

// --- Auth via firebase-admin ---
admin.initializeApp({
  credential: {
    getAccessToken: () => Promise.resolve({ access_token: accessToken, expires_in: 3600 }),
  },
  projectId: PROJECT,
});
const auth = admin.auth();

// --- Firestore REST API helpers ---
function httpsReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'firestore.googleapis.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function listDocs(collPath) {
  const docs = [];
  let pageToken = null;
  do {
    let path = `${BASE_PATH}/${collPath}?pageSize=300`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await httpsReq('GET', path);
    if (res.documents) docs.push(...res.documents);
    pageToken = res.nextPageToken || null;
  } while (pageToken);
  return docs;
}

async function deleteDocByName(name) {
  return httpsReq('DELETE', `/v1/${name}`);
}

async function deleteCollection(collPath) {
  const docs = await listDocs(collPath);
  if (!docs.length) return;
  for (let i = 0; i < docs.length; i += 50) {
    await Promise.all(docs.slice(i, i + 50).map(d => deleteDocByName(d.name)));
  }
  console.log(`    ✓ ${docs.length} docs borrados de ${collPath}`);
}

// PATCH a document with specific fields (fields not in body but in mask get deleted)
async function patchDoc(docPath, fields, fieldPaths) {
  const mask = fieldPaths.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  return httpsReq('PATCH', `${BASE_PATH}/${docPath}?${mask}`, { fields });
}

function getStringField(doc, key) {
  return doc.fields?.[key]?.stringValue ?? null;
}

function shellTotalCubes(K) {
  // Same formula as functions/index.js: 6 flat faces of (2K+1)² cells each
  const g = 2 * K + 1;
  return g * g * 6;
}

// --- Steps ---

async function deleteAllAuthUsers() {
  let total = 0;
  let nextPageToken;
  console.log('\n=== 1. BORRANDO FIREBASE AUTH ===');
  do {
    const result = await auth.listUsers(1000, nextPageToken);
    const uids = result.users.map(u => u.uid);
    if (!uids.length) break;
    const del = await auth.deleteUsers(uids);
    total += uids.length;
    if (del.errors?.length) console.warn('  Errores parciales:', del.errors.length);
    console.log(`  ${total} usuarios Auth borrados...`);
    nextPageToken = result.pageToken;
  } while (nextPageToken);
  console.log(`  ✅ Auth: ${total} usuario(s) borrado(s)`);
  return total;
}

async function deleteAllFirestoreUsers() {
  let total = 0;
  console.log('\n=== 2. BORRANDO FIRESTORE /users/* ===');
  const docs = await listDocs('users');
  for (const doc of docs) {
    const uid = doc.name.split('/').pop();
    for (const sub of ['serverAccess', 'notifications', 'picks']) {
      await deleteCollection(`users/${uid}/${sub}`);
    }
    await deleteDocByName(doc.name);
    total++;
  }
  console.log(`  ✅ Firestore: ${total} usuario(s) borrado(s)`);
  return total;
}

async function resetAllServers() {
  console.log('\n=== 3. RESETEANDO SERVIDORES ===');
  const serverDocs = await listDocs('servers');

  if (!serverDocs.length) {
    console.log('  No se encontraron servidores.');
    return 0;
  }

  for (const serverDoc of serverDocs) {
    const serverId = serverDoc.name.split('/').pop();
    const name = getStringField(serverDoc, 'name') || serverId;
    const chainId = getStringField(serverDoc, 'chainId');

    console.log(`\n  Servidor: "${name}" (${serverId})`);

    console.log('    Borrando cubos minados...');
    await deleteCollection(`servers/${serverId}/mined`);

    console.log('    Borrando stats de capas...');
    await deleteCollection(`servers/${serverId}/layers`);

    // Resetear campos del servidor
    const K = 100;
    await patchDoc(`servers/${serverId}`, {
      currentLayer: { integerValue: String(K) },
      totalMined:   { integerValue: '0' },
      winner:       { nullValue: null },
      completedAt:  { nullValue: null },
      status:       { stringValue: 'active' },
      episodeNumber:{ integerValue: '1' },
      // memberCount omitido → se borra por el mask
    }, ['currentLayer', 'totalMined', 'winner', 'completedAt', 'status', 'episodeNumber', 'memberCount']);

    // Recrear capa 100
    const totalCubes = shellTotalCubes(K);
    await patchDoc(`servers/${serverId}/layers/100`, {
      K:          { integerValue: String(K) },
      totalCubes: { integerValue: String(totalCubes) },
      stats:      { mapValue: { fields: { mined: { integerValue: '0' } } } },
      winRate:    { doubleValue: 0.50 },
    }, ['K', 'totalCubes', 'stats', 'winRate']);

    console.log(`    ✓ Servidor reseteado → capa ${K}, episodio 1, 0 minados`);

    // Resetear cadena
    if (chainId) {
      console.log(`    Reseteando cadena ${chainId}...`);
      await deleteCollection(`serverChains/${chainId}/history`);
      await deleteCollection(`serverChains/${chainId}/episodes`);
      await deleteCollection(`serverChains/${chainId}/meta`);

      await patchDoc(`serverChains/${chainId}`, {
        currentEpisode:  { integerValue: '1' },
        currentServerId: { stringValue: serverId },
        status:          { stringValue: 'active' },
        completedAt:     { nullValue: null },
      }, ['currentEpisode', 'currentServerId', 'status', 'completedAt']);

      console.log(`    ✓ Cadena reseteada → episodio 1`);
    }
  }

  console.log(`\n  ✅ ${serverDocs.length} servidor(es) reseteado(s)`);
  return serverDocs.length;
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     RESET COMPLETO DEL JUEGO             ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Proyecto: ${PROJECT}\n`);

  await confirmDestructive(PROJECT, 'RESET COMPLETO (borra Auth + Firestore /users/* + resetea TODOS los servidores)');

  const authTotal = await deleteAllAuthUsers();
  const fsTotal   = await deleteAllFirestoreUsers();
  const srvTotal  = await resetAllServers();

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  RESET COMPLETO ✅                        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  • ${authTotal} usuario(s) de Auth borrados`);
  console.log(`  • ${fsTotal} documento(s) /users/* borrados`);
  console.log(`  • ${srvTotal} servidor(es) → capa 100, episodio 1, 0 minados`);
  console.log('\n  El juego está listo para empezar de nuevo.');
}

main().catch(console.error).finally(() => process.exit(0));
