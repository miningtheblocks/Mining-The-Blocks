// CQ-003 / CQ-035 / P1-8: Logger centralizado para errores no-fatales.
// Reemplaza patrones `} catch {}` y `console.warn` ad-hoc que tragan info útil.
//
// Uso:
//   try { ... } catch (e) { logError('Registration.applyReferral', e, { code }); }
//
// En dev: console.warn estructurado.
// En prod: envía a Cloud Function `logClientError` que escribe en Firestore `errorLog`.

function safeMsg(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  return e.code ? `[${e.code}] ${e.message || e}` : (e.message || String(e));
}

// MEDIO-LE-02 + LE-08: scrub PII + extender truncado para stack traces.
// Si un caller pasa accidentalmente `{ password: '...' }` o `{ idToken: '...' }`
// como ctx, lo enmascaramos antes de mandar a Firestore.
const _SENSITIVE_KEY_RE = /(password|passwd|token|secret|wallet|authorization|api[_-]?key|private[_-]?key|cookie|session)/i;
function safeCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  try {
    return JSON.stringify(ctx, (k, v) => {
      if (typeof k === 'string' && _SENSITIVE_KEY_RE.test(k)) return '[redacted]';
      if (typeof v === 'function') return '[fn]';
      if (typeof v === 'string') {
        // Stacks pueden ser >200 chars y son útiles; truncar a 2000.
        const limit = k === 'stack' || k === 'componentStack' ? 2000 : 200;
        if (v.length > limit) return v.slice(0, limit) + '…';
      }
      return v;
    });
  } catch {
    return '[unserializable ctx]';
  }
}

// Reporte remoto: debouncea + cap diario para no saturar Firestore/Cloud Functions.
// Si el error es repetitivo (mismo scope+msg en <60s) lo descartamos.
const _recentErrors = new Map();
const _DAILY_MAX = 50;
let _todayCount = 0;
let _todayDay = 0;

async function reportRemote(scope, err, ctx) {
  try {
    const day = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    if (day !== _todayDay) { _todayDay = day; _todayCount = 0; }
    if (_todayCount >= _DAILY_MAX) return;
    const msg = safeMsg(err);
    const dedupeKey = `${scope}|${msg}`;
    const lastSent = _recentErrors.get(dedupeKey) || 0;
    if (Date.now() - lastSent < 60_000) return;
    _recentErrors.set(dedupeKey, Date.now());
    _todayCount++;

    // Lazy require para evitar dependencias circulares
    const { callLogClientError } = await import('../firebase/functions');
    await callLogClientError({ scope, msg, ctx: safeCtx(ctx) });
  } catch (_) {}
}

// MEDIO-LE-07: top-level try/catch para evitar que logError jamás lance.
// Si lanza dentro de un ErrorBoundary que vuelve a llamarlo, loop infinito.
export function logError(scope, err, ctx) {
  try {
    // MEDIO-LE-03: cap del Map a 200 entries con LRU eviction.
    if (_recentErrors.size > 200) {
      const firstKey = _recentErrors.keys().next().value;
      if (firstKey !== undefined) _recentErrors.delete(firstKey);
    }
    const msg = safeMsg(err);
    const ctxStr = safeCtx(ctx);
    // eslint-disable-next-line no-console
    console.warn(`[${scope}]`, msg, ctxStr || '');
    // En __DEV__ no enviamos al backend para no saturarlo durante desarrollo.
    if (typeof __DEV__ === 'undefined' || !__DEV__) {
      reportRemote(scope, err, ctx);
    }
  } catch (_) { /* swallow — no relanzar */ }
}

// Default export para compat con `import logError from '../utils/logError'`.
export default logError;

// Helper para usar como handler de `.catch()` sin tener que armar wrapper inline:
//   somePromise().catch(logErrorWith('Profile.loadGems'))
export const logErrorWith = (scope, ctx) => (err) => logError(scope, err, ctx);
