/**
 * publish-release.js — actualiza Firestore `config/app` para activar el
 * UpdateModal en clientes con versión vieja.
 *
 * Uso:
 *   node scripts/publish-release.js <version> [--soft]
 *
 *   <version>  Ej. "1.3.19". OBLIGATORIO.
 *   --soft     Soft update: muestra modal con botón "Más tarde".
 *              Default es force update (sin botón "Más tarde", no cerrable).
 *
 * Ejemplos:
 *   node scripts/publish-release.js 1.3.19           # force update
 *   node scripts/publish-release.js 1.3.19 --soft    # soft update
 *
 * Después de correr el script:
 *   - Clientes con APP_VERSION < <version> ven el UpdateModal automáticamente
 *     (listener Firestore en ServerList.js detecta el cambio en realtime).
 *   - El botón "Descargar" del modal abre https://github.com/.../latest/download/MTB-latest.apk
 *     (alias estable que apunta al último APK publicado en releases).
 *
 * Requiere: ~/.mtb-keys/mtb-admin-cli.json (ver _sa_init.js).
 */

const { getFirestore } = require('../functions/node_modules/firebase-admin/lib/firestore');
const { initAdmin } = require('./_sa_init');

const args = process.argv.slice(2);
const version = args[0];
const soft = args.includes('--soft');

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/publish-release.js <version> [--soft]');
  console.error('  <version> formato semver, ej "1.3.19"');
  console.error('  --soft   muestra modal cerrable (con "Más tarde")');
  process.exit(1);
}

initAdmin();
const db = getFirestore();

const payload = {
  latestVersion: version,
  downloadUrl: 'https://github.com/miningtheblocks/Mining-The-Blocks/releases/latest/download/MTB-latest.apk',
  updateMessageEs: `Hay una nueva versión (v${version}) con mejoras importantes. Descargala para seguir jugando.`,
  updateMessageEn: `A new version (v${version}) with important improvements is available. Download to keep playing.`,
};

if (soft) {
  // Soft: limpiar minVersion/forceUpdate por si quedaron de un release force.
  payload.minVersion = null;
  payload.forceUpdate = false;
} else {
  // Force: setea minVersion = version → clientes < version reciben modal
  // sin botón "Más tarde".
  payload.minVersion = version;
  payload.forceUpdate = true;
}

(async () => {
  try {
    await db.collection('config').doc('app').set(payload, { merge: true });
    console.log(`✅ config/app updated:`);
    console.log(`   latestVersion: ${version}`);
    console.log(`   minVersion:    ${soft ? '(cleared)' : version}`);
    console.log(`   forceUpdate:   ${soft ? 'false' : 'true'}`);
    console.log(`   downloadUrl:   ${payload.downloadUrl}`);
    console.log('');
    console.log(soft
      ? '🔔 Soft update activado — los clientes verán modal cerrable.'
      : '🔒 FORCE update activado — clientes con versión vieja no podrán seguir hasta actualizar.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Error actualizando config/app:', e.message);
    process.exit(1);
  }
})();
