// src/utils/sentry.js
//
// Sentry RN — error tracking en producción. Agente #11 HIGH-11-23 del audit.
//
// Lee el DSN de EXPO_PUBLIC_SENTRY_DSN (env var con prefijo EXPO_PUBLIC_ que
// sí llega al bundle del cliente). Si la var está vacía, Sentry queda no-op
// (init() no se llama) — útil para evitar enviar eventos en dev sin DSN.
//
// IMPORTANTE: cualquier cambio acá afecta el agrupamiento de issues. Antes
// de modificar tags/environment/release leer https://docs.sentry.io/.
//
// PII handling:
//   - sendDefaultPii: false (default en SDK 7+, explícito para que se vea).
//   - logError() del proyecto ya scrubbea PII antes de llamar acá.
//   - Si se agregan integrations nuevas (HttpClient, etc.), revisar qué data
//     mandan por default.

import * as Sentry from '@sentry/react-native';
import { scrubPiiValue } from './logError';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';

let _initialized = false;

// Round 2 audit #3 MED-4: hooks defense-in-depth ante PII fugada vía
// unhandled exceptions y breadcrumbs.
//
// Por qué existen: logError() scrubea el ctx que le pasa el caller, pero hay
// dos rutas que bypasean ese path:
//   1. Unhandled exceptions globales — Sentry las captura automáticamente con
//      `event.message` y `event.exception.values[].value` que pueden incluir
//      strings con email/wallet/phone (ej: "fetch failed for user a@b.com").
//   2. Breadcrumbs de fetch/console/navigation con URLs que llevan el wallet
//      o email en query params.
// El scrubber aplica los mismos regex de _PII_VALUE_RES sobre ambos canales
// antes de que salgan del device.
function _scrubInPlace(obj, keys) {
  if (!obj) return;
  for (const k of keys) {
    if (typeof obj[k] === 'string') {
      obj[k] = scrubPiiValue(obj[k]);
    }
  }
}

function beforeSendScrub(event) {
  try {
    _scrubInPlace(event, ['message']);
    if (event.exception && Array.isArray(event.exception.values)) {
      for (const exc of event.exception.values) {
        _scrubInPlace(exc, ['value']);
      }
    }
    if (event.request) {
      _scrubInPlace(event.request, ['url']);
      if (event.request.headers) {
        // Authorization/Cookie ya quedan strippeados por sendDefaultPii:false,
        // pero por las dudas no pasamos referer + URL crudos.
        delete event.request.headers['Cookie'];
        delete event.request.headers['Authorization'];
      }
    }
  } catch (_) { /* no-op: never break Sentry pipeline */ }
  return event;
}

function beforeBreadcrumbScrub(crumb) {
  try {
    _scrubInPlace(crumb, ['message']);
    if (crumb.data) {
      _scrubInPlace(crumb.data, ['url', 'to', 'from', 'email', 'message']);
    }
  } catch (_) { /* no-op */ }
  return crumb;
}

export function initSentry() {
  if (_initialized) return;
  if (!DSN) {
    // Dev sin DSN configurado: queda no-op. No throw para no romper boot.
    console.log('[Sentry] DSN no configurado (EXPO_PUBLIC_SENTRY_DSN vacío) — Sentry deshabilitado.');
    return;
  }
  try {
    Sentry.init({
      dsn: DSN,
      environment: __DEV__ ? 'dev' : 'prod',
      // tracesSampleRate: porcentaje de transactions (performance) que se
      // mandan. 0.2 = 20% — balance entre signal útil y consumo del free tier
      // (5k events/mes). Subir a 1.0 solo durante debugging activo.
      tracesSampleRate: __DEV__ ? 1.0 : 0.2,
      // PII off — el usuario no envía nombre/email a Sentry automáticamente.
      sendDefaultPii: false,
      // Round 2 audit #3 MED-4: hooks que scrubean PII en unhandled exceptions
      // y breadcrumbs (paths que bypasean logError).
      beforeSend: beforeSendScrub,
      beforeBreadcrumb: beforeBreadcrumbScrub,
      // Native crashes — captura crashes nativos (Android JNI / iOS Obj-C)
      // además de los JS errors. Necesario para fail-fast en native modules.
      enableNative: true,
      // En dev no queremos contaminar con cada hot-reload + warn.
      enableInExpoDevelopment: false,
    });
    _initialized = true;
    console.log('[Sentry] init OK (env=' + (__DEV__ ? 'dev' : 'prod') + ')');
    // Test event opt-in via EXPO_PUBLIC_SENTRY_TEST=1 — útil al wirear la
    // integración por primera vez. Quitar la env var cuando esté verificada.
    if (process.env.EXPO_PUBLIC_SENTRY_TEST === '1') {
      try {
        Sentry.captureMessage('[Sentry-test] integration smoke-test event from RN client', 'info');
        console.log('[Sentry] test event enviado — chequear dashboard.');
      } catch (e) {
        console.warn('[Sentry] test event falló:', e && e.message);
      }
    }
  } catch (e) {
    // Sentry.init nunca debería throw, pero por las dudas no rompemos el boot
    // de la app si falla.
    console.warn('[Sentry] init falló:', e && e.message);
  }
}

/**
 * Captura una excepción manualmente. Usar en catch blocks donde tenemos
 * contexto extra que merece ir a Sentry.
 *
 * @param {Error} err - El error a capturar
 * @param {Object} [extra] - Contexto adicional (no PII)
 * @param {string} [tag] - Tag para agrupar (e.g., 'Profile.save')
 */
export function captureException(err, extra, tag) {
  if (!_initialized) return;
  try {
    Sentry.withScope((scope) => {
      if (tag) scope.setTag('op', tag);
      if (extra && typeof extra === 'object') {
        scope.setExtras(extra);
      }
      Sentry.captureException(err);
    });
  } catch (_) {
    // no-op — capture jamás debería romper el flow del caller.
  }
}

export { Sentry };
