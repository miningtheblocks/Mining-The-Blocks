// CQ-014: ErrorBoundary global. Sin esto, cualquier error de render no capturado
// por try/catch deja la app en pantalla blanca sin posibilidad de recuperación
// salvo matando el proceso.
//
// Envuelve los providers del root (App.js).

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { logError } from '../utils/logError';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, err: null };
  }

  static getDerivedStateFromError(err) {
    return { hasError: true, err };
  }

  componentDidCatch(err, info) {
    logError('ErrorBoundary', err, { componentStack: info && info.componentStack });
  }

  handleReset = () => {
    this.setState({ hasError: false, err: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const e = this.state.err;
    const rawMsg = e && (e.message || String(e));

    // ALTO-56: NO mostrar el stack/mensaje crudo en producción. Puede
    // contener paths internos, UIDs, fragmentos de tokens, info de Firestore
    // rules. En dev (__DEV__) sí mostramos para facilitar debugging.
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    const display = isDev ? rawMsg : 'Error desconocido. Si el problema persiste, reportalo desde el menú una vez recuperada la app.';

    return (
      <View style={styles.container}>
        <Text style={styles.title}>Algo salió mal</Text>
        <Text style={styles.subtitle}>
          La app encontró un error inesperado. Probá reintentar; si el problema persiste,
          reportá el bug desde el menú una vez recuperada.
        </Text>
        <ScrollView style={styles.errBox} contentContainerStyle={{ padding: 12 }}>
          <Text style={styles.errText}>{display || 'Unknown error'}</Text>
        </ScrollView>
        <TouchableOpacity style={styles.btn} onPress={this.handleReset} activeOpacity={0.85}>
          <Text style={styles.btnTxt}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    padding: 24,
    paddingTop: 80,
    justifyContent: 'center',
  },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 12, textAlign: 'center' },
  subtitle: { color: '#bbb', fontSize: 14, lineHeight: 20, marginBottom: 20, textAlign: 'center' },
  errBox: {
    maxHeight: 200,
    backgroundColor: '#141414',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginBottom: 24,
  },
  errText: { color: '#f87171', fontSize: 12, fontFamily: 'monospace' },
  btn: { backgroundColor: '#2e7d32', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnTxt: { color: '#fff', fontWeight: '800', fontSize: 16 },
});
