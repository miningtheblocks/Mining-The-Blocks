import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, FlatList } from 'react-native';
import { collection, query, orderBy, limit, getDocs, doc, getDoc } from 'firebase/firestore';
import { useNavigation } from '@react-navigation/native';
import { db, auth } from '../firebase/client';
import { useAppAlert } from '../components/AppAlert';
import ChainClaimPickModal from '../components/ChainClaimPickModal';
import CaptchaModal from '../components/CaptchaModal';
import DynamicCube201 from '../components/DynamicCube201';
import { callGetChainBlockchainStatus, callClaimChainPick, callUnlockChain } from '../firebase/functions';
import { useI18n } from '../utils/i18n';

// Cambio 6 (modo Chain, 2026-07-03) — SE ENTREGA COMPLETO PERO INACTIVO,
// gateado server-side por config/app.blockchainModeEnabled.
//
// Cambio 8 (restyle, 2026-07-05): misma estructura que ServerList -- una
// "lista" (tarjeta de la cadena activa, estética de Servers, toggle de
// "Cadenas finalizadas" como Finished Servers) que al entrar navega al cubo
// 3D real (DynamicCube201 con chainMode=true -- mismo motor Three.js que
// servers).
//
// Cambio 9 (2026-07-05): mecánica de minado IDÉNTICA a servers/Free (cubo
// completo en la capa 250, se mina hacia el centro) -- la versión original
// (Cambio 6, un cubo que arrancaba en 1 y crecía hacia afuera) se descartó
// por la complejidad/bugs de render 3D para capas chicas. Solo cambia la
// economía (MTB coin por racha de días, no gemas) y la cantidad de capas
// (250 en vez de 100). El pico diario (anuncio + captcha) es un modal
// invocable desde ambas vistas.
export default function ChainMode() {
  const { t } = useI18n();
  const navigation = useNavigation();
  const { showAlert, AlertComponent } = useAppAlert();

  const [screen, setScreen] = useState('list'); // 'list' | 'cube'
  const [showFinished, setShowFinished] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [claimingPick, setClaimingPick] = useState(false);
  // Cambio 16 (captcha de desbloqueo único, 2026-07-06): distinto del
  // captcha de CADA reclamo de pico (arriba) -- este se pide UNA sola vez,
  // antes de entrar al cubo por primera vez. status.unlocked lo confirma
  // server-side (blockchainAccess/main.unlockVerifiedAt).
  const [showUnlockCaptcha, setShowUnlockCaptcha] = useState(false);
  const [unlockingChain, setUnlockingChain] = useState(false);

  const [history, setHistory] = useState([]);
  const [payouts, setPayouts] = useState({});
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // Cambio 12 (2026-07-05): tick propio para el countdown del pico diario --
  // sin esto, pickReady/el tiempo restante quedaban congelados en el
  // momento del último refresh() (no bajaban en tiempo real mientras el
  // usuario mira la pantalla esperando).
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const refresh = async () => {
    try {
      setLoading(true);
      const data = await callGetChainBlockchainStatus();
      setStatus(data);
    } catch (e) {
      showAlert(t('chain.errorTitle'), t('chain.errorStatus'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

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
      setHistoryLoaded(true);
    } catch (e) {
      showAlert(t('chain.errorTitle'), t('chain.errorHistory'));
    }
  };

  const onUnlockChain = async (token) => {
    setUnlockingChain(true);
    try {
      await callUnlockChain(token);
      await refresh();
      setShowUnlockCaptcha(false);
      setScreen('cube');
    } catch (e) {
      showAlert(t('chain.errorTitle'), t('chain.errorClaimPick'));
    } finally {
      setUnlockingChain(false);
    }
  };

  const toggleFinished = () => {
    const next = !showFinished;
    setShowFinished(next);
    if (next && !historyLoaded) loadHistory();
  };

  const onClaimPick = async (token) => {
    setClaimingPick(true);
    try {
      await callClaimChainPick(token);
      await refresh();
      setShowClaimModal(false);
    } catch (e) {
      const code = e?.code || '';
      if (code.endsWith('failed-precondition')) {
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
        {AlertComponent}
      </View>
    );
  }

  if (screen === 'cube') {
    // Mismo motor 3D y mecánica que los servers estándar/Free/a medida
    // (DynamicCube201) -- arranca completo en la capa 250 y se mina hacia
    // el centro. El propio componente maneja su status/listeners de Chain
    // internamente (chainMode=true).
    return <DynamicCube201 chainMode onExitChain={() => { setScreen('list'); refresh(); }} />;
  }

  // nowTick (reloj local) en vez de status.serverNow (congelado en el
  // momento del último refresh) -- el backend sigue siendo la fuente de
  // verdad real (claimChainPick revalida server-side), esto es solo UI.
  // Cambio 13 (2026-07-06): máximo 1 pico sin usar -- si ya tiene uno
  // (picks>=1), no importa el tiempo, no puede reclamar otro todavía.
  const pickReady = status.picks < 1 && status.pickNextAt <= nowTick;
  const pickRemainingMs = Math.max(0, status.pickNextAt - nowTick);
  const pickCountdown = (() => {
    const total = Math.floor(pickRemainingMs / 1000);
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  })();

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.screenTitle}>{t('chain.title')}</Text>
        <TouchableOpacity
          style={[styles.finishedBtn, showFinished && styles.finishedBtnActive]}
          onPress={toggleFinished}
          activeOpacity={0.8}
          accessibilityRole="tab"
          accessibilityState={{ selected: showFinished }}
        >
          <Text style={[styles.finishedBtnTxt, showFinished && styles.finishedBtnTxtActive]}>
            {showFinished ? t('serverList.backActive') : t('chain.historyTitle')}
          </Text>
        </TouchableOpacity>
      </View>

      {showFinished ? (
        <FlatList
          data={history}
          keyExtractor={(row) => row.name}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<Text style={styles.empty}>{t('chain.historyEmpty')}</Text>}
          renderItem={({ item: row }) => {
            const payout = payouts[row.name];
            return (
              <View style={[styles.card, styles.cardFinished]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.serverName}>{row.name}</Text>
                  <Text style={styles.serverMeta}>
                    💰 {t('chain.pool')}: ${row.poolUSD.toFixed(2)} · {row.contributorCount} {t('chain.contributors')}
                  </Text>
                  <Text style={[styles.serverMeta, payout ? styles.prizeMeta : null]}>
                    {payout ? `${t('chain.yourPayout')}: $${payout.amountUSD.toFixed(4)} (${(payout.share * 100).toFixed(2)}%)` : t('chain.noPayout')}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      ) : (
        <View style={[styles.card, styles.cardChain]}>
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={styles.serverName}>⛓ {t('chain.chainName')}: {status.name}</Text>
            </View>
            <Text style={styles.serverMeta}>
              {t('chain.layer', { n: status.currentLayer })} · {status.placedInCurrentLayer}/{status.layerSize}
            </Text>
            <Text style={[styles.serverMeta, styles.prizeMeta]}>
              💰 {t('chain.pool')}: ${status.poolUSD.toFixed(4)}
            </Text>
            <Text style={styles.serverMeta}>
              {t('chain.yourContribution')}: ${status.totalContributedUSD.toFixed(4)}
            </Text>
            <Text style={styles.serverMeta}>
              {t('chain.streak', { n: status.streakDays })} · ${status.currentRatePerCube.toFixed(4)}/{t('chain.perCube')}
            </Text>
            <Text style={styles.serverMeta}>⛏ {t('chain.picks')}: {status.picks}</Text>
            {!pickReady && (
              <Text style={styles.serverMeta}>⏳ {pickCountdown}</Text>
            )}
          </View>
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={styles.historyBtn}
              onPress={() => navigation.navigate('ChainHistory', { isChainMode: true, chainName: status.name })}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={t('drawer.history') || 'Historial'}
            >
              <Text style={styles.historyTxt}>📋</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.pickBtn}
              onPress={() => setShowClaimModal(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.pickBtnTxt}>{pickReady ? '⛏' : '⏳'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={status.unlocked ? styles.mineBtn : styles.unlockBtn}
              onPress={() => (status.unlocked ? setScreen('cube') : setShowUnlockCaptcha(true))}
              activeOpacity={0.8}
            >
              <Text style={status.unlocked ? styles.mineTxt : styles.unlockTxt}>
                {status.unlocked ? t('chain.place') : t('serverList.unlock')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ChainClaimPickModal
        visible={showClaimModal}
        onClose={() => setShowClaimModal(false)}
        onClaim={onClaimPick}
        claiming={claimingPick}
        pickReady={pickReady}
        pickNextAt={status.pickNextAt}
        serverNow={nowTick}
      />
      <CaptchaModal
        visible={showUnlockCaptcha}
        onClose={() => setShowUnlockCaptcha(false)}
        onSuccess={onUnlockChain}
      />
      {AlertComponent}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centerContainer: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },

  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  screenTitle: { color: '#fff', fontSize: 22, fontWeight: '900' },

  finishedBtn: { borderWidth: 1, borderColor: '#444', borderRadius: 20, paddingVertical: 6, paddingHorizontal: 14 },
  finishedBtnActive: { borderColor: '#ffd700', backgroundColor: '#1a1600' },
  finishedBtnTxt: { color: '#999', fontWeight: '700', fontSize: 13 },
  finishedBtnTxtActive: { color: '#ffd700' },

  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 16 },
  card: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#111', borderRadius: 12,
    padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#222',
  },
  cardChain: { borderColor: '#5a5a2a' },
  cardFinished: { borderColor: '#2a2a1a', backgroundColor: '#0f0f08' },
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 4 },
  serverName: { color: '#fff', fontWeight: '800', fontSize: 16, flexShrink: 1 },
  serverMeta: { color: '#777', fontSize: 12, marginTop: 4 },
  prizeMeta: { color: '#ffd700', fontWeight: '700' },
  cardActions: { flexDirection: 'column', alignItems: 'center', gap: 8 },

  historyBtn: {
    width: 36, height: 36, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1,
    borderColor: '#333', alignItems: 'center', justifyContent: 'center',
  },
  historyTxt: { fontSize: 16 },
  pickBtn: {
    width: 44, height: 36, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1,
    borderColor: '#333', alignItems: 'center', justifyContent: 'center',
  },
  pickBtnTxt: { color: '#ffd700', fontWeight: '700', fontSize: 13 },
  mineBtn: {
    backgroundColor: '#1a3a1a', borderRadius: 8, height: 36, paddingHorizontal: 16, minWidth: 70,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#2e7d32',
  },
  mineTxt: { color: '#5cb85c', fontWeight: '700' },
  unlockBtn: {
    backgroundColor: '#1a1a1a', borderRadius: 8, height: 36, paddingHorizontal: 16, minWidth: 70,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#444',
  },
  unlockTxt: { color: '#888', fontWeight: '700', fontSize: 13 },
});
