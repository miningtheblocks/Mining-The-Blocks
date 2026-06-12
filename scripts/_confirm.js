// SEC-B5: helper de confirmación interactiva para scripts destructivos.
// Forza al operador a escribir el nombre del proyecto antes de ejecutar.
// Bypass: --yes-i-am-sure (sólo para CI/cron).

const readline = require('readline');

function confirmDestructive(project, action) {
  if (process.argv.includes('--yes-i-am-sure')) {
    console.log(`[--yes-i-am-sure] Ejecutando ${action} en ${project}.`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║              OPERACIÓN DESTRUCTIVA           ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`  Acción:    ${action}`);
    console.log(`  Proyecto:  ${project}`);
    console.log('');
    rl.question(`Escribí "${project}" para confirmar (o cualquier otra cosa para abortar): `, (input) => {
      rl.close();
      if (input.trim() !== project) {
        console.log('\n❌ Abortado.');
        process.exit(1);
      }
      console.log('');
      resolve();
    });
  });
}

module.exports = { confirmDestructive };
