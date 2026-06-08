import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert, Image, ActivityIndicator, Switch } from 'react-native';
import { auth, db, storage } from '../firebase/client';
import { createUserWithEmailAndPassword, EmailAuthProvider, linkWithCredential, updateEmail, reauthenticateWithCredential } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import * as ImagePicker from 'expo-image-picker';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { useI18n } from '../utils/i18n';
import { navigate, goBack, navigationRef } from '../utils/navigationRef';

export default function Registration({ asModal = false, onClose }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [birthday, setBirthday] = useState(''); // YYYY-MM-DD
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isAnon, setIsAnon] = useState(true);
  const [accept18, setAccept18] = useState(false);
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [originalEmail, setOriginalEmail] = useState('');
  const [canEditAuthEmail, setCanEditAuthEmail] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const u = auth.currentUser;
        if (!u) return;
        setIsAnon(!!u.isAnonymous);
        const ref = doc(db, 'users', u.uid);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const d = snap.data() || {};
          const p = d.profile || {};
          setAvatarUrl(d.avatarUrl || '');
          setFirstName(p.firstName || '');
          setLastName(p.lastName || '');
          setUsername(p.username || '');
          setBirthday(p.birthday || '');
          setPhone(p.phone || '');
          setAddress(p.address || '');
          setPostalCode(p.postalCode || '');
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

  const onSave = async () => {
    try {
      let u = auth.currentUser;
      if (!u || u.isAnonymous) {
        if (!accept18) { Alert.alert(t('registration.errorTitle'), t('registration.mustAccept18')); return; }
        if (!acceptRisk) { Alert.alert(t('registration.errorTitle'), t('registration.mustAcceptRisk')); return; }
      }
      // Validaciones según estado de autenticación
      if (!u) {
        // Sin sesión: creación completa requiere email y password
        if (!email) {
          Alert.alert(t('registration.needValidEmailTitle'), t('registration.needValidEmailBody'));
          return;
        }
        if (!password || password.length < 6) {
          Alert.alert(t('registration.weakPasswordTitle'), t('registration.weakPasswordBody'));
          return;
        }
        if (password !== confirmPassword) {
          Alert.alert(t('registration.passwordsTitle'), t('registration.passwordsBody'));
          return;
        }
        const credUser = await createUserWithEmailAndPassword(auth, (email || '').trim(), password || '');
        u = credUser.user;
      } else if (u.isAnonymous) {
        // Usuario anónimo: permitir vincular si provee email+password
        if (!email) {
          Alert.alert(t('registration.needValidEmailTitle'), t('registration.needValidEmailBody'));
          return;
        }
        if (!password || password.length < 6) {
          Alert.alert(t('registration.weakPasswordTitle'), t('registration.weakPasswordBody'));
          return;
        }
        if (password !== confirmPassword) {
          Alert.alert(t('registration.passwordsTitle'), t('registration.passwordsBody'));
          return;
        }
        const credential = EmailAuthProvider.credential((email || '').trim(), password);
        const linked = await linkWithCredential(u, credential);
        u = linked.user;
      } else {
        // Usuario ya logueado (no anónimo): no exigir email/clave salvo que quiera CAMBIAR el email de la cuenta
        const wantsChangeEmail = (email || '').trim() !== (originalEmail || '').trim();
        if (wantsChangeEmail) {
          // Requiere reautenticación con su email actual + confirmPassword
          if (!originalEmail) {
            Alert.alert(t('registration.errorTitle'), t('registration.missingOriginalEmail'));
            return;
          }
          if (!confirmPassword) {
            Alert.alert(t('registration.passwordsTitle'), t('registration.confirmPasswordForEmail'));
            return;
          }
          const cred = EmailAuthProvider.credential(originalEmail, confirmPassword);
          try { await reauthenticateWithCredential(u, cred); } catch (e) {
            Alert.alert(t('registration.errorTitle'), t('registration.wrongPassword'));
            return;
          }
          try { await updateEmail(u, (email || '').trim()); } catch (e) {
            Alert.alert(t('registration.errorTitle'), e?.message || 'Could not update email');
            return;
          }
        }
      }

      const ref = doc(db, 'users', u.uid);
      await setDoc(ref, {
        avatarUrl: avatarUrl || null,
        photoURL: avatarUrl || null,
        displayName: `${firstName || ''} ${lastName || ''}`.trim() || null,
        email: email || null,
        profile: {
          firstName: firstName || null,
          lastName: lastName || null,
          username: username || null,
          birthday: birthday || null,
          phone: phone || null,
          address: address || null,
          postalCode: postalCode || null,
          email: email || null,
          updatedAt: serverTimestamp(),
        }
      }, { merge: true });
      Alert.alert(t('registration.savedTitle'), t('registration.savedBody'));
      // Tras guardar, el onAuthStateChanged en RootApp decidirá si muestra Drawer (Home) o sigue en Auth Stack.
      // Para evitar navegar a una ruta que no existe aún, no forzamos navegación a 'Home' aquí.
      // Si el usuario NO quedó autenticado, llevamos a Login explícitamente.
      try {
        const isAuthed = !!auth.currentUser?.uid;
        if (!isAuthed) navigate('Login');
      } catch {}
    } catch (e) {
      console.warn('save profile error', e);
      const msg = (e && (e.message || e.code)) ? `${t('registration.couldNotSave')}\n\n${e.code || ''} ${e.message || ''}`.trim() : t('registration.couldNotSave');
      Alert.alert(t('registration.errorTitle'), msg);
    }
  };

  const ensurePermissions = async () => {
    const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
    const cam = await ImagePicker.requestCameraPermissionsAsync();
    if (lib.status !== 'granted') Alert.alert(t('registration.permissionRequiredTitle'), t('registration.galleryPermissionBody'));
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
      Alert.alert(t('registration.errorTitle'), t('registration.couldNotPickImage'));
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
      Alert.alert(t('registration.errorTitle'), t('registration.couldNotTakePhoto'));
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

  const passwordsMatch = password.length > 0 && password === confirmPassword;

  return (
    <View style={[styles.container, asModal && { backgroundColor: '#000' }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => {
        try {
          const u = auth.currentUser;
          if (u && !u.isAnonymous) {
            // En sesión (Drawer): ir directo a Home, Drawer no mantiene back stack clásico
            navigate('Home');
            return;
          }
          // En Auth stack: volver a Login si hay back, sino navegar explícito
          if (navigationRef?.isReady?.() && navigationRef?.canGoBack?.()) {
            goBack();
          } else {
            navigate('Login');
          }
        } catch {
          navigate('Login');
        }
      }}>
        <Text style={[styles.backTxt, asModal && { color: '#aaa' }]}>{t('registration.back')}</Text>
      </TouchableOpacity>
      <Text style={[styles.title, asModal && { color: '#ddd' }]}>{t('registration.title')}</Text>
      <ScrollView contentContainerStyle={styles.form}>
        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.avatar')}</Text>
        <View style={styles.avatarRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatar} resizeMode="cover" />
              ) : (
                <View style={[styles.avatar, styles.avatarPlaceholder, asModal && { backgroundColor: '#111' }]}>
                  <Text style={{ color: asModal ? '#777' : '#888', fontWeight: '700' }}>{t('registration.noPhoto')}</Text>
                </View>
              )}
            </View>
            {uploading && <ActivityIndicator size="small" color="#0a84ff" />}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={[styles.smallBtn, asModal && { backgroundColor: '#1a1a1a' }]} onPress={pickFromGallery} activeOpacity={0.85}>
              <Text style={[styles.smallBtnTxt, asModal && { color: '#ddd' }]}>{t('registration.gallery')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.smallBtn, asModal && { backgroundColor: '#1a1a1a' }]} onPress={takePhoto} activeOpacity={0.85}>
              <Text style={[styles.smallBtnTxt, asModal && { color: '#ddd' }]}>{t('registration.camera')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.firstName')}</Text>
        <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={firstName} onChangeText={setFirstName} />

        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.lastName')}</Text>
        <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={lastName} onChangeText={setLastName} />

        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.username')}</Text>
        <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={username} onChangeText={setUsername} autoCapitalize="none" placeholder={t('registration.usernamePlaceholder')} placeholderTextColor={asModal ? '#666' : undefined} />

        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.birthday')}</Text>
        <TextInput
          style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]}
          value={birthday}
          onChangeText={onChangeBirthday}
          placeholder={t('registration.birthdayPlaceholder')}
          placeholderTextColor={asModal ? '#666' : undefined}
          keyboardType="number-pad"
          maxLength={10}
        />

        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.phone')}</Text>
        <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />

        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.address')}</Text>
        <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={address} onChangeText={setAddress} />

        <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.postalCode')}</Text>
        <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={postalCode} onChangeText={setPostalCode} keyboardType="numbers-and-punctuation" />

        {/* Email/Password section logic */}
        {isAnon ? (
          <>
            <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.email')}</Text>
            <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
            <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.password')}</Text>
            <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={password} onChangeText={setPassword} secureTextEntry placeholder={t('registration.passwordPlaceholder')} placeholderTextColor={asModal ? '#666' : undefined} />
            <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.confirmPassword')}</Text>
            <View style={styles.rowAlign}>
              <TextInput style={[styles.input, { flex: 1 }, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry />
              <Text style={[styles.matchIcon, passwordsMatch ? styles.matchOk : styles.matchEmpty]}>{passwordsMatch ? '✓' : ''}</Text>
            </View>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
              <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.accountEmail')}</Text>
              <TouchableOpacity style={[styles.smallBtn, asModal && { backgroundColor: '#1a1a1a' }]} onPress={() => setCanEditAuthEmail(v => !v)}>
                <Text style={[styles.smallBtnTxt, asModal && { color: '#ddd' }]}>{canEditAuthEmail ? t('registration.cancel') : t('registration.changeEmail')}</Text>
              </TouchableOpacity>
            </View>
            <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={email} onChangeText={setEmail} editable={canEditAuthEmail} keyboardType="email-address" autoCapitalize="none" />
            {canEditAuthEmail && (
              <>
                <Text style={[styles.label, asModal && { color: '#bbb' }]}>{t('registration.confirmCurrentPassword')}</Text>
                <TextInput style={[styles.input, asModal && { backgroundColor: '#111', borderColor: '#222', color: '#eee' }]} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry />
              </>
            )}
          </>
        )}

        {(!auth.currentUser || auth.currentUser.isAnonymous) && (
          <View style={styles.legalSection}>
            <TouchableOpacity style={styles.checkRow} onPress={() => setAccept18(v => !v)} activeOpacity={0.7}>
              <View style={[styles.checkbox, accept18 && styles.checkboxOn]}>
                {accept18 && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={[styles.checkLabel, asModal && { color: '#ccc' }]}>{t('registration.check18')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.checkRow} onPress={() => setAcceptRisk(v => !v)} activeOpacity={0.7}>
              <View style={[styles.checkbox, acceptRisk && styles.checkboxOn]}>
                {acceptRisk && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={[styles.checkLabel, asModal && { color: '#ccc' }]}>{t('registration.checkRisk')}</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity style={[styles.saveBtn, asModal && { backgroundColor: '#2a2a2a' }]} onPress={onSave} disabled={loading}>
          <Text style={[styles.saveTxt, asModal && { color: '#ddd' }]}>{loading ? t('registration.loading') : t('registration.save')}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  backBtn: { position: 'absolute', top: 40, left: 16, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.06)', zIndex: 2 },
  backTxt: { fontSize: 14, fontWeight: '700', color: '#333' },
  title: { marginTop: 90, fontSize: 20, fontWeight: '800', textAlign: 'center', color: '#222' },
  form: { padding: 16 },
  label: { fontSize: 13, fontWeight: '700', color: '#333', marginTop: 12 },
  input: { marginTop: 6, borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  saveBtn: { marginTop: 18, backgroundColor: '#333333', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  saveTxt: { color: '#ffffff', fontWeight: '800', fontSize: 15 },
  avatar: { width: 100, height: 100, borderRadius: 12, marginTop: 10, alignSelf: 'flex-start', borderWidth: 1, borderColor: 'rgba(0,0,0,0.15)' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.06)' },
  avatarRow: { marginTop: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  smallBtn: { backgroundColor: 'rgba(0,0,0,0.06)', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10 },
  smallBtnTxt: { color: '#111', fontWeight: '800', fontSize: 13 },
  rowAlign: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  matchIcon: { width: 28, textAlign: 'center', fontSize: 18, fontWeight: '900' },
  matchOk: { color: '#22c55e' },
  matchEmpty: { color: 'transparent' },
  legalSection: { marginTop: 20, padding: 14, backgroundColor: '#f8fafc', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', gap: 12 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: '#94a3b8', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  checkboxOn: { backgroundColor: '#1e293b', borderColor: '#1e293b' },
  checkmark: { color: '#fff', fontSize: 13, fontWeight: '900' },
  checkLabel: { flex: 1, fontSize: 12, color: '#334155', lineHeight: 18, fontWeight: '500' },
});
