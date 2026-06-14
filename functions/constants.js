/* eslint-disable max-len */
/* eslint-disable quotes */
/* eslint-disable object-curly-spacing */

// Configuración global del juego y de pagos.
// Mantener este archivo libre de imports de Firebase para que sea reusable
// en tests/scripts.

const MAX_EPISODES = 10;
const STARTING_LAYER = 100;

const GEM_PRICES = [100000, 50000, 10000, 1000, 500, 100, 50, 25, 15];

const MAX_MEMBERS_PER_SERVER = 100000;

const GEM_UNLOCK_THRESHOLDS = [
  54167, 45834, 41667, 37500, 33334, 29167, 25000, 20834, 12500,
];

// CRIT-20: CIDs actualizados 2026-06-14 — JSON metadata corregidos con valores
// correctos ($100k/$50k/.../$15) + external_url a miningtheblocks.github.io.
// Los CIDs viejos (con $500/$0.25 y external_url a miningtheblocks.com) NUNCA
// fueron usados por mints reales (verificado vía Polygon eth_getLogs: 0 NFTs
// minteados antes del 2026-06-14).
const GEM_TOKEN_URIS = [
  'ipfs://bafkreiemxipdlvqezbtb4xtr57u5bttt6lf4nwtyjytjc3po5icyuuhopm',
  'ipfs://bafkreidci6pki2umr2tzg6ss6w55ys7uxipwpna24fg4v67pu6rj7ogdja',
  'ipfs://bafkreiap2xu6hcaed6zxtxv2yealxay3v5cde5xuk55rscbief3x3i63n4',
  'ipfs://bafkreige2d3j2flwmz2sq432iwji7i72yx42c7kbxiue75pkhjk54nwjsu',
  'ipfs://bafkreiblecr5ggrb33xw2qwe7p3dkvzctxmb7airb7s6nhlog2h6l3ieaa',
  'ipfs://bafkreidsd7rypvd6tz22eyqaanugjlydexbr26w3jn6eblwa4je7ymowem',
  'ipfs://bafkreietbkcigg37pxropkd4web4xtgbfzkz6mz3thgc4j7wnizi7is7gu',
  'ipfs://bafkreiesew44ay2l5gj6lic74ylmor6mnai532dxla6sfxy6bt6x6muclq',
  'ipfs://bafkreibx455uher6cdea6sm3fagj4qdu6u4rfu3w52leptffoorrmzdd5y',
];

const MTBGEMS_CONTRACT = process.env.MTBGEMS_CONTRACT || '0x54c2859411afCb51fcfE42054aDcA3484B3f29E6';

const DAY_MS = 24 * 60 * 60 * 1000;

const PAYMENT_WALLET = '0x61f7E9df2113Ac2E4a3D18f802AF2EE77cFAAD4f';
const USDC_CONTRACTS = [
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC bridged (PoS)
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC native
];
const USDC_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const CREDIT_PRICE_USD = 15;
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

const GEM_NAMES_ES = [
  "Diamante rojo", "Painita", "Musgravita", "Jadeíta imperial", "Alejandrita",
  "Rubí sangre de paloma", "Diamante azul", "Diamante rosa", "Esmeralda colombiana",
];
const NOTIFY_EMAIL = "miningtheblocks@gmail.com";

module.exports = {
  MAX_EPISODES,
  STARTING_LAYER,
  GEM_PRICES,
  MAX_MEMBERS_PER_SERVER,
  GEM_UNLOCK_THRESHOLDS,
  GEM_TOKEN_URIS,
  MTBGEMS_CONTRACT,
  DAY_MS,
  PAYMENT_WALLET,
  USDC_CONTRACTS,
  USDC_ABI,
  CREDIT_PRICE_USD,
  PAYMENT_WINDOW_MS,
  GEM_NAMES_ES,
  NOTIFY_EMAIL,
};
