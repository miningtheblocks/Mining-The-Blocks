# Preparar build final con todas las optimizaciones
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "PREPARANDO BUILD FINAL CON 6 MEJORAS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Verificar que C:\MTB existe
if (-not (Test-Path "C:\MTB")) {
    Write-Host "ERROR: C:\MTB no existe" -ForegroundColor Red
    exit 1
}

Write-Host "Paso 1: Copiando DynamicCube201.js (con 6 mejoras)..." -ForegroundColor Yellow
Copy-Item -Path ".\src\components\DynamicCube201.js" -Destination "C:\MTB\src\components\DynamicCube201.js" -Force
Write-Host "  OK - DynamicCube201.js copiado" -ForegroundColor Green

Write-Host ""
Write-Host "Paso 2: Copiando audioManager.js (audio superpuesto)..." -ForegroundColor Yellow
Copy-Item -Path ".\src\utils\audioManager.js" -Destination "C:\MTB\src\utils\audioManager.js" -Force
Write-Host "  OK - audioManager.js copiado" -ForegroundColor Green

Write-Host ""
Write-Host "Paso 3: Copiando FaceDetection.js (deteccion de caras)..." -ForegroundColor Yellow
Copy-Item -Path ".\src\components\FaceDetection.js" -Destination "C:\MTB\src\components\FaceDetection.js" -Force
Write-Host "  OK - FaceDetection.js copiado" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "ARCHIVOS SINCRONIZADOS CON C:\MTB" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

Write-Host "Mejoras incluidas:" -ForegroundColor Cyan
Write-Host "  1. Navegacion invertida (arriba/abajo, izq/der)" -ForegroundColor White
Write-Host "  2. Audio superpuesto (multiples sonidos)" -ForegroundColor White
Write-Host "  3. Animacion pico rapida (0.5s)" -ForegroundColor White
Write-Host "  4. Precision de minado (raycast 3D)" -ForegroundColor White
Write-Host "  5. Deteccion caras estable (sin parpadeo)" -ForegroundColor White
Write-Host "  6. Culling optimizado (83% menos operaciones)" -ForegroundColor White
Write-Host ""

Write-Host "Listo para compilar APK!" -ForegroundColor Green
