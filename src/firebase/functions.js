// Polyfills required by Firebase Web SDK on React Native
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
// src/firebase/functions.js
import { app } from './client';
import { getFunctions, httpsCallable } from 'firebase/functions';

// Use default region where functions were deployed (us-central1)
const functions = getFunctions(app, 'us-central1');

// Optional: enable emulator in development if you run `firebase emulators:start`
// try {
//   if (__DEV__) connectFunctionsEmulator(functions, 'localhost', 5001);
// } catch {}

export async function callCreateServer(name) {
  const fn = httpsCallable(functions, 'createServer');
  const res = await fn({ name });
  return res.data;
}

// Cambio 3 (Fase 4, servers a medida) — SE ENTREGA COMPLETO PERO INACTIVO:
// ambas Cloud Functions responden failed-precondition/feature_disabled hasta
// que config/app.paramServerCreationEnabled se active manualmente. No se usan
// desde ninguna pantalla habilitada por default -- ver CreateCustomServer.js.
export async function callPreviewServerConfig(maxMembers, creditPriceUSD, tierQuantities) {
  const fn = httpsCallable(functions, 'previewServerConfig');
  const res = await fn({ maxMembers, creditPriceUSD, tierQuantities });
  return res.data;
}

export async function callCreateServerCustom(name, maxMembers, creditPriceUSD, tierQuantities) {
  const fn = httpsCallable(functions, 'createServerCustom');
  const res = await fn({ name, maxMembers, creditPriceUSD, tierQuantities });
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
// Cambio 1 (picos por cadena): picos/ads viven por chainId, no más globales
// por usuario — chainId es REQUERIDO (el backend rechaza si falta).
// Expected response shape from backend:
// {
//   picks: number,
//   serverNow: number, // millis
//   nextDailyAt: number, // millis when daily becomes available
//   adNextAt: { [slotIndex: number]: number }, // millis when each ad slot becomes available
//   dailyAdSlots: number, // cantidad de slots de ads de esta cadena (2 estándar, hasta 5 en el server Free)
// }
export async function callGetPeaksStatus(chainId) {
  const fn = httpsCallable(functions, 'getPeaksStatus');
  const res = await fn({ chainId });
  return res.data;
}

// Claims a daily pick if eligible on server
export async function callClaimDailyPick(chainId) {
  const fn = httpsCallable(functions, 'claimDailyPick');
  const res = await fn({ chainId });
  return res.data; // expect updated status like callGetPeaksStatus
}

// Creates a web ad session (timer page); returns { sessionId, token }
export async function callCreateAdSession(index, chainId) {
  const fn = httpsCallable(functions, 'createAdSession');
  const res = await fn({ index, chainId });
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

// SEC-N-005: setear walletAddress server-side (rules bloquean escritura directa)
export async function callSetUserWallet(walletAddress) {
  const fn = httpsCallable(functions, 'setUserWallet');
  const res = await fn({ walletAddress });
  return res.data;
}

export async function callCheckUsername(username) {
  const fn = httpsCallable(functions, 'checkUsername');
  const res = await fn({ username });
  return res.data; // { available: bool, reason?: string }
}

export async function callCheckReferralCode(code) {
  const fn = httpsCallable(functions, 'checkReferralCode');
  const res = await fn({ code });
  return res.data; // { valid: boolean }
}

// Claims a gem as NFT to the user's wallet (creates pendingMints record)
// Cash redemption is done on the external website using the gem code
// Round 2 Commit B: walletAddress se ignora en backend (Agentes #1 + #6 + #8) —
// la única vía de setear wallet es callSetUserWallet (que tiene cooldown 24h).
export async function callClaimGemNFT(gemId) {
  const fn = httpsCallable(functions, 'claimGemNFT');
  const res = await fn({ gemId });
  return res.data;
}

// Round 2 Commit B (Agente #6 CRIT): reset de password con revoke de tokens
// + email branded con notice de "sesiones cerradas". Reemplaza el
// sendPasswordResetEmail directo del Firebase Web SDK que no revocaba tokens
// existentes (ventana 60min de account takeover post-reset).
export async function callRequestPasswordReset(email) {
  const fn = httpsCallable(functions, 'requestPasswordReset');
  const res = await fn({ email });
  return res.data;
}

// Round 2 Commit F (Agente #6 + #10 + #11): self-serve account ops.
// deleteMyAccount: GDPR/Play Store right to erasure. Anonimiza el user doc
// y borra el Auth user. Gemas + history preservados anonimizados por 5y
// (AML/KYC). Username liberado.
export async function callDeleteMyAccount() {
  const fn = httpsCallable(functions, 'deleteMyAccount');
  const res = await fn({});
  return res.data;
}

// revokeMySessions: "logout everywhere" — usuario sospecha takeover y cierra
// todas las sesiones desde otros devices. Equivalente a un admin llamando
// revokeRefreshTokens manualmente.
export async function callRevokeMySessions() {
  const fn = httpsCallable(functions, 'revokeMySessions');
  const res = await fn({});
  return res.data;
}

// Creates a pending crypto payment (USDC/Polygon).
// Audit feedback 2026-06-23+:
//   - `senderWalletAddress` (opcional): si el caller la declara, el backend
//     devuelve $15.00 redondo y matchea por `from` address en el processor.
//     Sin esto, fallback a cents random ($15.XX) por amount.
//   - `saveWallet` (opcional, default false): opt-in para que el processor
//     guarde la `from` wallet como walletAddress del user al confirmar el
//     pago. Si false (o no se pasa), la wallet NO se guarda — útil para
//     pagos desde wallets temporales / compartidas.
// Returns { paymentId, amount, wallet, expiresAt }
export async function callCreateCryptoPayment(senderWalletAddress, opts) {
  const fn = httpsCallable(functions, 'createCryptoPayment');
  const payload = {};
  if (senderWalletAddress) payload.senderWalletAddress = senderWalletAddress;
  if (opts && opts.saveWallet) payload.saveWallet = true;
  const res = await fn(payload);
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

// P1-8: reporta un error no-fatal del cliente para que quede registrado server-side.
// El backend rate-limita por uid para evitar spam.
export async function callLogClientError({ scope, msg, ctx }) {
  const fn = httpsCallable(functions, 'logClientError');
  const res = await fn({ scope, msg, ctx });
  return res.data;
}
