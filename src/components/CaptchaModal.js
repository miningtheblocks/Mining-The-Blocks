import React from 'react';
import { Modal, View, TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { useI18n } from '../utils/i18n';

// Cambio 6 (modo Chain, 2026-07-03): modal reusable de hCaptcha, anti-bot
// puro (registro de cuenta + reclamo del pico diario del modo Chain), sin
// ninguna relación con anuncios. hCaptcha es un widget web -- se embebe vía
// WebView con un HTML mínimo, se comunica el token resuelto de vuelta a la
// app vía postMessage (mismo mecanismo que cualquier WebView↔RN bridge,
// no hay JS/DOM compartido con el resto de la app).
//
// HCAPTCHA_SITE_KEY es pública (a diferencia del secret, que vive solo en
// el backend vía HCAPTCHA_SECRET).
//
// Fix "invalid data" (2026-07-05): hCaptcha valida el sitekey contra un
// dominio registrado en su dashboard. Cargar el widget vía HTML inline
// (source={{ html: ... }}) no tiene un origen real -- hCaptcha lo
// rechazaba. Ahora se carga por URL desde docs/captcha.html (GitHub
// Pages, https://miningtheblocks.com/captcha.html), un dominio real
// registrable en el sitekey.
const HCAPTCHA_SITE_KEY = 'a05aeafa-e782-45c8-98ac-4b0edef0c056';
const CAPTCHA_URL = `https://miningtheblocks.com/captcha.html?sitekey=${HCAPTCHA_SITE_KEY}`;

export default function CaptchaModal({ visible, onSuccess, onClose }) {
  const { t } = useI18n();

  const onMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'success' && data.token) {
        onSuccess(data.token);
      }
    } catch {}
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.box}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('captcha.title') || 'Verificación'}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.8}>
              <Text style={styles.closeTxt}>✕</Text>
            </TouchableOpacity>
          </View>
          <WebView
            source={{ uri: CAPTCHA_URL }}
            style={styles.webview}
            onMessage={onMessage}
            originWhitelist={['https://miningtheblocks.com', 'https://js.hcaptcha.com', 'https://*.hcaptcha.com']}
            onShouldStartLoadWithRequest={(req) => req.url.startsWith('https://miningtheblocks.com') || req.url.includes('hcaptcha.com')}
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={true}
            javaScriptCanOpenWindowsAutomatically={false}
            onOpenWindow={() => {}}
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loadingBox}>
                <ActivityIndicator color="#ffd700" size="large" />
              </View>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  // hCaptcha puede mostrar un desafío visual (grilla de imágenes) más alto
  // que el simple checkbox -- 340 lo cortaba. maxHeight relativo a la
  // pantalla para que siga entrando en dispositivos chicos.
  box: { width: '100%', maxWidth: 380, height: '80%', maxHeight: 560, backgroundColor: '#0a0a0a', borderRadius: 16, borderWidth: 1, borderColor: '#222', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#111' },
  title: { color: '#fff', fontSize: 14, fontWeight: '900' },
  closeBtn: { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333' },
  closeTxt: { color: '#888', fontWeight: '900', fontSize: 12 },
  webview: { flex: 1, backgroundColor: '#0a0a0a' },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a' },
});
