import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, Share, Platform } from 'react-native';
import { useI18n } from '../utils/i18n';

// Audit Round 2 feedback (sesión 2026-06-23+): modal que bloquea la entrada al
// cube cuando la capa actual del server requiere más jugadores para liberar
// los premios de su tier más raro. Estética alineada con NotificationsRationaleModal
// y AppAlert (paleta dark, verde primary).
//
// Props:
//   visible          : boolean
//   currentMembers   : number — actual del server
//   requiredMembers  : number — threshold de la capa actual
//   layerK           : number | null — capa actual (info opcional)
//   referralCode     : string | null — para el share message
//   referralUrl      : string — fallback url del share (landing pública)
//   onClose          : () => void
export default function LayerLockedModal({
  visible,
  currentMembers = 0,
  requiredMembers = 0,
  layerK = null,
  referralCode = null,
  referralUrl = 'https://miningtheblocks.com/',
  onClose,
}) {
  const { t, currentLang } = useI18n();
  if (!visible) return null;

  const current = Math.max(0, Number(currentMembers) || 0);
  const required = Math.max(0, Number(requiredMembers) || 0);
  const remaining = Math.max(0, required - current);
  const pct = required > 0 ? Math.min(100, Math.round((current / required) * 100)) : 100;

  const handleShare = async () => {
    try {
      const msg = referralCode
        ? t('layerLocked.shareMessage', {
          code: referralCode,
          url: referralUrl,
          defaultValue: `Mining The Blocks — earn USDC prizes by mining a giant cube. Join with my code ${referralCode}: ${referralUrl}`,
        })
        : t('layerLocked.sharePlain', {
          url: referralUrl,
          defaultValue: `Mining The Blocks — earn USDC prizes by mining a giant cube. Download: ${referralUrl}`,
        });
      await Share.share({ message: msg });
    } catch (e) {
      // Sin Sentry log: Share.share lanza si user cancela en iOS, no es error real
    }
  };

  // formateo de números (miles con separador): 12,345 o 12.345 según locale.
  const fmt = (n) => {
    try {
      return Number(n).toLocaleString(currentLang === 'es' ? 'es-AR' : 'en-US');
    } catch {
      return String(n);
    }
  };

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.box}>
          <View style={s.iconWrap}>
            <Text style={s.lockIcon}>🔒</Text>
          </View>
          <Text style={s.title}>
            {t('layerLocked.title', { defaultValue: 'This layer is not unlocked yet' })}
          </Text>
          {layerK != null && (
            <Text style={s.layerLabel}>{`K = ${layerK}`}</Text>
          )}

          <Text style={s.body}>
            {t('layerLocked.body', {
              current: fmt(current),
              required: fmt(required),
              defaultValue: `To release the prizes of the current layer we need ${fmt(required)} players. Right now there are ${fmt(current)}.`,
            })}
          </Text>

          {/* Barra de progreso */}
          <View style={s.progressWrap}>
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${pct}%` }]} />
            </View>
            <View style={s.progressLabels}>
              <Text style={s.progressLabel}>
                {t('layerLocked.progressLabel', {
                  current: fmt(current),
                  required: fmt(required),
                  defaultValue: `${fmt(current)} / ${fmt(required)}`,
                })}
              </Text>
              <Text style={s.progressPct}>{pct}%</Text>
            </View>
            <Text style={s.needMore}>
              {t('layerLocked.needMoreLabel', {
                remaining: fmt(remaining),
                defaultValue: `${fmt(remaining)} more players needed`,
              })}
            </Text>
          </View>

          <View style={s.btnRow}>
            <TouchableOpacity
              style={[s.btn, s.btnCancel]}
              onPress={onClose}
              activeOpacity={0.85}
            >
              <Text style={[s.btnTxt, s.btnTxtCancel]}>
                {t('layerLocked.backBtn', { defaultValue: 'Back' })}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.btn, s.btnShare]}
              onPress={handleShare}
              activeOpacity={0.85}
            >
              <Text style={s.btnTxt}>
                {t('layerLocked.shareBtn', { defaultValue: '📤 Share' })}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  box: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#111',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    padding: 24,
  },
  iconWrap: {
    alignItems: 'center',
    marginBottom: 10,
  },
  lockIcon: {
    fontSize: 48,
  },
  title: {
    color: '#fff',
    fontSize: 19,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 4,
  },
  layerLabel: {
    color: '#5cb85c',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: 1,
  },
  body: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 18,
  },
  progressWrap: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    padding: 14,
    marginBottom: 18,
  },
  progressTrack: {
    height: 10,
    backgroundColor: '#0a0a0a',
    borderRadius: 5,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#5cb85c',
    borderRadius: 5,
  },
  progressLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  progressLabel: {
    color: '#bbb',
    fontSize: 12,
    fontWeight: '700',
  },
  progressPct: {
    color: '#5cb85c',
    fontSize: 12,
    fontWeight: '800',
  },
  needMore: {
    color: '#888',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 8,
    fontStyle: 'italic',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnShare: {
    backgroundColor: '#1a3a1a',
    borderColor: '#2e7d32',
    flex: 1.6,
  },
  btnCancel: {
    backgroundColor: '#1a1a1a',
    borderColor: '#333',
  },
  btnTxt: {
    color: '#5cb85c',
    fontWeight: '800',
    fontSize: 14,
  },
  btnTxtCancel: {
    color: '#888',
  },
});
