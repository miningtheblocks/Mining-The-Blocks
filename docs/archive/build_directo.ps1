# Build directo desde el proyecto actual
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "COMPILANDO APK CON 6 MEJORAS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Ubicacion: $PWD" -ForegroundColor Yellow
Write-Host ""

Write-Host "Paso 1: Limpiando builds anteriores..." -ForegroundColor Yellow

# Limpiar gradle cache local
if (Test-Path ".\android\.gradle") {
    Remove-Item ".\android\.gradle" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  OK - Cache gradle limpiado" -ForegroundColor Green
}

# Limpiar builds previos
if (Test-Path ".\android\app\build") {
    Remove-Item ".\android\app\build" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  OK - Build anterior limpiado" -ForegroundColor Green
}

# Limpiar cache C++
if (Test-Path ".\android\app\.cxx") {
    Remove-Item ".\android\app\.cxx" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  OK - Cache C++ limpiado" -ForegroundColor Green
}

Write-Host ""
Write-Host "Paso 2: Ejecutando gradlew clean..." -ForegroundColor Yellow
Set-Location ".\android"
.\gradlew clean | Out-Null
Write-Host "  OK - Limpieza completada" -ForegroundColor Green

Write-Host ""
Write-Host "Paso 3: Compilando APK Release..." -ForegroundColor Yellow
Write-Host "  (Esto puede tomar 5-10 minutos...)" -ForegroundColor Gray
Write-Host ""

.\gradlew assembleRelease

Write-Host ""
if (Test-Path ".\app\build\outputs\apk\release\app-release.apk") {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "BUILD EXITOSO!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "APK ubicado en:" -ForegroundColor Cyan
    Write-Host "  android\app\build\outputs\apk\release\app-release.apk" -ForegroundColor White
    Write-Host ""
    
    # Copiar a ubicacion facil
    $fecha = Get-Date -Format "yyyyMMdd_HHmm"
    $nombreApk = "MiningTheBlocks_6mejoras_$fecha.apk"
    Copy-Item ".\app\build\outputs\apk\release\app-release.apk" "..\$nombreApk"
    Write-Host "APK copiado a:" -ForegroundColor Cyan
    Write-Host "  $nombreApk" -ForegroundColor White
    Write-Host ""
    Write-Host "Mejoras incluidas:" -ForegroundColor Yellow
    Write-Host "  1. Navegacion invertida" -ForegroundColor White
    Write-Host "  2. Audio superpuesto" -ForegroundColor White
    Write-Host "  3. Animacion pico rapida (0.5s)" -ForegroundColor White
    Write-Host "  4. Precision de minado (raycast 3D)" -ForegroundColor White
    Write-Host "  5. Deteccion caras estable" -ForegroundColor White
    Write-Host "  6. Culling optimizado (83% menos ops)" -ForegroundColor White
} else {
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "BUILD FALLO" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "Revisa los errores arriba" -ForegroundColor Yellow
}

Set-Location ..
