# Build desde final_complete_apk con las mejoras
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "COMPILANDO APK CON 6 MEJORAS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Verificar que final_complete_apk existe
if (-not (Test-Path ".\final_complete_apk")) {
    Write-Host "ERROR: final_complete_apk no existe" -ForegroundColor Red
    Write-Host "Creando desde cero..." -ForegroundColor Yellow
    npx create-expo-app@latest final_complete_apk --template blank
}

Write-Host "Paso 1: Copiando archivos con mejoras..." -ForegroundColor Yellow

# Copiar src completo
Copy-Item -Path ".\src" -Destination ".\final_complete_apk\src" -Recurse -Force
Write-Host "  OK - src copiado" -ForegroundColor Green

# Copiar assets
Copy-Item -Path ".\assets" -Destination ".\final_complete_apk\assets" -Recurse -Force
Write-Host "  OK - assets copiado" -ForegroundColor Green

# Copiar archivos raiz importantes
Copy-Item -Path ".\App.js" -Destination ".\final_complete_apk\App.js" -Force
Copy-Item -Path ".\index.js" -Destination ".\final_complete_apk\index.js" -Force
Copy-Item -Path ".\package.json" -Destination ".\final_complete_apk\package.json" -Force
Write-Host "  OK - archivos raiz copiados" -ForegroundColor Green

Write-Host ""
Write-Host "Paso 2: Limpiando cache..." -ForegroundColor Yellow

Set-Location ".\final_complete_apk"

# Limpiar gradle cache
if (Test-Path ".\android\.gradle") {
    Remove-Item ".\android\.gradle" -Recurse -Force -ErrorAction SilentlyContinue
}

# Limpiar builds
if (Test-Path ".\android\app\build") {
    Remove-Item ".\android\app\build" -Recurse -Force -ErrorAction SilentlyContinue
}

# Limpiar .cxx
if (Test-Path ".\android\app\.cxx") {
    Remove-Item ".\android\app\.cxx" -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "  OK - Cache limpiado" -ForegroundColor Green

Write-Host ""
Write-Host "Paso 3: Compilando APK..." -ForegroundColor Yellow
Write-Host "  (Esto puede tomar 5-10 minutos...)" -ForegroundColor Gray
Write-Host ""

Set-Location ".\android"
.\gradlew assembleRelease

Write-Host ""
if (Test-Path ".\app\build\outputs\apk\release\app-release.apk") {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "BUILD EXITOSO!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    
    # Copiar a ubicacion facil
    $fecha = Get-Date -Format "yyyyMMdd_HHmm"
    $nombreApk = "MiningTheBlocks_6mejoras_$fecha.apk"
    Copy-Item ".\app\build\outputs\apk\release\app-release.apk" "..\..\$nombreApk"
    
    Write-Host "APK ubicado en:" -ForegroundColor Cyan
    Write-Host "  $nombreApk" -ForegroundColor White
    Write-Host ""
    Write-Host "Mejoras incluidas:" -ForegroundColor Yellow
    Write-Host "  1. Navegacion invertida" -ForegroundColor White
    Write-Host "  2. Audio superpuesto" -ForegroundColor White
    Write-Host "  3. Animacion pico rapida (0.5s)" -ForegroundColor White
    Write-Host "  4. Precision de minado (raycast 3D)" -ForegroundColor White
    Write-Host "  5. Deteccion caras estable" -ForegroundColor White
    Write-Host "  6. Culling optimizado" -ForegroundColor White
} else {
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "BUILD FALLO" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
}

Set-Location ..\..
