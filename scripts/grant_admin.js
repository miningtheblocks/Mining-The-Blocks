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

const admin = require('../functions/node_modules/firebase-admin');
const fs = require('fs');
const { confirmDestructive } = require('./_confirm');

const config = JSON.parse(fs.readFileSync('/home/code/.config/configstore/firebase-tools.json', 'utf8'));
const accessToken = config.tokens.access_token;
const PROJECT = 'miningtheblocks-669f6';

admin.initializeApp({
  credential: {
    getAccessToken: () => Promise.resolve({ access_token: accessToken, expires_in: 3600 }),
  },
  projectId: PROJECT,
});

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
    user = await admin.auth().getUser(targetUid);
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

  await admin.auth().setCustomUserClaims(targetUid, newClaims);

  // Audit log
  await admin.firestore().collection('adminActions').add({
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
