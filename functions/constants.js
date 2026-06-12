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

const GEM_TOKEN_URIS = [
  'ipfs://bafkreiazqr5ll6frb27jxl6n6pp7c7jrfy2stcezwl7r3hr4iyyqxctl5m',
  'ipfs://bafkreiggojefjwtthfjpxg454euhzf3zajjadlw3q6nv3tttorvu3frndq',
  'ipfs://bafkreif4ysa3pwnrpuqqmtk4647a26vfwyfp3tbpe5ypcivjytptr3b7he',
  'ipfs://bafkreicc4vvma5xb3u65poxnncqj63z3jke5q3zo53s2vfc3vzjcxpefaa',
  'ipfs://bafkreiggrq4ipierqj2eyfzg7qm4gfuyl5ve6hhpknqvjnqzy7vg6ijpdm',
  'ipfs://bafkreigxc6uqc7co6qcu4mzaq2tnkqwcsngfet63eczmmgwfzbyhmmpogq',
  'ipfs://bafkreidex4rj7rofevpe45u2sdvvnq5hkovxulqjtpjjj2xjakxvuzpbi4',
  'ipfs://bafkreiaujynahu64ui75bihvggjh5thoesn7ewgjqgqgafjf24osdb4lci',
  'ipfs://bafkreiabkbvz5g3b3alkh3omymgg2urw47bgtal3sd7kudxtebohk2pzta',
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
