/**
 * grant_admin.js — setea custom claim `admin: true` en un usuario.
 *
 * Funciones que requieren este claim:
 *   - addServerCredit, processPendingMints, notifyAllUsers,
 *     grantPicksDev, resetAllMinedCubes, initLayerRewards
 *
 * Uso:
 *   node scripts/grant_admin.js <uid>              # otorga admin
 *   node scripts/grant_admin.js <uid> --revoke     # quita admin
 *   node scripts/grant_admin.js <uid> --yes-i-am-sure   # skip prompt (CI)
 *
 * Importante:
 *   - Los custom claims tardan ~1h en propagarse al ID token del cliente,
 *     o se refrescan inmediatamente forzando logout/login del user admin.
 *   - El log de la acción queda en Firestore `adminActions`.
 */

// Path absoluto a lib/auth + lib/firestore — las subpath exports
// (firebase-admin/auth) NO resuelven cuando se usa filesystem-path require
// desde fuera del package, por eso apuntamos directo a /lib.
const { getAuth } = require('../functions/node_modules/firebase-admin/lib/auth');
const { getFirestore } = require('../functions/node_modules/firebase-admin/lib/firestore');
const { confirmDestructive } = require('./_confirm');
const { initAdmin } = require('./_sa_init');

// SA dedicado mtb-admin-cli (Firebase Auth Admin + Cloud Datastore User).
// Reemplaza firebase-tools.json (= roles/owner). Ver _sa_init.js + RUNBOOK.md.
initAdmin();

async function main() {
  const targetUid = process.argv[2];
  const revoke = process.argv.includes('--revoke');

  if (!targetUid) {
    console.error('Uso: node scripts/grant_admin.js <uid> [--revoke]');
    process.exit(1);
  }

  // Verificar que el user exista
  let user;
  try {
    user = await getAuth().getUser(targetUid);
  } catch (e) {
    console.error(`Usuario ${targetUid} no encontrado en Auth.`);
    process.exit(1);
  }

  const currentClaims = user.customClaims || {};
  const wasAdmin = !!currentClaims.admin;
  console.log(`\n  Usuario: ${user.email || user.uid}`);
  console.log(`  Admin actual: ${wasAdmin ? 'SÍ' : 'NO'}`);
  console.log(`  Acción:       ${revoke ? 'REVOCAR' : 'OTORGAR'} admin\n`);

  if (revoke && !wasAdmin) {
    console.log('  Ya no es admin. Nada que hacer.');
    process.exit(0);
  }
  if (!revoke && wasAdmin) {
    console.log('  Ya es admin. Nada que hacer.');
    process.exit(0);
  }

  await confirmDestructive(
    PROJECT,
    `${revoke ? 'REVOCAR' : 'OTORGAR'} admin a ${user.email || user.uid}`,
  );

  const newClaims = { ...currentClaims };
  if (revoke) delete newClaims.admin;
  else newClaims.admin = true;

  await getAuth().setCustomUserClaims(targetUid, newClaims);

  // Audit log
  await getFirestore().collection('adminActions').add({
    action: revoke ? 'revoke_admin' : 'grant_admin',
    adminUid: 'cli',
    targetUid,
    targetEmail: user.email || null,
    ts: Date.now(),
    operator: process.env.USER || 'unknown',
  });

  console.log(`\n✅ ${revoke ? 'Revocado' : 'Otorgado'}. El user debe re-loggear para que el ID token refleje el cambio.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
