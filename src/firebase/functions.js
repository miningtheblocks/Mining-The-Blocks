// Polyfills required by Firebase Web SDK on React Native
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
// src/firebase/functions.js
import { app } from './client';
import { getFunctions, httpsCallableFromURL, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';

// Use default region where functions were deployed (us-central1)
const functions = getFunctions(app, 'us-central1');

// Optional: enable emulator in development if you run `firebase emulators:start`
// try {
//   if (__DEV__) connectFunctionsEmulator(functions, 'localhost', 5001);
// } catch {}

export async function callInitLayerRewards(layer) {
  // Direct callable URL (v2) to avoid any auto-discovery issues
  const url = 'https://initlayerrewards-vavj7ufcja-uc.a.run.app';
  const fn = httpsCallableFromURL(functions, url);
  const res = await fn({ layer });
  return res.data;
}

export async function callCreateServer(name) {
  const fn = httpsCallable(functions, 'createServer');
  const res = await fn({ name });
  return res.data;
}

export async function callGetServers() {
  const fn = httpsCallable(functions, 'getServers');
  const res = await fn({});
  return res.data;
}

export async function callMineCube(cubeNumber, serverId) {
  const fn = httpsCallable(functions, 'mineCube');
  const res = await fn({ cubeNumber, serverId });
  return res.data;
}

// Peaks: server-authoritative status (prevents client manipulation)
// Expected response shape from backend:
// {
//   picks: number,
//   serverNow: number, // millis
//   nextDailyAt: number, // millis when daily becomes available
//   ad1NextAt: number, // millis when ad1 becomes available
//   ad2NextAt: number  // millis when ad2 becomes available
// }
export async function callGetPeaksStatus() {
  const fn = httpsCallable(functions, 'getPeaksStatus');
  const res = await fn({});
  return res.data;
}

// Claims a daily pick if eligible on server
export async function callClaimDailyPick() {
  const fn = httpsCallable(functions, 'claimDailyPick');
  const res = await fn({});
  return res.data; // expect updated status like callGetPeaksStatus
}

// Claims an ad-based pick if eligible; index: 1 or 2
export async function callClaimAdPick(index) {
  const fn = httpsCallable(functions, 'claimAdPick');
  const res = await fn({ index });
  return res.data; // expect updated status
}

// Creates a web ad session (timer page); returns { sessionId, token }
export async function callCreateAdSession(index) {
  const fn = httpsCallable(functions, 'createAdSession');
  const res = await fn({ index });
  return res.data;
}

// Sends a test push notification to the current user's stored Expo push token
export async function callSendTestPush() {
  const fn = httpsCallable(functions, 'sendTestPush');
  const res = await fn({});
  return res.data;
}

// Verifica créditos y acceso del usuario a un server
export async function callCheckServerAccess(serverId) {
  const fn = httpsCallable(functions, 'checkServerAccess');
  const res = await fn({ serverId });
  return res.data; // { hasAccess: bool, serverCredits: number }
}

// Une al usuario a un server consumiendo 1 crédito
export async function callJoinServer(serverId) {
  const fn = httpsCallable(functions, 'joinServer');
  const res = await fn({ serverId });
  return res.data;
}

// Returns chain data for a given chainId
export async function callGetChain(chainId) {
  const fn = httpsCallable(functions, 'getChain');
  const res = await fn({ chainId });
  return res.data;
}

// Returns all gems discovered by the current user
export async function callGetUserGems() {
  const fn = httpsCallable(functions, 'getUserGems');
  const res = await fn({});
  return res.data;
}

export async function callApplyReferral(code) {
  const fn = httpsCallable(functions, 'applyReferral');
  const res = await fn({ code });
  return res.data;
}

export async function callCheckReferralCode(code) {
  const fn = httpsCallable(functions, 'checkReferralCode');
  const res = await fn({ code });
  return res.data; // { valid: boolean }
}

// Claims a gem as NFT to the user's wallet (creates pendingMints record)
// Cash redemption is done on the external website using the gem code
export async function callClaimGemNFT(gemId, walletAddress) {
  const fn = httpsCallable(functions, 'claimGemNFT');
  const res = await fn({ gemId, walletAddress });
  return res.data;
}

// Creates a pending crypto payment (USDC/Polygon) with a unique amount
// Returns { paymentId, amount, expiresAt }
export async function callCreateCryptoPayment() {
  const fn = httpsCallable(functions, 'createCryptoPayment');
  const res = await fn({});
  return res.data;
}

// Sends a custom branded verification email via Gmail
export async function callSendVerificationEmail() {
  const fn = httpsCallable(functions, 'sendVerificationEmail');
  const res = await fn({});
  return res.data;
}

// Sends a problem report to the admin email
export async function callReportProblem({ userType, reportType, description, email }) {
  const fn = httpsCallable(functions, 'reportProblem');
  const res = await fn({ userType, reportType, description, email });
  return res.data;
}
