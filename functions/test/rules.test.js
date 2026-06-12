// P1-10: Tests de Firestore Security Rules.
//
// Requiere el Firestore emulator corriendo. Ejecutar con:
//   npm run test:rules
// (que ejecuta `firebase emulators:exec ... jest --testRegex=rules.test.js`)
//
// Cubre las protecciones críticas:
//   - users create whitelist (SEC-005)
//   - users update whitelist (P1-6)
//   - history create solo type='mine' (A1+A2)
//   - meta/counter sólo +1 incrementos
//   - config/app sólo Cloud Functions escriben
//   - gemClaims, adminActions, errorLog, rateLimits no legibles desde cliente
//   - serverAccess sólo Cloud Functions
//   - usernames create/update reglas

const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-mtb',
    firestore: {
      rules: fs.readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

function dbAs(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}
function dbAnon() {
  return testEnv.unauthenticatedContext().firestore();
}

describe('users create (SEC-005 whitelist)', () => {
  test('create con whitelist permitida: OK', async () => {
    const db = dbAs('uid1');
    await assertSucceeds(db.doc('users/uid1').set({
      displayName: 'Alice', email: 'a@b.com', picks: 0, createdAt: Date.now(),
    }));
  });
  test('create con picks!=0: FALLA', async () => {
    const db = dbAs('uid2');
    await assertFails(db.doc('users/uid2').set({ picks: 999, createdAt: Date.now() }));
  });
  test('create con referredBy: FALLA (no está en whitelist)', async () => {
    const db = dbAs('uid3');
    await assertFails(db.doc('users/uid3').set({
      referredBy: 'attacker', createdAt: Date.now(),
    }));
  });
  test('create con walletAddress: FALLA', async () => {
    const db = dbAs('uid4');
    await assertFails(db.doc('users/uid4').set({
      walletAddress: '0xattacker', createdAt: Date.now(),
    }));
  });
  test('create con uid distinto: FALLA', async () => {
    const db = dbAs('uid5');
    await assertFails(db.doc('users/other').set({ displayName: 'Bob' }));
  });
});

describe('users update (P1-6 whitelist)', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('users/uid1').set({
        displayName: 'Alice', picks: 5, serverCredits: 2, walletAddress: '0xabc', referralCode: 'AAA',
      });
    });
  });

  test('update displayName: OK', async () => {
    const db = dbAs('uid1');
    await assertSucceeds(db.doc('users/uid1').update({ displayName: 'Alice2' }));
  });
  test('update picks (game state): FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('users/uid1').update({ picks: 9999 }));
  });
  test('update walletAddress (sensitive): FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('users/uid1').update({ walletAddress: '0xattacker' }));
  });
  test('update referralCode: FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('users/uid1').update({ referralCode: 'OWNED' }));
  });
  test('update otra user: FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('users/uid2').update({ displayName: 'pwned' }));
  });
});

describe('serverChains/history (A1+A2)', () => {
  const chainId = 'chain1';
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`users/uid1/serverAccess/server1`).set({ chainId, serverId: 'server1' });
    });
  });

  test('history create con type=mine y campos válidos: OK', async () => {
    const db = dbAs('uid1');
    await assertSucceeds(db.collection(`serverChains/${chainId}/history`).add({
      type: 'mine', seq: 1, ts: Date.now(), uid: 'uid1', displayName: 'Alice',
      serverId: 'server1', cubeNumber: 100, layerK: 50, episodeNumber: 1, rewardPicks: 3,
    }));
  });
  test('history create con type=episode_complete: FALLA (sólo backend)', async () => {
    const db = dbAs('uid1');
    await assertFails(db.collection(`serverChains/${chainId}/history`).add({
      type: 'episode_complete', seq: 2, ts: Date.now(), uid: 'uid1',
      serverId: 'server1', episodeNumber: 1, totalMined: 1000,
    }));
  });
  test('history create con rewardCash > $100k: FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.collection(`serverChains/${chainId}/history`).add({
      type: 'mine', seq: 1, ts: Date.now(), uid: 'uid1',
      serverId: 'server1', rewardCash: 999999999,
    }));
  });
  test('history create con seq > 10^8: FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.collection(`serverChains/${chainId}/history`).add({
      type: 'mine', seq: 999999999, ts: Date.now(), uid: 'uid1', serverId: 'server1',
    }));
  });
  test('history create sin serverAccess: FALLA', async () => {
    const db = dbAs('uidWithoutAccess');
    await assertFails(db.collection(`serverChains/${chainId}/history`).add({
      type: 'mine', seq: 1, ts: Date.now(), uid: 'uidWithoutAccess',
      serverId: 'server1',
    }));
  });
  test('history update/delete: FALLA siempre', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`serverChains/${chainId}/history/entry1`).set({ type: 'mine', seq: 1, uid: 'uid1', serverId: 'server1' });
    });
    const db = dbAs('uid1');
    await assertFails(db.doc(`serverChains/${chainId}/history/entry1`).update({ rewardCash: 9999 }));
    await assertFails(db.doc(`serverChains/${chainId}/history/entry1`).delete());
  });
});

describe('serverChains/meta (seq counter)', () => {
  const chainId = 'chain1';
  test('meta create con seq=1: OK', async () => {
    const db = dbAs('uid1');
    await assertSucceeds(db.doc(`serverChains/${chainId}/meta/counter`).set({ seq: 1 }));
  });
  test('meta update seq+1: OK', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`serverChains/${chainId}/meta/counter`).set({ seq: 5 });
    });
    const db = dbAs('uid1');
    await assertSucceeds(db.doc(`serverChains/${chainId}/meta/counter`).set({ seq: 6 }));
  });
  test('meta update seq+2 (skip): FALLA', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`serverChains/${chainId}/meta/counter`).set({ seq: 5 });
    });
    const db = dbAs('uid1');
    await assertFails(db.doc(`serverChains/${chainId}/meta/counter`).set({ seq: 7 }));
  });
  test('meta update con otros campos: FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc(`serverChains/${chainId}/meta/counter`).set({ seq: 1, evil: 'inject' }));
  });
});

describe('config/app (downloadUrl protection)', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('config/app').set({
        minVersion: '1.0.0', latestVersion: '1.0.4',
        downloadUrl: 'https://miningtheblocks.github.io/Mining-The-Blocks/',
      });
    });
  });
  test('read autenticado: OK', async () => {
    await assertSucceeds(dbAs('uid1').doc('config/app').get());
  });
  test('read anónimo: FALLA', async () => {
    await assertFails(dbAnon().doc('config/app').get());
  });
  test('write desde cliente: FALLA (incluso authed)', async () => {
    await assertFails(dbAs('uid1').doc('config/app').update({
      downloadUrl: 'http://attacker/payload.apk',
    }));
  });
});

describe('Colecciones admin-only no son legibles', () => {
  test('gemClaims: no read', async () => {
    await assertFails(dbAs('uid1').collection('gemClaims').get());
  });
  test('adminActions: no read', async () => {
    await assertFails(dbAs('uid1').collection('adminActions').get());
  });
  test('errorLog: no read', async () => {
    await assertFails(dbAs('uid1').collection('errorLog').get());
  });
  test('rateLimits: no read', async () => {
    await assertFails(dbAs('uid1').collection('rateLimits').get());
  });
  test('adSessions: no read', async () => {
    await assertFails(dbAs('uid1').collection('adSessions').get());
  });
});

describe('serverAccess (Cloud Functions only)', () => {
  test('write desde cliente: FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('users/uid1/serverAccess/server1').set({
      serverId: 'server1', chainId: 'c1', joinedAt: Date.now(),
    }));
  });
  test('read propio: OK', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('users/uid1/serverAccess/server1').set({ serverId: 'server1' });
    });
    await assertSucceeds(dbAs('uid1').collection('users/uid1/serverAccess').get());
  });
  test('read ajeno: FALLA', async () => {
    await assertFails(dbAs('uid1').collection('users/uid2/serverAccess').get());
  });
});

describe('usernames', () => {
  test('create con formato válido: OK', async () => {
    const db = dbAs('uid1');
    await assertSucceeds(db.doc('usernames/alice123').set({
      uid: 'uid1', createdAt: Date.now(),
    }));
  });
  test('create con uid distinto: FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('usernames/alice123').set({
      uid: 'attacker', createdAt: Date.now(),
    }));
  });
  test('create con formato inválido (mayúsculas): FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('usernames/Alice123').set({
      uid: 'uid1', createdAt: Date.now(),
    }));
  });
  test('create con username corto (<3): FALLA', async () => {
    const db = dbAs('uid1');
    await assertFails(db.doc('usernames/ab').set({ uid: 'uid1', createdAt: Date.now() }));
  });
  test('update no puede reasignar a otro uid: FALLA (SEC-006)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('usernames/alice123').set({ uid: 'uid1', createdAt: 1 });
    });
    const db = dbAs('uid1');
    await assertFails(db.doc('usernames/alice123').update({ uid: 'attacker' }));
  });
});

describe('pendingCryptoPayments', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('pendingCryptoPayments/pay1').set({ uid: 'uid1', amount: 15 });
    });
  });
  test('owner puede leer su pago: OK', async () => {
    await assertSucceeds(dbAs('uid1').doc('pendingCryptoPayments/pay1').get());
  });
  test('otro usuario NO puede leer: FALLA', async () => {
    await assertFails(dbAs('uid2').doc('pendingCryptoPayments/pay1').get());
  });
  test('escritura desde cliente: FALLA', async () => {
    await assertFails(dbAs('uid1').doc('pendingCryptoPayments/pay1').update({ status: 'completed' }));
  });
});

describe('Activity feed', () => {
  test('autenticado puede leer: OK', async () => {
    await assertSucceeds(dbAs('uid1').collection('activityFeed').get());
  });
  test('anon NO puede leer', async () => {
    await assertFails(dbAnon().collection('activityFeed').get());
  });
  test('escritura: FALLA siempre', async () => {
    await assertFails(dbAs('uid1').collection('activityFeed').add({ type: 'fake' }));
  });
});
