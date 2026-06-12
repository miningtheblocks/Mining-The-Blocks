# 🔧 Instrucciones de Compilación - FIX Grid Mode Face Selection

## 🎯 Problema Resuelto
**BUG:** Al rotar el cubo a "right" y hacer zoom, siempre iba a "front"

**CAUSA RAÍZ:** React state (`activeFaceIndex`) se actualiza **asíncronamente**. Cuando detectas una cara y luego haces zoom inmediatamente:
1. ✅ Detección identifica "right" (índice 2)
2. ⏳ `setActiveFaceIndex(2)` se llama (asíncrono)
3. 🔍 Zoom entra a grid mode
4. ❌ Grid mode lee `activeFaceIndex` → todavía es 0 (valor anterior)

**SOLUCIÓN:** Usar `lastDetectedFaceIndexRef.current` (ref sincrónico) en lugar de `activeFaceIndex` (state asíncrono)

---

## 📋 Pasos para Compilar

### 1️⃣ Limpiar Caché de Metro
```powershell
# En PowerShell (desde la raíz del proyecto)
Remove-Item -Path "$env:LOCALAPPDATA\Temp\metro-*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$env:LOCALAPPDATA\Temp\react-*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$env:LOCALAPPDATA\Temp\haste-*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "node_modules\.cache" -Recurse -Force -ErrorAction SilentlyContinue
```

### 2️⃣ Limpiar Build de Gradle
```powershell
# Limpiar builds previos
Remove-Item -Path "final_complete_apk\.gradle" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "final_complete_apk\app\build" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "final_complete_apk\build" -Recurse -Force -ErrorAction SilentlyContinue
```

### 3️⃣ Compilar APK
```powershell
# Ejecutar el script de build
.\build_native_apk.ps1
```

### 4️⃣ Instalar APK en el Dispositivo
El APK estará en: `final_complete_apk\app\build\outputs\apk\release\`

---

## ✅ Verificar que el Fix Funciona

### Test Rápido:
1. Abre la app
2. Rota el cubo hacia **RIGHT** (cara derecha)
3. Espera a ver: `🎯 CARA ESTABILIZADA: right (índice: 2)`
4. Haz **ZOOM** inmediatamente

### Logs Esperados (CORRECTOS):
```
🔍 DEBUG: Cara detectada ANTES de entrar a grilla: 2 cara: right
🔍 DEBUG: activeFaceIndex (state asíncrono): 0 cara: front
🎯 Modo grilla usando cara: right (índice detectado: 2, state: 0)
```

**✅ ÉXITO:** 
- Dice "Cara detectada: 2 cara: right"
- Dice "Modo grilla usando cara: right"
- Los números aparecen en la cara RIGHT (no en FRONT)

**❌ ERROR:**
- Dice "Cara detectada: 0 cara: front" → el código no se compiló
- Dice "Modo grilla usando cara: front" → el fix no funcionó

---

## 🔍 Archivos Modificados

### `DynamicCube201.js`

**Cambio 1:** Línea ~2745 (al entrar a grid mode)
```javascript
// ANTES (usaba state asíncrono)
console.log('🔍 DEBUG: activeFaceIndex ANTES de entrar a grilla:', activeFaceIndex, 'cara:', FACES[activeFaceIndex]?.name);

// DESPUÉS (usa ref sincrónico)
const detectedIndex = lastDetectedFaceIndexRef.current;
console.log('🔍 DEBUG: Cara detectada ANTES de entrar a grilla:', detectedIndex, 'cara:', FACES[detectedIndex]?.name);
console.log('🔍 DEBUG: activeFaceIndex (state asíncrono):', activeFaceIndex, 'cara:', FACES[activeFaceIndex]?.name);
```

**Cambio 2:** Línea ~2808 (determinar qué cara mostrar)
```javascript
// ANTES (usaba state asíncrono)
const currentFace = FACES[activeFaceIndex] || FACES[0];

// DESPUÉS (usa ref sincrónico)
const detectedIndex = lastDetectedFaceIndexRef.current;
const currentFace = FACES[detectedIndex] || FACES[0];
```

---

## 🆘 Troubleshooting

### Problema: Los logs no cambian después de compilar
**Solución:** Metro está usando código en caché
```powershell
# Matar todos los procesos de Metro y Node
taskkill /F /IM node.exe
# Limpiar caché nuevamente
Remove-Item -Path "$env:LOCALAPPDATA\Temp\metro-*" -Recurse -Force
# Compilar de nuevo
.\build_native_apk.ps1
```

### Problema: Gradle falla con "daemon disappeared"
**Solución:** Ya tienes `gradle.properties` con memoria aumentada. Si persiste:
```powershell
# Detener todos los daemons de Gradle
cd final_complete_apk
.\gradlew.bat --stop
cd ..
# Intentar de nuevo
.\build_native_apk.ps1
```

### Problema: Todavía va a "front" después de compilar
**Verificar:** ¿Los logs nuevos aparecen?
- ✅ **SÍ:** El código se compiló, pero hay otro problema
- ❌ **NO:** El código no se compiló correctamente

---

## 📊 Logs Completos de Ejemplo

**Secuencia completa cuando funciona correctamente:**

```
# 1. Detección en modo cubo (rotando)
🎯 CARA ESTABILIZADA: right (índice: 2) - requestedFace: auto

# 2. Entrando a grid mode (zoom)
Cambiando a modo cámara - alineando perpendicular en zoom 230.89
🔍 DEBUG: Cara detectada ANTES de entrar a grilla: 2 cara: right
🔍 DEBUG: activeFaceIndex (state asíncrono): 0 cara: front
🎯 Entrando a modo grilla - detección automática activa

# 3. Renderizando la cara correcta
🎯 Modo grilla usando cara: right (índice detectado: 2, state: 0)
📊 NÚMEROS DEBUG - distancia: 230.89, shouldShow: true
📋 CARA ACTIVA (right): shouldShow=true, isActive=true
✅ NÚMEROS CREADOS: 40 en cara right
```

**Lo clave:** "Cara detectada: 2" y "Modo grilla usando cara: right"

---

Ver `TESTING_GUIDE.md` para pruebas más detalladas.
