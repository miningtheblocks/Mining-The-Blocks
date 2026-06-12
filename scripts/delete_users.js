const admin = require('../functions/node_modules/firebase-admin');
const https = require('https');
const fs = require('fs');
const { confirmDestructive } = require('./_confirm');

const config = JSON.parse(fs.readFileSync('/home/code/.config/configstore/firebase-tools.json', 'utf8'));
const accessToken = config.tokens.access_token;
const PROJECT = 'miningtheblocks-669f6';

// --- Firebase Auth deletion via firebase-admin ---
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
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function listFirestoreUsers(pageToken) {
  let path = `/v1/projects/${PROJECT}/databases/(default)/documents/users?pageSize=300`;
  if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
  return httpsReq('GET', path);
}

async function deleteFirestoreDoc(name) {
  // name = "projects/.../documents/users/UID"
  const path = `/v1/${name}`;
  return httpsReq('DELETE', path);
}

async function deleteAllAuthUsers() {
  let total = 0;
  let nextPageToken;
  console.log('=== BORRANDO FIREBASE AUTH ===');
  do {
    const result = await auth.listUsers(1000, nextPageToken);
    const uids = result.users.map(u => u.uid);
    if (!uids.length) break;
    const del = await auth.deleteUsers(uids);
    total += uids.length;
    if (del.errors?.length) console.warn('  Errores parciales:', del.errors.length);
    console.log(`  ${total} usuarios borrados...`);
    nextPageToken = result.pageToken;
  } while (nextPageToken);
  console.log(`✅ Auth: ${total} usuarios borrados\n`);
  return total;
}

async function deleteAllFirestoreDocs() {
  let total = 0;
  let pageToken;
  console.log('=== BORRANDO FIRESTORE /users/* ===');
  do {
    const res = await listFirestoreUsers(pageToken);
    const docs = res.documents || [];
    if (!docs.length) break;

    // Borrar en paralelo (lotes de 50)
    for (let i = 0; i < docs.length; i += 50) {
      const batch = docs.slice(i, i + 50);
      await Promise.all(batch.map(d => deleteFirestoreDoc(d.name)));
      total += batch.length;
    }
    console.log(`  ${total} documentos borrados...`);
    pageToken = res.nextPageToken;
  } while (pageToken);
  console.log(`✅ Firestore /users/*: ${total} documentos borrados\n`);
  return total;
}

(async () => {
  try {
    await confirmDestructive(PROJECT, 'BORRAR TODOS los usuarios (Auth + Firestore /users/*)');
    const a = await deleteAllAuthUsers();
    const f = await deleteAllFirestoreDocs();
    console.log(`🎉 LISTO: ${a} Auth users + ${f} Firestore docs borrados.`);
    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e.message || e);
    process.exit(1);
  }
})();
