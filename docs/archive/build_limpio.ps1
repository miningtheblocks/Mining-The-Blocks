# Build con limpieza previa
Write-Host "Limpiando cache y builds anteriores..." -ForegroundColor Yellow

# Limpiar en C:\MTB
Set-Location "C:\MTB"

# Limpiar gradle cache
if (Test-Path ".\android\.gradle") {
    Remove-Item ".\android\.gradle" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Cache gradle limpiado" -ForegroundColor Green
}

# Limpiar builds
if (Test-Path ".\android\app\build") {
    Remove-Item ".\android\app\build" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Build app limpiado" -ForegroundColor Green
}

# Limpiar .cxx
if (Test-Path ".\android\app\.cxx") {
    Remove-Item ".\android\app\.cxx" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Cache C++ limpiado" -ForegroundColor Green
}

Write-Host ""
Write-Host "Iniciando build limpio..." -ForegroundColor Cyan

# Ejecutar gradlew clean
Set-Location ".\android"
.\gradlew clean

# Ejecutar build
Write-Host ""
Write-Host "Compilando APK..." -ForegroundColor Cyan
.\gradlew assembleRelease

Write-Host ""
Write-Host "Build completado!" -ForegroundColor Green
