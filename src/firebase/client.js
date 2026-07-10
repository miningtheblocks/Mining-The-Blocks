// src/firebase/client.js
import { initializeApp, getApps } from 'firebase/app';
import { initializeAuth, getAuth, getReactNativePersistence, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Firebase configuration.
// Round 2 smoke-test fix (2026-06-16):
// - apiKey original `AIzaSyDRCpXkNW...` (Browser key, HTTP Referer restricted):
//   rechazaba con `auth/requests-from-referer-<empty>-are-blocked` porque RN
//   nativo no manda header Referer.
// - Probamos `AIzaSyAtC4ItAQ5...` (Android key, package + SHA-1 restricted):
//   rechazaba con `auth/requests-from-this-android-client-application-<empty>`
//   porque el Firebase JS SDK no manda los headers X-Android-Package +
//   X-Android-Cert que GCP usa para validar attestation (esos los manda solo
//   el SDK nativo via Google Play Services).
// - Solución temporal: 3ra API key `AIzaSyCwvPai1S...` con
//   `Application restrictions: None` + `API restrictions` limitadas a
//   Identity Toolkit + Firestore + Storage + Cloud Functions + Installations.
//   La defensa real son las Firestore Security Rules + Auth — la key embebida
//   en el APK nunca fue secret.
// - Plan v1.2.0: migrar a @react-native-firebase nativo + App Check con Play
//   Integrity. Cuando se haga, esta key se borra y se vuelve a la Android key.
//   Ver RUNBOOK.md → sección "Migración a @react-native-firebase + App Check".
const firebaseConfig = {
  apiKey: 'AIzaSyCwvPai1SixwhvYfIovfA0ovm3NCuu2nPk',
  authDomain: 'miningtheblocks-669f6.firebaseapp.com',
  projectId: 'miningtheblocks-669f6',
  storageBucket: 'miningtheblocks-669f6.firebasestorage.app',
  messagingSenderId: '581259503872',
  appId: '1:581259503872:web:d2f5d71daee9996392abe5'
};

// Initialize Firebase only once (Expo fast refresh safe)
export const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// Guard initializeAuth against hot-reload double-init (throws auth/already-initialized)
let _auth;
try {
  _auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
} catch {
  _auth = getAuth(app);
}
export const auth = _auth;
export const db = getFirestore(app);
export const storage = getStorage(app);

// CRIT-15: race del patrón anterior — onAuthStateChanged se desuscribía en
// el primer evento. Si el primero era null y Firebase restauraba sesión
// persistida un instante después (caso documentado en RN), `ensureUser`
// quedaba resuelto con null y se perdía la sesión.
//
// Firebase 9+ expone `auth.authStateReady()` que resuelve cuando auth
// terminó de inicializar (incluyendo restauración de persistencia AsyncStorage)
// y SÍ refleja la sesión restaurada. Lo usamos como fuente única.
const _authReady = typeof _auth.authStateReady === 'function'
  ? _auth.authStateReady()
  : new Promise((resolve) => {
      // Fallback para versiones viejas: mantener suscripción al primer evento
      // distinto de null (o resolver null tras 5s como timeout).
      let resolved = false;
      const finish = (v) => { if (!resolved) { resolved = true; resolve(v); unsub(); } };
      const unsub = onAuthStateChanged(_auth, (u) => { if (u || resolved) finish(u || null); });
      setTimeout(() => finish(null), 5000);
    });

// V1.1.0: el modo anónimo fue eliminado para reducir superficie de ataque.
// ensureUser solo bootstrappea el doc del user si está logueado con email/password.
// Si no hay user → resuelve null (App.js redirige a Login/Registration).
export async function ensureUser() {
  await _authReady;
  if (!auth.currentUser) return null;
  try {
    const userRef = doc(db, 'users', auth.currentUser.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      // Firestore rules whitelist: solo picks=0 + createdAt + updatedAt en create.
      // wallet/stats se setean server-side (Admin SDK) cuando hace falta.
      await setDoc(userRef, {
        picks: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }
  } catch (e) {
    console.warn('ensureUser bootstrap error', e);
  }
  return auth.currentUser;
}

// V1.1.0: modo anónimo eliminado. signInAnonymously ya no se usa.
