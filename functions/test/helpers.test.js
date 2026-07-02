// P1-9: Tests unitarios para helpers críticos.
// Aseguran que la lógica de recompensas y códigos no se rompa silenciosamente
// en futuros refactors. Cubre `getRewardForCube`, `getGemForCube`,
// `generateGemCode`, `generateReferralCode`, `shellTotalCubes`,
// `cubeNumberToFaceGridForK`, `fnv1a`.

const {
  shellTotalCubes,
  cumSum,
  zoneSizeFor,
  cubeNumberToFaceGridForK,
  fnv1a,
  getRewardForCube,
  getGemForCube,
  getGemForCubeGeneric,
  getLayerUnlockThreshold,
  getLayerUnlockThresholdGeneric,
  isLayerUnlocked,
  generateReferralCode,
  generateGemCode,
  esc,
  buildChainStatus,
  DEFAULT_CONFIG,
  DEFAULT_TIER_TABLE,
  DEFAULT_REWARD_BRACKETS,
} = require('../helpers');

describe('shellTotalCubes', () => {
  test('K=0 → 6 cubos (caras 1x1)', () => {
    expect(shellTotalCubes(0)).toBe(6);
  });
  test('K=100 → 242406 (4 capas × 60601)', () => {
    expect(shellTotalCubes(100)).toBe(242406);
  });
  test('K=1 → 54', () => {
    expect(shellTotalCubes(1)).toBe(54);
  });
});

describe('fnv1a', () => {
  test('determinista', () => {
    expect(fnv1a('foo')).toBe(fnv1a('foo'));
  });
  test('distinto para distintos inputs', () => {
    expect(fnv1a('foo')).not.toBe(fnv1a('bar'));
  });
  test('devuelve uint32', () => {
    const h = fnv1a('test');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });
});

describe('cubeNumberToFaceGridForK', () => {
  test('K=100 cubo 1 → cara 0, gridX 0, gridY 0', () => {
    expect(cubeNumberToFaceGridForK(1, 100)).toEqual({ faceIndex: 0, gridX: 0, gridY: 0 });
  });
  test('out of range devuelve null', () => {
    expect(cubeNumberToFaceGridForK(0, 100)).toBeNull();
    expect(cubeNumberToFaceGridForK(242407, 100)).toBeNull();
    expect(cubeNumberToFaceGridForK('not a number', 100)).toBeNull();
  });
  test('último cubo de K=100 está en la cara 5', () => {
    const r = cubeNumberToFaceGridForK(242406, 100);
    expect(r).not.toBeNull();
    expect(r.faceIndex).toBe(5);
  });
});

describe('getRewardForCube', () => {
  test('rango válido: 0-5', () => {
    for (let i = 1; i <= 100; i++) {
      const r = getRewardForCube('server-x', 50, i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(5);
    }
  });
  test('determinista (mismo input → mismo output)', () => {
    const a = getRewardForCube('s1', 50, 100);
    const b = getRewardForCube('s1', 50, 100);
    expect(a).toBe(b);
  });
  test('K más bajo tiene mayor winRate', () => {
    let winsHi = 0; let winsLo = 0;
    for (let i = 1; i <= 1000; i++) {
      if (getRewardForCube('s', 100, i) > 0) winsHi++;
      if (getRewardForCube('s', 10, i) > 0) winsLo++;
    }
    // K=100 (winRate=0.5) gana más que K=10 (winRate=0.15)
    expect(winsHi).toBeGreaterThan(winsLo);
  });
});

describe('getGemForCube', () => {
  test('K >= 98 nunca da gema', () => {
    for (let i = 1; i <= 100; i++) {
      expect(getGemForCube('s', 98, i, 1000)).toBeNull();
      expect(getGemForCube('s', 100, i, 1000)).toBeNull();
    }
  });
  test('memberCount=0 nunca da gema (tier unlock check)', () => {
    let any = null;
    for (let K = 0; K < 90; K++) {
      for (let i = 1; i <= 10; i++) {
        const g = getGemForCube('s', K, i, 0);
        if (g) { any = g; break; }
      }
      if (any) break;
    }
    expect(any).toBeNull();
  });
  test('rango: 1..9 si retorna gema', () => {
    for (let i = 1; i < 1000; i++) {
      const g = getGemForCube('s', 50, i, 10000);
      if (g !== null) {
        expect(g).toBeGreaterThanOrEqual(1);
        expect(g).toBeLessThanOrEqual(9);
      }
    }
  });
});

describe('generateReferralCode', () => {
  test('longitud 8', () => {
    expect(generateReferralCode()).toHaveLength(8);
  });
  test('solo caracteres permitidos', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateReferralCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    }
  });
  test('no es derivado de uid (varía entre llamadas)', () => {
    const codes = new Set();
    for (let i = 0; i < 100; i++) codes.add(generateReferralCode());
    expect(codes.size).toBeGreaterThan(95); // randomness alta
  });
});

describe('generateGemCode', () => {
  test('formato MTB[1-9]-XXXXXXXX-RRRRRR', () => {
    const c = generateGemCode('s1', 50, 100, 3, 'uid123');
    expect(c).toMatch(/^MTB[1-9]-[0-9A-F]{8}-[A-Z0-9]{6}$/);
  });
  test('tier en el prefijo coincide', () => {
    expect(generateGemCode('s1', 50, 100, 7, 'uid')).toMatch(/^MTB7-/);
  });
  test('códigos son únicos con mismos inputs (randomBytes, no derivable)', () => {
    // FIX-P1: generateGemCode usa crypto.randomBytes — códigos no predecibles
    // aun conociendo todos los inputs. El tier sí se mantiene en el prefijo.
    const a = generateGemCode('s1', 50, 100, 3, 'uid');
    const b = generateGemCode('s1', 50, 100, 3, 'uid');
    expect(a).not.toBe(b);
    expect(a.slice(0, 5)).toBe('MTB3-');
    expect(b.slice(0, 5)).toBe('MTB3-');
  });
});

describe('getLayerUnlockThreshold', () => {
  test('K=0..6 → 54167 (tier 1 binding)', () => {
    expect(getLayerUnlockThreshold(0)).toBe(54167);
    expect(getLayerUnlockThreshold(6)).toBe(54167);
  });
  test('K=7..16 → 45834 (tier 2 binding)', () => {
    expect(getLayerUnlockThreshold(7)).toBe(45834);
    expect(getLayerUnlockThreshold(16)).toBe(45834);
  });
  test('K=17..26 → 41667 (tier 3 binding)', () => {
    expect(getLayerUnlockThreshold(17)).toBe(41667);
    expect(getLayerUnlockThreshold(26)).toBe(41667);
  });
  test('K=27..46 → 37500 (tier 4 binding)', () => {
    expect(getLayerUnlockThreshold(27)).toBe(37500);
    expect(getLayerUnlockThreshold(46)).toBe(37500);
  });
  test('K=47..81 → 29167 (tier 6 binding)', () => {
    expect(getLayerUnlockThreshold(47)).toBe(29167);
    expect(getLayerUnlockThreshold(81)).toBe(29167);
  });
  test('K=82..97 → 20834 (tier 8 binding)', () => {
    expect(getLayerUnlockThreshold(82)).toBe(20834);
    expect(getLayerUnlockThreshold(97)).toBe(20834);
  });
  test('K>=98 → 0 (warmup, sin lock)', () => {
    expect(getLayerUnlockThreshold(98)).toBe(0);
    expect(getLayerUnlockThreshold(99)).toBe(0);
    expect(getLayerUnlockThreshold(100)).toBe(0);
  });
  test('K inválido (NaN, negativo, string) → 0 fallback seguro', () => {
    expect(getLayerUnlockThreshold(NaN)).toBe(0);
    expect(getLayerUnlockThreshold(-5)).toBe(0);
    expect(getLayerUnlockThreshold(null)).toBe(0);
    expect(getLayerUnlockThreshold(undefined)).toBe(0);
  });
});

describe('isLayerUnlocked', () => {
  test('warmup K=100 con 0 miembros → unlocked', () => {
    expect(isLayerUnlocked(100, 0)).toBe(true);
    expect(isLayerUnlocked(98, 1)).toBe(true);
  });
  test('K=50 con 30000 miembros (>29167) → unlocked', () => {
    expect(isLayerUnlocked(50, 30000)).toBe(true);
  });
  test('K=50 con 28000 miembros (<29167) → locked', () => {
    expect(isLayerUnlocked(50, 28000)).toBe(false);
  });
  test('K=0 con 60000 (>54167) → unlocked', () => {
    expect(isLayerUnlocked(0, 60000)).toBe(true);
  });
  test('K=0 con 50000 (<54167) → locked', () => {
    expect(isLayerUnlocked(0, 50000)).toBe(false);
  });
  test('memberCount inválido (undefined/null) → tratado como 0', () => {
    expect(isLayerUnlocked(50, undefined)).toBe(false);
    expect(isLayerUnlocked(50, null)).toBe(false);
    expect(isLayerUnlocked(100, undefined)).toBe(true); // warmup OK
  });
});

// Fase 0 (servers a medida + server Free): getGemForCube/getRewardForCube/
// getLayerUnlockThreshold aceptan un `config` explícito. Sin config, deben
// comportarse IDÉNTICO a los tests de arriba (ya lo verifican). Estos tests
// cubren que el `config` custom realmente se respeta.
describe('config paramétrico (Fase 0)', () => {
  test('DEFAULT_CONFIG expone 9 tiers y 5 franjas de reward', () => {
    expect(DEFAULT_TIER_TABLE).toHaveLength(9);
    expect(DEFAULT_REWARD_BRACKETS).toHaveLength(5);
    expect(DEFAULT_CONFIG.tierTable).toBe(DEFAULT_TIER_TABLE);
    expect(DEFAULT_CONFIG.rewardBrackets).toBe(DEFAULT_REWARD_BRACKETS);
  });

  test('zoneSizeFor reproduce los zoneSize hardcodeados históricos', () => {
    expect(zoneSizeFor(0, 6)).toBe(2730);
    expect(zoneSizeFor(7, 16)).toBe(36540);
    expect(zoneSizeFor(17, 26)).toBe(118140);
    expect(zoneSizeFor(0, 46)).toBe(830490);
    expect(zoneSizeFor(0, 81)).toBe(4410780);
    expect(zoneSizeFor(0, 97)).toBe(7529340);
  });

  test('cumSum(n) = suma de shellTotalCubes(0..n-1)', () => {
    let sum = 0;
    for (let K = 0; K < 10; K++) sum += shellTotalCubes(K);
    expect(cumSum(10)).toBe(sum);
  });

  test('tierTable custom con 1 solo tier chico: solo ese tier puede salir', () => {
    const tinyTable = [
      { tier: 9, price: 15, count: 2, minK: 0, maxK: 5, unlockAt: 0, zoneSize: zoneSizeFor(0, 5) },
    ];
    let sawGem = false;
    const total = shellTotalCubes(0) + shellTotalCubes(1) + shellTotalCubes(2) +
      shellTotalCubes(3) + shellTotalCubes(4) + shellTotalCubes(5);
    for (let K = 0; K <= 5; K++) {
      for (let cn = 1; cn <= shellTotalCubes(K); cn++) {
        const g = getGemForCubeGeneric('s-tiny', K, cn, 999999, 'seed', 1, tinyTable);
        if (g !== null) {
          expect(g).toBe(9); // el único tier de la tabla
          sawGem = true;
        }
      }
      // fuera del rango de la tierTable (K>5 no existe acá) siempre null
    }
    expect(sawGem).toBe(true);
    // K=6 no está en ninguna zona de tinyTable -> siempre null
    for (let cn = 1; cn <= shellTotalCubes(6); cn++) {
      expect(getGemForCubeGeneric('s-tiny', 6, cn, 999999, 'seed', 1, tinyTable)).toBeNull();
    }
    void total;
  });

  test('tierTable custom con count=0 nunca reparte ese tier (redondeo a 0, Fase 4)', () => {
    const zeroTable = [
      { tier: 1, price: 100000, count: 0, minK: 0, maxK: 6, unlockAt: 0, zoneSize: zoneSizeFor(0, 6) },
    ];
    for (let cn = 1; cn <= shellTotalCubes(3); cn++) {
      expect(getGemForCubeGeneric('s-zero', 3, cn, 999999, 'seed', 1, zeroTable)).toBeNull();
    }
  });

  test('rewardBrackets custom cambian el winRate efectivo', () => {
    const alwaysWin = [{ minK: 0, rate: 1.0 }];
    const neverWin = [{ minK: 0, rate: 0.0 }];
    let wins = 0; let losses = 0;
    for (let i = 1; i <= 50; i++) {
      if (getRewardForCube('s', 5, i, 'seed', 1, { rewardBrackets: alwaysWin }) > 0) wins++;
      if (getRewardForCube('s', 5, i, 'seed', 1, { rewardBrackets: neverWin }) > 0) losses++;
    }
    expect(wins).toBe(50);
    expect(losses).toBe(0);
  });

  test('getLayerUnlockThresholdGeneric = max(unlockAt) entre tiers cuyo maxK alcanza K', () => {
    const table = [
      { tier: 1, maxK: 10, unlockAt: 500 },
      { tier: 2, maxK: 20, unlockAt: 200 },
    ];
    expect(getLayerUnlockThresholdGeneric(5, table)).toBe(500); // ambos tiers alcanzan K=5, max=500
    expect(getLayerUnlockThresholdGeneric(15, table)).toBe(200); // solo tier2 alcanza K=15
    expect(getLayerUnlockThresholdGeneric(25, table)).toBe(0); // ningún tier alcanza K=25
  });

  test('getGemForCube/getRewardForCube sin config = idéntico a DEFAULT_CONFIG explícito', () => {
    for (let K = 0; K <= 100; K += 7) {
      for (let cn = 1; cn <= 20; cn++) {
        const a = getGemForCube('s', K, cn, 60000, 'seed', 2);
        const b = getGemForCube('s', K, cn, 60000, 'seed', 2, DEFAULT_CONFIG);
        expect(a).toBe(b);
        const ra = getRewardForCube('s', K, cn, 'seed', 2);
        const rb = getRewardForCube('s', K, cn, 'seed', 2, DEFAULT_CONFIG);
        expect(ra).toBe(rb);
      }
      const ta = getLayerUnlockThreshold(K);
      const tb = getLayerUnlockThreshold(K, DEFAULT_CONFIG);
      expect(ta).toBe(tb);
    }
  });
});

// Cambio 1 (picos por cadena): buildChainStatus reemplaza a buildStatus, con
// slots de ads variables en vez de los 2 hardcodeados (ad1NextAt/ad2NextAt).
describe('buildChainStatus (Cambio 1 — picos por cadena)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test('doc nuevo (sin lastDailyAt): nextDailyAt ancla en createdAt', () => {
    const now = 1000000;
    const s = buildChainStatus({ picks: 3, createdAt: now - 1000 }, now, 2);
    expect(s.picks).toBe(3);
    expect(s.nextDailyAt).toBe(now - 1000 + DAY_MS);
  });

  test('con lastDailyAt: nextDailyAt ancla ahí, no en createdAt', () => {
    const now = 1000000;
    const s = buildChainStatus({ picks: 0, createdAt: now - 5000, lastDailyAt: now - 1000 }, now, 2);
    expect(s.nextDailyAt).toBe(now - 1000 + DAY_MS);
  });

  test('genera adNextAt para N slots (2 por default, hasta 5 para el server Free)', () => {
    const now = 1000000;
    const s2 = buildChainStatus({}, now, 2);
    expect(Object.keys(s2.adNextAt)).toHaveLength(2);
    expect(s2.dailyAdSlots).toBe(2);

    const s5 = buildChainStatus({}, now, 5);
    expect(Object.keys(s5.adNextAt)).toHaveLength(5);
    expect(s5.adNextAt[5]).toBe(DAY_MS); // sin ads.5 -> lastAt=0 -> next=DAY_MS
  });

  test('ad ya reclamado hoy: adNextAt[i] = lastClaim + DAY_MS', () => {
    const now = 2000000;
    const s = buildChainStatus({ ads: { 1: now - 1000 } }, now, 2);
    expect(s.adNextAt[1]).toBe(now - 1000 + DAY_MS);
    expect(s.adNextAt[2]).toBe(DAY_MS); // nunca reclamado
  });

  test('dailyAdSlots inválido/ausente cae a default 2', () => {
    const s = buildChainStatus({}, 1000, undefined);
    expect(s.dailyAdSlots).toBe(2);
  });

  test('dailyFreeClaim default true, explícito false para el server Free', () => {
    expect(buildChainStatus({}, 1000, 2).dailyFreeClaim).toBe(true);
    expect(buildChainStatus({}, 1000, 5, false).dailyFreeClaim).toBe(false);
  });
});

describe('esc (HTML escape)', () => {
  test('escapa < > & "', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('"quoted"')).toBe('&quot;quoted&quot;');
  });
  test('null/undefined → string vacío', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
  test('inyección XSS típica', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });
});
