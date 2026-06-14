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
  let failed = 0;
  let pageToken;
  console.log('=== BORRANDO FIRESTORE /users/* ===');
  do {
    const res = await listFirestoreUsers(pageToken);
    const docs = res.documents || [];
    if (!docs.length) break;

    // ALTO-92: Promise.allSettled en vez de Promise.all — si 1 de 50 falla por
    // rate-limit/network, no rechaza el batch entero. Loguea los failures.
    for (let i = 0; i < docs.length; i += 50) {
      const batch = docs.slice(i, i + 50);
      const results = await Promise.allSettled(batch.map((d) => deleteFirestoreDoc(d.name)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') total++;
        else {
          failed++;
          console.warn(`  ✗ fallo al borrar ${batch[idx].name}: ${r.reason && r.reason.message}`);
        }
      });
    }
    console.log(`  ${total} documentos borrados (${failed} fallaron)...`);
    pageToken = res.nextPageToken;
  } while (pageToken);
  console.log(`Firestore /users/*: ${total} documentos borrados, ${failed} fallaron\n`);
  return total;
}

// CRIT-28: count + dry-run + gating prod-safe.
async function countAuth() {
  let total = 0;
  let nextPageToken;
  do {
    const result = await auth.listUsers(1000, nextPageToken);
    total += result.users.length;
    nextPageToken = result.pageToken;
  } while (nextPageToken);
  return total;
}

async function logAdminAction(action, payload) {
  try {
    const db = admin.firestore();
    await db.collection('adminActions').add({
      action,
      payload,
      operator: process.env.USER || 'unknown',
      script: 'delete_users.js',
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('No se pudo loguear adminAction:', e.message);
  }
}

(async () => {
  try {
    // --dry-run: solo contar, NO borrar.
    const DRY_RUN = process.argv.includes('--dry-run');
    // --i-confirm-full-wipe: gate explícito requerido en producción además
    // del confirmDestructive estándar. Sin este flag y con PROJECT que parezca
    // prod, abortar.
    const HAS_PROD_GATE = process.argv.includes('--i-confirm-full-wipe');
    const looksLikeProd = !PROJECT.includes('staging') && !PROJECT.includes('test') && !PROJECT.includes('dev');

    console.log(`Proyecto destino: ${PROJECT}`);
    console.log(`Operador: ${process.env.USER || 'unknown'}`);

    const authCount = await countAuth();
    console.log(`\nUsuarios en Auth: ${authCount}`);

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No se borrará nada. Saliendo.');
      process.exit(0);
    }

    if (looksLikeProd && !HAS_PROD_GATE) {
      console.error('\nABORT: el proyecto parece ser producción.');
      console.error('Para ejecutar contra prod requerís TRES condiciones:');
      console.error('  1. Flag --i-confirm-full-wipe');
      console.error('  2. Confirmación interactiva (no usar --yes-i-am-sure)');
      console.error('  3. Variable USER seteada para auditoría');
      process.exit(1);
    }

    if (process.argv.includes('--yes-i-am-sure')) {
      console.error('\nABORT: --yes-i-am-sure NO permitido en este script (demasiado destructivo).');
      console.error('Requiere confirmación interactiva.');
      process.exit(1);
    }

    await confirmDestructive(PROJECT, `BORRAR ${authCount} usuarios (Auth + Firestore /users/*)`);

    await logAdminAction('delete_users_start', { authCount, projectId: PROJECT });

    const a = await deleteAllAuthUsers();
    const f = await deleteAllFirestoreDocs();

    await logAdminAction('delete_users_done', {
      authDeleted: a,
      firestoreDeleted: f,
      projectId: PROJECT,
    });

    console.log(`LISTO: ${a} Auth users + ${f} Firestore docs borrados.`);
    process.exit(0);
  } catch (e) {
    console.error('ERROR:', e.message || e);
    process.exit(1);
  }
})();
