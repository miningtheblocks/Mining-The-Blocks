module.exports = {
  dependencies: {
    // COMPLETELY DISABLE react-native-reanimated y react-native-gesture-handler
    // del autolinking. La sintaxis vieja (platforms.android.sourceDir: null,
    // platforms.ios.podspecPath: null) rompía la validación de schema de la
    // versión actual del CLI ("must be a string" / "is not allowed to be
    // empty") -- el CLI entero fallaba (Config Validation Error), lo que
    // hacía que TODO el autolinking se saltara en silencio durante el build
    // de Gradle, no solo estos dos paquetes. Esto dejó a
    // react-native-webview (agregado 2026-07-03) sin registrar en el
    // binario nativo -- cualquier pantalla con <WebView> (picos, carga del
    // cubo, modo Chain) crashea. `null` a nivel del paquete entero (no
    // anidado en platforms) es la forma actual de excluirlo del
    // autolinking por completo.
    'react-native-reanimated': null,
    'react-native-gesture-handler': null,
  },
};