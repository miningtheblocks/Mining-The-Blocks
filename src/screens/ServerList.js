import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppAlert } from '../components/AppAlert';
import { useNavigation } from '@react-navigation/native';
import { collection, query, orderBy, limit, onSnapshot, doc, deleteDoc } from 'firebase/firestore';
import { db, auth } from '../firebase/client';
import { signOut, onAuthStateChanged } from 'firebase/auth';
import { callCreateServer, callJoinServer, callCheckServerAccess } from '../firebase/functions';
import { useServer } from '../utils/serverContext';
import { useI18n } from '../utils/i18n';
import { useOverlayModals } from '../components/OverlayModalsProvider';
import audioManager from '../utils/audioManager';
import UpdateModal from '../components/UpdateModal';
import { APP_VERSION, compareVersions } from '../constants';
import { logError } from '../utils/logError';

// SEC-A7: anti-downgrade. Cacheamos el máximo latestVersion visto históricamente.
// Si Firebase es comprometido y un atacante setea latestVersion a una versión
// vieja+vulnerable con su downloadUrl, ignoramos el "update" porque < max visto.
const LATEST_VERSION_KEY = '@mtb/lastSeenLatestVersion';
// P2-11: cache del último config/app conocido (fallback si Firebase tiene outage)
const CONFIG_CACHE_KEY = '@mtb/cachedConfigApp';

export default function ServerList() {
  const navigation = useNavigation();
  const { t } = useI18n();
  const { openModal } = useOverlayModals();
  const [menuVisible, setMenuVisible] = useState(false);
  const { setActiveServer } = useServer();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [serverName, setServerName] = useState('');
  const [tab, setTab] = useState('active'); // 'active' | 'finished'
  const [joining, setJoining] = useState(null); // serverId que está procesando
  const [currentUser, setCurrentUser] = useState(auth.currentUser);
  const [serverCredits, setServerCredits] = useState(null);
  const [joinedServerIds, setJoinedServerIds] = useState(new Set());
  const [referralBonusNotif, setReferralBonusNotif] = useState(null); // { id } referrer bonus
  const [referralBonusSelfNotif, setReferralBonusSelfNotif] = useState(null); // { id } buyer bonus
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showWelcomePicks, setShowWelcomePicks] = useState(false);
  const [pendingServer, setPendingServer] = useState(null); // server to navigate to after welcome modal
  const { showAlert, AlertComponent } = useAppAlert();

  const currentUid = currentUser?.uid;

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setCurrentUser(u));
    return () => unsub();
  }, []);

  // Real-time version check — blocks access if a newer version exists
  useEffect(() => {
    // SEC-A7: anti-downgrade. Cargamos el cache ANTES de suscribirnos al snapshot
    // para evitar el race en el que el primer fire de Firebase llega con
    // cachedMax=null y "envenena" el storage con un latestVersion bajo malicioso.
    // P2-11: además cacheamos la config completa por si Firebase tiene un outage
    // al abrir la app (sino el cliente queda esperando para siempre la primera
    // snapshot y no muestra el listado de servers).
    let cachedMax = null;
    let unsub = null;
    let cancelled = false;
    let firstSnapshotArrived = false;

    const processConfig = (cfg, fromCache) => {
      const { minVersion, latestVersion, downloadUrl, forceUpdate, updateMessageEn, updateMessageEs } = cfg || {};
      let effectiveLatest = latestVersion;
      if (latestVersion) {
        if (cachedMax && compareVersions(latestVersion, cachedMax) < 0) {
          effectiveLatest = cachedMax;
        } else if (!cachedMax || compareVersions(latestVersion, cachedMax) > 0) {
          cachedMax = latestVersion;
          if (!fromCache) AsyncStorage.setItem(LATEST_VERSION_KEY, latestVersion).catch(() => {});
        }
      }
      const needsForce = minVersion && compareVersions(APP_VERSION, minVersion) < 0;
      const needsSoft  = effectiveLatest && compareVersions(APP_VERSION, effectiveLatest) < 0;
      if (needsForce || needsSoft) {
        setUpdateInfo({ forceUpdate: needsForce || !!forceUpdate, latestVersion: effectiveLatest, downloadUrl, messageEn: updateMessageEn, messageEs: updateMessageEs });
      } else {
        setUpdateInfo(null);
      }
    };

    (async () => {
      try {
        cachedMax = await AsyncStorage.getItem(LATEST_VERSION_KEY);
      } catch (_) {}
      if (cancelled) return;

      // Fallback inmediato si tenemos config cacheado (Firebase offline u outage)
      try {
        const cachedRaw = await AsyncStorage.getItem(CONFIG_CACHE_KEY);
        if (cachedRaw && !firstSnapshotArrived) {
          processConfig(JSON.parse(cachedRaw), true);
        }
      } catch (_) {}
      if (cancelled) return;

      unsub = onSnapshot(doc(db, 'config', 'app'), (snap) => {
        if (!snap.exists()) return;
        firstSnapshotArrived = true;
        const cfg = snap.data();
        processConfig(cfg, false);
        // Cache para próximo cold start
        AsyncStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg)).catch(() => {});
      }, (err) => { logError('ServerList.configSnapshot', err); });
    })();

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);

  useEffect(() => {
    if (!currentUid) { setServerCredits(0); return; }
    const unsub = onSnapshot(doc(db, 'users', currentUid), (snap) => {
      setServerCredits(snap.exists() ? (snap.data()?.serverCredits ?? 0) : 0);
    });
    return () => unsub();
  }, [currentUid]);

  useEffect(() => {
    if (!currentUid) { setJoinedServerIds(new Set()); return; }
    // PERF-009: limit(200) — soporta hasta 200 servers joineados; si crece,
    // paginar.  Sin límite, usuarios con historia larga descargan todo en cada
    // snapshot.
    const unsub = onSnapshot(
      query(collection(db, 'users', currentUid, 'serverAccess'), limit(200)),
      (snap) => setJoinedServerIds(new Set(snap.docs.map(d => d.id))),
      () => {},
    );
    return () => unsub();
  }, [currentUid]);

  useEffect(() => {
    if (!currentUid) return;
    // PERF-009: limit(50) — notificaciones recientes; el cliente las borra al
    // mostrarlas, así que 50 cubre con creces el caso normal.
    const unsub = onSnapshot(
      query(collection(db, 'users', currentUid, 'notifications'), limit(50)),
      (snap) => {
        const referrerNotif = snap.docs.find(d => d.data().type === 'referral_bonus');
        if (referrerNotif) setReferralBonusNotif({ id: referrerNotif.id });
        const selfNotif = snap.docs.find(d => d.data().type === 'referral_bonus_self');
        if (selfNotif) setReferralBonusSelfNotif({ id: selfNotif.id });
      },
      () => {},
    );
    return () => unsub();
  }, [currentUid]);

  useEffect(() => {
    const q = query(collection(db, 'servers'), orderBy('createdAt', 'desc'), limit(50));
    const unsub = onSnapshot(q, (snap) => {
      setServers(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return () => unsub();
  }, []);

  useEffect(() => {
    const initAudio = async () => {
      try {
        await audioManager.init();
        await audioManager.loadSounds();
        await audioManager.playBackgroundMusic();
      } catch {}
    };
    initAudio();
  }, []);

  const refreshAuth = async () => {
    // V1.1.0: sin anonymous. Si no hay user, App.js ya está mostrando Login.
    if (!auth.currentUser) return;
    try {
      await auth.currentUser.getIdToken(true);
    } catch (e) {
      logError('ServerList.refreshAuth', e);
      // Token irrecuperable → forzar signOut, App.js redirige a Login.
      try { await signOut(auth); } catch (signErr) { logError('ServerList.refreshAuth.signOut', signErr); }
    }
  };

  const goToRegister = () => openModal('registration');

  const joinServer = async (server) => {
    if (!currentUser) { goToRegister(); return; }
    setJoining(server.id);
    const doJoin = async () => {
      const { hasAccess, serverCredits } = await callCheckServerAccess(server.id);
      if (hasAccess) {
        // Already paid — update local state in case the listener missed it
        setJoinedServerIds(prev => new Set([...prev, server.id]));
        return true;
      }
      if (serverCredits < 1) {
        showAlert(t('serverList.noCreditsTitle'), t('serverList.noCreditsMsg'));
        return false;
      }
      const joinResult = await callJoinServer(server.id);
      setJoinedServerIds(prev => new Set([...prev, server.id]));
      if (joinResult?.welcomePicks) {
        return 'welcome';
      }
      return true;
    };

    try {
      await refreshAuth();
      let result = false;
      try {
        result = await doJoin();
      } catch (firstErr) {
        if (firstErr?.code === 'functions/unauthenticated') {
          try { await auth.currentUser?.getIdToken(true); } catch {}
          result = await doJoin();
        } else {
          throw firstErr;
        }
      }
      if (result === 'welcome') {
        setPendingServer(server);
        setShowWelcomePicks(true);
      } else if (result === true) {
        setActiveServer(server);
        navigation.navigate('GameDrawer');
      }
    } catch (e) {
      logError('ServerList.joinServer', e, { serverId: server?.id });
      const msg = e?.message || '';
      const code = e?.code || '';
      if (msg.includes('server_full')) {
        showAlert(t('serverList.serverFullTitle'), t('serverList.serverFullMsg'));
      } else if (code === 'functions/unauthenticated') {
        showAlert(t('serverList.sessionExpiredTitle'), t('serverList.sessionExpiredMsg'), [
          { text: 'OK', style: 'destructive', onPress: async () => { try { await signOut(auth); } catch (signErr) { logError('ServerList.signOut', signErr); } } },
        ]);
      } else if (code === 'functions/permission-denied') {
        showAlert(t('serverList.noCreditsTitle'), msg || t('serverList.errorJoin'));
      } else {
        showAlert('Error', msg || t('serverList.errorJoin'));
      }
    } finally {
      setJoining(null);
    }
  };

  const handleCreate = async () => {
    if (!currentUser) { goToRegister(); return; }
    const name = serverName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const result = await callCreateServer(name);
      const newServer = {
        id: result.serverId,
        name,
        currentLayer: 100,
        status: 'active',
        totalMined: 0,
      };
      if (result?.welcomePicks) {
        setPendingServer(newServer);
        setShowWelcomePicks(true);
      } else {
        setActiveServer(newServer);
        navigation.navigate('GameDrawer');
      }
    } catch (e) {
      showAlert('Error', e?.message || t('serverList.errorCreate'));
    } finally {
      setCreating(false);
      setShowCreate(false);
      setServerName('');
    }
  };

  const activeServers = servers.filter(s => s.status !== 'completed');
  const finishedServers = servers.filter(s => s.status === 'completed');
  const displayedServers = tab === 'finished' ? finishedServers : activeServers;

  const renderEpisodeBadge = (item) => {
    if (!item.episodeNumber) return null;
    const ep = item.episodeNumber;
    const total = 10;
    return (
      <View style={styles.episodeBadge}>
        <Text style={styles.episodeBadgeTxt}>{t('serverList.episodeBadge')} {ep}/{total}</Text>
      </View>
    );
  };

  const renderActiveItem = ({ item }) => (
    <View style={styles.card}>
      <View style={{ flex: 1 }}>
        <View style={styles.nameRow}>
          <Text style={styles.serverName}>{t('serverList.chainLabel')} {item.name}</Text>
          {renderEpisodeBadge(item)}
        </View>
        <Text style={styles.serverMeta}>
          {t('serverList.layer')}: {item.currentLayer}
          {typeof item.totalMined === 'number' ? `  ·  ⛏ ${item.totalMined} ${t('serverList.totalMined')}` : ''}
        </Text>
        <Text style={styles.serverMeta}>
          👥 {(item.memberCount || 0).toLocaleString()} / 100,000 {t('serverList.members')}
        </Text>
      </View>
      <View style={styles.cardActions}>
        {item.chainId ? (
          <TouchableOpacity
            style={styles.historyBtn}
            onPress={() => navigation.navigate('ChainHistory', { chainId: item.chainId, chainName: item.name })}
            activeOpacity={0.8}
          >
            <Text style={styles.historyTxt}>📋</Text>
          </TouchableOpacity>
        ) : null}
        {(() => {
          const hasAccess = joinedServerIds.has(item.id);
          const btnStyle = hasAccess ? styles.mineBtn : styles.unlockBtn;
          const label = hasAccess ? t('serverList.mine') : t('serverList.unlock');
          const txtStyle = hasAccess ? styles.mineTxt : styles.unlockTxt;
          return (
            <TouchableOpacity
              style={[btnStyle, joining === item.id && styles.joinBtnDisabled]}
              onPress={() => joinServer(item)}
              activeOpacity={0.8}
              disabled={joining === item.id}
              accessibilityRole="button"
              accessibilityLabel={typeof label === 'string' ? label : t('serverList.join')}
            >
              {joining === item.id
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={txtStyle}>{label}</Text>
              }
            </TouchableOpacity>
          );
        })()}
      </View>
    </View>
  );

  const renderFinishedItem = ({ item }) => {
    const completedDate = item.completedAt
      ? new Date(item.completedAt).toLocaleDateString()
      : null;
    return (
      <View style={[styles.card, styles.cardFinished]}>
        <View style={{ flex: 1 }}>
          <View style={styles.finishedNameRow}>
            <Text style={styles.serverName}>{t('serverList.chainLabel')} {item.name}</Text>
            {renderEpisodeBadge(item)}
            <View style={styles.completedBadge}>
              <Text style={styles.completedBadgeTxt}>✓</Text>
            </View>
          </View>
          <Text style={styles.serverMeta}>
            {t('serverList.layer')}: {item.currentLayer}
            {typeof item.totalMined === 'number' ? `  ·  ⛏ ${item.totalMined} ${t('serverList.totalMined')}` : ''}
            {completedDate ? `  ·  ${completedDate}` : ''}
          </Text>
        </View>
        {item.chainId ? (
          <TouchableOpacity
            style={styles.historyBtn}
            onPress={() => navigation.navigate('ChainHistory', { chainId: item.chainId, chainName: item.name })}
            activeOpacity={0.8}
          >
            <Text style={styles.historyTxt}>📋</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  const handleSignOut = async () => {
    setMenuVisible(false);
    try { await signOut(auth); } catch (e) { console.warn('Sign out error:', e); }
  };

  const openItem = (key) => {
    setMenuVisible(false);
    if (key === 'buyCredits' && !currentUser) { goToRegister(); return; }
    // CQ-013: el menú ya no tiene 'subscribe' (era redundante con Login).
    // Si en el futuro reaparece, navegar a Login screen en lugar de openModal.
    if (key === 'login') { navigation.navigate('Login'); return; }
    openModal(key);
  };

  return (
    <View style={styles.container}>

      {/* Blocking update modal */}
      <UpdateModal
        visible={!!updateInfo}
        forceUpdate={!!updateInfo?.forceUpdate}
        latestVersion={updateInfo?.latestVersion}
        downloadUrl={updateInfo?.downloadUrl}
        messageEn={updateInfo?.messageEn}
        messageEs={updateInfo?.messageEs}
        onDismiss={() => {}}
      />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{t('serverList.title')}</Text>
          <Text style={styles.creditsLine}>
            🎟️ {serverCredits === null ? '…' : serverCredits} {t('serverList.credits')}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={[styles.finishedBtn, tab === 'finished' && styles.finishedBtnActive]}
            onPress={() => setTab(tab === 'finished' ? 'active' : 'finished')}
            activeOpacity={0.8}
          >
            <Text style={[styles.finishedBtnTxt, tab === 'finished' && styles.finishedBtnTxtActive]}>
              {tab === 'finished' ? t('serverList.backActive') : t('serverList.finished')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.menuBtn} onPress={() => setMenuVisible(true)} activeOpacity={0.8}>
            <Text style={styles.menuBtnTxt}>☰</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Slide-down menu modal */}
      <Modal transparent animationType="fade" visible={menuVisible} onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity style={styles.menuOverlay} activeOpacity={1} onPress={() => setMenuVisible(false)}>
          <View style={styles.menuPanel}>
            <Text style={styles.menuHeader}>{t('drawer.menu')}</Text>
            {[
              { label: t('drawer.getPeaks'),  key: 'peaks' },
              { label: t('drawer.gems'),      key: 'gems' },
              { label: t('drawer.profile'),   key: 'profile' },
              { label: t('drawer.config'),    key: 'config' },
              { label: t('drawer.howToPlay'), key: 'howToPlay' },
              { label: t('drawer.buyCredits'), key: 'buyCredits' },
              ...(!currentUser
                ? [{ label: t('drawer.signIn') || 'Sign in', key: 'login' }]
                : []),
            ].map((item) => (
              <TouchableOpacity key={item.key} style={styles.menuItem} onPress={() => openItem(item.key)} activeOpacity={0.8}>
                <Text style={styles.menuItemTxt}>{item.label}</Text>
              </TouchableOpacity>
            ))}
            <View style={styles.menuSep} />
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuVisible(false); openModal('report'); }} activeOpacity={0.8}>
              <Text style={[styles.menuItemTxt, { color: '#888' }]}>⚠ {t('login.report')}</Text>
            </TouchableOpacity>
            {currentUser && (
              <>
                <View style={styles.menuSep} />
                <TouchableOpacity style={styles.menuItem} onPress={handleSignOut} activeOpacity={0.8}>
                  <Text style={[styles.menuItemTxt, { color: '#cc4444' }]}>{t('drawer.signOut')}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Filter row — solo en tab activos */}
      {tab === 'active' && (
        <View style={styles.filterRow}>
          <View style={[styles.filterChip, styles.filterChipActive]}>
            <Text style={styles.filterChipTxtActive}>{t('serverList.allServers')}</Text>
          </View>
          <View style={styles.filterChipLocked}>
            <Text style={styles.filterChipTxtLocked}>🔒 {t('serverList.myServers')}</Text>
          </View>
        </View>
      )}

      {/* Formulario crear servidor */}
      {tab === 'active' && (
        showCreate ? (
          <View style={styles.createForm}>
            <TextInput
              style={styles.input}
              value={serverName}
              onChangeText={setServerName}
              placeholder={t('serverList.serverNamePlaceholder')}
              placeholderTextColor="#555"
              maxLength={40}
              autoFocus
            />
            <View style={styles.createRow}>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary]}
                onPress={handleCreate}
                disabled={creating || !serverName.trim()}
                activeOpacity={0.85}
              >
                <Text style={styles.btnTxt}>
                  {creating ? t('serverList.creating') : t('serverList.create')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary]}
                onPress={() => { setShowCreate(false); setServerName(''); }}
                disabled={creating}
                activeOpacity={0.85}
              >
                <Text style={styles.btnTxt}>{t('serverList.cancel')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, styles.createTopBtn, styles.btnDisabled]}
            disabled={true}
            activeOpacity={1}
          >
            <Text style={[styles.btnTxt, styles.btnTxtDisabled]}>+ {t('serverList.create')}</Text>
          </TouchableOpacity>
        )
      )}

      {/* Lista */}
      {loading ? (
        <ActivityIndicator color="#fff" style={{ marginTop: 40 }} size="large" />
      ) : displayedServers.length === 0 ? (
        <Text style={styles.empty}>
          {tab === 'finished' ? t('serverList.finishedEmpty') : t('serverList.empty')}
        </Text>
      ) : (
        <FlatList
          data={displayedServers}
          keyExtractor={(item) => item.id}
          renderItem={tab === 'finished' ? renderFinishedItem : renderActiveItem}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={true}
          initialNumToRender={10}
          windowSize={5}
        />
      )}

      {/* Welcome picks modal */}
      <Modal visible={showWelcomePicks} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={wpStyles.overlay}>
          <View style={wpStyles.box}>
            <Text style={wpStyles.icon}>⛏️</Text>
            <Text style={wpStyles.title}>{t('serverList.welcomePicksTitle')}</Text>
            <Text style={wpStyles.msg}>{t('serverList.welcomePicksMsg')}</Text>
            <TouchableOpacity
              style={wpStyles.btn}
              onPress={() => {
                setShowWelcomePicks(false);
                if (pendingServer) {
                  setActiveServer(pendingServer);
                  setPendingServer(null);
                  navigation.navigate('GameDrawer');
                }
              }}
              activeOpacity={0.85}
            >
              <Text style={wpStyles.btnTxt}>{t('serverList.welcomePicksOk')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Referral bonus notification modal (shown to referrer when their friend paid) */}
      <Modal visible={!!referralBonusNotif} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={wpStyles.overlay}>
          <View style={wpStyles.box}>
            <Text style={wpStyles.icon}>🎉</Text>
            <Text style={wpStyles.title}>{t('serverList.referralBonusTitle')}</Text>
            <Text style={wpStyles.msg}>{t('serverList.referralBonusMsg')}</Text>
            <TouchableOpacity
              style={wpStyles.btn}
              onPress={async () => {
                const notifId = referralBonusNotif?.id;
                setReferralBonusNotif(null);
                if (notifId && currentUid) {
                  try { await deleteDoc(doc(db, 'users', currentUid, 'notifications', notifId)); } catch {}
                }
              }}
              activeOpacity={0.85}
            >
              <Text style={wpStyles.btnTxt}>{t('serverList.referralBonusOk')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Referral bonus self — shown to the buyer who used a referral code */}
      <Modal visible={!!referralBonusSelfNotif} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={wpStyles.overlay}>
          <View style={wpStyles.box}>
            <Text style={wpStyles.icon}>🎁</Text>
            <Text style={wpStyles.title}>{t('serverList.referralBonusSelfTitle')}</Text>
            <Text style={wpStyles.msg}>{t('serverList.referralBonusSelfMsg')}</Text>
            <TouchableOpacity
              style={wpStyles.btn}
              onPress={async () => {
                const notifId = referralBonusSelfNotif?.id;
                setReferralBonusSelfNotif(null);
                if (notifId && currentUid) {
                  try { await deleteDoc(doc(db, 'users', currentUid, 'notifications', notifId)); } catch {}
                }
              }}
              activeOpacity={0.85}
            >
              <Text style={wpStyles.btnTxt}>{t('serverList.referralBonusOk')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {AlertComponent}

    </View>
  );
}

const wpStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  box: {
    backgroundColor: '#111',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2e7d32',
    padding: 32,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  icon: { fontSize: 48, marginBottom: 14 },
  title: { color: '#fff', fontSize: 22, fontWeight: '900', textAlign: 'center', marginBottom: 10 },
  msg: { color: '#aaa', fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  btn: {
    backgroundColor: '#2e7d32',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 36,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  btnTxt: { color: '#fff', fontWeight: '900', fontSize: 16 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', paddingTop: 60, paddingHorizontal: 16 },

  // Header
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 },
  creditsLine: { color: '#ffd700', fontSize: 12, fontWeight: '700', marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: '#fff', fontSize: 24, fontWeight: '900' },
  menuBtn: { width: 36, height: 36, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333', alignItems: 'center', justifyContent: 'center' },
  menuBtnTxt: { color: '#ccc', fontSize: 18 },
  // Overlay menu
  menuOverlay: { flex: 1, backgroundColor: '#000000aa' },
  menuPanel: { position: 'absolute', top: 54, right: 16, backgroundColor: '#111', borderRadius: 14, borderWidth: 1, borderColor: '#333', paddingVertical: 8, minWidth: 200, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 10, elevation: 12 },
  menuHeader: { color: '#666', fontWeight: '800', fontSize: 11, paddingHorizontal: 16, paddingBottom: 6, textTransform: 'uppercase', letterSpacing: 1 },
  menuItem: { paddingVertical: 13, paddingHorizontal: 16 },
  menuItemTxt: { color: '#ddd', fontWeight: '700', fontSize: 15 },
  menuSep: { height: 1, backgroundColor: '#2a2a2a', marginHorizontal: 12, marginVertical: 4 },
  finishedBtn: {
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  finishedBtnActive: { borderColor: '#ffd700', backgroundColor: '#1a1600' },
  finishedBtnTxt: { color: '#999', fontWeight: '700', fontSize: 13 },
  finishedBtnTxtActive: { color: '#ffd700' },

  // Filter row
  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  filterChipActive: { backgroundColor: '#1a3a1a', borderColor: '#2e7d32' },
  filterChipTxtActive: { color: '#5cb85c', fontWeight: '700', fontSize: 13 },
  filterChipLocked: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    opacity: 0.45,
  },
  filterChipTxtLocked: { color: '#777', fontWeight: '700', fontSize: 13 },

  // Create form
  createForm: { marginBottom: 16 },
  input: {
    backgroundColor: '#111',
    color: '#fff',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 8,
  },
  createRow: { flexDirection: 'row', gap: 8 },
  createTopBtn: { marginBottom: 16, alignSelf: 'flex-start' },
  btn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, alignItems: 'center' },
  btnPrimary: { backgroundColor: '#2e7d32' },
  btnSecondary: { backgroundColor: '#333' },
  btnDisabled: { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a', opacity: 0.45 },
  btnTxt: { color: '#fff', fontWeight: '700' },
  btnTxtDisabled: { color: '#555' },

  // Cards
  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#222',
  },
  cardFinished: { borderColor: '#2a2a1a', backgroundColor: '#0f0f08' },
  serverName: { color: '#fff', fontWeight: '800', fontSize: 16 },
  serverMeta: { color: '#777', fontSize: 12, marginTop: 4 },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  historyBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyTxt: { fontSize: 16 },
  mineBtn: {
    backgroundColor: '#1a3a1a',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minWidth: 70,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2e7d32',
  },
  mineTxt: { color: '#5cb85c', fontWeight: '700' },
  joinBtn: {
    backgroundColor: '#1565c0',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minWidth: 70,
    alignItems: 'center',
  },
  unlockBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minWidth: 70,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  joinBtnDisabled: { backgroundColor: '#0d3a70' },
  joinTxt: { color: '#fff', fontWeight: '700' },
  unlockTxt: { color: '#888', fontWeight: '700', fontSize: 13 },

  // Name rows
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  finishedNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  // Episode badge
  episodeBadge: {
    backgroundColor: '#0d1f33',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#1a4a7a',
  },
  episodeBadgeTxt: { color: '#5599cc', fontWeight: '700', fontSize: 10 },
  completedBadge: {
    backgroundColor: '#2a3a1a',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#3a5a1a',
  },
  completedBadgeTxt: { color: '#7bc67e', fontWeight: '900', fontSize: 11 },
});
