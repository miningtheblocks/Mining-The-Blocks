import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, Linking, AppState } from 'react-native';
import { ensureAnonLogin } from '../firebase/client';
import { callGetPeaksStatus, callClaimDailyPick, callCreateAdSession } from '../firebase/functions';
import { useI18n } from '../utils/i18n';

export default function GetPeaks({ asModal = false, onClose }) {
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [picks, setPicks] = useState(0);
  const [serverNow, setServerNow] = useState(0);
  const [baseLocalTs, setBaseLocalTs] = useState(0);
  const [nextDailyAt, setNextDailyAt] = useState(0);
  const [ad1NextAt, setAd1NextAt] = useState(0);
  const [ad2NextAt, setAd2NextAt] = useState(0);
  const tickRef = useRef(null);
  const dailyAutoClaimingRef = useRef(false);
  const adStateSubRef = useRef(null);
  const [claimingDaily, setClaimingDaily] = useState(false);
  const [claimingAd1, setClaimingAd1] = useState(false);
  const [claimingAd2, setClaimingAd2] = useState(false);
  const [tick, setTick] = useState(0); // eslint-disable-line no-unused-vars

  const nowMs = () => serverNow + (Date.now() - baseLocalTs);

  const remainingDaily = Math.max(0, nextDailyAt - nowMs());
  const remainingAd1 = Math.max(0, ad1NextAt - nowMs());
  const remainingAd2 = Math.max(0, ad2NextAt - nowMs());

  const fmt = (ms) => {
    if (!ms || ms <= 0) return '00:00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(totalSec % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  const refresh = async () => {
    try {
      setLoading(true);
      await ensureAnonLogin();
      const data = await callGetPeaksStatus();
      setPicks(Number(data?.picks || 0));
      setServerNow(Number(data?.serverNow || Date.now()));
      setBaseLocalTs(Date.now());
      setNextDailyAt(Number(data?.nextDailyAt || 0));
      setAd1NextAt(Number(data?.ad1NextAt || 0));
      setAd2NextAt(Number(data?.ad2NextAt || 0));
    } catch (e) {
      Alert.alert(t('peaks.errorTitle'), t('peaks.errorStatus'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (adStateSubRef.current) { adStateSubRef.current.remove(); adStateSubRef.current = null; }
    };
  }, []);

  useEffect(() => {
    tickRef.current = setInterval(() => {
      setTick(v => v + 1);
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  useEffect(() => {
    if (remainingDaily <= 0 && !dailyAutoClaimingRef.current) {
      dailyAutoClaimingRef.current = true;
      (async () => {
        try {
          const res = await callClaimDailyPick();
          setPicks(Number(res?.picks || 0));
          setServerNow(Number(res?.serverNow || Date.now()));
          setBaseLocalTs(Date.now());
          setNextDailyAt(Number(res?.nextDailyAt || 0));
          setAd1NextAt(Number(res?.ad1NextAt || 0));
          setAd2NextAt(Number(res?.ad2NextAt || 0));
        } catch (e) {
          try { await refresh(); } catch {}
        } finally {
          setTimeout(() => { dailyAutoClaimingRef.current = false; }, 1500);
        }
      })();
    }
  }, [remainingDaily]);

  const onClaimDaily = async () => {
    try {
      if (claimingDaily) return;
      setClaimingDaily(true);
      const res = await callClaimDailyPick();
      setPicks(Number(res?.picks || 0));
      setServerNow(Number(res?.serverNow || Date.now()));
      setBaseLocalTs(Date.now());
      setNextDailyAt(Number(res?.nextDailyAt || 0));
      setAd1NextAt(Number(res?.ad1NextAt || 0));
      setAd2NextAt(Number(res?.ad2NextAt || 0));
    } catch (e) {
      Alert.alert(t('peaks.errorTitle'), t('peaks.errorClaimDaily'));
    } finally {
      setClaimingDaily(false);
    }
  };

  const onClaimAd = async (index) => {
    if (index === 1 && claimingAd1) return;
    if (index === 2 && claimingAd2) return;
    if (index === 1) setClaimingAd1(true);
    if (index === 2) setClaimingAd2(true);
    try {
      const session = await callCreateAdSession(index);
      const url = `https://miningtheblocks.github.io/Mining-The-Blocks/adpick.html?sid=${session.sessionId}&t=${session.token}`;
      await Linking.openURL(url);
      // Cuando el usuario vuelva a la app, refrescar picks
      if (adStateSubRef.current) adStateSubRef.current.remove();
      adStateSubRef.current = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') {
          if (adStateSubRef.current) { adStateSubRef.current.remove(); adStateSubRef.current = null; }
          refresh();
        }
      });
    } catch (e) {
      const code = e?.code || '';
      if (code === 'failed-precondition') {
        Alert.alert(t('peaks.adUnavailableTitle'), t('peaks.adUnavailableMsg'));
      } else {
        Alert.alert(t('peaks.errorTitle'), t('peaks.errorClaimAd'));
      }
    } finally {
      if (index === 1) setClaimingAd1(false);
      if (index === 2) setClaimingAd2(false);
    }
  };

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
              <Text style={styles.picksLabel}>picks</Text>
            </View>
          </View>
        )}
      </View>

      {/* Daily */}
      <View style={styles.cardRow}>
        <View style={styles.cardLeft}>
          <Text style={styles.cardIcon}>📅</Text>
          <Text style={styles.cardTitle}>{t('peaks.dailyIn')}</Text>
        </View>
        {remainingDaily <= 0 ? (
          <TouchableOpacity
            style={[styles.claimBtn, claimingDaily && { opacity: 0.6 }]}
            onPress={onClaimDaily}
            disabled={claimingDaily}
            activeOpacity={0.85}
          >
            {claimingDaily
              ? <ActivityIndicator size="small" color="#0a0a0a" />
              : <Text style={styles.claimTxt}>{t('peaks.claimDaily')}</Text>
            }
          </TouchableOpacity>
        ) : (
          <View style={styles.timerPill}>
            <Text style={styles.timerTxt}>{fmt(remainingDaily)}</Text>
          </View>
        )}
      </View>

      {/* Ad 1 */}
      <View style={styles.cardRow}>
        <View style={styles.cardLeft}>
          <Text style={styles.cardIcon}>📺</Text>
          <Text style={styles.cardTitle}>{t('peaks.adPeaks1')}</Text>
        </View>
        {remainingAd1 <= 0 ? (
          <TouchableOpacity
            style={[styles.adBtn, claimingAd1 && { opacity: 0.6 }]}
            onPress={() => onClaimAd(1)}
            disabled={claimingAd1}
            activeOpacity={0.85}
          >
            {claimingAd1
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.adTxt}>{t('peaks.watchAd')}</Text>
            }
          </TouchableOpacity>
        ) : (
          <View style={styles.timerPill}>
            <Text style={styles.timerTxt}>{fmt(remainingAd1)}</Text>
          </View>
        )}
      </View>

      {/* Ad 2 */}
      <View style={styles.cardRow}>
        <View style={styles.cardLeft}>
          <Text style={styles.cardIcon}>📺</Text>
          <Text style={styles.cardTitle}>{t('peaks.adPeaks2')}</Text>
        </View>
        {remainingAd2 <= 0 ? (
          <TouchableOpacity
            style={[styles.adBtn, claimingAd2 && { opacity: 0.6 }]}
            onPress={() => onClaimAd(2)}
            disabled={claimingAd2}
            activeOpacity={0.85}
          >
            {claimingAd2
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.adTxt}>{t('peaks.watchAd')}</Text>
            }
          </TouchableOpacity>
        ) : (
          <View style={styles.timerPill}>
            <Text style={styles.timerTxt}>{fmt(remainingAd2)}</Text>
          </View>
        )}
      </View>

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

  // Claim daily (gold)
  claimBtn: {
    backgroundColor: '#1a1400',
    borderWidth: 1,
    borderColor: '#ffd700',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 20,
    minWidth: 90,
    alignItems: 'center',
  },
  claimTxt: { color: '#ffd700', fontWeight: '900', fontSize: 13 },

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
});
