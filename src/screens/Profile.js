import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, TextInput, Share } from 'react-native';
import { useAppAlert } from '../components/AppAlert';
import { auth, db } from '../firebase/client';
import { navigate } from '../utils/navigationRef';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { useI18n } from '../utils/i18n';
import { useOverlayModals } from '../components/OverlayModalsProvider';
import { callApplyReferral, callSetUserWallet } from '../firebase/functions';
import { logError } from '../utils/logError';

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export default function Profile({ asModal = false, onClose }) {
  const { t } = useI18n();
  const { openModal } = useOverlayModals();
  const { showAlert, AlertComponent } = useAppAlert();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [walletInput, setWalletInput] = useState('');
  const [savingWallet, setSavingWallet] = useState(false);
  const [referralInput, setReferralInput] = useState('');
  const [applyingReferral, setApplyingReferral] = useState(false);

  useEffect(() => {
    const u = auth.currentUser;
    if (!u) { setLoading(false); return; }
    const ref = doc(db, 'users', u.uid);
    const unsub = onSnapshot(ref, (snap) => {
      const d = snap.exists() ? snap.data() : null;
      setData(d);
      setWalletInput(d?.walletAddress || '');
      setLoading(false);
    }, () => setLoading(false));
    return () => unsub();
  }, []);

  const shareReferralCode = async () => {
    const code = data?.referralCode;
    if (!code) return;
    const url = `https://miningtheblocks.github.io/Mining-The-Blocks/?ref=${code}`;
    const msg = t('profile.referralShareMsg').replace('{code}', code).replace('{url}', url);
    try {
      await Share.share({ message: msg });
    } catch {}
  };

  const applyReferral = async () => {
    const code = referralInput.trim().toUpperCase();
    if (!code) return;
    setApplyingReferral(true);
    try {
      await callApplyReferral(code);
      showAlert(t('profile.referralAppliedTitle'), t('profile.referralAppliedMsg'));
      setReferralInput('');
    } catch (e) {
      const msg = e?.code === 'already-exists'
        ? t('profile.referralAlreadyUsed')
        : e?.code === 'not-found'
          ? t('profile.referralInvalidCode')
          : e?.message;
      showAlert('Error', msg);
    } finally {
      setApplyingReferral(false);
    }
  };

  const saveWallet = async () => {
    const addr = walletInput.trim();
    if (addr && !ETH_ADDRESS_RE.test(addr)) {
      showAlert(t('profile.walletInvalidTitle'), t('profile.walletInvalidMsg'));
      return;
    }
    setSavingWallet(true);
    try {
      // SEC-N-005: las Firestore rules bloquean escritura directa de walletAddress.
      // Cloud Function valida formato y la setea con Admin SDK.
      await callSetUserWallet(addr || null);
      showAlert('', addr ? t('profile.walletSaved') : t('profile.walletRemoved'));
    } catch (e) {
      logError('Profile.saveWallet', e);
      showAlert('Error', e?.message);
    } finally {
      setSavingWallet(false);
    }
  };

  const fullName = `${data?.profile?.firstName || ''} ${data?.profile?.lastName || ''}`.trim() || '';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header: avatar + nombre */}
        {!loading && !data ? (
          <View style={styles.card}>
            <Text style={styles.emptyTxt}>{t('profile.noData')}</Text>
          </View>
        ) : (
          <View style={styles.cardHeader}>
            {data?.avatarUrl ? (
              <Image source={{ uri: data.avatarUrl }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarTxt}>👤</Text>
              </View>
            )}
            <View style={styles.headerTextBlock}>
              <Text style={styles.name}>{fullName || '—'}</Text>
              {data?.profile?.username ? (
                <Text style={styles.usernameTag}>@{data.profile.username}</Text>
              ) : null}
            </View>
          </View>
        )}

        {/* Info personal */}
        <View style={styles.card}>
          <InfoRow label={t('profile.firstName')} value={data?.profile?.firstName} />
          <Sep />
          <InfoRow label={t('profile.lastName')} value={data?.profile?.lastName} />
          <Sep />
          <InfoRow label={t('profile.birthday')} value={data?.profile?.birthday} />
          <Sep />
          <InfoRow label={t('profile.phone')} value={data?.profile?.phone} />
          <Sep />
          <InfoRow label={t('profile.address')} value={data?.profile?.address} />
          <Sep />
          <InfoRow label={t('profile.postalCode')} value={data?.profile?.postalCode} />
        </View>

        {/* Wallet ETH */}
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.cardSectionLabel}>🔷 {t('profile.wallet')}</Text>
          <TextInput
            style={styles.monoInput}
            value={walletInput}
            onChangeText={setWalletInput}
            placeholder="0x..."
            placeholderTextColor="#444"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.actionBtn, { marginTop: 8 }]}
            onPress={saveWallet}
            disabled={savingWallet}
            activeOpacity={0.85}
          >
            <Text style={styles.actionBtnTxt}>
              {savingWallet ? t('profile.saving') : t('profile.saveWallet')}
            </Text>
          </TouchableOpacity>
          {data?.walletAddress ? (
            <Text style={styles.walletConfirm}>
              ✓ {data.walletAddress.slice(0, 10)}…{data.walletAddress.slice(-6)}
            </Text>
          ) : null}
        </View>

        {/* Referidos */}
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.cardSectionLabel}>🔗 {t('profile.referralTitle')}</Text>
          {data?.referralCode ? (
            <View style={styles.referralCodeRow}>
              <Text style={styles.referralCode}>{data.referralCode}</Text>
              <TouchableOpacity style={styles.shareBtn} onPress={shareReferralCode} activeOpacity={0.85}>
                <Text style={styles.shareBtnTxt}>{t('profile.referralShare')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={styles.mutedTxt}>{t('profile.referralNoCode')}</Text>
          )}
          <Text style={[styles.cardSectionLabel, { marginTop: 14 }]}>{t('profile.referralApplyLabel')}</Text>
          {data?.referredBy ? (
            <Text style={styles.referralUsed}>✓ {t('profile.referralAlreadyUsed')}</Text>
          ) : (
            <View style={styles.referralInputRow}>
              <TextInput
                style={[styles.monoInput, { flex: 1, marginBottom: 0 }]}
                value={referralInput}
                onChangeText={setReferralInput}
                placeholder={t('profile.referralPlaceholder')}
                placeholderTextColor="#444"
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[styles.actionBtn, { marginTop: 0, marginLeft: 8, paddingHorizontal: 16 }]}
                onPress={applyReferral}
                disabled={applyingReferral || !referralInput.trim()}
                activeOpacity={0.85}
              >
                <Text style={styles.actionBtnTxt}>{applyingReferral ? '…' : t('profile.referralApplyBtn')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Editar perfil */}
        <TouchableOpacity
          style={styles.editProfileBtn}
          onPress={() => { if (asModal && onClose) onClose(); openModal('registration'); }}
          activeOpacity={0.85}
        >
          <Text style={styles.editProfileTxt}>✏️ {t('profile.editProfile')}</Text>
        </TouchableOpacity>

      </ScrollView>
      {AlertComponent}
    </View>
  );
}

function InfoRow({ label, value }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value || '—'}</Text>
    </View>
  );
}

function Sep() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 4, paddingBottom: 16 },

  emptyTxt: { color: '#555', textAlign: 'center', fontSize: 14, paddingVertical: 8 },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#222',
  },
  avatar: { width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: '#333' },
  avatarPlaceholder: { backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 32 },
  headerTextBlock: { marginLeft: 14, flex: 1 },
  name: { fontSize: 18, fontWeight: '900', color: '#fff' },
  usernameTag: { fontSize: 13, color: '#888', marginTop: 3, fontWeight: '600' },

  card: {
    backgroundColor: '#111',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    marginBottom: 2,
  },
  cardSectionLabel: {
    color: '#666',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 6,
  },

  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11 },
  infoLabel: { color: '#666', fontWeight: '700', fontSize: 14 },
  infoValue: { color: '#ccc', fontWeight: '600', fontSize: 14 },
  separator: { height: 1, backgroundColor: '#1a1a1a' },

  monoInput: {
    backgroundColor: '#0d0d0d',
    color: '#ccc',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  walletConfirm: { color: '#22c55e', fontSize: 11, marginTop: 6, fontFamily: 'monospace' },

  actionBtn: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  actionBtnTxt: { color: '#ccc', fontWeight: '800', fontSize: 13 },

  referralCodeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  referralCode: {
    flex: 1,
    color: '#ffd700',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 4,
    fontFamily: 'monospace',
  },
  shareBtn: { backgroundColor: '#1a2a0a', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#2e7d32' },
  shareBtnTxt: { color: '#5cb85c', fontWeight: '700', fontSize: 13 },
  mutedTxt: { color: '#555', fontSize: 13 },
  referralInputRow: { flexDirection: 'row', alignItems: 'center' },
  referralUsed: { color: '#22c55e', fontSize: 13, fontWeight: '700' },

  editProfileBtn: {
    marginTop: 14,
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  editProfileTxt: { color: '#ccc', fontWeight: '800', fontSize: 15 },
});
