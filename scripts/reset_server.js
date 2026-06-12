/**
 * reset_server.js
 * Resetea un servidor al estado inicial (episodio 1, capa 100, sin minados).
 * NO borra usuarios ni serverAccess — los miembros conservan su acceso.
 *
 * Uso:
 *   node scripts/reset_server.js <serverId>
 *   node scripts/reset_server.js <serverId> --wipe-access   (también borra serverAccess de usuarios)
 */

const admin = require('/run/media/code/c3c2291c-9fa2-4d6a-925f-b7f7876f676a/MTB/functions/node_modules/firebase-admin');
const { confirmDestructive } = require('./_confirm');

const PROJECT = 'miningtheblocks-669f6';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const STARTING_LAYER = 100;

function shellTotalCubes(K) {
  if (K < 0) return 0;
  const side = 2 * K + 1;
  const inner = K > 0 ? 2 * (K - 1) + 1 : 0;
  return side * side * side - inner * inner * inner;
}

async function deleteCollectionInBatches(colRef) {
  let deleted = 0;
  let snap;
  do {
    snap = await colRef.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
  } while (snap.size === 400);
  if (deleted > 0) console.log(`  ✓ Borrados ${deleted} docs de ${colRef.path}`);
}

async function main() {
  const serverId = process.argv[2];
  const wipeAccess = process.argv.includes('--wipe-access');

  if (!serverId) {
    console.error('Uso: node scripts/reset_server.js <serverId> [--wipe-access]');
    process.exit(1);
  }

  const serverRef = db.collection('servers').doc(serverId);
  const serverSnap = await serverRef.get();
  if (!serverSnap.exists) {
    console.error(`Servidor ${serverId} no encontrado.`);
    process.exit(1);
  }

  const serverData = serverSnap.data();
  const chainId = serverData.chainId;
  console.log(`\nReseteando servidor: "${serverData.name}" (${serverId})`);
  console.log(`  Chain: ${chainId}`);
  console.log(`  Estado actual: capa ${serverData.currentLayer}, episodio ${serverData.episodeNumber}, minados ${serverData.totalMined}`);
  if (wipeAccess) console.log('  ⚠️  --wipe-access activo: se borrará serverAccess de todos los usuarios');
  console.log('');

  await confirmDestructive(PROJECT, `RESET del servidor "${serverData.name}" (${serverId})${wipeAccess ? ' + wipe serverAccess' : ''}`);

  // 1. Borrar cubos minados
  console.log('1. Borrando cubos minados...');
  await deleteCollectionInBatches(serverRef.collection('mined'));

  // 2. Borrar estadísticas de capas
  console.log('2. Borrando stats de capas...');
  await deleteCollectionInBatches(serverRef.collection('layers'));

  // 3. Resetear documento del servidor
  console.log('3. Reseteando documento del servidor...');
  const K = STARTING_LAYER;
  await serverRef.update({
    currentLayer: K,
    totalMined: 0,
    winner: null,
    completedAt: null,
    status: 'active',
    episodeNumber: 1,
    memberCount: admin.firestore.FieldValue.delete(), // se recalcula al unirse
  });
  // Recrear capa inicial
  await serverRef.collection('layers').doc(String(K)).set({
    K,
    totalCubes: shellTotalCubes(K),
    stats: { mined: 0 },
    winRate: 0.50,
  });
  console.log(`  ✓ Servidor reseteado a capa ${K}`);

  // 4. Borrar historial y episodios de la cadena
  if (chainId) {
    const chainRef = db.collection('serverChains').doc(chainId);
    console.log('4. Borrando historial de cadena...');
    await deleteCollectionInBatches(chainRef.collection('history'));
    console.log('5. Borrando episodios de cadena...');
    await deleteCollectionInBatches(chainRef.collection('episodes'));
    console.log('6. Borrando meta (seq counter)...');
    await deleteCollectionInBatches(chainRef.collection('meta'));

    // Resetear documento de la cadena
    console.log('7. Reseteando documento de cadena...');
    await chainRef.update({
      currentEpisode: 1,
      currentServerId: serverId,
      status: 'active',
      completedAt: null,
    });
    console.log('  ✓ Cadena reseteada a episodio 1');
  } else {
    console.log('4-7. Sin chainId, saltando reset de cadena.');
  }

  // 5. Borrar registros de mines de usuarios (opcional)
  if (wipeAccess) {
    console.log('8. Borrando serverAccess de usuarios...');
    const usersSnap = await db.collection('users').get();
    let count = 0;
    for (const userDoc of usersSnap.docs) {
      const accessRef = userDoc.ref.collection('serverAccess').doc(serverId);
      const accessSnap = await accessRef.get();
      if (accessSnap.exists) {
        await accessRef.delete();
        count++;
      }
    }
    console.log(`  ✓ Borrado serverAccess de ${count} usuario(s)`);
  }

  console.log('\n✅ Reset completo. El servidor está listo para una nueva partida.');
}

main().catch(console.error).finally(() => process.exit(0));
