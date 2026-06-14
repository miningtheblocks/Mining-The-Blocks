module.exports = function (api) {
  api.cache(true);
  // MEDIO-BBL-01: en production strip los console.* para reducir bundle, ruido
  // en Logcat y leaks de info de debug. Opt-in via STRIP_CONSOLE=1 para no
  // romper builds sin el plugin instalado. Ver ACCIONES_MANUALES.md tarea #26.
  const stripConsole = process.env.STRIP_CONSOLE === '1' &&
    (process.env.NODE_ENV === 'production' || process.env.BABEL_ENV === 'production');
  const stripPlugin = [];
  if (stripConsole) {
    try {
      require.resolve('babel-plugin-transform-remove-console');
      stripPlugin.push(['transform-remove-console', { exclude: ['error', 'warn'] }]);
    } catch (_) {
      // Plugin no instalado — silently skip.
    }
  }
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ...stripPlugin,
      // MEDIO-BBL-02: react-native-reanimated/plugin DEBE ir al final del array.
      'react-native-reanimated/plugin',
    ],
  };
};
