# Copiar proyecto completo limpio con mejoras a C:\MTB
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "COPIANDO PROYECTO LIMPIO A C:\MTB" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$origen = "C:\Users\Bissicletta-PC\Desktop\MiningTheBlocks"
$destino = "C:\MTB"

# Crear C:\MTB si no existe
if (-not (Test-Path $destino)) {
    New-Item -ItemType Directory -Path $destino -Force | Out-Null
    Write-Host "Creado: $destino" -ForegroundColor Green
}

Write-Host "Copiando carpetas principales..." -ForegroundColor Yellow
Write-Host ""

# Copiar src con todas las mejoras
Write-Host "  src/ (con 6 mejoras)" -ForegroundColor White
Copy-Item -Path "$origen\src" -Destination "$destino\src" -Recurse -Force
Write-Host "    OK" -ForegroundColor Green

# Copiar assets
Write-Host "  assets/ (sonidos e imagenes)" -ForegroundColor White
Copy-Item -Path "$origen\assets" -Destination "$destino\assets" -Recurse -Force
Write-Host "    OK" -ForegroundColor Green

# Copiar android (configuracion de build)
Write-Host "  android/ (configuracion)" -ForegroundColor White
Copy-Item -Path "$origen\android" -Destination "$destino\android" -Recurse -Force
Write-Host "    OK" -ForegroundColor Green

# Copiar final_complete_apk (build nativo)
Write-Host "  final_complete_apk/ (build APK)" -ForegroundColor White
Copy-Item -Path "$origen\final_complete_apk" -Destination "$destino\final_complete_apk" -Recurse -Force
Write-Host "    OK" -ForegroundColor Green

# Copiar functions (Firebase)
if (Test-Path "$origen\functions") {
    Write-Host "  functions/ (Firebase)" -ForegroundColor White
    Copy-Item -Path "$origen\functions" -Destination "$destino\functions" -Recurse -Force
    Write-Host "    OK" -ForegroundColor Green
}

Write-Host ""
Write-Host "Copiando archivos raiz..." -ForegroundColor Yellow

# Archivos importantes de configuracion
$archivosRaiz = @(
    "App.js",
    "index.js",
    "package.json",
    "package-lock.json",
    "babel.config.js",
    "metro.config.js",
    "react-native.config.js",
    "app.json",
    "eas.json",
    ".firebaserc",
    "firebase.json",
    "expo-autolinking-exclude.json",
    "expo-module.config.json",
    ".env"
)

foreach ($archivo in $archivosRaiz) {
    if (Test-Path "$origen\$archivo") {
        Copy-Item -Path "$origen\$archivo" -Destination "$destino\$archivo" -Force
        Write-Host "  OK: $archivo" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Copiando scripts de build..." -ForegroundColor Yellow
Copy-Item -Path "$origen\build_native_apk.ps1" -Destination "$destino\build_native_apk.ps1" -Force
Write-Host "  OK: build_native_apk.ps1" -ForegroundColor Green

Write-Host ""
Write-Host "Copiando documentacion..." -ForegroundColor Yellow
Copy-Item -Path "$origen\README.md" -Destination "$destino\README.md" -Force
Copy-Item -Path "$origen\BUILD_INSTRUCTIONS.md" -Destination "$destino\BUILD_INSTRUCTIONS.md" -Force
Copy-Item -Path "$origen\INFORME_OPTIMIZACION_COMPLETO.md" -Destination "$destino\INFORME_OPTIMIZACION_COMPLETO.md" -Force
Copy-Item -Path "$origen\REPORTE_LIMPIEZA_COMPLETADA.md" -Destination "$destino\REPORTE_LIMPIEZA_COMPLETADA.md" -Force
Write-Host "  OK: Documentos clave copiados" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "PROYECTO COPIADO A C:\MTB" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

Write-Host "Contenido en C:\MTB:" -ForegroundColor Cyan
Write-Host "  - src/ (5 componentes limpios con 6 mejoras)" -ForegroundColor White
Write-Host "  - assets/ (sonidos e imagenes)" -ForegroundColor White
Write-Host "  - android/ (configuracion de build)" -ForegroundColor White
Write-Host "  - final_complete_apk/ (build nativo)" -ForegroundColor White
Write-Host "  - Archivos de configuracion" -ForegroundColor White
Write-Host "  - Scripts de build" -ForegroundColor White
Write-Host ""

Write-Host "Mejoras incluidas:" -ForegroundColor Yellow
Write-Host "  1. Navegacion invertida" -ForegroundColor White
Write-Host "  2. Audio superpuesto" -ForegroundColor White
Write-Host "  3. Animacion pico rapida (0.5s)" -ForegroundColor White
Write-Host "  4. Precision de minado (raycast 3D)" -ForegroundColor White
Write-Host "  5. Deteccion caras estable" -ForegroundColor White
Write-Host "  6. Culling optimizado (83% menos ops)" -ForegroundColor White
Write-Host ""

Write-Host "Proximo paso:" -ForegroundColor Cyan
Write-Host "  cd C:\MTB" -ForegroundColor White
Write-Host "  .\build_native_apk.ps1" -ForegroundColor White
