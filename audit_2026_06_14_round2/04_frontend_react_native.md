# Agente #4 — Frontend React Native (sin DynamicCube201)

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 6 |
| ALTO | 10 |
| MEDIO | 11 |
| BAJO | 16 |
| INFO | 3 |
| **TOTAL** | **46** |

## Top 5 críticos

1. **[CRIT-FE-01] Push token registrado sin opt-in del usuario** — `App.js:190-235`. El `requestPermissionsAsync()` dispara automático al login sin contexto; los toggles de Config no controlan nada.

2. **[CRIT-FE-04] Wallet input pisado en cada snapshot** — `Profile.js:29-34`. Mientras el user tipea una wallet, un snapshot intermedio (de otra llamada) borra el input → data loss en flow crítico.

3. **[CRIT-FE-02] AppState listener en GetPeaks puede sobrevivir al unmount** — `GetPeaks.js:151-156`. Closure stale + listener re-creado en cada onClaimAd; warnings + leak permanente si el AppState 'change' nunca llega.

4. **[CRIT-FE-06] Override global de `console.log` persiste cross-screen** — `DynamicCube201.js:25-32`. Monkey-patches a nivel módulo; HMR genera cadena infinita de wrappers.

5. **[ALTO-FE-11] UpdateModal acepta downloadUrl con userinfo/credentials** — la validación no chequea `u.username`/`u.password`/`u.port`/`u.pathname`. Bypass de la última línea de defensa contra APK malicioso.

## Hallazgos secundarios importantes

- **[ALTO-FE-07]** Profile snapshot capturado con `auth.currentUser` stale → potencial cross-user data leakage
- **[ALTO-FE-08]** MyGems `loadGems` sin guard de unmount + closure stale
- **[ALTO-FE-09]** Registration username/referral debounce: race entre requests, último que responde gana (sin tracking de id)
- **[ALTO-FE-14]** BuyCredits restore desde cache pierde `amount` y `wallet` → user no sabe cuánto pagar
- **[ALTO-FE-15]** Email/password se mantienen en memoria post-login (no `setPassword('')`)
- **[ALTO-FE-12]** DeepLinkHandler no valida origen del intent (apps maliciosas pueden disparar `mtb://peaks`)
- **[ALTO-FE-13]** AudioManager doble-unload warning en activeSounds tras cap eviction
- **[ALTO-FE-16]** sliderSaveTimer pierde el save silenciosamente si user sign-out
- **[MEDIO-FE-17]** Dead code: ~1200 LOC + ~650KB de deps (MassiveCube, Layer100Renderer, FaceGrid201, ThreeSetup, CubeCalculations, ads.js)
- **[MEDIO-FE-18]** ImagePicker pide AMBOS permisos (gallery + camera) cuando solo se necesita uno
- **[MEDIO-FE-21]** No hay teardown de audio en signOut (~5MB residente + UX disonante)
- **[MEDIO-FE-22]** Logout sin closeAll de modales → modales con datos del user anterior visibles sobre Login
- **[MEDIO-FE-23]** logError NO redacta WALLETS COMO VALOR (solo por nombre de key)
- **[MEDIO-FE-26]** Auto-claim daily pick se dispara sin gesto del user al cruzar 0 → UX sorprendente
- **[BAJO-FE-35]** Magic strings duplicados — URL del dominio aparece hardcoded en 4+ archivos
- **[BAJO-FE-41]** No hay eslint-plugin-react-hooks → deps incompletos en useEffect no detectados

## Patrones positivos detectados (12)

- Anti-downgrade pattern bien implementado en ServerList + App.js (cachedMax)
- logError centralizado con scrub de PII por key + cap diario + dedupe
- ErrorBoundary que oculta stack en prod
- OverlayModalsProvider lazy-mount (solo cuando `visible[key]`)
- ServerContext con cleanup correcto del onSnapshot via unsubRef
- AudioManager cap de 8 sonidos simultáneos
- BuyCredits valida wallet response con regex ETH
- I18n persistido en AsyncStorage Y Firestore con re-hidratación
- ETH_ADDRESS_RE en Profile + BuyCredits
- Allowlist de hosts en UpdateModal (.com / .github.io)
- Cooldown anti-enumeration en applyReferral (10s)
- Reset de password no distingue user-not-found vs success

## Memory leaks (6)

- CRIT-FE-02: AppState listener re-creado en cada onClaimAd
- MEDIO-FE-21: audio sigue tras signOut
- MEDIO-FE-27: indicatorCache (texturas GPU) podría no limpiarse
- BAJO-FE-36: onSnapshot de ChainHistory queda activo mientras user navega lejos
- BAJO-FE-38: Animated.spring no se detiene en cleanup de GemPixelArt
- ALTO-FE-13: doble-unload de Sound tras cap eviction

## Async race conditions (8)

- ALTO-FE-07/08/09/14, MEDIO-FE-16/19/26, CRIT-FE-03

## Áreas sin cobertura de test
**TODO el frontend.** No hay jest, no hay @testing-library/react-native. Cubrir mínimamente: Login, Registration, Profile, BuyCredits, ServerList, UpdateModal (especialmente URL validation), AudioManager, compareVersions edge cases.

## Conclusión

Frontend maduro tras 6+ rondas de auditoría. Lo que queda es sutil: notificaciones sin opt-in, estado de inputs sobreescrito por snapshots, listeners residuales, dead code (~1200 LOC). Sin issues bloqueantes para producción, pero el conjunto medio/bajo es grande — un sprint de cleanup + tests reduce riesgo significativamente.

Deuda técnica más significativa: **0 tests automatizados** para una app que maneja dinero real.
