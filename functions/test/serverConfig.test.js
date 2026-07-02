// Cambio 3 (Fase 4): servers a medida. Este módulo es el corazón de la
// garantía "el ratio premio/recaudación nunca se puede romper" -- se testea
// exhaustivamente porque hay plata real de por medio.

const { GEM_PRICES, GEM_UNLOCK_THRESHOLDS } = require('../constants');
const sc = require('../serverConfig');

describe('deriveServerConfig — identidad en el punto de referencia (N=100.000, P=$15)', () => {
  const cfg = sc.deriveServerConfig(100000, 15);

  test('reproduce exactamente el cubo actual: L=100, pool=$650.000', () => {
    expect(cfg.layerCount).toBe(100);
    expect(cfg.totalPrizePoolUSD).toBe(650000);
  });

  test('cantidades por tier idénticas a las de hoy', () => {
    expect(cfg.quantityPerTier).toEqual([1, 1, 5, 50, 100, 500, 1000, 4000, 10000]);
  });

  test('umbrales de desbloqueo idénticos a GEM_UNLOCK_THRESHOLDS', () => {
    const unlockAt = sc.deriveUnlockThresholds(100000);
    for (let tier = 1; tier <= 9; tier++) {
      expect(unlockAt[tier]).toBe(GEM_UNLOCK_THRESHOLDS[tier - 1]);
    }
  });

  test('ratio exacto 43,33%', () => {
    expect(cfg.totalPrizePoolUSD / (100000 * 15)).toBeCloseTo(sc.RATIO, 6);
  });
});

describe('validateServerConfig — rangos', () => {
  test('rechaza jugadores fuera de rango', () => {
    expect(sc.validateServerConfig(99, 15).length).toBeGreaterThan(0);
    expect(sc.validateServerConfig(100001, 15).length).toBeGreaterThan(0);
    expect(sc.validateServerConfig(100, 15)).toHaveLength(0);
    expect(sc.validateServerConfig(100000, 15)).toHaveLength(0);
  });

  test('rechaza precio fuera de rango', () => {
    expect(sc.validateServerConfig(1000, 0.09).length).toBeGreaterThan(0);
    expect(sc.validateServerConfig(1000, 100.01).length).toBeGreaterThan(0);
    expect(sc.validateServerConfig(1000, 0.10)).toHaveLength(0);
    expect(sc.validateServerConfig(1000, 100)).toHaveLength(0);
  });

  test('rechaza combinaciones que superan el cap de recaudación', () => {
    // 100.000 × $100 = $10.000.000, muy por encima del cap ($1.500.000)
    expect(sc.validateServerConfig(100000, 100).length).toBeGreaterThan(0);
  });

  test('NaN/valores inválidos son rechazados, no crashean', () => {
    expect(sc.validateServerConfig(NaN, 15).length).toBeGreaterThan(0);
    expect(sc.validateServerConfig(1000, NaN).length).toBeGreaterThan(0);
    expect(sc.validateServerConfig(undefined, undefined).length).toBeGreaterThan(0);
  });
});

describe('El ratio nunca se rompe (grid search exhaustivo)', () => {
  test('toda config aceptada por validateDerivedConfig mantiene el ratio dentro de 5% relativo', () => {
    let checked = 0;
    for (let N = sc.N_MIN; N <= sc.N_MAX; N += 337) {
      for (let P = sc.P_MIN; P <= sc.P_MAX; P *= 1.9) {
        if (sc.validateServerConfig(N, P).length) continue;
        const cfg = sc.deriveServerConfig(N, P);
        if (sc.validateDerivedConfig(cfg).length) continue; // rechazada, no cuenta
        checked++;
        const revenue = N * P;
        const ratio = cfg.totalPrizePoolUSD / revenue;
        const relDev = Math.abs(ratio - sc.RATIO) / sc.RATIO;
        expect(relDev).toBeLessThanOrEqual(0.05);
      }
    }
    expect(checked).toBeGreaterThan(100); // asegura que el grid search corrió de verdad
  });

  test('ninguna config aceptada tiene K-boundaries colapsados o zoneSize insuficiente', () => {
    for (let N = sc.N_MIN; N <= sc.N_MAX; N += 521) {
      for (let P = sc.P_MIN; P <= sc.P_MAX; P *= 2.3) {
        if (sc.validateServerConfig(N, P).length) continue;
        const cfg = sc.deriveServerConfig(N, P);
        const errors = sc.validateDerivedConfig(cfg);
        if (errors.length) continue;
        // Si pasó la validación, verificar directamente las invariantes.
        const kb = sc.computeKBoundaries(cfg.layerCount);
        expect(kb.t1).toBeLessThan(kb.t2);
        expect(kb.t2).toBeLessThan(kb.t3);
        for (const t of cfg.tierTable) {
          if (t.count > 0) expect(t.zoneSize).toBeGreaterThanOrEqual(t.count);
        }
      }
    }
  });

  test('layerCount siempre dentro de [30, 150] para cualquier N válido', () => {
    for (let N = sc.N_MIN; N <= sc.N_MAX; N += 199) {
      const L = sc.deriveLayerCount(N);
      expect(L).toBeGreaterThanOrEqual(sc.L_MIN);
      expect(L).toBeLessThanOrEqual(sc.L_MAX);
    }
  });

  test('servers muy chicos (pool cercano a la granularidad de $15) se rechazan, no se crean rotos', () => {
    // N=100, P=0.50 -> revenue=$50, pool ideal=$21.67, la granularidad de $15
    // produce una desviación de ~32% -- debe rechazarse.
    const cfg = sc.deriveServerConfig(100, 0.50);
    const errors = sc.validateDerivedConfig(cfg);
    expect(errors.some((e) => e.startsWith('ratio_deviation_too_large'))).toBe(true);
  });
});

describe('D7/D8 — distribución manual de premios por tier', () => {
  const base = sc.deriveServerConfig(100000, 15); // pool = $650.000

  test('aceptar la misma distribución que el auto-escalado', () => {
    const r = sc.applyManualDistribution(base, base.quantityPerTier);
    expect(r.ok).toBe(true);
    expect(r.config.totalPrizePoolUSD).toBe(base.totalPrizePoolUSD);
  });

  test('D8: tier con precio > pool disponible se rechaza si tiene cantidad > 0', () => {
    const smallPool = sc.deriveServerConfig(1000, 15); // pool bien menor a $100.000
    const badQty = [1, 0, 0, 0, 0, 0, 0, 0, Math.round(smallPool.totalPrizePoolUSD / 15) - 6666];
    const r = sc.applyManualDistribution(smallPool, badQty);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('tier_1_exceeds_pool'))).toBe(true);
  });

  test('D8: tier con precio EXACTAMENTE igual al pool se permite (1 solo premio, 100% del pool)', () => {
    const exactPool = { totalPrizePoolUSD: 50000, tierTable: base.tierTable, maxMembers: 100000, creditPriceUSD: 15 };
    const r = sc.applyManualDistribution(exactPool, [0, 1, 0, 0, 0, 0, 0, 0, 0]); // tier2 = $50.000
    expect(r.ok).toBe(true);
  });

  test('rechaza si la suma no cierra exacto con el pool', () => {
    const r = sc.applyManualDistribution(base, [0, 0, 0, 0, 0, 0, 0, 0, 1000]); // $15.000, no $650.000
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('distribution_sum_mismatch'))).toBe(true);
  });

  test('rechaza arrays que no tienen exactamente 9 posiciones', () => {
    const r = sc.applyManualDistribution(base, [1, 2, 3]);
    expect(r.ok).toBe(false);
  });

  test('cantidades negativas o no numéricas se tratan como 0, no crashean', () => {
    const r = sc.applyManualDistribution(base, [-5, 'x', null, undefined, NaN, 0, 0, 0, 0]);
    expect(r.ok).toBe(false); // suma no va a cerrar en 650000, pero no debe tirar excepción
  });
});

describe('Consistencia con el motor genérico de Fase 0 (helpers.js)', () => {
  const { getGemForCubeGeneric, getRewardForCube, getLayerUnlockThresholdGeneric } = require('../helpers');

  test('un config derivado funciona end-to-end con el motor genérico sin crashear', () => {
    const cfg = sc.deriveServerConfig(25000, 30);
    for (let K = 0; K <= cfg.layerCount; K += 5) {
      const g = getGemForCubeGeneric('srv-test', K, 1, cfg.maxMembers, 'seed', 1, cfg.tierTable);
      if (g !== null) { expect(g).toBeGreaterThanOrEqual(1); expect(g).toBeLessThanOrEqual(9); }
      const r = getRewardForCube('srv-test', K, 1, 'seed', 1, cfg);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(5);
      const threshold = getLayerUnlockThresholdGeneric(K, cfg.tierTable);
      expect(threshold).toBeGreaterThanOrEqual(0);
    }
  });
});
