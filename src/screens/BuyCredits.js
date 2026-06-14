import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppAlert } from '../components/AppAlert';
import { TERMS_URL } from '../constants';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../firebase/client';
import { callCreateCryptoPayment } from '../firebase/functions';
import { useI18n } from '../utils/i18n';
import { logError } from '../utils/logError';

// ALTO-49: persistir paymentId activo en AsyncStorage para recuperar el
// estado si el usuario cierra la app a mitad del pago.
const PAYMENT_CACHE_KEY = '@mtb/activePayment';

// SEC-B2: PAYMENT_WALLET viene del backend (createCryptoPayment response).
// NO hardcodear en cliente — un APK modificado podría reemplazar la constante
// y redirigir todos los pagos al wallet del atacante.

function formatTimer(ms) {
  if (ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function BuyCredits({ onClose }) {
  const { t } = useI18n();
  const { showAlert, AlertComponent } = useAppAlert();
  const [loading, setLoading] = useState(false);
  const [payment, setPayment] = useState(null); // { paymentId, amount, expiresAt }
  const [status, setStatus] = useState(null); // 'waiting' | 'completed' | 'expired'
  const [timeLeft, setTimeLeft] = useState(0);
  const [userData, setUserData] = useState(null);
  const timerRef = useRef(null);
  const unsubRef = useRef(null);
  const userUnsubRef = useRef(null);

  // Countdown timer
  useEffect(() => {
    if (!payment) return;
    const tick = () => setTimeLeft(Math.max(0, payment.expiresAt - Date.now()));
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => clearInterval(timerRef.current);
  }, [payment]);

  // Escuchar estado del pago en Firestore
  useEffect(() => {
    if (!payment?.paymentId) return;
    const ref = doc(db, 'pendingCryptoPayments', payment.paymentId);
    unsubRef.current = onSnapshot(ref, (snap) => {
      if (snap.exists()) setStatus(snap.data().status);
    });
    return () => unsubRef.current && unsubRef.current();
  }, [payment?.paymentId]);

  // Escuchar doc del usuario para detectar bonus de referido
  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    userUnsubRef.current = onSnapshot(doc(db, 'users', u.uid), (snap) => {
      setUserData(snap.exists() ? snap.data() : null);
    }, () => {});
    return () => userUnsubRef.current && userUnsubRef.current();
  }, []);

  const generatePayment = async () => {
    setLoading(true);
    try {
      const result = await callCreateCryptoPayment();
      setPayment(result);
      setStatus('waiting');
      // ALTO-49: persistir para recovery si el user cierra la app.
      try {
        await AsyncStorage.setItem(PAYMENT_CACHE_KEY, JSON.stringify({
          paymentId: result.paymentId,
          expiresAt: result.expiresAt,
        }));
      } catch {}
    } catch (e) {
      logError('BuyCredits.generatePayment', e);
      // No revelar mensaje crudo del backend al UI.
      showAlert('Error', t('buyCredits.errorGenerate'));
    } finally {
      setLoading(false);
    }
  };

  // ALTO-49: al montar, recuperar paymentId activo si no expiró.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PAYMENT_CACHE_KEY);
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw);
        if (parsed?.expiresAt && parsed.expiresAt > Date.now() && parsed.paymentId) {
          // Restaurar listener; el snapshot lo va a mostrar como waiting/completed/expired.
          setPayment({ paymentId: parsed.paymentId, expiresAt: parsed.expiresAt, amount: null, wallet: null });
          setStatus('waiting');
        } else {
          AsyncStorage.removeItem(PAYMENT_CACHE_KEY).catch(() => {});
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // Limpiar cache cuando el pago sale del estado waiting (completed/expired/cancelled).
  useEffect(() => {
    if (status && status !== 'waiting') {
      AsyncStorage.removeItem(PAYMENT_CACHE_KEY).catch(() => {});
    }
  }, [status]);

  // MEDIO-C20: copiar al portapapeles en lugar de Share.share. Share abre el
  // selector de apps para "compartir" — el usuario podía mandar el wallet/
  // monto a una app maliciosa accidentalmente. Clipboard es directo.
  const copyToClipboard = async (text, label) => {
    try {
      await Clipboard.setStringAsync(String(text || ''));
    } catch (e) {
      try { (await import('../utils/logError')).default('BuyCredits.copy', e, { label }); } catch {}
    }
  };

  // MEDIO-C21: validar wallet del backend antes de mostrar/usar. Si el backend
  // devolviera un wallet con caracteres unicode RTL/look-alike (`0х...` cirílica),
  // el usuario podría copiar visualmente correcto pero enviar a otro destino.
  const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
  const safeWallet = payment && ETH_ADDR_RE.test(String(payment.wallet || '')) ? payment.wallet : null;

  if (status === 'completed') {
    // Show bonus on first purchase: referredBy set and bonus not yet processed (will fire in background)
    const gotReferralBonus = userData?.referredBy && !userData?.referralBonusPaid;
    return (
      <View style={s.container}>
        <View style={s.successBox}>
          <Text style={s.successIcon}>✅</Text>
          <Text style={s.successTitle}>{t('buyCredits.successTitle')}</Text>
          <Text style={s.successMsg}>{t('buyCredits.successMsg')}</Text>
          {gotReferralBonus ? (
            <View style={s.bonusBox}>
              <Text style={s.bonusTxt}>{t('buyCredits.successReferralBonus')}</Text>
            </View>
          ) : null}
          <TouchableOpacity style={s.btn} onPress={onClose} activeOpacity={0.85}>
            <Text style={s.btnTxt}>{t('buyCredits.close')}</Text>
          </TouchableOpacity>
        </View>
        {AlertComponent}
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Header info */}
      <View style={s.infoBox}>
        <Text style={s.infoTitle}>USDC · Polygon</Text>
        <Text style={s.infoSub}>{t('buyCredits.subtitle')}</Text>
      </View>

      {!payment ? (
        /* Sin pago generado */
        <View style={s.centerBox}>
          <Text style={s.price}>$15 <Text style={s.priceCurrency}>USDC</Text></Text>
          <Text style={s.priceNote}>{t('buyCredits.priceNote')}</Text>
          <TouchableOpacity style={s.btn} onPress={generatePayment} disabled={loading} activeOpacity={0.85}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.btnTxt}>{t('buyCredits.generate')}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL).catch(() => {})} style={s.termsBtn}>
            <Text style={s.termsTxt}>{t('buyCredits.termsNote')}</Text>
          </TouchableOpacity>
        </View>
      ) : status === 'expired' ? (
        /* Pago expirado */
        <View style={s.centerBox}>
          <Text style={s.expiredTxt}>⏱ {t('buyCredits.expired')}</Text>
          <TouchableOpacity style={s.btn} onPress={generatePayment} disabled={loading} activeOpacity={0.85}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnTxt}>{t('buyCredits.newPayment')}</Text>}
          </TouchableOpacity>
        </View>
      ) : (
        /* Pago activo — mostrar instrucciones */
        <View style={s.paymentBox}>
          {/* Monto */}
          <Text style={s.fieldLabel}>{t('buyCredits.sendExactly')}</Text>
          <TouchableOpacity style={s.copyRow} onPress={() => copyToClipboard(payment.amount, 'amount')} activeOpacity={0.75}>
            <Text style={s.amount}>{payment.amount} USDC</Text>
            <View style={s.copyBtn}><Text style={s.copyTxt}>{t('buyCredits.copy')}</Text></View>
          </TouchableOpacity>
          <Text style={s.warning}>⚠️ {t('buyCredits.exactWarning')}</Text>

          {/* Wallet — MEDIO-C21: solo mostrar si pasa validación de formato. */}
          <Text style={[s.fieldLabel, { marginTop: 16 }]}>{t('buyCredits.toAddress')}</Text>
          <TouchableOpacity style={s.copyRow} onPress={() => safeWallet && copyToClipboard(safeWallet, 'wallet')} activeOpacity={0.75}>
            <Text style={s.walletTxt} numberOfLines={1} ellipsizeMode="middle">{safeWallet || '(inválido)'}</Text>
            <View style={s.copyBtn}><Text style={s.copyTxt}>{t('buyCredits.copy')}</Text></View>
          </TouchableOpacity>

          {/* Red */}
          <View style={s.networkBadge}>
            <Text style={s.networkTxt}>🔷 {t('buyCredits.network')}</Text>
          </View>

          {/* Timer */}
          <View style={s.timerRow}>
            <Text style={s.timerLabel}>{t('buyCredits.expiresIn')}</Text>
            <Text style={[s.timerVal, timeLeft < 120000 && { color: '#ff4444' }]}>
              {formatTimer(timeLeft)}
            </Text>
          </View>

          {/* Estado */}
          <View style={s.statusRow}>
            <ActivityIndicator size="small" color="#ffd700" style={{ marginRight: 8 }} />
            <Text style={s.statusTxt}>{t('buyCredits.waiting')}</Text>
          </View>

          <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={generatePayment} disabled={loading} activeOpacity={0.8}>
            <Text style={[s.btnTxt, { color: '#888' }]}>{t('buyCredits.newPayment')}</Text>
          </TouchableOpacity>
        </View>
      )}
      {AlertComponent}
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0a0a0f', padding: 16 },
  infoBox:      { backgroundColor: '#0d1a2e', borderRadius: 12, padding: 12, marginBottom: 16, alignItems: 'center' },
  infoTitle:    { color: '#4a9eff', fontWeight: '800', fontSize: 16 },
  infoSub:      { color: '#666', fontSize: 12, marginTop: 4, textAlign: 'center' },
  centerBox:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  price:        { fontSize: 52, fontWeight: '900', color: '#ffd700' },
  priceCurrency:{ fontSize: 24, color: '#aaa' },
  priceNote:    { color: '#666', fontSize: 13, textAlign: 'center' },
  btn:          { backgroundColor: '#1a3a1a', paddingVertical: 14, paddingHorizontal: 32, borderRadius: 12, alignItems: 'center', minWidth: 200 },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#333', marginTop: 8 },
  btnTxt:       { color: '#5cb85c', fontWeight: '800', fontSize: 15 },
  paymentBox:   { flex: 1 },
  fieldLabel:   { color: '#888', fontSize: 12, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 },
  copyRow:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#12121a', borderRadius: 10, borderWidth: 1, borderColor: '#222', padding: 12, gap: 10 },
  amount:       { flex: 1, color: '#ffd700', fontSize: 22, fontWeight: '900', fontFamily: 'monospace' },
  walletTxt:    { flex: 1, color: '#ccc', fontSize: 12, fontFamily: 'monospace' },
  copyBtn:      { backgroundColor: '#1a1a2e', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  copyTxt:      { color: '#4a9eff', fontSize: 12, fontWeight: '700' },
  warning:      { color: '#ff9944', fontSize: 11, marginTop: 6 },
  networkBadge: { backgroundColor: '#0d1a2e', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start', marginTop: 16 },
  networkTxt:   { color: '#4a9eff', fontSize: 12, fontWeight: '700' },
  timerRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, backgroundColor: '#12121a', borderRadius: 10, padding: 12 },
  timerLabel:   { color: '#888', fontSize: 13 },
  timerVal:     { color: '#fff', fontSize: 20, fontWeight: '900', fontFamily: 'monospace' },
  statusRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  statusTxt:    { color: '#ffd700', fontSize: 14, fontWeight: '700' },
  termsBtn:     { marginTop: 10, alignItems: 'center' },
  termsTxt:     { color: '#444', fontSize: 11, fontWeight: '600', textDecorationLine: 'underline', textAlign: 'center' },
  expiredTxt:   { color: '#ff4444', fontSize: 16, fontWeight: '700' },
  successBox:   { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  successIcon:  { fontSize: 64 },
  successTitle: { color: '#5cb85c', fontSize: 22, fontWeight: '900' },
  successMsg:   { color: '#aaa', fontSize: 15, textAlign: 'center' },
  bonusBox:     { backgroundColor: '#1a1400', borderWidth: 1, borderColor: '#ffd700', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, width: '100%' },
  bonusTxt:     { color: '#ffd700', fontSize: 14, fontWeight: '800', textAlign: 'center' },
});
