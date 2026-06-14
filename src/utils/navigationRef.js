import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

// BAJO-NAV-01: loguear errores en vez de tragarlos. Si alguien navega a una
// screen inexistente, ver el bug en errorLog ahorra horas de debug.
function reportNavError(scope, err, extra) {
  // Lazy import para evitar dependencia circular si logError llega a usar navigate.
  import('./logError')
      .then(({ default: logError }) => logError(scope, err, extra))
      .catch(() => {});
}

export function navigate(name, params) {
  try {
    if (navigationRef.isReady()) {
      navigationRef.navigate(name, params);
    }
  } catch (e) {
    reportNavError('navigationRef.navigate', e, { name });
  }
}

export function goBack() {
  try {
    if (navigationRef.isReady() && navigationRef.canGoBack()) {
      navigationRef.goBack();
    }
  } catch (e) {
    reportNavError('navigationRef.goBack', e);
  }
}
