import React, { useState, useEffect } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import CaptchaModal from './CaptchaModal';
import { useI18n } from '../utils/i18n';

// Fix "abre el navegador" (2026-07-05): ad-frame.html va DENTRO de un
// iframe sandboxed (sin allow-popups/allow-top-navigation) en vez de
// cargarse directo -- ver comentario en docs/ad-safe.html.
const AD_FRAME_URL_SOCIAL = 'https://miningtheblocks.com/ad-safe.html?type=social';

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Cambio 8 (modo Chain, restyle, 2026-07-05): el reclamo del pico diario
// (anuncio pasivo + captcha) vive en un modal reusable, invocable tanto
// desde la lista de cadenas como desde adentro del cubo -- antes el
// WebView del anuncio estaba embebido en el flujo normal de la pantalla,
// ensuciando el layout tipo Servers que se buscaba acá.
//
// pickReady/pickNextAt/serverNow (Cambio 12, 2026-07-05): si el pico
// diario todavía no está listo, se muestra un countdown en vivo en vez de
// solo "no listo" -- pickNextAt/serverNow vienen del mismo status ya
// cargado por el caller (callGetChainBlockchainStatus), no hace falta
// pedir nada nuevo al backend.
export default function ChainClaimPickModal({ visible, onClose, onClaim, claiming, pickReady = true, pickNextAt = 0, serverNow = 0 }) {
  const { t } = useI18n();
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [remainingMs, setRemainingMs] = useState(Math.max(0, pickNextAt - serverNow));

  useEffect(() => {
    setRemainingMs(Math.max(0, pickNextAt - serverNow));
    if (pickReady) return undefined;
    const iv = setInterval(() => {
      setRemainingMs((prev) => Math.max(0, prev - 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [pickNextAt, serverNow, pickReady]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.box}>
          <View style={styles.header}>
            <Text style={styles.title}>⛏ {t('chain.claimPick')}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.8}>
              <Text style={styles.closeTxt}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.socialBannerBox} pointerEvents="none">
            {/* pointerEvents="none": este formato de anuncio ("Social Bar")
                está diseñado por la red publicitaria para parecer clickeable
                (imita notificaciones/UI real) -- el diseño del proyecto es
                "ads pasivos", ninguna interacción real se espera ni se
                quiere. Bloquear TODO tap acá evita que cualquier JS del
                anuncio (que no controlamos) dispare un intent/redirect al
                navegador externo, sin depender de que onShouldStartLoad
                alcance a interceptarlo a tiempo. */}
            <WebView
              source={{ uri: AD_FRAME_URL_SOCIAL }}
              style={styles.socialBannerWebview}
              originWhitelist={['https://miningtheblocks.com', 'https://ads.miningtheblocks.com']}
              onShouldStartLoadWithRequest={(req) => req.url.startsWith('https://miningtheblocks.com') || req.url.startsWith('https://ads.miningtheblocks.com')}
              javaScriptEnabled
              domStorageEnabled
              setSupportMultipleWindows={true}
              javaScriptCanOpenWindowsAutomatically={false}
              onOpenWindow={() => {}}
            />
          </View>
          <Text style={styles.adDisclaimer}>{t('chain.adDisclaimer')}</Text>
          {pickReady ? (
            <TouchableOpacity
              style={[styles.claimBtn, claiming && { opacity: 0.6 }]}
              onPress={() => setShowCaptcha(true)}
              disabled={claiming}
              activeOpacity={0.85}
            >
              {claiming ? <ActivityIndicator size="small" color="#0a0a0a" /> : <Text style={styles.claimTxt}>{t('chain.claimPick')}</Text>}
            </TouchableOpacity>
          ) : (
            <View style={styles.waitBox}>
              <Text style={styles.waitTxt}>{t('chain.pickWait', { time: formatCountdown(remainingMs) })}</Text>
            </View>
          )}
        </View>
      </View>
      <CaptchaModal
        visible={showCaptcha}
        onClose={() => setShowCaptcha(false)}
        onSuccess={(token) => { setShowCaptcha(false); onClaim(token); }}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  box: { width: '100%', maxWidth: 380, backgroundColor: '#0a0a0a', borderRadius: 16, borderWidth: 1, borderColor: '#222', padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: '#fff', fontSize: 15, fontWeight: '900' },
  closeBtn: { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333' },
  closeTxt: { color: '#888', fontWeight: '900', fontSize: 12 },
  socialBannerBox: { width: '100%', height: 70, borderRadius: 10, overflow: 'hidden', backgroundColor: '#111', marginBottom: 6 },
  socialBannerWebview: { flex: 1, backgroundColor: 'transparent' },
  adDisclaimer: { fontSize: 10, color: '#555', textAlign: 'center', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 },
  claimBtn: { backgroundColor: '#1a1400', borderWidth: 1, borderColor: '#ffd700', paddingVertical: 12, borderRadius: 20, alignItems: 'center' },
  claimTxt: { color: '#ffd700', fontWeight: '900', fontSize: 13 },
  waitBox: { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333', paddingVertical: 12, borderRadius: 20, alignItems: 'center' },
  waitTxt: { color: '#888', fontWeight: '700', fontSize: 13 },
});
