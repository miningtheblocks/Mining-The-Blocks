// CQ-006: Single source of truth para constantes compartidas entre módulos.
// CRIT-19: NO importar package.json — eso mete TODO el manifest (deps,
// scripts, versiones) al bundle JS, filtrando info útil para reverse-engineer.
// Leemos la versión desde expo-constants (el archivo nativo expuesto a JS).
import Constants from 'expo-constants';

// Fallback hardcoded sincronizado manualmente con app.json/package.json en cada bump.
// El proceso de release es: bumpear 3 lugares (app.json.expo.version + package.json.version + acá).
const FALLBACK_APP_VERSION = '1.1.0';

export const APP_VERSION =
  Constants?.expoConfig?.version ||
  Constants?.manifest2?.extra?.expoClient?.version ||
  Constants?.manifest?.version ||
  FALLBACK_APP_VERSION;

export const TERMS_URL = 'https://miningtheblocks.github.io/Mining-The-Blocks/terms.html';
export const PRIVACY_URL = 'https://miningtheblocks.github.io/Mining-The-Blocks/privacy.html';

// Comparación semver simple — devuelve -1, 0 o 1.
// MEDIO-CONST-05: strip de sufijos prerelease/build (e.g. "1.2.3-beta.1" → "1.2.3")
// y casting defensivo de NaN. Antes "1.2.3-beta" devolvía [1, NaN, NaN] vía
// Number() y los comparators contra NaN siempre eran false (versión "se quedaba
// estancada"). Ahora siempre comparamos solo major.minor.patch.
export function compareVersions(v1, v2) {
  const norm = (v) => {
    const cleaned = String(v || '0').split('-')[0].split('+')[0];
    return cleaned.split('.').slice(0, 3).map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const a = norm(v1);
  const b = norm(v2);
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
