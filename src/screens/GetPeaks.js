import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Share } from 'react-native';
import { WebView } from 'react-native-webview';
import { useAppAlert } from '../components/AppAlert';
import { ensureUser, auth, db } from '../firebase/client';
import { doc, onSnapshot } from 'firebase/firestore';
import { callGetPeaksStatus, callClaimAdSlotPick } from '../firebase/functions';
import { useI18n } from '../utils/i18n';

// Cambio 1 (picos por cadena): GetPeaks ya no es un modal global sin
// contexto — recibe `chainId` (de activeServer.chainId vía useServer()) y lo
// reenvía a las Cloud Functions, que ahora lo requieren.
// Cambio 5 (compliance anuncios, 2026-07-03): se elimina el "Daily" separado
// y el flujo de timer web (createAdSession/claimAdSession, condicionado a
// "esperar viendo el anuncio" -- confirmado con soporte de Adsterra que ese
// patrón viola sus términos como "incentivized traffic"). Ahora hay 2 slots
// incondicionales (`dailyAdSlots`, fijo en 2 para toda cadena) que se
// reclaman al toque, cada uno con su propio cooldown de 24h. El Social Bar
// que se muestra acá abajo es puramente pasivo (WebView aislado, mismo
// subdominio separado que antes) -- no tiene ninguna relación server-side
// con el claim, aparece igual haya o no picos disponibles.
// Fix "abre el navegador" (2026-07-05): ver docs/ad-safe.html -- el
// anuncio va dentro de un iframe sandboxed (sin allow-popups/
// allow-top-navigation) en vez de cargarse directo como documento
// principal del WebView, donde el script del ad-network tenía privilegios
// de navegación de nivel superior y disparaba un redirect automático.
const AD_FRAME_URL = 'https://miningtheblocks.com/ad-safe.html?type=social';

export default function GetPeaks({ asModal = false, onClose, chainId = null, isFreeServer = false }) {
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [picks, setPicks] = useState(0);
  const [serverNow, setServerNow] = useState(0);
  const [baseLocalTs, setBaseLocalTs] = useState(0);
  const [adNextAt, setAdNextAt] = useState({}); // { [slotIndex]: timestamp }
  const tickRef = useRef(null);
  const [claimingAdSlot, setClaimingAdSlot] = useState(null); // índice del slot en curso, o null
  const [tick, setTick] = useState(0); // eslint-disable-line no-unused-vars
  const [userData, setUserData] = useState(null);
  const [copied, setCopied] = useState(false);
  const { showAlert, AlertComponent } = useAppAlert();

  const nowMs = () => serverNow + (Date.now() - baseLocalTs);

  const adSlotIndices = Object.keys(adNextAt).map(Number).sort((a, b) => a - b);
  const remainingForSlot = (idx) => Math.max(0, (adNextAt[idx] || 0) - nowMs());

  const fmt = (ms) => {
    if (!ms || ms <= 0) return '00:00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(totalSec % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  const applyStatus = (data) => {
    setPicks(Number(data?.picks || 0));
    setServerNow(Number(data?.serverNow || Date.now()));
    setBaseLocalTs(Date.now());
    setAdNextAt(data?.adNextAt || {});
  };

  const refresh = async () => {
    // FIX-P1: si no hay user, no llamamos la function (devolvería unauthenticated)
    if (!auth.currentUser || !chainId) { setLoading(false); return; }
    try {
      setLoading(true);
      await ensureUser();
      const data = await callGetPeaksStatus(chainId);
      applyStatus(data);
    } catch (e) {
      showAlert(t('peaks.errorTitle'), t('peaks.errorStatus'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [chainId]);

  useEffect(() => {
    let unsub = null;
    (async () => {
      try {
        await ensureUser();
        const u = auth.currentUser;
        if (!u) return;
        unsub = onSnapshot(doc(db, 'users', u.uid), (snap) => {
          setUserData(snap.exists() ? snap.data() : null);
        }, () => {});
      } catch {}
    })();
    return () => { if (unsub) unsub(); };
  }, []);

  useEffect(() => {
    tickRef.current = setInterval(() => {
      setTick(v => v + 1);
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  const onClaimAd = async (index) => {
    if (claimingAdSlot != null || !chainId) return;
    setClaimingAdSlot(index);
    try {
      const res = await callClaimAdSlotPick(index, chainId);
      applyStatus(res);
    } catch (e) {
      const code = e?.code || '';
      if (code.endsWith('failed-precondition')) {
        showAlert(t('peaks.adUnavailableTitle'), t('peaks.adUnavailableMsg'));
      } else {
        showAlert(t('peaks.errorTitle'), t('peaks.errorClaimAd'));
      }
    } finally {
      setClaimingAdSlot(null);
    }
  };

  const getInviteMsg = () => {
    const code = userData?.referralCode || '';
    const url = 'https://miningtheblocks.com/';
    // CQ-007: template viene de i18n y se interpola con code+url
    const tpl = t('peaks.inviteMessage') || '';
    return tpl.replace('{code}', code).replace('{url}', url);
  };

  const copyReferralCode = async () => {
    const msg = getInviteMsg();
    try {
      await Share.share({ message: msg });
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {}
  };

  const shareReferralCode = async () => {
    try { await Share.share({ message: getInviteMsg() }); } catch {}
  };

  if (!loading && !chainId) {
    return (
      <View style={styles.container}>
        <View style={styles.noChainBox}>
          <Text style={styles.noChainTxt}>{t('peaks.noChainMsg')}</Text>
        </View>
        {AlertComponent}
      </View>
    );
  }

  return (
    <View style={styles.container}>

      {/* Header: pickaxe + count */}
      <View style={styles.headerBox}>
        {loading ? (
          <ActivityIndicator color="#ffd700" size="large" style={{ marginVertical: 16 }} />
        ) : (
          <View style={styles.headerRow}>
            <Text style={styles.bigPick}>⛏</Text>
            <View style={styles.countBlock}>
              <Text style={styles.pickCount}>{picks}</Text>
              <Text style={styles.picksLabel}>{t('profile.picksSuffix')}</Text>
            </View>
          </View>
        )}
      </View>

      {/* Ads — 2 slots incondicionales, cada uno con su cooldown propio */}
      {adSlotIndices.map((idx) => {
        const remaining = remainingForSlot(idx);
        const claiming = claimingAdSlot === idx;
        return (
          <View style={styles.cardRow} key={idx}>
            <View style={styles.cardLeft}>
              <Text style={styles.cardIcon}>⛏</Text>
              <Text style={styles.cardTitle}>{t('peaks.adPeaksN', { n: idx })}</Text>
            </View>
            {remaining <= 0 ? (
              <TouchableOpacity
                style={[styles.adBtn, claiming && { opacity: 0.6 }]}
                onPress={() => onClaimAd(idx)}
                disabled={claimingAdSlot != null}
                activeOpacity={0.85}
                accessibilityLabel={`${t('peaks.watchAd')} (${idx})`}
                accessibilityState={{ disabled: claimingAdSlot != null, busy: claiming }}
              >
                {claiming
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.adTxt}>{t('peaks.watchAd')}</Text>
                }
              </TouchableOpacity>
            ) : (
              <View style={styles.timerPill}>
                <Text style={styles.timerTxt}>{fmt(remaining)}</Text>
              </View>
            )}
          </View>
        );
      })}

      {/* Banner pasivo (Social Bar) — WebView aislado, mismo subdominio
          separado que usaba la vieja página web (ads.miningtheblocks.com).
          Sin relación con onClaimAd: aparece siempre, haya o no picos
          disponibles para reclamar. originWhitelist restringe navegación
          a ese origen; el WebView no comparte JS/DOM con la app (proceso
          web aislado, a diferencia de un iframe same-origin).
          Cambio 15 (2026-07-06): solo Free -- los servers pagos (estándar
          y a medida) ya cobran entrada, no llevan ads. */}
      {isFreeServer && (
      <>
      <Text style={styles.adDisclaimer}>{t('peaks.adDisclaimer')}</Text>
      <View style={styles.adBannerBox} pointerEvents="none">
        {/* pointerEvents="none": ad pasivo, ninguna interacción esperada. */}
        <WebView
          source={{ uri: AD_FRAME_URL }}
          style={styles.adBannerWebview}
          originWhitelist={['https://miningtheblocks.com', 'https://ads.miningtheblocks.com']}
          onShouldStartLoadWithRequest={(req) => req.url.startsWith('https://miningtheblocks.com') || req.url.startsWith('https://ads.miningtheblocks.com')}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={true}
          javaScriptCanOpenWindowsAutomatically={false}
          onOpenWindow={() => {}}
        />
      </View>
      </>
      )}

      {/* Referidos */}
      <View style={styles.referralCard}>
        <Text style={styles.referralTitle}>🔗 {t('profile.referralTitle')}</Text>

        {userData?.referralCode ? (
          <>
            <Text style={styles.referralSubtitle}>{t('peaks.referralInviteLabel')}</Text>
            <View style={styles.referralCodeRow}>
              <Text style={styles.referralCode}>{userData.referralCode}</Text>
            </View>
            <View style={styles.referralBtnRow}>
              <TouchableOpacity
                style={[styles.copyBtn, copied && styles.copyBtnDone]}
                onPress={copyReferralCode}
                activeOpacity={0.85}
              >
                <Text style={styles.copyBtnTxt}>{copied ? t('peaks.copied') : `📋 ${t('peaks.copy')}`}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.shareBtn} onPress={shareReferralCode} activeOpacity={0.85}>
                <Text style={styles.shareBtnTxt}>↑ {t('peaks.share')}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.referralHint}>{t('peaks.referralHint')}</Text>
          </>
        ) : (
          <Text style={styles.referralMuted}>{t('profile.referralNoCode')}</Text>
        )}
      </View>

      {AlertComponent}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },

  // Header pickaxe
  headerBox: {
    alignItems: 'center',
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    marginBottom: 12,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  bigPick: { fontSize: 72, lineHeight: 80 },
  countBlock: { alignItems: 'flex-start' },
  pickCount: { fontSize: 52, fontWeight: '900', color: '#ffd700', lineHeight: 56 },
  picksLabel: { fontSize: 13, fontWeight: '700', color: '#555', textTransform: 'uppercase', letterSpacing: 1 },

  // No chain state
  noChainBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  noChainTxt: { color: '#777', fontSize: 14, textAlign: 'center' },

  // Cards
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  cardLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  cardIcon: { fontSize: 20 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#ccc' },

  // Ad button (green)
  adBtn: {
    backgroundColor: '#0a1a0a',
    borderWidth: 1,
    borderColor: '#2e7d32',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 20,
    minWidth: 90,
    alignItems: 'center',
  },
  adTxt: { color: '#5cb85c', fontWeight: '900', fontSize: 13 },

  // Countdown pill
  timerPill: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  timerTxt: { fontSize: 16, fontWeight: '900', color: '#888', fontFamily: 'monospace' },

  // Banner pasivo (Social Bar)
  adDisclaimer: { fontSize: 10, color: '#555', textAlign: 'center', marginBottom: 4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  adBannerBox: {
    height: 70,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 8,
    backgroundColor: '#0a0a0a',
  },
  adBannerWebview: { flex: 1, backgroundColor: 'transparent' },

  // Referral card
  referralCard: {
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 14,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  referralTitle: { fontSize: 15, fontWeight: '700', color: '#ccc', marginBottom: 6 },
  referralSubtitle: { fontSize: 12, color: '#666', marginBottom: 8 },
  referralCodeRow: { marginBottom: 10 },
  referralCode: { fontSize: 28, fontWeight: '900', color: '#ffd700', letterSpacing: 3 },
  referralBtnRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  copyBtn: { flex: 1, backgroundColor: '#1a1400', borderWidth: 1, borderColor: '#ffd700', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, alignItems: 'center' },
  copyBtnDone: { backgroundColor: '#0a2a0a', borderColor: '#22c55e' },
  copyBtnTxt: { color: '#ffd700', fontWeight: '900', fontSize: 13 },
  shareBtn: { backgroundColor: '#111', borderWidth: 1, borderColor: '#333', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center' },
  shareBtnTxt: { color: '#888', fontWeight: '700', fontSize: 13 },
  referralHint: { fontSize: 11, color: '#555', lineHeight: 16 },
  referralMuted: { fontSize: 13, color: '#555', fontStyle: 'italic' },
});
