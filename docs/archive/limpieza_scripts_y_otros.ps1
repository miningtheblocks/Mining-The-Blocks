# Limpieza de scripts y archivos temporales
Write-Host "PASO 3: Scripts Python..." -ForegroundColor Cyan
$pythonFiles = Get-ChildItem -Path "." -Filter "*.py"
$moved = 0
foreach ($file in $pythonFiles) {
    Move-Item -Path $file.FullName -Destination ".\BACKUP_OBSOLETOS\otros\$($file.Name)" -Force
    Write-Host "  OK: $($file.Name)" -ForegroundColor Green
    $moved++
}
Write-Host "Total: $moved archivos Python movidos" -ForegroundColor Cyan
Write-Host ""

Write-Host "PASO 4: Scripts PowerShell temporales..." -ForegroundColor Cyan
# Mantener solo build_native_apk.ps1
$psTemp = @(
    "build_con_log_completo.ps1",
    "build_verbose.ps1",
    "verificar_ndk.ps1",
    "check_system.ps1",
    "habilitar_rutas_largas.ps1",
    "copiar_audio.ps1",
    "copiar_cambios.ps1",
    "copiar_dinamiccube.ps1",
    "MOVER_PROYECTO.ps1",
    "verificar_y_preparar.ps1",
    "limpiar_proyecto_seguro.ps1",
    "limpieza_paso_a_paso.ps1",
    "limpieza_docs.ps1"
)
$moved = 0
foreach ($ps in $psTemp) {
    if (Test-Path $ps) {
        Move-Item -Path $ps -Destination ".\BACKUP_OBSOLETOS\otros\$ps" -Force
        Write-Host "  OK: $ps" -ForegroundColor Green
        $moved++
    }
}
Write-Host "Total: $moved scripts PowerShell movidos" -ForegroundColor Cyan
Write-Host "Mantenido: build_native_apk.ps1" -ForegroundColor Green
Write-Host ""

Write-Host "PASO 5: Archivos de texto/datos..." -ForegroundColor Cyan
$textFiles = @(
    "DATOS_COMPLETOS_PICO.txt",
    "DATOS_PICO_64x64.txt",
    "LEER_PRIMERO.txt",
    "FUNCIONES_MODIFICADAS.js"
)
$moved = 0
foreach ($txt in $textFiles) {
    if (Test-Path $txt) {
        Move-Item -Path $txt -Destination ".\BACKUP_OBSOLETOS\otros\$txt" -Force
        Write-Host "  OK: $txt" -ForegroundColor Green
        $moved++
    }
}
Write-Host "Total: $moved archivos de texto movidos" -ForegroundColor Cyan
Write-Host ""

Write-Host "PASO 6: Logs de build..." -ForegroundColor Cyan
$logs = @("build_log.txt", "build_verbose_log.txt")
$moved = 0
foreach ($log in $logs) {
    if (Test-Path $log) {
        Move-Item -Path $log -Destination ".\BACKUP_OBSOLETOS\otros\$log" -Force
        Write-Host "  OK: $log" -ForegroundColor Green
        $moved++
    }
}
Write-Host "Total: $moved logs movidos" -ForegroundColor Cyan
Write-Host ""

Write-Host "================================" -ForegroundColor Green
Write-Host "LIMPIEZA COMPLETADA!" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""
Write-Host "El proyecto esta limpio y mas liviano." -ForegroundColor Cyan
Write-Host "Todos los archivos estan en BACKUP_OBSOLETOS\" -ForegroundColor Yellow
