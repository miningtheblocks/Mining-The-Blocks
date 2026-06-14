const js = require("@eslint/js");
const {FlatCompat} = require("@eslint/eslintrc");
const globals = require("globals");

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

module.exports = [
  {
    ignores: ["node_modules/**", "coverage/**", "lib/**", "test/**"],
  },
  js.configs.recommended,
  ...compat.extends("google", "plugin:security/recommended-legacy"),
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      "no-restricted-globals": ["error", "name", "length"],
      "prefer-arrow-callback": "error",
      "quotes": ["error", "double", {"allowTemplateLiterals": true}],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      // ESLint v9 quitó valid-jsdoc y require-jsdoc (deprecated en v8).
      // eslint-config-google los referencia y crashea sin estos overrides.
      "valid-jsdoc": "off",
      "require-jsdoc": "off",
      // Permitir catch params unused si empiezan con `_` o son `_` solo.
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  {
    files: ["**/*.test.*", "**/*.spec.*"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.mocha,
      },
    },
  },
];
