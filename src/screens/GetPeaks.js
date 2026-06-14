import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking, AppState, Share, Modal } from 'react-native';
import { useAppAlert } from '../components/AppAlert';
import { ensureUser, auth, db } from '../firebase/client';
import { doc, onSnapshot } from 'firebase/firestore';
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
  const [userData, setUserData] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const { showAlert, AlertComponent } = useAppAlert();

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
    // FIX-P1: si no hay user, no llamamos la function (devolvería unauthenticated)
    if (!auth.currentUser) { setLoading(false); return; }
    try {
      setLoading(true);
      await ensureUser();
      const data = await callGetPeaksStatus();
      setPicks(Number(data?.picks || 0));
      setServerNow(Number(data?.serverNow || Date.now()));
      setBaseLocalTs(Date.now());
      setNextDailyAt(Number(data?.nextDailyAt || 0));
      setAd1NextAt(Number(data?.ad1NextAt || 0));
      setAd2NextAt(Number(data?.ad2NextAt || 0));
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
      if (adStateSubRef.current) { adStateSubRef.current.remove(); adStateSubRef.current = null; }
    };
  }, []);

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
      showAlert(t('peaks.errorTitle'), t('peaks.errorClaimDaily'));
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
      // ALTO-54: encodeURIComponent en query params. Si el backend devuelve
      // tokens con caracteres especiales (& # ?) el URL se rompe; con encode
      // queda parseable y previene inyección via params.
      const sid = encodeURIComponent(session.sessionId || '');
      const tok = encodeURIComponent(session.token || '');
      const url = `https://miningtheblocks.github.io/Mining-The-Blocks/adpick.html?sid=${sid}&t=${tok}`;
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
        showAlert(t('peaks.adUnavailableTitle'), t('peaks.adUnavailableMsg'));
      } else {
        showAlert(t('peaks.errorTitle'), t('peaks.errorClaimAd'));
      }
    } finally {
      if (index === 1) setClaimingAd1(false);
      if (index === 2) setClaimingAd2(false);
    }
  };

  const getInviteMsg = () => {
    const code = userData?.referralCode || '';
    const url = 'https://miningtheblocks.github.io/Mining-The-Blocks/';
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

      {/* Aviso ads externos */}
      <View style={styles.adWarningBox}>
        <Text style={styles.adWarningTxt}>{t('peaks.adBrowserWarning')}</Text>
        <TouchableOpacity onPress={() => setShowExamples(true)} activeOpacity={0.8}>
          <Text style={styles.adExamplesLink}>{t('peaks.adExamplesBtn')}</Text>
        </TouchableOpacity>
      </View>

      {/* Modal ejemplos de publicidad engañosa */}
      <Modal visible={showExamples} transparent animationType="fade" onRequestClose={() => setShowExamples(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.examplesBox}>
            <Text style={styles.examplesTitle}>{t('peaks.adExamplesTitle')}</Text>
            <Text style={styles.examplesTxt}>
              {'• ' + t('peaks.adExamples.iphone')    + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagFake')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.visitor')   + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagFake')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.selected')  + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagFake')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.survey')    + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagFake')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.points')    + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagFake')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.car')       + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagFake')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.virus')     + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagFake')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.phone')     + ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagDont')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.installBtn')+ ' → '}<Text style={styles.fakeTag}>{t('peaks.adExamples.tagSkip')}</Text>{'\n'}
              {'• ' + t('peaks.adExamples.closeBtn')  + ' → '}<Text style={styles.cautionTag}>{t('peaks.adExamples.tagCaution')}</Text>
            </Text>
            <TouchableOpacity style={styles.examplesCloseBtn} onPress={() => setShowExamples(false)} activeOpacity={0.85}>
              <Text style={styles.examplesCloseTxt}>{t('peaks.adExamplesClose')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

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

  // Ad warning banner
  adWarningBox: {
    backgroundColor: '#1a1000',
    borderWidth: 1,
    borderColor: '#4a3000',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  adWarningTxt: { fontSize: 12, color: '#aa8800', lineHeight: 18, textAlign: 'center', fontWeight: '700' },
  adExamplesLink: { fontSize: 12, color: '#4a9eff', fontWeight: '700', textAlign: 'center', marginTop: 6 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  examplesBox: { backgroundColor: '#111', borderWidth: 1, borderColor: '#333', borderRadius: 14, padding: 22, width: '100%', maxWidth: 380 },
  examplesTitle: { fontSize: 14, fontWeight: '900', color: '#ff6600', marginBottom: 14, textAlign: 'center' },
  examplesTxt: { fontSize: 13, color: '#ccc', lineHeight: 26 },
  fakeTag: { color: '#ff4444', fontWeight: '900' },
  cautionTag: { color: '#ff9900', fontWeight: '900' },
  examplesCloseBtn: { backgroundColor: '#1a3a1a', borderWidth: 1, borderColor: '#2e7d32', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 32, alignItems: 'center', marginTop: 18 },
  examplesCloseTxt: { color: '#5cb85c', fontSize: 14, fontWeight: '800' },

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
