# Agente #5 — Rendering 3D (DynamicCube201 + Three.js)

## Resumen ejecutivo

| Severidad | Cantidad |
|-----------|----------|
| CRIT | 5 |
| HIGH | 12 |
| MEDIUM | 17 |
| LOW | 12 |
| INFO | 5 |
| **TOTAL** | **51** |

## Top 5 críticos

1. **[CRIT] Schema mismatch `ts` vs `minedAt` — feed multijugador ROTO** — `DynamicCube201.js:1756-1761` ↔ `functions/index.js:761`. Backend escribe `ts`, cliente subscribe con `orderBy('minedAt')` → snapshot vacío. Multijugador solo aparenta funcionar por optimistic local update. **CONFIRMA hallazgo del Agente #2**.

2. **[CRIT] Render loop sigue sobre GL context muerto al navegar** — `DynamicCube201.js:3635-3709, 3923-3940`. Al perder foco por navegación, `<GLView>` se desmonta pero `rendererRef.current` queda apuntando al context destruido. RAF sigue corriendo → render sobre context muerto → crash potencial Adreno/Mali al volver.

3. **[CRIT] `_numMeshPool` global corrompido entre remounts** — `DynamicCube201.js:167-193`. Pool a nivel módulo sobrevive al unmount, pero materials de sus meshes son disposed por `scene.traverse` en cleanup. Próximo mount reutiliza materials muertos → texturas blancas o crash GL.

4. **[CRIT] `getFaceRange()` en JSX itera 240k entries por re-render** — `DynamicCube201.js:3897-3919, 3974`. Durante pan activo: 15-60 re-renders/seg × 240k iter = ~14M iter/seg. Stutter visible en Android low-end. Datos ya cacheados en `faceRangesRef` pero JSX duplica el cálculo.

5. **[CRIT] `addDarkPatch` aloca PlaneGeometry + Material por cada celda minada** — `DynamicCube201.js:1251-1348`. En capa K=100 minada (~50k cells) consume cientos de MB de VRAM. OOM garantizado en GPUs Adreno 5xx/Mali-G52.

## High severity (12)
- Vector3/Euler alloc en panResponder (~120-240 alloc/seg durante pan)
- BoxGeometry duplicada 6 veces para caras del cubo
- 36 BoxGeometry + EdgesGeometry por mineo en createFragments
- cleanupCracksNow no se llama en watchdog timeout
- useEffect auth con deps=[] lee miningAnimations (state muerto, never updated)
- panResponder con deps=[] lee longPressActive stale (protegido por ref backup)
- syncRendererSize race en primer mount
- Patch global console.log a nivel módulo (código muerto en prod)
- Patch global Image.getSize sin restaurar
- Optimistic update sin revert en branch `else` de respuesta backend
- (más en el reporte detallado)

## Memory leaks (10)
- `_numMeshPool` global (CRIT-3)
- `addDarkPatch` (CRIT-5)
- `createFragments` burst con race en unmount
- `_intersectablesCache` con refs a meshes disposed
- `MinedCubesRewardStore.rewards` Map crece sin cota (~10MB capa minada)
- `hudToastTimerRef/gridExitTimerRef/preHoldTimerRef` setTimeouts huérfanos
- `miningWatchdogRef/miningProgressTimerRef` no cleared en cancelMining
- `cracksRef.current` si watchdog cierra modal antes que startMining
- `audioManager.cleanup()` nunca invocado desde DynamicCube201
- LRU `textureCache` evict puede liberar textura aún referenciada

## Frame perf issues (8)
- getFaceRange en JSX (CRIT-4)
- Vector3/Euler alloc en pan handlers
- addDarkPatch burst en realtime snapshot batch
- createFragments 36×4 GPU resources por mineo
- onSnapshot sin filtrar metadata changes (doble disparo cache+server)
- setCamState durante gesto cascada re-renders
- miningProgressTimerRef setInterval 120ms
- Pool acquire/release con remove(mesh) cientos/frame en zoom

## Patrones positivos (13)
- Scratch vectors módulo-level (`_sv1`-`_sv12`)
- `sharedNumberPlaneGeo` protegida con `userData.shared`
- `_moduleRaycaster` singleton
- Throttling adaptativo render loop (60→30→15 FPS)
- `renderPausedRef` en AppState background
- Cleanup recursivo dispose con guard userData.shared
- Optimistic update + revert (branch principal)
- Watchdog timeout para modal congelado
- Recomputed faceRanges en ref (aunque NO usado en JSX)
- Comentarios CRIT-XX/PERF-XX/MEDIO-XX documentan auditorías previas
- Bitmap font 5x7 inline (sin fuente pesada)
- InstancedMesh con `needsUpdate=true` correcto
- Texturas pixel-art con NearestFilter coherente

## Conclusión

Renderer pasado por múltiples rondas. **Frame loop interno está limpio**: scratch vectors, viewport culling, throttling adaptativo, dispose recursivo. Pero quedan **3 áreas con problemas serios**:

1. **Schema sync roto** (CRIT-1) — feed multijugador no funciona, solo se sostiene por optimistic local.
2. **Lifecycle del WebGL context no contempla navegación** (CRIT-2) — manifesta como "la app se cuelga al volver".
3. **Recursos GPU por celda minada crecen linealmente** (CRIT-5) — OOM en endgame para low-end devices.

CRIT-1 y CRIT-4 son fixes de pocas líneas. CRIT-2 requiere refactor ~50 LOC. CRIT-3 y CRIT-5 son más invasivos pero localizados.

Código muerto significativo: `CubeCalculations.js`, `ThreeSetup.js`, `MassiveCube.js`, `Layer100Renderer.js`, `miningAnimations` state, `minedPollRef`, `setMiningAnimations` — confirma hallazgo del Agente #4.
