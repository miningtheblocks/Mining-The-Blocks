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
// el backend vía HCAPTCHA_SECRET) -- reemplazar por la key real una vez que
// el usuario cree la cuenta en hCaptcha.
const HCAPTCHA_SITE_KEY = 'a05aeafa-e782-45c8-98ac-4b0edef0c056';

function buildCaptchaHtml(siteKey) {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://js.hcaptcha.com/1/api.js" async defer></script>
<style>
  html,body{margin:0;padding:0;background:#0a0a0a;display:flex;align-items:center;justify-content:center;min-height:100vh;}
</style>
</head><body>
<div class="h-captcha" data-sitekey="${siteKey}" data-callback="onCaptchaSuccess" data-error-callback="onCaptchaError"></div>
<script>
  function onCaptchaSuccess(token) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'success', token }));
  }
  function onCaptchaError() {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error' }));
  }
</script>
</body></html>`;
}

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
            source={{ html: buildCaptchaHtml(HCAPTCHA_SITE_KEY) }}
            style={styles.webview}
            onMessage={onMessage}
            javaScriptEnabled
            domStorageEnabled
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
  box: { width: '100%', maxWidth: 380, height: 340, backgroundColor: '#0a0a0a', borderRadius: 16, borderWidth: 1, borderColor: '#222', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#111' },
  title: { color: '#fff', fontSize: 14, fontWeight: '900' },
  closeBtn: { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333' },
  closeTxt: { color: '#888', fontWeight: '900', fontSize: 12 },
  webview: { flex: 1, backgroundColor: '#0a0a0a' },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a' },
});
