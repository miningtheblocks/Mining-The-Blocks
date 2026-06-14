module.exports = {
  env: {
    es6: true,
    node: true,
  },
  parserOptions: {
    // MEDIO-L-01: ecmaVersion bumpeada a 2022. El runtime es Node 22 (ES2024+)
    // y necesitamos parsing correcto de optional chaining, nullish coalescing,
    // top-level await en módulos, etc.
    "ecmaVersion": 2022,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback": "error",
    "quotes": ["error", "double", {"allowTemplateLiterals": true}],
    // MEDIO-L-03: reglas de seguridad explícitas. Algunas vienen vía
    // eslint:recommended pero `no-eval` y `no-implied-eval` no — agregarlas
    // explícitas. eslint-plugin-security se documenta en ACCIONES_MANUALES
    // como instalación pendiente (requiere npm i).
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
    "no-script-url": "error",
  },
  overrides: [
    {
      // MEDIO-L-04: matchear *.test.js (Jest) además de *.spec.* (mocha).
      // Antes los tests Jest no tenían env.jest declarado.
      files: ["**/*.test.*", "**/*.spec.*"],
      env: {
        mocha: true,
        jest: true,
      },
      rules: {},
    },
  ],
  globals: {},
};
