import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { WebView } from 'react-native-webview';
import { collection, query, where, orderBy, limit, onSnapshot, getDocs, doc, getDoc } from 'firebase/firestore';
import { db, auth } from '../firebase/client';
import { useAppAlert } from '../components/AppAlert';
import CaptchaModal from '../components/CaptchaModal';
import { callGetChainBlockchainStatus, callClaimChainPick, callPlaceCube } from '../firebase/functions';
import { useI18n } from '../utils/i18n';

// Cambio 6 (modo Chain, cubo invertido, 2026-07-03) — SE ENTREGA COMPLETO
// PERO INACTIVO, gateado server-side por config/app.blockchainModeEnabled
// (getChainBlockchainStatus/claimChainPick/placeCube devuelven
// failed-precondition "feature_disabled" hasta que se active manualmente).
//
// Simplificación deliberada (no 3D): reconstruir el motor Three.js completo
// de DynamicCube201.js para la mecánica invertida (capas que se AGREGAN en
// vez de destruirse) hubiera sido un proyecto aparte del tamaño de este
// mismo. En cambio, la capa actual se muestra como una grilla 2D paginada
// (ventana de WINDOW_SIZE cubos por vez) -- cumple la misma mecánica visual
// pedida (parche oscuro → número blanco al colocar) sin el render 3D.
const AD_FRAME_URL_BANNER = 'https://ads.miningtheblocks.com/ad-frame.html?type=banner';
const AD_FRAME_URL_SOCIAL = 'https://ads.miningtheblocks.com/ad-frame.html?type=social';
const WINDOW_SIZE = 60;
const WINDOW_COLUMNS = 6;

export default function ChainMode() {
  const { t } = useI18n();
  const { showAlert, AlertComponent } = useAppAlert();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [windowOffset, setWindowOffset] = useState(0); // desplazamiento dentro de la capa actual
  const [placedInWindow, setPlacedInWindow] = useState({}); // { cubeNumber: true }
  const [placingCube, setPlacingCube] = useState(null);
  const [claimingPick, setClaimingPick] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [showEntryBanner, setShowEntryBanner] = useState(true);
  const buildStartRef = useRef(0);
  const ENTRY_BANNER_MIN_MS = 1100;

  // Cambio 7 (cierre de cadena): historial de cadenas ya cerradas + lo que
  // ganó el usuario en cada una (ledger, sin movimiento real de plata
  // todavía). Lectura directa de Firestore -- las reglas ya permiten leer
  // blockchainHistory (público autenticado) y blockchainPayouts (solo el
  // propio uid), no hace falta una Cloud Function para esto.
  const [history, setHistory] = useState([]);
  const [payouts, setPayouts] = useState({}); // { chainName: payoutDoc }
  const [showHistory, setShowHistory] = useState(false);

  const loadHistory = async () => {
    try {
      const histCol = collection(db, 'blockchainHistory');
      const q = query(histCol, orderBy('closedAt', 'desc'), limit(20));
      const snap = await getDocs(q);
      const rows = snap.docs.map((d) => d.data());
      setHistory(rows);

      const uid = auth.currentUser && auth.currentUser.uid;
      if (uid) {
        const payoutEntries = await Promise.all(rows.map(async (row) => {
          const pSnap = await getDoc(doc(db, 'users', uid, 'blockchainPayouts', row.name));
          return [row.name, pSnap.exists() ? pSnap.data() : null];
        }));
        setPayouts(Object.fromEntries(payoutEntries));
      }
    } catch (e) {
      showAlert(t('chain.errorTitle'), t('chain.errorHistory'));
    }
  };

  const refresh = async () => {
    try {
      setLoading(true);
      buildStartRef.current = Date.now();
      const data = await callGetChainBlockchainStatus();
      setStatus(data);
      setWindowOffset(0);
    } catch (e) {
      showAlert(t('chain.errorTitle'), t('chain.errorStatus'));
    } finally {
      const elapsed = Date.now() - buildStartRef.current;
      const remaining = ENTRY_BANNER_MIN_MS - elapsed;
      setTimeout(() => setShowEntryBanner(false), Math.max(0, remaining));
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Listener de los cubos ya colocados dentro de la ventana visible actual.
  useEffect(() => {
    if (!status) return;
    const K = status.currentLayer;
    const rangeMin = K > 0 ? cumSumDedupLocal(K - 1) : 0;
    const from = rangeMin + 1 + windowOffset;
    const to = from + WINDOW_SIZE - 1;
    const placedCol = collection(db, 'blockchainState', 'main', 'placed');
    const q = query(
      placedCol,
      where('__name__', '>=', String(from)),
      where('__name__', '<=', String(to)),
      orderBy('__name__'),
      limit(WINDOW_SIZE)
    );
    const unsub = onSnapshot(q, (snap) => {
      const map = {};
      snap.forEach((d) => { map[d.id] = true; });
      setPlacedInWindow(map);
    }, () => {});
    return () => unsub();
  }, [status, windowOffset]);

  function cumSumDedupLocal(K) {
    let total = 0;
    for (let k = 0; k <= K; k++) total += (k <= 0 ? 1 : 24 * k * k + 2);
    return total;
  }

  const onPlace = async (cubeNumber) => {
    if (placingCube != null) return;
    setPlacingCube(cubeNumber);
    try {
      const res = await callPlaceCube(cubeNumber);
      if (res.layerComplete) {
        showAlert(t('chain.layerCompleteTitle'), t('chain.layerCompleteBody', { n: res.newLayer }));
      }
      await refresh();
    } catch (e) {
      const code = e?.code || '';
      if (code === 'failed-precondition' && e?.message?.includes('no_picks')) {
        showAlert(t('chain.errorTitle'), t('chain.noPicksBody'));
      } else {
        showAlert(t('chain.errorTitle'), t('chain.errorPlace'));
      }
    } finally {
      setPlacingCube(null);
    }
  };

  const onClaimPickPress = () => setShowCaptcha(true);

  const onCaptchaSuccess = async (token) => {
    setShowCaptcha(false);
    setClaimingPick(true);
    try {
      await callClaimChainPick(token);
      await refresh();
    } catch (e) {
      const code = e?.code || '';
      if (code === 'failed-precondition') {
        showAlert(t('chain.errorTitle'), t('chain.pickNotReadyBody'));
      } else {
        showAlert(t('chain.errorTitle'), t('chain.errorClaimPick'));
      }
    } finally {
      setClaimingPick(false);
    }
  };

  if (loading || !status) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#ffd700" />
        {showEntryBanner && (
          <View style={styles.entryBannerWrap}>
            <Text style={styles.entryBannerDisclaimer}>{t('chain.adDisclaimer')}</Text>
            <View style={styles.entryBannerBox}>
              <WebView
                source={{ uri: AD_FRAME_URL_BANNER }}
                style={styles.entryBannerWebview}
                originWhitelist={['https://ads.miningtheblocks.com']}
                onShouldStartLoadWithRequest={(req) => req.url.startsWith('https://ads.miningtheblocks.com')}
                javaScriptEnabled
                domStorageEnabled
                setSupportMultipleWindows={false}
              />
            </View>
          </View>
        )}
        {AlertComponent}
      </View>
    );
  }

  const K = status.currentLayer;
  const rangeMin = K > 0 ? cumSumDedupLocal(K - 1) : 0;
  const windowStart = rangeMin + 1 + windowOffset;
  const cellsInWindow = Math.min(WINDOW_SIZE, status.layerSize - windowOffset);
  const cells = Array.from({ length: Math.max(0, cellsInWindow) }, (_, i) => windowStart + i);
  const pickReady = status.pickNextAt <= status.serverNow;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <View style={styles.headerBox}>
        <Text style={styles.headerTitle}>{t('chain.title')}</Text>
        <Text style={styles.headerStat}>{t('chain.chainName')}: {status.name}</Text>
        <Text style={styles.headerStat}>{t('chain.layer', { n: K })} · {status.placedInCurrentLayer}/{status.layerSize}</Text>
        <Text style={styles.headerStat}>{t('chain.pool')}: ${status.poolUSD.toFixed(4)}</Text>
        <Text style={styles.headerStat}>{t('chain.yourContribution')}: ${status.totalContributedUSD.toFixed(4)}</Text>
        <Text style={styles.headerStat}>{t('chain.streak', { n: status.streakDays })} · ${status.currentRatePerCube.toFixed(4)}/{t('chain.perCube')}</Text>
      </View>

      <View style={styles.pickCard}>
        <Text style={styles.pickTitle}>⛏ {t('chain.picks')}: {status.picks}</Text>
        {pickReady ? (
          <TouchableOpacity
            style={[styles.claimBtn, claimingPick && { opacity: 0.6 }]}
            onPress={onClaimPickPress}
            disabled={claimingPick}
            activeOpacity={0.85}
          >
            {claimingPick ? <ActivityIndicator size="small" color="#0a0a0a" /> : <Text style={styles.claimTxt}>{t('chain.claimPick')}</Text>}
          </TouchableOpacity>
        ) : (
          <Text style={styles.pickWait}>{t('chain.pickWait')}</Text>
        )}
        <View style={styles.socialBannerBox}>
          <WebView
            source={{ uri: AD_FRAME_URL_SOCIAL }}
            style={styles.socialBannerWebview}
            originWhitelist={['https://ads.miningtheblocks.com']}
            onShouldStartLoadWithRequest={(req) => req.url.startsWith('https://ads.miningtheblocks.com')}
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
          />
        </View>
        <Text style={styles.adDisclaimer}>{t('chain.adDisclaimer')}</Text>
      </View>

      <View style={styles.gridBox}>
        <Text style={styles.gridTitle}>{t('chain.layer', { n: K })}</Text>
        <View style={styles.grid}>
          {cells.map((n) => {
            const placed = !!placedInWindow[String(n)];
            const placing = placingCube === n;
            return (
              <TouchableOpacity
                key={n}
                style={[styles.cell, placed && styles.cellPlaced]}
                onPress={() => !placed && onPlace(n)}
                disabled={placed || placingCube != null}
                activeOpacity={0.8}
              >
                {placing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Text style={[styles.cellNumber, placed && styles.cellNumberPlaced]}>{n}</Text>
                    {!placed && <Text style={styles.cellAction}>{t('chain.place')}</Text>}
                  </>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={styles.pagerRow}>
          <TouchableOpacity
            style={[styles.pagerBtn, windowOffset === 0 && styles.pagerBtnDisabled]}
            onPress={() => setWindowOffset((o) => Math.max(0, o - WINDOW_SIZE))}
            disabled={windowOffset === 0}
          >
            <Text style={styles.pagerTxt}>← {t('chain.prev')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.pagerBtn, windowOffset + WINDOW_SIZE >= status.layerSize && styles.pagerBtnDisabled]}
            onPress={() => setWindowOffset((o) => o + WINDOW_SIZE)}
            disabled={windowOffset + WINDOW_SIZE >= status.layerSize}
          >
            <Text style={styles.pagerTxt}>{t('chain.next')} →</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.historyBox}>
        <TouchableOpacity
          style={styles.historyToggle}
          onPress={() => { const next = !showHistory; setShowHistory(next); if (next && history.length === 0) loadHistory(); }}
          activeOpacity={0.85}
        >
          <Text style={styles.historyToggleTxt}>{t('chain.historyTitle')} {showHistory ? '▲' : '▼'}</Text>
        </TouchableOpacity>
        {showHistory && (
          history.length === 0 ? (
            <Text style={styles.historyEmpty}>{t('chain.historyEmpty')}</Text>
          ) : (
            history.map((row) => {
              const payout = payouts[row.name];
              return (
                <View key={row.name} style={styles.historyRow}>
                  <Text style={styles.historyName}>{row.name}</Text>
                  <Text style={styles.historyStat}>{t('chain.pool')}: ${row.poolUSD.toFixed(2)} · {row.contributorCount} {t('chain.contributors')}</Text>
                  <Text style={styles.historyStat}>
                    {payout ? `${t('chain.yourPayout')}: $${payout.amountUSD.toFixed(4)} (${(payout.share * 100).toFixed(2)}%)` : t('chain.noPayout')}
                  </Text>
                </View>
              );
            })
          )
        )}
      </View>

      <CaptchaModal visible={showCaptcha} onClose={() => setShowCaptcha(false)} onSuccess={onCaptchaSuccess} />
      {AlertComponent}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  scrollContent: { padding: 16, paddingBottom: 40 },
  centerContainer: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },

  headerBox: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#1e1e1e', padding: 16, marginBottom: 12 },
  headerTitle: { color: '#ffd700', fontSize: 18, fontWeight: '900', marginBottom: 8 },
  headerStat: { color: '#ccc', fontSize: 13, fontWeight: '600', marginBottom: 3 },

  pickCard: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#1e1e1e', padding: 16, marginBottom: 12, alignItems: 'center' },
  pickTitle: { color: '#fff', fontSize: 15, fontWeight: '800', marginBottom: 10 },
  claimBtn: { backgroundColor: '#1a1400', borderWidth: 1, borderColor: '#ffd700', paddingVertical: 10, paddingHorizontal: 24, borderRadius: 20, minWidth: 140, alignItems: 'center', marginBottom: 10 },
  claimTxt: { color: '#ffd700', fontWeight: '900', fontSize: 13 },
  pickWait: { color: '#666', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  socialBannerBox: { width: '100%', height: 70, borderRadius: 10, overflow: 'hidden', backgroundColor: '#0a0a0a', marginBottom: 6 },
  socialBannerWebview: { flex: 1, backgroundColor: 'transparent' },
  adDisclaimer: { fontSize: 10, color: '#555', textAlign: 'center', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },

  gridBox: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#1e1e1e', padding: 16 },
  gridTitle: { color: '#ccc', fontSize: 13, fontWeight: '800', marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: {
    width: `${100 / WINDOW_COLUMNS - 3}%`,
    aspectRatio: 1,
    backgroundColor: '#1a1000',
    borderWidth: 1,
    borderColor: '#3a2a00',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellPlaced: { backgroundColor: '#0a1a0a', borderColor: '#2e7d32' },
  cellNumber: { color: '#aa8800', fontSize: 10, fontWeight: '900' },
  cellNumberPlaced: { color: '#ffffff' },
  cellAction: { color: '#ffd700', fontSize: 8, fontWeight: '800', marginTop: 2 },

  pagerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  pagerBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333' },
  pagerBtnDisabled: { opacity: 0.4 },
  pagerTxt: { color: '#ccc', fontSize: 12, fontWeight: '700' },

  historyBox: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#1e1e1e', padding: 16, marginTop: 12 },
  historyToggle: { alignItems: 'center' },
  historyToggleTxt: { color: '#ccc', fontSize: 13, fontWeight: '800' },
  historyEmpty: { color: '#555', fontSize: 12, textAlign: 'center', marginTop: 10, fontStyle: 'italic' },
  historyRow: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#1e1e1e' },
  historyName: { color: '#ffd700', fontSize: 13, fontWeight: '900', marginBottom: 3 },
  historyStat: { color: '#999', fontSize: 12, fontWeight: '600', marginBottom: 2 },

  entryBannerWrap: { marginTop: 24, width: 260 },
  entryBannerDisclaimer: { fontSize: 10, color: '#888', textAlign: 'center', marginBottom: 4, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  entryBannerBox: { height: 70, borderRadius: 10, overflow: 'hidden', backgroundColor: '#0a0a0a' },
  entryBannerWebview: { flex: 1, backgroundColor: 'transparent' },
});
