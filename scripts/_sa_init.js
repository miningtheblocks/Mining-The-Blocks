/**
 * _sa_init.js — Service Account dedicado para scripts admin.
 *
 * Reemplaza el patrón anterior de leer firebase-tools.json (que tenía
 * roles/owner = pwn total del proyecto si se filtraba — Agente #11
 * CRIT-11-03 del audit Round 2).
 *
 * El SA `mtb-admin-cli` solo tiene 2 roles:
 *   - Firebase Authentication Admin (necesario para grant_admin.js +
 *     delete_users.js que crean/borran users de Auth)
 *   - Cloud Datastore User (necesario para read/write de Firestore)
 *
 * NO tiene Owner, Editor, billing, Secret Manager. Si el JSON se filtra,
 * blast radius limitado a Auth + Firestore (sin acceso a secrets como
 * SERVER_SEED, COMPANY_WALLET_KEY, GMAIL_APP_PASSWORD).
 *
 * Setup (one-time, ver RUNBOOK.md):
 *   1. GCP Console → IAM → Service Accounts → Create.
 *   2. Nombre: mtb-admin-cli. Roles: Auth Admin + Datastore User.
 *   3. Create Key (JSON) → guardar en ~/.mtb-keys/mtb-admin-cli.json (chmod 600).
 *   4. Opcional: export MTB_ADMIN_SA=/otra/ruta/sa.json para override.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const admin = require('../functions/node_modules/firebase-admin');

const DEFAULT_SA_PATH = path.join(os.homedir(), '.mtb-keys', 'mtb-admin-cli.json');
const PROJECT = 'miningtheblocks-669f6';

function loadServiceAccount() {
  const saPath = process.env.MTB_ADMIN_SA || DEFAULT_SA_PATH;
  try {
    return { json: JSON.parse(fs.readFileSync(saPath, 'utf8')), path: saPath };
  } catch (e) {
    console.error(`[SA] Error leyendo Service Account en ${saPath}: ${e.message}`);
    console.error(`[SA] Setea MTB_ADMIN_SA=/path/to/sa.json o poné el archivo en ${DEFAULT_SA_PATH}.`);
    console.error(`[SA] Ver RUNBOOK.md → "Service Account dedicado para scripts admin".`);
    process.exit(1);
  }
}

function initAdmin() {
  if (admin.apps.length) return { admin, app: admin.app() };
  const { json, path: saPath } = loadServiceAccount();
  const app = admin.initializeApp({
    credential: admin.credential.cert(json),
    projectId: PROJECT,
  });
  console.log(`[SA] firebase-admin inicializado con ${path.basename(saPath)} (project ${PROJECT})`);
  return { admin, app };
}

// Cache del Bearer token con buffer de 60s antes del expiry para evitar
// llamadas REST con tokens que expiran mid-flight.
let _cachedToken = null;
let _cachedExpiry = 0;

/**
 * Devuelve un Bearer token fresco del SA actual. Usar para llamadas REST
 * directas a googleapis.com (Firestore REST API, etc.).
 */
async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _cachedExpiry) return _cachedToken;
  if (!admin.apps.length) initAdmin();
  const credential = admin.app().options.credential;
  const { access_token, expires_in } = await credential.getAccessToken();
  _cachedToken = access_token;
  _cachedExpiry = now + ((expires_in || 3600) * 1000) - 60000;
  return _cachedToken;
}

module.exports = { initAdmin, getAccessToken, PROJECT };
