const admin = require('/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/node_modules/firebase-admin');
const { confirmDestructive } = require('./_confirm');

const PROJECT = 'miningtheblocks-669f6';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

async function deleteCollection(colRef) {
  const snap = await colRef.get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  console.log(`  Borrados ${snap.size} docs de ${colRef.path}`);
}

async function deleteServer(doc) {
  console.log(`Borrando servidor: ${doc.data().name} (${doc.id})`);
  await deleteCollection(doc.ref.collection('mined'));
  await deleteCollection(doc.ref.collection('layers'));
  await deleteCollection(doc.ref.collection('mined')); // segunda pasada por si quedaron
  await doc.ref.delete();
  console.log(`  Servidor ${doc.data().name} borrado.`);
}

async function main() {
  const namesToDelete = ['bissi', 'raken'];
  const snap = await db.collection('servers').get();

  const toDelete = snap.docs.filter(d => {
    const name = (d.data().name || '').toLowerCase();
    return namesToDelete.some(n => name.includes(n));
  });

  if (toDelete.length === 0) {
    console.log('No se encontraron servidores con esos nombres.');
    return;
  }

  console.log(`Encontrados ${toDelete.length} servidor(es) para borrar:`);
  toDelete.forEach(d => console.log(`  - ${d.data().name} (${d.id})`));

  await confirmDestructive(PROJECT, `BORRAR ${toDelete.length} servidor(es) y sus subcolecciones (mined, layers)`);

  for (const doc of toDelete) {
    await deleteServer(doc);
  }

  console.log('\nListo. Servidores eliminados.');
}

main().catch(console.error).finally(() => process.exit(0));
