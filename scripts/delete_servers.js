// CRIT-27: ya no acepta una lista hardcoded de substrings de nombre que
// podía borrar cualquier server cuyo nombre contuviera 'bissi' o 'raken'
// (incluyendo terceros como 'Brakenridge' o 'Abissinia'). Ahora EXIGE
// serverIds explícitos por CLI args.
//
// Uso:
//   node scripts/delete_servers.js <serverId> [<serverId> ...]
//   node scripts/delete_servers.js abc123 def456
//
// Con --yes-i-am-sure salta el prompt (NO recomendado para producción).

const admin = require('../functions/node_modules/firebase-admin');
const { confirmDestructive } = require('./_confirm');

const PROJECT = 'miningtheblocks-669f6';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const SERVER_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

async function deleteCollectionPaginated(colRef) {
  let total = 0;
  while (true) {
    const snap = await colRef.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < 400) break;
  }
  if (total > 0) console.log(`  Borrados ${total} docs de ${colRef.path}`);
}

async function deleteServer(doc) {
  const name = doc.data().name || '(sin nombre)';
  console.log(`Borrando servidor: ${name} (${doc.id})`);
  await deleteCollectionPaginated(doc.ref.collection('mined'));
  await deleteCollectionPaginated(doc.ref.collection('layers'));
  await doc.ref.delete();
  console.log(`  Servidor ${name} borrado.`);
}

async function logAdminAction(action, payload) {
  try {
    await db.collection('adminActions').add({
      action,
      payload,
      operator: process.env.USER || 'unknown',
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('No se pudo loguear adminAction:', e.message);
  }
}

async function main() {
  // Filtrar args, ignorando --flags
  const serverIds = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (serverIds.length === 0) {
    console.error('Error: especificá al menos un serverId.');
    console.error('Uso: node scripts/delete_servers.js <serverId> [<serverId> ...]');
    process.exit(1);
  }

  // Validar formato para evitar typos / inyección path traversal
  for (const id of serverIds) {
    if (!SERVER_ID_RE.test(id)) {
      console.error(`Error: serverId inválido: "${id}"`);
      console.error('Formato esperado: 6-40 chars alfanuméricos/underscore/dash.');
      process.exit(1);
    }
  }

  // Buscar exactamente esos servers (no substring match)
  const found = [];
  const missing = [];
  for (const id of serverIds) {
    const doc = await db.collection('servers').doc(id).get();
    if (doc.exists) found.push(doc);
    else missing.push(id);
  }

  if (missing.length > 0) {
    console.error(`Error: no existen los siguientes servers: ${missing.join(', ')}`);
    console.error('Abort: no se borrará nada.');
    process.exit(1);
  }

  console.log(`Servidores a borrar (${found.length}):`);
  found.forEach((d) => console.log(`  - ${d.data().name || '(sin nombre)'} (${d.id})`));

  await confirmDestructive(PROJECT, `BORRAR ${found.length} servidor(es) y sus subcolecciones (mined, layers)`);

  await logAdminAction('delete_servers_start', {
    serverIds: found.map((d) => d.id),
    serverNames: found.map((d) => d.data().name || null),
  });

  for (const doc of found) {
    await deleteServer(doc);
  }

  await logAdminAction('delete_servers_done', {
    serverIds: found.map((d) => d.id),
    count: found.length,
  });

  console.log('\nListo. Servidores eliminados.');
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
