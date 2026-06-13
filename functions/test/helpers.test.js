// P1-9: Tests unitarios para helpers críticos.
// Aseguran que la lógica de recompensas y códigos no se rompa silenciosamente
// en futuros refactors. Cubre `getRewardForCube`, `getGemForCube`,
// `generateGemCode`, `generateReferralCode`, `shellTotalCubes`,
// `cubeNumberToFaceGridForK`, `fnv1a`.

const {
  shellTotalCubes,
  cubeNumberToFaceGridForK,
  fnv1a,
  getRewardForCube,
  getGemForCube,
  generateReferralCode,
  generateGemCode,
  esc,
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
