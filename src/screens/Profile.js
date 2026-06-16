import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, TextInput, Share } from 'react-native';
import { signOut } from 'firebase/auth';
import { useAppAlert } from '../components/AppAlert';
import { auth, db } from '../firebase/client';
import { navigate } from '../utils/navigationRef';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { useI18n } from '../utils/i18n';
import { useOverlayModals } from '../components/OverlayModalsProvider';
import { callApplyReferral, callSetUserWallet, callDeleteMyAccount, callRevokeMySessions } from '../firebase/functions';
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
  // Round 2 Commit F: self-serve account ops state.
  const [revoking, setRevoking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Round 2 Agente #4 ALTO-FE-07: subscribe al uid actual via onAuthStateChanged
  // en lugar de capturar auth.currentUser al mount. Pre-fix: si el user cambia
  // durante la vida del componente (e.g., logout + login con cuenta distinta,
  // o token refresh con uid diff), el listener servía data del uid VIEJO →
  // cross-user data leak (mostraba wallet/email del primer user al segundo).
  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    // Re-import onAuthStateChanged dinámicamente para evitar imports adicionales arriba.
    let unsubAuth = null;
    (async () => {
      const { onAuthStateChanged } = await import('firebase/auth');
      if (cancelled) return;
      unsubAuth = onAuthStateChanged(auth, (u) => {
        // Cleanup previous listener cuando cambia el uid.
        if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
        if (!u) {
          setData(null);
          setWalletInput('');
          setLoading(false);
          return;
        }
        const ref = doc(db, 'users', u.uid);
        unsub = onSnapshot(ref, (snap) => {
          const d = snap.exists() ? snap.data() : null;
          setData(d);
          setWalletInput(d?.walletAddress || '');
          setLoading(false);
        }, () => setLoading(false));
      });
    })();
    return () => {
      cancelled = true;
      if (unsub) { try { unsub(); } catch (_) {} }
      if (unsubAuth) { try { unsubAuth(); } catch (_) {} }
    };
  }, []);

  const shareReferralCode = async () => {
    const code = data?.referralCode;
    if (!code) return;
    const url = `https://miningtheblocks.com/?ref=${code}`;
    const msg = t('profile.referralShareMsg', { code, url });
    try {
      await Share.share({ message: msg });
    } catch {}
  };

  // ALTO-52: throttle local + mensaje unificado para evitar enumeration de
  // códigos. Antes distinguir 'already-exists' vs 'not-found' permitía
  // probar códigos rápido.
  const referralCooldownRef = useRef(0);
  const applyReferral = async () => {
    const code = referralInput.trim().toUpperCase();
    if (!code) return;
    const now = Date.now();
    if (now - referralCooldownRef.current < 10000) {
      showAlert('', t('profile.referralInvalidCode'));
      return;
    }
    referralCooldownRef.current = now;
    setApplyingReferral(true);
    try {
      await callApplyReferral(code);
      showAlert(t('profile.referralAppliedTitle'), t('profile.referralAppliedMsg'));
      setReferralInput('');
    } catch (e) {
      try { logError('Profile.applyReferral', e, { codeLen: code.length }); } catch {}
      // Mensaje único, no distingue not-found vs already-exists.
      showAlert('', t('profile.referralInvalidCode'));
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
      // ALTO-30 backend: si el backend devuelve email_not_verified, decir al user.
      // ALTO-35 backend: si devuelve wallet_cooldown:Xh, decir al user.
      const code = e?.code || '';
      const msg = e?.message || '';
      if (msg.includes('email_not_verified')) {
        // Round 2 #10 CRIT-10-04: t() ahora soporta interpolación; las keys
        // emailNotVerified + walletCooldown se agregaron en Tier 1 (EN+ES).
        showAlert(t('profile.walletInvalidTitle'), t('profile.emailNotVerified'));
      } else if (msg.startsWith('wallet_cooldown:')) {
        const h = msg.split(':')[1] || '24';
        showAlert('', t('profile.walletCooldown', { h }));
      } else {
        showAlert('Error', t('profile.walletInvalidMsg') || 'No se pudo guardar.');
      }
    } finally {
      setSavingWallet(false);
    }
  };

  const fullName = `${data?.profile?.firstName || ''} ${data?.profile?.lastName || ''}`.trim() || '';

  // Round 2 Commit F: self-serve account ops (logout everywhere + delete).
  const handleLogoutEverywhere = () => {
    showAlert(
      t('profile.logoutEverywhereTitle'),
      t('profile.logoutEverywhereMsg'),
      [
        { text: t('profile.cancel'), style: 'cancel' },
        {
          text: t('profile.logoutEverywhereConfirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              setRevoking(true);
              await callRevokeMySessions();
              // Cierre local inmediato — el revoke server-side recién toma
              // efecto cuando otros devices intentan validar su token (los
              // tokens viejos son <60min, próximo refresh los pesca).
              await signOut(auth).catch(() => {});
            } catch (e) {
              logError('Profile.revokeSessions', e);
              showAlert('Error', t('profile.logoutEverywhereError'));
            } finally {
              setRevoking(false);
            }
          },
        },
      ]
    );
  };

  const handleDeleteAccount = () => {
    showAlert(
      t('profile.deleteAccountTitle'),
      t('profile.deleteAccountWarning'),
      [
        { text: t('profile.cancel'), style: 'cancel' },
        {
          text: t('profile.deleteAccountConfirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              setDeleting(true);
              await callDeleteMyAccount();
              // El Auth user fue borrado server-side → tokens invalidados.
              // signOut local para coherencia inmediata del cliente.
              await signOut(auth).catch(() => {});
            } catch (e) {
              logError('Profile.deleteAccount', e);
              showAlert('Error', t('profile.deleteAccountError'));
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

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
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t('profile.wallet')}
          />
          <TouchableOpacity
            style={[styles.actionBtn, { marginTop: 8 }]}
            onPress={saveWallet}
            disabled={savingWallet}
            activeOpacity={0.85}
            accessibilityLabel={t('profile.saveWallet')}
            accessibilityState={{ disabled: savingWallet, busy: savingWallet }}
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
                placeholderTextColor="#888"
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
          accessibilityLabel={t('profile.editProfile')}
        >
          <Text style={styles.editProfileTxt}>✏️ {t('profile.editProfile')}</Text>
        </TouchableOpacity>

        {/* Round 2 Commit F: Danger zone — self-serve "logout everywhere" + account deletion. */}
        {!loading && data && (
          <View style={styles.dangerSection}>
            <Text style={styles.dangerLabel}>{t('profile.dangerZone')}</Text>
            <TouchableOpacity
              style={styles.dangerBtn}
              onPress={handleLogoutEverywhere}
              disabled={revoking}
              activeOpacity={0.85}
              accessibilityLabel={t('profile.logoutEverywhere')}
              accessibilityState={{ disabled: revoking, busy: revoking }}
            >
              <Text style={styles.dangerBtnTxt}>🔐 {revoking ? '…' : t('profile.logoutEverywhere')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.dangerBtn, styles.dangerBtnCritical]}
              onPress={handleDeleteAccount}
              disabled={deleting}
              activeOpacity={0.85}
              accessibilityLabel={t('profile.deleteAccount')}
              accessibilityState={{ disabled: deleting, busy: deleting }}
            >
              <Text style={[styles.dangerBtnTxt, styles.dangerBtnTxtCritical]}>⚠️  {deleting ? '…' : t('profile.deleteAccount')}</Text>
            </TouchableOpacity>
          </View>
        )}

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

  emptyTxt: { color: '#888', textAlign: 'center', fontSize: 14, paddingVertical: 8 },

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
  mutedTxt: { color: '#888', fontSize: 13 },
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

  // Round 2 Commit F: Danger zone (self-serve account ops).
  dangerSection: {
    marginTop: 32,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  dangerLabel: {
    color: '#888',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
    marginLeft: 2,
  },
  dangerBtn: {
    minHeight: 44,
    backgroundColor: '#1a1414',
    borderWidth: 1,
    borderColor: '#3a2222',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  dangerBtnCritical: {
    backgroundColor: '#1a0a0a',
    borderColor: '#5a1414',
  },
  dangerBtnTxt: { color: '#ccc', fontWeight: '700', fontSize: 14 },
  dangerBtnTxtCritical: { color: '#ff6b6b', fontWeight: '800' },
});
