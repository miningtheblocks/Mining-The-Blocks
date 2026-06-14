import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import { useI18n } from '../utils/i18n';

export default function UpdateModal({ visible, forceUpdate, latestVersion, downloadUrl, messageEn, messageEs, onDismiss }) {
  const { t, language } = useI18n();

  const message = language === 'es'
    ? (messageEs || t('update.defaultBody'))
    : (messageEn || t('update.defaultBody'));

  const openDownload = () => {
    // SEC-B4 + ALTO-57: validar scheme/host. downloadUrl viene de Firestore
    // config/app — si Firebase es comprometido, un atacante podría setear
    // http://, intent://, file:// o un host arbitrario y MITMear a todos.
    //
    // ALTO-57: sacamos github.com del allowlist porque permite que un
    // atacante suba un release a OTRA cuenta de github (e.g. /malicious/x/releases)
    // y lo apunte desde config/app.downloadUrl. Sólo aceptamos URLs de
    // miningtheblocks.github.io (org de la app) y de objects.githubusercontent.com
    // PERO sólo si el path empieza con `/MTB/` o `/Mining-The-Blocks/` (releases
    // del repo oficial).
    const fallback = 'https://miningtheblocks.github.io/Mining-The-Blocks/';
    let safeUrl = fallback;
    try {
      const raw = (downloadUrl || '').trim();
      if (raw) {
        const u = new URL(raw);
        if (u.protocol !== 'https:') throw new Error('scheme');
        const okHost = u.hostname === 'miningtheblocks.github.io';
        // objects.githubusercontent.com es el CDN de release assets; los paths
        // incluyen el repo ID — no hay garantía path-based. Mantenerlo afuera y
        // forzar que el atacante use el host del org.
        if (okHost) safeUrl = u.toString();
      }
    } catch (_) {}
    Linking.openURL(safeUrl).catch(() => {});
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={forceUpdate ? undefined : onDismiss}>
      <View style={s.overlay}>
        <View style={s.box}>
          <Text style={s.icon}>⛏️</Text>
          <Text style={s.title}>{t('update.title')}</Text>
          {latestVersion ? <Text style={s.version}>v{latestVersion}</Text> : null}
          <Text style={s.body}>{message}</Text>

          <TouchableOpacity style={s.btnPrimary} onPress={openDownload} activeOpacity={0.85}>
            <Text style={s.btnPrimaryTxt}>{t('update.download')}</Text>
          </TouchableOpacity>

          {!forceUpdate && (
            <TouchableOpacity style={s.btnSecondary} onPress={onDismiss} activeOpacity={0.8}>
              <Text style={s.btnSecondaryTxt}>{t('update.later')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  box: {
    backgroundColor: '#111', borderRadius: 18, borderWidth: 1, borderColor: '#333',
    padding: 28, width: '100%', maxWidth: 360, alignItems: 'center',
  },
  icon:           { fontSize: 40, marginBottom: 12 },
  title:          { color: '#fff', fontSize: 20, fontWeight: '900', textAlign: 'center', marginBottom: 4 },
  version:        { color: '#ffd700', fontSize: 13, fontWeight: '700', marginBottom: 12 },
  body:           { color: '#aaa', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 22 },
  btnPrimary:     { backgroundColor: '#2e7d32', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, alignSelf: 'stretch', alignItems: 'center', marginBottom: 10 },
  btnPrimaryTxt:  { color: '#fff', fontWeight: '800', fontSize: 15 },
  btnSecondary:   { paddingVertical: 10, alignItems: 'center', alignSelf: 'stretch' },
  btnSecondaryTxt:{ color: '#555', fontWeight: '700', fontSize: 13 },
});
