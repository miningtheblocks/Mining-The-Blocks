import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, Image, Linking } from 'react-native';

const TERMS_URL = 'https://miningtheblocks.github.io/Mining-The-Blocks/terms.html';
import { auth, db } from '../firebase/client';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { useI18n } from '../utils/i18n';
import { navigate } from '../utils/navigationRef';

export default function Subscribe({ asModal = false, onClose }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const ensureUserDoc = async (uid) => {
    try {
      await setDoc(doc(db, 'users', uid), { createdAt: serverTimestamp() }, { merge: true });
    } catch {}
  };

  const onLogin = async () => {
    if (!email || !password) {
      Alert.alert(t('subscribe.requiredFieldsTitle'), t('subscribe.requiredFieldsBody'));
      return;
    }
    setLoading(true);
    try {
      const res = await signInWithEmailAndPassword(auth, email.trim(), password);
      await ensureUserDoc(res.user.uid);
      Alert.alert(t('subscribe.doneTitle'), t('subscribe.signInTitle'));
    } catch (e) {
      Alert.alert(t('subscribe.errorTitle'), e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Image source={require('../../assets/icon.png')} style={styles.icon} />
      <Text style={styles.title}>{t('subscribe.signInTitle')}</Text>
      <TextInput
        style={styles.input}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder={t('subscribe.emailPlaceholder')}
        placeholderTextColor="#888"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        secureTextEntry
        placeholder={t('subscribe.passwordPlaceholder')}
        placeholderTextColor="#888"
        value={password}
        onChangeText={setPassword}
      />
      <TouchableOpacity style={[styles.btn, styles.primary]} onPress={onLogin} disabled={loading}>
        <Text style={styles.btnTxt}>{loading ? '...' : t('subscribe.signInBtn')}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.btn, styles.registerBtn]} onPress={() => { if (asModal && onClose) onClose(); navigate('Registration'); }} disabled={loading}>
        <Text style={styles.btnTxt}>{t('subscribe.registerBtn')}</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>{t('subscribe.hint')}</Text>
      <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL).catch(() => {})} style={styles.termsBtn}>
        <Text style={styles.termsTxt}>{t('common.termsLink')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 20, paddingTop: 60 },
  icon: { width: 80, height: 80, borderRadius: 16, alignSelf: 'center', marginBottom: 12 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 20, textAlign: 'center' },
  input: { backgroundColor: '#111', color: '#fff', padding: 12, borderRadius: 8, marginBottom: 12 },
  btn: { padding: 12, borderRadius: 8, alignItems: 'center', marginBottom: 12 },
  primary: { backgroundColor: '#2e7d32' },
  registerBtn: { backgroundColor: '#333333' },
  btnTxt: { color: '#fff', fontWeight: '700' },
  hint: { color: '#aaa', marginTop: 12 },
  termsBtn: { marginTop: 20, alignItems: 'center' },
  termsTxt: { color: '#555', fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
});
