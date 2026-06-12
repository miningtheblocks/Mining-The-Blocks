// CQ-006: Single source of truth para constantes compartidas entre módulos.
// La APP_VERSION sigue al package.json para que un único bump (en app.json + package.json)
// se propague a todos los chequeos de versión (App.js, ServerList.js, version gate).
import pkg from '../package.json';

export const APP_VERSION = pkg.version;

export const TERMS_URL = 'https://miningtheblocks.github.io/Mining-The-Blocks/terms.html';
export const PRIVACY_URL = 'https://miningtheblocks.github.io/Mining-The-Blocks/privacy.html';

// Comparación semver simple — devuelve -1, 0 o 1.
export function compareVersions(v1, v2) {
  const a = (v1 || '0').split('.').map(Number);
  const b = (v2 || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) < (b[i] || 0)) return -1;
    if ((a[i] || 0) > (b[i] || 0)) return 1;
  }
  return 0;
}

// CQ-032: AsyncStorage keys con namespace consistente.
export const StorageKeys = {
  KEEP_SIGNED_IN: '@mtb_keep_signed_in',
  ACTIVE_SERVER: '@mtb_active_server',
  LANGUAGE: '@mtb_language',
};
