# 🔧 SOLUCIÓN: Error de Rutas Largas en Build

## ❌ Problema Detectado

El build falló con el error:
```
ninja: error: Filename longer than 260 characters
```

**Causa:** Windows tiene un límite de 260 caracteres para rutas de archivos, y el build de Android excede este límite.

---

## ✅ SOLUCIÓN: Habilitar Rutas Largas en Windows

### **Opción 1: Ejecutar Script (REQUIERE ADMIN)**

1. Abre PowerShell **como ADMINISTRADOR**:
   - Click derecho en el menú Inicio
   - Selecciona "Windows PowerShell (Administrador)"

2. Ejecuta estos comandos:
```powershell
cd "C:\Users\Bissicletta-PC\Desktop\MiningTheBlocks"
.\BACKUP_OBSOLETOS\otros\habilitar_rutas_largas.ps1
```

### **Opción 2: Manual (REQUIERE ADMIN)**

1. Abre PowerShell **como ADMINISTRADOR**

2. Ejecuta este comando:
```powershell
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -Type DWord
```

3. Verifica que se habilitó:
```powershell
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled"
```

Debe mostrar: `LongPathsEnabled : 1`

---

### **Opción 3: Mover Proyecto a Ruta Más Corta**

Si no puedes ejecutar como administrador, mueve el proyecto a una ruta más corta:

```powershell
# Crear directorio en raíz
New-Item -ItemType Directory -Path "C:\MTB2" -Force

# Copiar proyecto
Copy-Item -Path "C:\Users\Bissicletta-PC\Desktop\MiningTheBlocks\*" -Destination "C:\MTB2\" -Recurse -Force

# Compilar desde la nueva ubicación
cd C:\MTB2
.\build_directo.ps1
```

---

## 🚀 DESPUÉS DE HABILITAR RUTAS LARGAS

Una vez habilitadas las rutas largas, ejecuta el build nuevamente:

```powershell
cd "C:\Users\Bissicletta-PC\Desktop\MiningTheBlocks"
.\build_final_completo.ps1
```

---

## 📝 NOTA

- **NO es necesario reiniciar** después de habilitar rutas largas
- El cambio es permanente (solo hay que hacerlo una vez)
- Esto no afecta la seguridad del sistema
- Es una configuración estándar de Windows 10/11

---

## ⚠️ SI EL PROBLEMA PERSISTE

Si después de habilitar rutas largas el build sigue fallando:

1. Limpia completamente el cache:
```powershell
Remove-Item ".\final_complete_apk\android\.gradle" -Recurse -Force
Remove-Item ".\final_complete_apk\android\app\build" -Recurse -Force
Remove-Item ".\final_complete_apk\android\app\.cxx" -Recurse -Force
```

2. Vuelve a intentar el build:
```powershell
.\build_final_completo.ps1
```

---

**Estoy esperando que habilites las rutas largas para continuar con el build.**
