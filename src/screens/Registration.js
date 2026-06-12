import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Image, ActivityIndicator, Switch, Linking, Modal } from 'react-native';
import { useAppAlert } from '../components/AppAlert';
import { TERMS_URL } from '../constants';
import { auth, db, storage } from '../firebase/client';
import { createUserWithEmailAndPassword, EmailAuthProvider, linkWithCredential, updateEmail, reauthenticateWithCredential, sendEmailVerification, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import * as ImagePicker from 'expo-image-picker';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { useI18n } from '../utils/i18n';
import { navigate, goBack, navigationRef } from '../utils/navigationRef';
import { callSendVerificationEmail, callCheckReferralCode, callApplyReferral, callCheckUsername } from '../firebase/functions';

export default function Registration({ asModal = false, onClose }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [originalUsername, setOriginalUsername] = useState('');
  const [usernameStatus, setUsernameStatus] = useState('idle'); // 'idle'|'checking'|'available'|'taken'|'invalid'
  const usernameDebounceRef = useRef(null);
  const [birthday, setBirthday] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // FIX-P1: inicializar desde auth.currentUser para evitar race en cold-start
  // (si auth se restaura entre el mount y el useEffect, antes quedaba en true).
  const [isAnon, setIsAnon] = useState(() => !auth.currentUser);
  const [accept18, setAccept18] = useState(false);
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [originalEmail, setOriginalEmail] = useState('');
  const [canEditAuthEmail, setCanEditAuthEmail] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [resending, setResending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState({ text: '', type: '' }); // type: 'error' | 'success'
  const [showEmailInUseModal, setShowEmailInUseModal] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const [referralStatus, setReferralStatus] = useState('idle'); // 'idle'|'checking'|'valid'|'invalid'
  const referralDebounceRef = useRef(null);
  const { showAlert, AlertComponent } = useAppAlert();

  useEffect(() => {
    (async () => {
      try {
        const u = auth.currentUser;
        if (!u) return;
        setIsAnon(false); // V1.1.0: sin modo anónimo
        const ref = doc(db, 'users', u.uid);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const d = snap.data() || {};
          const p = d.profile || {};
          setAvatarUrl(d.avatarUrl || '');
          setFirstName(p.firstName || '');
          setLastName(p.lastName || '');
          setUsername(p.username || '');
          setOriginalUsername(p.username || '');
          setBirthday(p.birthday || '');
          setPhone(p.phone || '');
          const initialEmail = p.email || d.email || u.email || '';
          setEmail(initialEmail);
          setOriginalEmail(initialEmail);
        }
      } catch (e) {
        console.warn('load profile error', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const u = username.trim().toLowerCase();
    if (!u) { setUsernameStatus('idle'); return; }
    if (u === originalUsername.toLowerCase()) { setUsernameStatus('available'); return; }
    if (u.length < 3) { setUsernameStatus('invalid'); return; }
    if (!/^[a-z0-9_]+$/.test(u)) { setUsernameStatus('invalid'); return; }
    setUsernameStatus('checking');
    if (usernameDebounceRef.current) clearTimeout(usernameDebounceRef.current);
    usernameDebounceRef.current = setTimeout(async () => {
      try {
        const res = await callCheckUsername(u);
        setUsernameStatus(res?.available ? 'available' : 'taken');
      } catch {
        setUsernameStatus('idle');
      }
    }, 600);
    return () => { if (usernameDebounceRef.current) clearTimeout(usernameDebounceRef.current); };
  }, [username, originalUsername]);

  useEffect(() => {
    const code = referralCode.trim().toUpperCase();
    if (!code) { setReferralStatus('idle'); return; }
    setReferralStatus('checking');
    if (referralDebounceRef.current) clearTimeout(referralDebounceRef.current);
    referralDebounceRef.current = setTimeout(async () => {
      try {
        const res = await callCheckReferralCode(code);
        setReferralStatus(res?.valid ? 'valid' : 'invalid');
      } catch {
        setReferralStatus('invalid');
      }
    }, 600);
    return () => { if (referralDebounceRef.current) clearTimeout(referralDebounceRef.current); };
  }, [referralCode]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      let u = auth.currentUser;
      // V1.1.0: sin modo anónimo. Si !u → signup nuevo (requiere aceptaciones).
      if (!u) {
        if (!accept18) { showAlert(t('registration.errorTitle'), t('registration.mustAccept18')); return; }
        if (!acceptRisk) { showAlert(t('registration.errorTitle'), t('registration.mustAcceptRisk')); return; }
      }

      // Required fields
      if (!firstName.trim() || !lastName.trim() || !username.trim() || !birthday.trim() || !phone.trim()) {
        showAlert(t('registration.requiredFields'), t('registration.requiredFieldsBody'));
        return;
      }
      // Username must be available
      if (usernameStatus === 'taken') {
        showAlert(t('registration.errorTitle'), t('registration.usernameTakenError'));
        return;
      }
      if (usernameStatus === 'invalid') {
        showAlert(t('registration.errorTitle'), t('registration.usernameInvalidChars'));
        return;
      }

      // Validaciones según estado de autenticación
      if (!u) {
        // Sin sesión: creación completa requiere email y password
        if (!email) {
          showAlert(t('registration.needValidEmailTitle'), t('registration.needValidEmailBody'));
          return;
        }
        if (!password || password.length < 6) {
          showAlert(t('registration.weakPasswordTitle'), t('registration.weakPasswordBody'));
          return;
        }
        if (password !== confirmPassword) {
          showAlert(t('registration.passwordsTitle'), t('registration.passwordsBody'));
          return;
        }
        const credUser = await createUserWithEmailAndPassword(auth, (email || '').trim(), password || '');
        u = credUser.user;
        try { await callSendVerificationEmail(); } catch { try { await sendEmailVerification(u); } catch {} }
      } else {
        // Usuario ya logueado (no anónimo): no exigir email/clave salvo que quiera CAMBIAR el email de la cuenta
        const wantsChangeEmail = (email || '').trim() !== (originalEmail || '').trim();
        if (wantsChangeEmail) {
          // Requiere reautenticación con su email actual + confirmPassword
          const effectiveOriginalEmail = originalEmail || u.email || '';
          if (!effectiveOriginalEmail) {
            showAlert(t('registration.errorTitle'), t('registration.missingOriginalEmail'));
            return;
          }
          if (!confirmPassword) {
            showAlert(t('registration.passwordsTitle'), t('registration.confirmPasswordForEmail'));
            return;
          }
          const cred = EmailAuthProvider.credential(effectiveOriginalEmail, confirmPassword);
          try { await reauthenticateWithCredential(u, cred); } catch (e) {
            showAlert(t('registration.errorTitle'), t('registration.wrongPassword'));
            return;
          }
          try { await updateEmail(u, (email || '').trim()); } catch (e) {
            showAlert(t('registration.errorTitle'), e?.message || 'Could not update email');
            return;
          }
        }
      }

      const wasNewAccount = isAnon; // anon user just linked → new account
      const userDocRef = doc(db, 'users', u.uid);
      const profileData = {
        avatarUrl: avatarUrl || null,
        photoURL: avatarUrl || null,
        displayName: `${firstName || ''} ${lastName || ''}`.trim() || null,
        email: email || null,
        profile: {
          firstName: firstName || null,
          lastName: lastName || null,
          username: username.trim() || null,
          birthday: birthday || null,
          phone: phone || null,
          email: email || null,
          updatedAt: serverTimestamp(),
        },
      };
      // FIX-P1: wallet ya no se escribe desde cliente — backend usa Admin SDK.
      // Las Firestore rules bloquean 'wallet'/'stats' fuera del whitelist.
      await setDoc(userDocRef, profileData, { merge: true });

      // Claim username in usernames collection
      const unameLower = username.trim().toLowerCase();
      if (unameLower) {
        try {
          // Release old username if changed
          if (originalUsername && originalUsername.toLowerCase() !== unameLower) {
            await deleteDoc(doc(db, 'usernames', originalUsername.toLowerCase())).catch(() => {});
          }
          await setDoc(doc(db, 'usernames', unameLower), { uid: u.uid, updatedAt: serverTimestamp() });
          setOriginalUsername(username.trim());
        } catch {}
      }

      // Aplicar código de referido si se ingresó uno válido en una cuenta nueva
      if (wasNewAccount && referralCode.trim() && referralStatus === 'valid') {
        try { await callApplyReferral(referralCode.trim().toUpperCase()); } catch {}
      }

      if (wasNewAccount) {
        setVerifyMsg({ text: '', type: '' });
        setShowVerifyModal(true);
      } else {
        const goHome = () => {
          try {
            const u = auth.currentUser;
            if (u) {
              navigate('ServerList');
            } else {
              navigate('Login');
            }
          } catch { navigate('Login'); }
        };
        showAlert(t('registration.savedTitle'), t('registration.savedBody'), [
          { text: 'OK', onPress: goHome },
        ]);
      }
    } catch (e) {
      console.warn('save profile error', e);
      const code = e?.code || '';
      let msg;
      if (code === 'auth/email-already-in-use') {
        setShowEmailInUseModal(true);
        return;
      } else if (code === 'auth/weak-password') {
        msg = t('registration.weakPasswordBody');
      } else if (code === 'auth/invalid-email') {
        msg = t('registration.needValidEmailBody');
      } else {
        msg = (e && (e.message || code)) ? `${t('registration.couldNotSave')}\n\n${code} ${e.message || ''}`.trim() : t('registration.couldNotSave');
      }
      showAlert(t('registration.errorTitle'), msg);
    } finally {
      setSaving(false);
    }
  };

  const ensurePermissions = async () => {
    const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
    const cam = await ImagePicker.requestCameraPermissionsAsync();
    if (lib.status !== 'granted') showAlert(t('registration.permissionRequiredTitle'), t('registration.galleryPermissionBody'));
    if (cam.status !== 'granted') console.log(t('registration.cameraPermissionLog'));
  };

  const uploadImageAsync = async (uri) => {
    try {
      setUploading(true);
      const u = auth.currentUser;
      if (!u) throw new Error('No auth user');
      const res = await fetch(uri);
      const blob = await res.blob();
      const filename = `avatars/${u.uid}_${Date.now()}.jpg`;
      const storageRef = ref(storage, filename);
      await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
      const url = await getDownloadURL(storageRef);
      setAvatarUrl(url);
      return url;
    } finally {
      setUploading(false);
    }
  };

  const pickFromGallery = async () => {
    try {
      await ensurePermissions();
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        await uploadImageAsync(uri);
      }
    } catch (e) {
      console.warn('gallery pick error', e);
      showAlert(t('registration.errorTitle'), t('registration.couldNotPickImage'));
    }
  };

  const takePhoto = async () => {
    try {
      await ensurePermissions();
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        await uploadImageAsync(uri);
      }
    } catch (e) {
      console.warn('camera error', e);
      showAlert(t('registration.errorTitle'), t('registration.couldNotTakePhoto'));
    }
  };

  // Autoformateo DD/MM/YYYY
  const onChangeBirthday = (val) => {
    const digits = (val || '').replace(/\D+/g, '');
    let d = digits.substring(0, 8);
    let out = '';
    if (d.length <= 2) out = d;
    else if (d.length <= 4) out = `${d.slice(0,2)}/${d.slice(2)}`;
    else out = `${d.slice(0,2)}/${d.slice(2,4)}/${d.slice(4)}`;
    setBirthday(out);
  };

  const handleResend = async () => {
    try {
      setResending(true);
      try {
        await callSendVerificationEmail();
      } catch {
        const u = auth.currentUser;
        if (u) await sendEmailVerification(u);
      }
      setVerifyMsg({
        text: t('registration.verifyResent') || 'Email reenviado. Revisá tu bandeja.',
        type: 'success',
      });
    } catch (e) {
      const code = e?.code || e?.message || '';
      let msg;
      if (code.includes('too-many-requests')) {
        msg = t('registration.tooManyRequests') || 'Demasiados intentos. Esperá unos minutos antes de reintentar.';
      } else {
        msg = e?.message || 'Error al reenviar';
      }
      setVerifyMsg({ text: msg, type: 'error' });
    } finally {
      setResending(false);
    }
  };

  const handleGoToLogin = async () => {
    try {
      setVerifying(true);
      const u = auth.currentUser;
      if (u) {
        await u.reload();
        const currentUser = auth.currentUser;
        if (currentUser && !currentUser.emailVerified) {
          setVerifyMsg({
            text: t('registration.notVerifiedYet') || 'Todavía no verificaste el email. Revisá tu bandeja y hacé click en el link.',
            type: 'error',
          });
          return;
        }
      }
      // Cerrar modales y limpiar estado
      setShowVerifyModal(false);
      if (onClose) { try { onClose(); } catch {} }
      await signOut(auth);
      // App.js recibe el onAuthStateChanged (user=null) y
      // monta el stack de Login. Esperamos un tick para que la transición
      // de stack esté estable antes de hacer el reset de navegación.
      setTimeout(() => {
        try {
          if (navigationRef.isReady()) {
            navigationRef.reset({ index: 0, routes: [{ name: 'Login' }] });
          }
        } catch {}
      }, 150);
    } catch (e) {
      showAlert(t('registration.errorTitle'), e?.message || 'Error');
    } finally {
      setVerifying(false);
    }
  };

  const passwordsMatch = password.length > 0 && password === confirmPassword;

  return (
    <View style={styles.container}>
      {!asModal && <TouchableOpacity style={styles.backBtn} onPress={() => {
        try {
          const u = auth.currentUser;
          if (u) {
            navigate('Home');
            return;
          }
          if (navigationRef?.isReady?.() && navigationRef?.canGoBack?.()) {
            goBack();
          } else {
            navigate('Login');
          }
        } catch {
          navigate('Login');
        }
      }}>
        <Text style={styles.backTxt}>{t('registration.back')}</Text>
      </TouchableOpacity>}
      <Text style={[styles.title, asModal && { marginTop: 0 }]}>{t('registration.title')}</Text>
      <ScrollView nestedScrollEnabled contentContainerStyle={styles.form}>
        <Text style={styles.label}>{t('registration.avatar')}</Text>
        <View style={styles.avatarRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatar} resizeMode="cover" />
              ) : (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <Text style={{ color: '#888', fontWeight: '700' }}>{t('registration.noPhoto')}</Text>
                </View>
              )}
            </View>
            {uploading && <ActivityIndicator size="small" color="#0a84ff" />}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={styles.smallBtn} onPress={pickFromGallery} activeOpacity={0.85}>
              <Text style={styles.smallBtnTxt}>{t('registration.gallery')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.smallBtn} onPress={takePhoto} activeOpacity={0.85}>
              <Text style={styles.smallBtnTxt}>{t('registration.camera')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={styles.label}>{t('registration.firstName')}</Text>
        <TextInput style={styles.input} value={firstName} onChangeText={setFirstName} placeholderTextColor="#555" />

        <Text style={styles.label}>{t('registration.lastName')}</Text>
        <TextInput style={styles.input} value={lastName} onChangeText={setLastName} placeholderTextColor="#555" />

        <Text style={styles.label}>{t('registration.username')}</Text>
        <View style={styles.rowAlign}>
          <TextInput style={[styles.input, { flex: 1 }]} value={username} onChangeText={setUsername} autoCapitalize="none" placeholder={t('registration.usernamePlaceholder')} placeholderTextColor="#555" />
          <Text style={[styles.matchIcon, usernameStatus === 'available' ? styles.matchOk : (usernameStatus === 'taken' || usernameStatus === 'invalid') ? styles.matchBad : styles.matchEmpty]}>
            {usernameStatus === 'available' ? '✓' : (usernameStatus === 'taken' || usernameStatus === 'invalid') ? '✗' : usernameStatus === 'checking' ? '…' : ''}
          </Text>
        </View>
        {usernameStatus === 'available' && username.trim() && (
          <Text style={styles.referralValidMsg}>{t('registration.usernameAvailable')}</Text>
        )}
        {usernameStatus === 'taken' && (
          <Text style={styles.referralInvalidMsg}>{t('registration.usernameTaken')}</Text>
        )}
        {usernameStatus === 'invalid' && username.trim() && (
          <Text style={styles.referralInvalidMsg}>{t('registration.usernameInvalidChars')}</Text>
        )}

        <Text style={styles.label}>{t('registration.birthday')}</Text>
        <TextInput
          style={styles.input}
          value={birthday}
          onChangeText={onChangeBirthday}
          placeholder={t('registration.birthdayPlaceholder')}
          placeholderTextColor="#555"
          keyboardType="number-pad"
          maxLength={10}
        />

        <Text style={styles.label}>{t('registration.phone')}</Text>
        <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholderTextColor="#555" />

        {/* Email/Password section logic */}
        {isAnon ? (
          <>
            <Text style={styles.label}>{t('registration.email')}</Text>
            <TextInput style={styles.input} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#555" />
            <Text style={styles.label}>{t('registration.password')}</Text>
            <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder={t('registration.passwordPlaceholder')} placeholderTextColor="#555" />
            <Text style={styles.label}>{t('registration.confirmPassword')}</Text>
            <View style={styles.rowAlign}>
              <TextInput style={[styles.input, { flex: 1 }]} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry placeholderTextColor="#555" />
              <Text style={[styles.matchIcon, passwordsMatch ? styles.matchOk : styles.matchEmpty]}>{passwordsMatch ? '✓' : ''}</Text>
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
              <Text style={styles.label}>{t('registration.accountEmail')}</Text>
              <TouchableOpacity style={styles.smallBtn} onPress={() => setCanEditAuthEmail(v => !v)}>
                <Text style={styles.smallBtnTxt}>{canEditAuthEmail ? t('registration.cancel') : t('registration.changeEmail')}</Text>
              </TouchableOpacity>
            </View>
            <TextInput style={styles.input} value={email} onChangeText={setEmail} editable={canEditAuthEmail} keyboardType="email-address" autoCapitalize="none" placeholderTextColor="#555" />
            {canEditAuthEmail && (
              <>
                <Text style={styles.label}>{t('registration.confirmCurrentPassword')}</Text>
                <TextInput style={styles.input} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry placeholderTextColor="#555" />
              </>
            )}
          </>
        )}

        {/* Referral code — solo para cuentas nuevas */}
        {isAnon && (
          <View style={styles.referralSection}>
            <Text style={styles.label}>{t('registration.referralCodeLabel')}</Text>
            <View style={styles.rowAlign}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={referralCode}
                onChangeText={v => setReferralCode(v.toUpperCase())}
                placeholder={t('registration.referralCodePlaceholder')}
                placeholderTextColor="#555"
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={10}
              />
              <Text style={[styles.matchIcon, referralStatus === 'valid' ? styles.matchOk : (referralStatus === 'invalid' ? styles.matchBad : styles.matchEmpty)]}>
                {referralStatus === 'valid' ? '✓' : referralStatus === 'invalid' ? '✗' : referralStatus === 'checking' ? '…' : ''}
              </Text>
            </View>
            {referralStatus === 'valid' && (
              <Text style={styles.referralValidMsg}>{t('registration.referralCodeValid')}</Text>
            )}
            {referralStatus === 'invalid' && referralCode.trim().length > 0 && (
              <Text style={styles.referralInvalidMsg}>{t('registration.referralCodeInvalid')}</Text>
            )}
          </View>
        )}

        {!auth.currentUser && (
          <View style={styles.legalSection}>
            <TouchableOpacity style={styles.checkRow} onPress={() => setAccept18(v => !v)} activeOpacity={0.7}>
              <View style={[styles.checkbox, accept18 && styles.checkboxOn]}>
                {accept18 && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={styles.checkLabel}>{t('registration.check18')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.checkRow} onPress={() => setAcceptRisk(v => !v)} activeOpacity={0.7}>
              <View style={[styles.checkbox, acceptRisk && styles.checkboxOn]}>
                {acceptRisk && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={styles.checkLabel}>{t('registration.checkRisk')}</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL).catch(() => {})} style={styles.termsLinkBtn}>
          <Text style={styles.termsLinkTxt}>{t('registration.viewTerms')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.saveBtn, (loading || saving) && { opacity: 0.6 }]}
          onPress={onSave}
          disabled={loading || saving}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.saveTxt}>{loading ? t('registration.loading') : t('registration.save')}</Text>
          }
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Email already in use modal */}
      <Modal visible={showEmailInUseModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('registration.errorTitle')}</Text>
            <Text style={styles.modalBody}>{t('registration.emailInUse')}</Text>
            <Text style={styles.modalEmail}>{email}</Text>

            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnPrimary, { marginTop: 12 }]}
              onPress={() => { setShowEmailInUseModal(false); navigate('Login'); }}
              activeOpacity={0.85}
            >
              <Text style={styles.modalBtnTxt}>{t('registration.goToLogin') || 'Ir a Login'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnSecondary]}
              onPress={() => setShowEmailInUseModal(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.modalBtnTxtSecondary}>{t('registration.cancel') || 'Cancelar'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {AlertComponent}

      <Modal visible={showVerifyModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>{t('registration.verifyEmailTitle')}</Text>
            <Text style={styles.modalBody}>{t('registration.verifyEmailBody')}</Text>
            <Text style={styles.modalEmail}>{email}</Text>
            <Text style={styles.modalHint}>{t('registration.canLoginFromApp')}</Text>

            {Boolean(verifyMsg.text) && (
              <View style={[styles.verifyMsgBox, verifyMsg.type === 'error' ? styles.verifyMsgError : styles.verifyMsgSuccess]}>
                <Text style={[styles.verifyMsgTxt, verifyMsg.type === 'error' ? styles.verifyMsgTxtError : styles.verifyMsgTxtSuccess]}>
                  {verifyMsg.type === 'error' ? '✕ ' : '✓ '}{verifyMsg.text}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnPrimary]}
              onPress={handleGoToLogin}
              disabled={verifying}
            >
              {verifying
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.modalBtnTxt}>{t('registration.goToLogin')}</Text>
              }
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalBtn, styles.modalBtnSecondary]}
              onPress={handleResend}
              disabled={resending}
            >
              {resending
                ? <ActivityIndicator color="#aaa" />
                : <Text style={styles.modalBtnTxtSecondary}>{t('registration.resendEmail') || 'Reenviar email'}</Text>
              }
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.modalBtnEdit}
              onPress={() => setShowVerifyModal(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.modalBtnEditTxt}>✏️ {t('registration.editEmail') || 'Editar email'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  backBtn: { position: 'absolute', top: 40, left: 16, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333', zIndex: 2 },
  backTxt: { fontSize: 14, fontWeight: '700', color: '#888' },
  title: { marginTop: 90, fontSize: 20, fontWeight: '900', textAlign: 'center', color: '#fff' },
  form: { padding: 16 },
  label: { fontSize: 13, fontWeight: '700', color: '#888', marginTop: 12 },
  input: { marginTop: 6, borderWidth: 1, borderColor: '#222', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: '#111', color: '#eee' },
  termsLinkBtn: { marginTop: 10, alignItems: 'center', paddingVertical: 6 },
  termsLinkTxt: { color: '#4a9eff', fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  saveBtn: { marginTop: 10, backgroundColor: '#1a2a0a', paddingVertical: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#2e7d32' },
  saveTxt: { color: '#5cb85c', fontWeight: '900', fontSize: 15 },
  avatar: { width: 100, height: 100, borderRadius: 12, marginTop: 10, alignSelf: 'flex-start', borderWidth: 1, borderColor: '#333' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  avatarRow: { marginTop: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  smallBtn: { backgroundColor: '#1a1a1a', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: '#333' },
  smallBtnTxt: { color: '#ccc', fontWeight: '800', fontSize: 13 },
  rowAlign: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  matchIcon: { width: 28, textAlign: 'center', fontSize: 18, fontWeight: '900' },
  matchOk: { color: '#22c55e' },
  matchBad: { color: '#e57373' },
  matchEmpty: { color: 'transparent' },
  referralSection: { marginTop: 8 },
  referralValidMsg: { color: '#22c55e', fontSize: 12, fontWeight: '700', marginTop: 4, lineHeight: 16 },
  referralInvalidMsg: { color: '#e57373', fontSize: 12, fontWeight: '700', marginTop: 4 },
  legalSection: { marginTop: 20, padding: 14, backgroundColor: '#111', borderRadius: 10, borderWidth: 1, borderColor: '#222', gap: 12 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: '#444', backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  checkboxOn: { backgroundColor: '#ffd700', borderColor: '#ffd700' },
  checkmark: { color: '#000', fontSize: 13, fontWeight: '900' },
  checkLabel: { flex: 1, fontSize: 12, color: '#aaa', lineHeight: 18, fontWeight: '500' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalBox: { backgroundColor: '#111', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#222' },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '900', textAlign: 'center' },
  modalBody: { color: '#888', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  modalEmail: { color: '#ffd700', fontSize: 15, fontWeight: '800', textAlign: 'center', fontFamily: 'monospace' },
  modalBtn: { width: '100%', paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  modalBtnPrimary: { backgroundColor: '#1a2a0a', borderWidth: 1, borderColor: '#2e7d32' },
  modalBtnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#333' },
  modalBtnTxt: { color: '#5cb85c', fontWeight: '900', fontSize: 15 },
  modalBtnTxtSecondary: { color: '#888', fontWeight: '700', fontSize: 14 },
  modalHint: { color: '#22c55e', fontSize: 13, textAlign: 'center', lineHeight: 18, fontWeight: '600', marginTop: 4 },
  modalBtnEdit: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 16, alignSelf: 'center' },
  modalBtnEditTxt: { color: '#444', fontWeight: '600', fontSize: 12 },
  verifyMsgBox: { width: '100%', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, marginTop: 4 },
  verifyMsgError: { backgroundColor: '#1a0505', borderColor: '#4a1515' },
  verifyMsgSuccess: { backgroundColor: '#061a08', borderColor: '#1a4a1a' },
  verifyMsgTxt: { fontSize: 13, fontWeight: '700', textAlign: 'center', lineHeight: 18 },
  verifyMsgTxtError: { color: '#ff6666' },
  verifyMsgTxtSuccess: { color: '#5cb85c' },
});
