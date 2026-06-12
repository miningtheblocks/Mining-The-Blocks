# Script de PowerShell para build APK nativo de Mining The Blocks
# Configuración final optimizada - USA LA CONFIGURACIÓN QUE FUNCIONA

Write-Host "========================================" -ForegroundColor Green
Write-Host "BUILD APK NATIVO - MINING THE BLOCKS" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# Configurar variables de entorno
$env:ANDROID_HOME = "C:\Users\Bissicletta-PC\AppData\Local\Android\Sdk"
$env:ANDROID_SDK_ROOT = "C:\Users\Bissicletta-PC\AppData\Local\Android\Sdk"
$env:PATH = "$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\tools;$env:PATH"

Write-Host "Configurando variables de entorno..." -ForegroundColor Yellow
Write-Host "ANDROID_HOME: $env:ANDROID_HOME" -ForegroundColor Gray
Write-Host "ANDROID_SDK_ROOT: $env:ANDROID_SDK_ROOT" -ForegroundColor Gray

# Verificar que el SDK existe
if (!(Test-Path $env:ANDROID_HOME)) {
    Write-Host "ERROR: Android SDK no encontrado en $env:ANDROID_HOME" -ForegroundColor Red
    exit 1
}

Write-Host "Android SDK encontrado correctamente" -ForegroundColor Green

# Verificar que local.properties existe en final_complete_apk
if (!(Test-Path "final_complete_apk\local.properties")) {
    Write-Host "Creando final_complete_apk\local.properties..." -ForegroundColor Yellow
    "sdk.dir=C:\\Users\\Bissicletta-PC\\AppData\\Local\\Android\\Sdk" | Out-File -FilePath "final_complete_apk\local.properties" -Encoding ASCII
}

Write-Host "Archivo local.properties configurado" -ForegroundColor Green

# Cambiar al directorio final_complete_apk que tiene configuración funcional (ahora sin Expo)
Set-Location final_complete_apk

Write-Host "Iniciando build de APK RELEASE..." -ForegroundColor Yellow
Write-Host "Esto puede tomar varios minutos..." -ForegroundColor Gray

# Ejecutar gradlew con configuración explícita
try {
    # Limpieza para resultados reproducibles
    & .\gradlew.bat clean --no-daemon --stacktrace --info

    # Build de release (usará la firma de debug configurada en app/build.gradle para fines locales)
    & .\gradlew.bat assembleRelease --no-daemon --stacktrace --info
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "BUILD COMPLETADO EXITOSAMENTE!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        
        # Buscar el APK generado
        $apkPath = "app\build\outputs\apk\release\app-release.apk"
        if (Test-Path $apkPath) {
            Write-Host "APK generado en: $apkPath" -ForegroundColor Green
            $fullPath = Resolve-Path $apkPath
            Write-Host "Ruta completa: $fullPath" -ForegroundColor Green
            
            # Copiar APK al directorio raíz con nombre descriptivo
            $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
            $finalApkName = "..\MINING-THE-BLOCKS-NATIVE-$timestamp.apk"
            Copy-Item $apkPath $finalApkName
            Write-Host "APK copiado como: $finalApkName" -ForegroundColor Green
            
            # Mostrar información del APK
            $apkSize = (Get-Item $fullPath).Length / 1MB
            Write-Host "Tamaño del APK: $([math]::Round($apkSize, 2)) MB" -ForegroundColor Cyan
            
        } else {
            Write-Host "APK no encontrado en la ubicacion esperada" -ForegroundColor Yellow
            Write-Host "Buscando APKs..." -ForegroundColor Yellow
            Get-ChildItem -Recurse -Filter "*.apk" | ForEach-Object { Write-Host "Encontrado: $($_.FullName)" -ForegroundColor Gray }
        }
    } else {
        Write-Host "BUILD FALLO con codigo de salida: $LASTEXITCODE" -ForegroundColor Red
    }
} catch {
    Write-Host "ERROR durante el build: $($_.Exception.Message)" -ForegroundColor Red
}

# Volver al directorio raíz
Set-Location ..

Write-Host "Script completado" -ForegroundColor Blue
Write-Host "Si el build fue exitoso, instale el APK en su dispositivo Android" -ForegroundColor Cyan
