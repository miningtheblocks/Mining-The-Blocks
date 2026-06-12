// src/firebase/client.js
import { initializeApp, getApps } from 'firebase/app';
import { initializeAuth, getAuth, getReactNativePersistence, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: 'AIzaSyDRCpXkNWupz2PmoOG6XcuFENYaU5xIUps',
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

// Resolves with the first auth state emitted by Firebase (persisted session or null).
// ensureUser awaits this before deciding what to do.
let _authReadyResolve;
const _authReady = new Promise(resolve => { _authReadyResolve = resolve; });
const _initUnsub = onAuthStateChanged(_auth, (u) => {
  _authReadyResolve(u);
  _initUnsub();
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
      await setDoc(userRef, {
        picks: 0,
        wallet: { balance: 0 },
        stats: {
          totalMined: 0,
          totalRewardPicks: 0,
          totalRewards: 0,
          lastMine: null,
          lastReward: null,
        },
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
