// Script para corregir codificación UTF-8
const fs = require('fs');
const path = require('path');

// Mapeo de caracteres mal codificados a correctos
const encodingFixes = [
  ['Workingâ€¦', 'Working…'],
  ['YES â›', 'YES ⛏'],
  ['â› +', '⛏ +'],
  ['â› x', '⛏ x'],
  ['CRÃTICO', 'CRÍTICO'],
  ['rotaciÃ³n', 'rotación'],
  ['detecciÃ³n', 'detección'],
  ['navegaciÃ³n', 'navegación'],
  ['suscripciÃ³n', 'suscripción'],
  ['estadÃ­sticas', 'estadísticas'],
  ['mÃ¡s', 'más'],
  ['cÃ¡mara', 'cámara'],
  ['Ã³ptima', 'óptima'],
  ['PROTECCIÃ"N', 'PROTECCIÓN'],
  ['invÃ¡lido', 'inválido'],
  ['segÃºn', 'según']
];

function fixFileEncoding(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;
    
    // Aplicar todas las correcciones
    for (const [wrong, correct] of encodingFixes) {
      if (content.includes(wrong)) {
        content = content.replace(new RegExp(wrong, 'g'), correct);
        changed = true;
        console.log(`✅ Fixed "${wrong}" → "${correct}" in ${path.basename(filePath)}`);
      }
    }
    
    if (changed) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`📝 Updated: ${filePath}`);
    }
    
    return changed;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error.message);
    return false;
  }
}

function fixDirectoryEncoding(dirPath) {
  const files = fs.readdirSync(dirPath);
  let totalFixed = 0;
  
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Recursivamente procesar subdirectorios
      totalFixed += fixDirectoryEncoding(fullPath);
    } else if (file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.ts') || file.endsWith('.tsx')) {
      if (fixFileEncoding(fullPath)) {
        totalFixed++;
      }
    }
  }
  
  return totalFixed;
}

// Ejecutar corrección
console.log('🔧 Iniciando corrección de codificación UTF-8...');
const srcPath = path.join(__dirname, 'src');
const totalFixed = fixDirectoryEncoding(srcPath);
console.log(`\n✅ Corrección completada! ${totalFixed} archivos corregidos.`);
