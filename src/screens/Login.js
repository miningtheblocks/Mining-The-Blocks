import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch, TextInput, Image } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useOverlayModals } from '../components/OverlayModalsProvider';
import { auth, db } from '../firebase/client';
import { doc, setDoc } from 'firebase/firestore';
import { signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, signOut } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useI18n } from '../utils/i18n';
import { StorageKeys } from '../constants';

export default function Login() {
  const navigation = useNavigation && typeof useNavigation === 'function' ? useNavigation() : null;
  const { t, language, setLanguage } = useI18n();
  const { openModal } = useOverlayModals();
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showResend, setShowResend] = useState(false);
  const errorTimerRef = useRef(null);
  const isValid = (email || '').trim().length > 0 && (password || '').length > 0;

  // Utilidad para mostrar error con estética propia (banner)
  const showError = (msg) => {
    try { if (errorTimerRef.current) { clearTimeout(errorTimerRef.current); errorTimerRef.current = null; } } catch {}
    setErrorMsg(String(msg || ''));
    errorTimerRef.current = setTimeout(() => { setErrorMsg(''); }, 4000);
  };
  useEffect(() => () => { try { if (errorTimerRef.current) clearTimeout(errorTimerRef.current); } catch {} }, []);

  const onEmailLogin = async () => {
    try {
      setLoading(true);
      if (!email || !password) {
        showError(t('login.missingDataBody'));
        return;
      }
      const creds = await signInWithEmailAndPassword(auth, email.trim(), password);
      const u = creds?.user || auth.currentUser;
      if (u && !u.emailVerified) {
        showError(t('login.emailNotVerified'));
        setShowResend(true);
        await signOut(auth);
        return;
      }
      setShowResend(false);
      // Persist "keep signed in" preference locally so App.js can enforce it on cold start
      await AsyncStorage.setItem(StorageKeys.KEEP_SIGNED_IN, remember ? '1' : '0');
      try {
        if (u?.uid) {
          const ref = doc(db, 'users', u.uid);
          await setDoc(ref, { settings: { keepSignedIn: !!remember } }, { merge: true });
        }
      } catch {}
    } catch (e) {
      console.warn('email login error', e);
      const code = e?.code || '';
      const friendly =
        code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential'
          ? t('login.genericLogin')
          : code === 'auth/too-many-requests'
          ? t('registration.tooManyRequests')
          : code === 'auth/network-request-failed'
          ? t('login.offline')
          : e?.message || t('login.genericLogin');
      showError(friendly);
    } finally {
      setLoading(false);
    }
  };

  // ALTO-44: NO re-loguear con email+password para reenviar verificación.
  // Antes hacía signIn → sendVerification → signOut lo que:
  //   1. Gastaba un intento de login (puede triggear too-many-attempts).
  //   2. Filtraba 'auth/wrong-password' al UI si las credenciales estaban mal.
  //   3. Permitía a un atacante con credenciales válidas spamear emails.
  // Ahora usamos la Cloud Function `sendVerificationEmail` que requiere
  // sesión iniciada o un flow distinto. Si no hay user activo, mostramos
  // mensaje neutro para no enumerar emails.
  const resendVerification = async () => {
    try {
      setLoading(true);
      if (!auth.currentUser) {
        showError(t('login.verificationResent'));
        return;
      }
      try {
        const { callSendVerificationEmail } = await import('../firebase/functions');
        await callSendVerificationEmail();
      } catch (cfErr) {
        // Fallback al método SDK directo si la CF falla.
        try { await sendEmailVerification(auth.currentUser); } catch {}
      }
      showError(t('login.verificationResent'));
    } catch (e) {
      try { (await import('../utils/logError')).default('Login.resendVerification', e); } catch {}
      // Mensaje neutro al usuario (no leak de auth/wrong-password etc.)
      showError(t('login.verificationResent'));
    } finally {
      setLoading(false);
    }
  };



  return (
    <View style={styles.container}>
      {/* Language toggle pill */}
      <View style={styles.langRow}>
        <TouchableOpacity
          style={[styles.langBtn, language === 'en' && styles.langBtnActive]}
          onPress={() => setLanguage('en')}
          activeOpacity={0.85}
        >
          <Text style={[styles.langTxt, language === 'en' && styles.langTxtActive]}>{t('config.english')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.langBtn, language === 'es' && styles.langBtnActive]}
          onPress={() => setLanguage('es')}
          activeOpacity={0.85}
        >
          <Text style={[styles.langTxt, language === 'es' && styles.langTxtActive]}>{t('config.spanish')}</Text>
        </TouchableOpacity>
      </View>
      {/* Logo */}
      <Image source={require('../../assets/icon.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.title}>{t('login.signIn')}</Text>

      {/* Email */}
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder={t('login.email')}
        placeholderTextColor="#555"
        autoCapitalize="none"
        keyboardType="email-address"
        textContentType="emailAddress"
      />

      {/* Password */}
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder={t('login.password')}
        placeholderTextColor="#555"
        secureTextEntry
        textContentType="password"
      />

      {/* Remember switch */}
      <View style={[styles.rowBetween, { marginTop: 0, marginBottom: 6 }]}>
        <Text style={styles.label}>{t('login.keepSignedIn')}</Text>
        <Switch
          value={remember}
          onValueChange={setRemember}
          trackColor={{ false: '#1a1a1a', true: '#1a2a0a' }}
          thumbColor={remember ? '#5cb85c' : '#444'}
        />
      </View>

      {/* Error banner con estética de la app */}
      {Boolean(errorMsg) && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      )}
      {showResend && (
        <TouchableOpacity style={styles.resendBtn} onPress={resendVerification} activeOpacity={0.85}>
          <Text style={styles.resendTxt}>{t('login.resendVerification')}</Text>
        </TouchableOpacity>
      )}

      {/* Sign In */}
      <TouchableOpacity
        style={[styles.primaryBtn, isValid ? styles.primaryBtnEnabled : styles.primaryBtnDisabled, { paddingVertical: 20 }]}
        onPress={onEmailLogin}
        activeOpacity={isValid ? 0.85 : 1}
        disabled={loading || !isValid}
      >
        <Text style={[styles.primaryTxt, isValid ? styles.primaryTxtEnabled : styles.primaryTxtDisabled]}>
          {loading ? t('login.signingIn') : t('login.signIn')}
        </Text>
      </TouchableOpacity>

      {/* Forgot password */}
      <TouchableOpacity
        style={{ alignSelf: 'center', marginTop: 8 }}
        onPress={async () => {
          // ALTO-45: NO distinguir entre éxito y "user-not-found" para
          // evitar user enumeration. SIEMPRE mostramos el mismo mensaje
          // genérico "si existe la cuenta, te enviamos el email".
          const em = (email || '').trim();
          if (!em) {
            showError(t('login.emailRequiredBody'));
            return;
          }
          try {
            await sendPasswordResetEmail(auth, em);
          } catch (e) {
            try { (await import('../utils/logError')).default('Login.forgot', e); } catch {}
            // No re-throw — silenciamos al usuario.
          }
          showError(t('login.emailSentBody'));
        }}
        activeOpacity={0.8}
      >
        <Text style={styles.forgotTxt}>{t('login.forgot')}</Text>
      </TouchableOpacity>

      {/* Create Account (gris oscuro con letras #666) */}
      <TouchableOpacity style={styles.createBtn} onPress={() => navigation?.navigate('Registration')} activeOpacity={0.85}>
        <Text style={styles.createTxt}>{t('login.createAccount')}</Text>
      </TouchableOpacity>

      {/* Report Problem */}
      <TouchableOpacity
        style={styles.reportBtn}
        onPress={() => openModal('report')}
        activeOpacity={0.8}
      >
        <Text style={styles.reportTxt}>⚠ {t('login.report')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', paddingTop: 100, paddingHorizontal: 16 },
  langRow: { position: 'absolute', top: 40, right: 16, flexDirection: 'row', gap: 8 },
  langBtn: { backgroundColor: '#1a1a1a', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: '#333' },
  langBtnActive: { backgroundColor: '#1a1400', borderColor: '#ffd700' },
  langTxt: { color: '#666', fontWeight: '800', fontSize: 12 },
  langTxtActive: { color: '#ffd700' },
  logo: { width: 140, height: 140, alignSelf: 'center', marginBottom: 12, borderRadius: 70, overflow: 'hidden' },
  title: { fontSize: 22, fontWeight: '800', textAlign: 'center', color: '#fff', marginBottom: 16 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 16, fontWeight: '800', color: '#888' },
  input: { marginTop: 10, borderWidth: 1, borderColor: '#222', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: '#111', color: '#eee' },
  primaryBtn: { borderRadius: 10, paddingVertical: 16, alignItems: 'center', marginTop: 6, borderWidth: 1 },
  primaryBtnEnabled: { backgroundColor: '#1a2a0a', borderColor: '#2e7d32' },
  primaryBtnDisabled: { backgroundColor: '#111', borderColor: '#1a1a1a' },
  primaryTxt: { fontWeight: '800', fontSize: 16 },
  primaryTxtEnabled: { color: '#5cb85c' },
  primaryTxtDisabled: { color: '#333' },
  errorBox: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#331111',
    borderColor: '#662222',
    borderWidth: 1,
    borderRadius: 10,
    alignSelf: 'stretch',
  },
  errorText: { color: '#ff6666', fontWeight: '800', fontSize: 13, textAlign: 'center' },
  createBtn: { marginTop: 12, backgroundColor: '#111', borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#1e1e1e' },
  createTxt: { color: '#888', fontWeight: '800', fontSize: 14 },
  forgotTxt: { color: '#555', fontWeight: '700', fontSize: 13 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 6 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#1e1e1e' },
  dividerTxt: { color: '#444', fontWeight: '700', fontSize: 12, marginHorizontal: 8 },
  guestNote: { color: '#555', fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 6 },
  guestBtn: { marginTop: 4, backgroundColor: '#1a1a1a', borderRadius: 10, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  guestTxt: { color: '#888', fontWeight: '700', fontSize: 14 },
  resendBtn: { marginTop: 6, backgroundColor: '#221111', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: '#442222' },
  resendTxt: { color: '#ff8866', fontWeight: '700', fontSize: 13 },
  reportBtn: { marginTop: 20, alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16 },
  reportTxt: { color: '#444', fontWeight: '700', fontSize: 13 },
});
