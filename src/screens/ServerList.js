import React, { useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppAlert } from '../components/AppAlert';
import { useNavigation } from '@react-navigation/native';
import { collection, query, orderBy, limit, onSnapshot, doc, deleteDoc, getDocs, where, documentId } from 'firebase/firestore';
import { db, auth } from '../firebase/client';
import { signOut, onAuthStateChanged } from 'firebase/auth';
import { callJoinServer, callCheckServerAccess } from '../firebase/functions';
import { useServer } from '../utils/serverContext';
import { useI18n } from '../utils/i18n';
import { useOverlayModals } from '../components/OverlayModalsProvider';
import audioManager from '../utils/audioManager';
import UpdateModal from '../components/UpdateModal';
import LayerLockedModal from '../components/LayerLockedModal';
import { getLayerUnlockThreshold, isLayerUnlocked, TOTAL_PRIZE_POOL_USD } from '../utils/gems';
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
  const [tab, setTab] = useState('active'); // 'active' | 'finished'
  const [joining, setJoining] = useState(null); // serverId que está procesando
  const [currentUser, setCurrentUser] = useState(auth.currentUser);
  const [serverCredits, setServerCredits] = useState(null);
  // Cambio 4 (Mis Servers): Map<serverId, {role, chainId}> en vez de un Set
  // de solo IDs — permite distinguir "creado por mí" ('creator') de "unido"
  // ('member'), dato que ya vivía en serverAccess pero antes se descartaba.
  const [myServerAccess, setMyServerAccess] = useState(new Map());
  const [myServersFilter, setMyServersFilter] = useState(false);
  // Servers a los que el usuario tiene acceso pero que cayeron fuera del
  // top-50 de `servers` (más viejos) — se buscan aparte solo cuando el
  // filtro "Mis Servers" está activo.
  const [extraServers, setExtraServers] = useState([]);
  const [referralBonusNotif, setReferralBonusNotif] = useState(null); // { id } referrer bonus
  const [referralBonusSelfNotif, setReferralBonusSelfNotif] = useState(null); // { id } buyer bonus
  const [updateInfo, setUpdateInfo] = useState(null);
  // Audit feedback 2026-06-23+: modal cuando el user intenta entrar a un server
  // cuya capa actual no tiene quorum suficiente. Bloquea entrada hasta cumplir
  // threshold + CTA de share. Info viene de getServers (layerUnlocked/Threshold).
  const [layerLockedInfo, setLayerLockedInfo] = useState(null);
  // referralCode del usuario actual — usado en el share message del modal locked.
  const [myReferralCode, setMyReferralCode] = useState(null);
  const [showWelcomePicks, setShowWelcomePicks] = useState(false);
  const [pendingServer, setPendingServer] = useState(null); // server to navigate to after welcome modal
  // Cambio 2 (server Free): id de la cadena Free fija, para pinearla arriba
  // de todo en la lista. Viene de config/app.freeServerChainId (seteado una
  // sola vez por la Cloud Function bootstrapFreeServer).
  const [freeServerChainId, setFreeServerChainId] = useState(null);
  // El server "activo" de esa cadena cambia en cada reinicio infinito (nuevo
  // episodio = nuevo serverId) -- se resuelve en 2 pasos (chain -> server
  // actual) para no depender de que esté dentro del top-50 de `servers`.
  const [freeServerDoc, setFreeServerDoc] = useState(null);
  // Cambio 3 (Fase 4, servers a medida): flag de config/app, apagado por
  // default. El botón para crear un server a medida ni se muestra si esto
  // es false -- el backend también lo re-valida (defensa en profundidad).
  const [paramServerCreationEnabled, setParamServerCreationEnabled] = useState(false);
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
        setFreeServerChainId(cfg.freeServerChainId || null);
        setParamServerCreationEnabled(cfg.paramServerCreationEnabled === true);
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
    if (!currentUid) { setServerCredits(0); setMyReferralCode(null); return; }
    const unsub = onSnapshot(doc(db, 'users', currentUid), (snap) => {
      if (snap.exists()) {
        const data = snap.data() || {};
        setServerCredits(data.serverCredits ?? 0);
        setMyReferralCode(data.referralCode || null);
      } else {
        setServerCredits(0);
        setMyReferralCode(null);
      }
    });
    return () => unsub();
  }, [currentUid]);

  useEffect(() => {
    if (!currentUid) { setMyServerAccess(new Map()); return; }
    // PERF-009: limit(200) — soporta hasta 200 servers joineados; si crece,
    // paginar.  Sin límite, usuarios con historia larga descargan todo en cada
    // snapshot.
    const unsub = onSnapshot(
      query(collection(db, 'users', currentUid, 'serverAccess'), limit(200)),
      (snap) => {
        const m = new Map();
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          m.set(d.id, { role: data.role || 'member', chainId: data.chainId || null });
        });
        setMyServerAccess(m);
      },
      () => {},
    );
    return () => unsub();
  }, [currentUid]);

  // Cambio 4: la lista base `servers` es un top-50 por fecha — si el filtro
  // "Mis Servers" está activo y el usuario tiene acceso a un server más viejo
  // que cayó fuera de ese top-50, lo buscamos aparte por ID (chunked de a 10,
  // límite de Firestore para cláusulas `in`).
  useEffect(() => {
    if (!myServersFilter) { setExtraServers([]); return; }
    const knownIds = new Set(servers.map((s) => s.id));
    const missingIds = [...myServerAccess.keys()].filter((id) => !knownIds.has(id));
    if (missingIds.length === 0) { setExtraServers([]); return; }
    let cancelled = false;
    (async () => {
      const chunks = [];
      for (let i = 0; i < missingIds.length; i += 10) chunks.push(missingIds.slice(i, i + 10));
      try {
        const results = await Promise.all(chunks.map((chunk) =>
          getDocs(query(collection(db, 'servers'), where(documentId(), 'in', chunk))),
        ));
        if (cancelled) return;
        setExtraServers(results.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
      } catch (e) {
        logError('ServerList.fetchMyServersExtra', e);
      }
    })();
    return () => { cancelled = true; };
  }, [myServersFilter, myServerAccess, servers]);

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

  // Cambio 2: resolver el server ACTIVO de la cadena Free en 2 pasos (chain
  // -> currentServerId -> ese doc), porque el server concreto cambia en cada
  // reinicio infinito y no siempre va a estar en el top-50 de `servers`.
  useEffect(() => {
    if (!freeServerChainId) { setFreeServerDoc(null); return; }
    let unsubServer = null;
    const unsubChain = onSnapshot(doc(db, 'serverChains', freeServerChainId), (chainSnap) => {
      if (unsubServer) { unsubServer(); unsubServer = null; }
      const currentServerId = chainSnap.exists() ? chainSnap.data().currentServerId : null;
      if (!currentServerId) { setFreeServerDoc(null); return; }
      unsubServer = onSnapshot(doc(db, 'servers', currentServerId), (serverSnap) => {
        setFreeServerDoc(serverSnap.exists() ? { id: serverSnap.id, ...serverSnap.data() } : null);
      }, () => setFreeServerDoc(null));
    }, () => setFreeServerDoc(null));
    return () => { unsubChain(); if (unsubServer) unsubServer(); };
  }, [freeServerChainId]);

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
    // Audit feedback 2026-06-23+: bloquear entrada si la capa actual del
    // server no tiene quorum suficiente. Modal explica + CTA share. El user
    // no gasta créditos en un server que no puede minar todavía.
    // Computamos en cliente (espejo de functions/helpers.js#isLayerUnlocked)
    // porque ServerList lee via onSnapshot directo a Firestore, no via
    // callGetServers (que sí anexaría layerUnlocked al payload).
    const K = server?.currentLayer;
    const members = server?.memberCount || 0;
    // Cambio 2/3: el espejo cliente de isLayerUnlocked usa los umbrales fijos
    // del cubo estándar (100 capas) — no aplica a servers con config propia
    // (Free, a medida), que tienen su propia geometría/umbrales. Para esos,
    // confiamos en que el backend (mineCube) gatee correctamente y salteamos
    // este check especulativo del lado cliente.
    if (!server?.config && typeof K === 'number' && !isLayerUnlocked(K, members)) {
      setLayerLockedInfo({
        current: members,
        required: getLayerUnlockThreshold(K),
        K,
      });
      return;
    }
    setJoining(server.id);
    const markJoined = () => {
      setMyServerAccess((prev) => {
        const m = new Map(prev);
        if (!m.has(server.id)) m.set(server.id, { role: 'member', chainId: server.chainId || null });
        return m;
      });
    };
    const doJoin = async () => {
      const { hasAccess, serverCredits } = await callCheckServerAccess(server.id);
      if (hasAccess) {
        // Already paid — update local state in case the listener missed it
        markJoined();
        return true;
      }
      // Cambio 2: el server Free no cobra crédito -- el backend (joinServer)
      // ya lo saltea, pero el cliente también debe saltear este gate o
      // bloquearía a un usuario con 0 créditos que en realidad puede entrar gratis.
      const isFree = !!(server?.config && server.config.isFreeServer);
      if (!isFree && serverCredits < 1) {
        showAlert(t('serverList.noCreditsTitle'), t('serverList.noCreditsMsg'));
        return false;
      }
      const joinResult = await callJoinServer(server.id);
      markJoined();
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

  // Cambio 4: con el filtro "Mis Servers" activo, la fuente es servers (top-50)
  // + extraServers (los que cayeron fuera del top-50 pero el user tiene
  // acceso), filtrados a solo los que están en myServerAccess.
  const baseServers = myServersFilter
    ? [...servers, ...extraServers.filter((es) => !servers.some((s) => s.id === es.id))]
        .filter((s) => myServerAccess.has(s.id))
    : servers;
  // Cambio 2: el server Free se pinea siempre arriba de todo en la pestaña de
  // activos (nunca aparece en "finalizados" -- reinicia para siempre). Se
  // filtra igual que el resto si "Mis Servers" está activo.
  const freeVisible = tab !== 'finished' && freeServerDoc &&
    (!myServersFilter || myServerAccess.has(freeServerDoc.id));
  const withFree = freeVisible
    ? [freeServerDoc, ...baseServers.filter((s) => s.id !== freeServerDoc.id)]
    : baseServers;
  const activeServers = withFree.filter(s => s.status !== 'completed');
  const finishedServers = baseServers.filter(s => s.status === 'completed');
  const displayedServers = tab === 'finished' ? finishedServers : activeServers;

  const renderEpisodeBadge = (item) => {
    if (!item.episodeNumber) return null;
    const ep = item.episodeNumber;
    // Cambio 2: el server Free reinicia infinito, "ep/10" no aplica ahí.
    if (item.config && item.config.isFreeServer) {
      return (
        <View style={styles.episodeBadge}>
          <Text style={styles.episodeBadgeTxt}>{t('serverList.episodeBadge')} {ep}</Text>
        </View>
      );
    }
    const total = 10;
    return (
      <View style={styles.episodeBadge}>
        <Text style={styles.episodeBadgeTxt}>{t('serverList.episodeBadge')} {ep}/{total}</Text>
      </View>
    );
  };

  // Cambio 5: premio total del server/cadena. Usa item.config.totalPrizePoolUSD
  // si el server tiene config propia (Fase 3/4, server Free o a medida);
  // servers estándar/legacy no tienen config -> fallback al total fijo actual.
  const prizePoolFor = (item) => item?.config?.totalPrizePoolUSD ?? TOTAL_PRIZE_POOL_USD;

  // Cambio 4: badge "creador" — el dato ya existía en serverAccess.role pero
  // antes solo se usaba para el botón Mine/Unlock, nunca se mostraba.
  const renderCreatorBadge = (item) => {
    if (myServerAccess.get(item.id)?.role !== 'creator') return null;
    return (
      <View style={styles.creatorBadge}>
        <Text style={styles.creatorBadgeTxt}>👑 {t('serverList.createdByMe')}</Text>
      </View>
    );
  };

  // Cambio 2: badge distintivo para el server Free.
  const renderFreeBadge = (item) => {
    if (!item.config || !item.config.isFreeServer) return null;
    return (
      <View style={styles.freeBadge}>
        <Text style={styles.freeBadgeTxt}>🎁 FREE</Text>
      </View>
    );
  };

  const renderActiveItem = ({ item }) => (
    <View style={[styles.card, item.config && item.config.isFreeServer && styles.cardFree]}>
      <View style={{ flex: 1 }}>
        <View style={styles.nameRow}>
          <Text style={styles.serverName}>{t('serverList.chainLabel')} {item.name}</Text>
          {renderFreeBadge(item)}
          {renderEpisodeBadge(item)}
          {renderCreatorBadge(item)}
        </View>
        <Text style={styles.serverMeta}>
          {t('serverList.layer')}: {item.currentLayer}
          {typeof item.totalMined === 'number' ? `  ·  ⛏ ${item.totalMined} ${t('serverList.totalMined')}` : ''}
        </Text>
        <Text style={styles.serverMeta}>
          👥 {(item.memberCount || 0).toLocaleString()}
          {item.config && item.config.maxMembers == null ? '' : ' / 100,000'} {t('serverList.members')}
        </Text>
        <Text style={[styles.serverMeta, styles.prizeMeta]}>
          💰 {t('serverList.totalPrize')}: ${prizePoolFor(item).toLocaleString()}
        </Text>
        {(() => {
          // Audit feedback 2026-06-23+: indicador visual de unlock por capa.
          // Si la capa actual está locked, mostrar "🔒 faltan N jugadores".
          // Si está unlocked y la capa tiene threshold > 0, mostrar "🔓 desbloqueada".
          const K = item.currentLayer;
          if (typeof K !== 'number' || item.config) return null; // Cambio 2/3: servers con config propia no usan estos umbrales fijos
          const threshold = getLayerUnlockThreshold(K);
          if (threshold === 0) return null; // capa warmup, sin info
          const members = item.memberCount || 0;
          const unlocked = members >= threshold;
          if (unlocked) {
            return (
              <Text style={[styles.serverMeta, { color: '#5cb85c' }]}>
                🔓 {t('serverList.layerUnlocked', { defaultValue: 'Capa desbloqueada' })}
              </Text>
            );
          }
          const remaining = Math.max(0, threshold - members);
          return (
            <Text style={[styles.serverMeta, { color: '#f59e0b' }]}>
              🔒 {t('serverList.layerLocked', { remaining: remaining.toLocaleString(), defaultValue: `Faltan ${remaining.toLocaleString()} jugadores` })}
            </Text>
          );
        })()}
      </View>
      <View style={styles.cardActions}>
        {item.chainId ? (
          <TouchableOpacity
            style={styles.historyBtn}
            onPress={() => navigation.navigate('ChainHistory', { chainId: item.chainId, chainName: item.name })}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`${t('drawer.history') || 'Historial'}: ${item.name}`}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Text style={styles.historyTxt}>📋</Text>
          </TouchableOpacity>
        ) : null}
        {(() => {
          const hasAccess = myServerAccess.has(item.id);
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
            {renderCreatorBadge(item)}
            <View style={styles.completedBadge}>
              <Text style={styles.completedBadgeTxt}>✓</Text>
            </View>
          </View>
          <Text style={styles.serverMeta}>
            {t('serverList.layer')}: {item.currentLayer}
            {typeof item.totalMined === 'number' ? `  ·  ⛏ ${item.totalMined} ${t('serverList.totalMined')}` : ''}
            {completedDate ? `  ·  ${completedDate}` : ''}
          </Text>
          <Text style={[styles.serverMeta, styles.prizeMeta]}>
            💰 {t('serverList.totalPrize')}: ${prizePoolFor(item).toLocaleString()}
          </Text>
        </View>
        {item.chainId ? (
          <TouchableOpacity
            style={styles.historyBtn}
            onPress={() => navigation.navigate('ChainHistory', { chainId: item.chainId, chainName: item.name })}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`${t('drawer.history') || 'Historial'}: ${item.name}`}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <Text style={styles.historyTxt}>📋</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  const handleSignOut = async () => {
    setMenuVisible(false);
    // BAJO-SL-11: logError en vez de console.warn — consistencia con resto del archivo.
    try { await signOut(auth); } catch (e) { logError('ServerList.handleSignOut', e); }
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
        onDismiss={() => setUpdateInfo(null)}
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
            accessibilityRole="tab"
            accessibilityLabel={tab === 'finished' ? t('serverList.backActive') : t('serverList.finished')}
            accessibilityState={{ selected: tab === 'finished' }}
          >
            <Text style={[styles.finishedBtnTxt, tab === 'finished' && styles.finishedBtnTxtActive]}>
              {tab === 'finished' ? t('serverList.backActive') : t('serverList.finished')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.menuBtn}
            onPress={() => setMenuVisible(true)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('drawer.menu')}
            accessibilityHint={t('drawer.menu')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.menuBtnTxt}>☰</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Slide-down menu modal */}
      <Modal transparent animationType="fade" visible={menuVisible} onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity
          style={styles.menuOverlay}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}
          accessibilityLabel={t('serverList.cancel') || 'Close menu'}
          accessibilityRole="button"
        >
          <View style={styles.menuPanel}>
            <Text style={styles.menuHeader}>{t('drawer.menu')}</Text>
            {/* Cambio 1: "Picos" se quitó de este menú (lista de cadenas/servers,
                sin cadena activa necesariamente) — ahora vive solo en el menú
                del cubo (GameDrawer/CustomDrawerContent en App.js), donde
                activeServer.chainId siempre está definido. */}
            {[
              { label: t('drawer.gems'),      key: 'gems' },
              { label: t('drawer.profile'),   key: 'profile' },
              { label: t('drawer.config'),    key: 'config' },
              { label: t('drawer.howToPlay'), key: 'howToPlay' },
              { label: t('drawer.buyCredits'), key: 'buyCredits' },
              ...(!currentUser
                ? [{ label: t('drawer.signIn') || 'Sign in', key: 'login' }]
                : []),
            ].map((item) => (
              <TouchableOpacity
                key={item.key}
                style={styles.menuItem}
                onPress={() => openItem(item.key)}
                activeOpacity={0.8}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
              >
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

      {/* Filter row — solo en tab activos. Cambio 4: chips ahora interactivos,
          alternan entre "Todos" y "Mis Servers" (creados + unidos). */}
      {tab === 'active' && (
        <View style={styles.filterRow}>
          <TouchableOpacity
            style={[styles.filterChip, !myServersFilter ? styles.filterChipActive : styles.filterChipInactive]}
            onPress={() => setMyServersFilter(false)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ selected: !myServersFilter }}
          >
            <Text style={!myServersFilter ? styles.filterChipTxtActive : styles.filterChipTxtLocked}>
              {t('serverList.allServers')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.filterChip, myServersFilter ? styles.filterChipActive : styles.filterChipInactive]}
            onPress={() => setMyServersFilter(true)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ selected: myServersFilter }}
          >
            <Text style={myServersFilter ? styles.filterChipTxtActive : styles.filterChipTxtLocked}>
              {t('serverList.myServers')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Cambio 3 (Fase 4): botón de creación de server. Reemplaza al viejo
          "+ Create Chain" (quedaba permanentemente disabled, showCreate nunca
          se activaba — dead code eliminado junto con este cambio), solo
          visible si config/app.paramServerCreationEnabled está activo. */}
      {tab === 'active' && paramServerCreationEnabled && (
        <TouchableOpacity
          style={styles.createCustomBtn}
          onPress={() => openModal('createCustomServer')}
          activeOpacity={0.85}
        >
          <Text style={styles.createCustomBtnTxt}>⚙️ {t('drawer.createCustomServer')}</Text>
        </TouchableOpacity>
      )}

      {/* Lista */}
      {loading ? (
        <ActivityIndicator color="#fff" style={{ marginTop: 40 }} size="large" />
      ) : displayedServers.length === 0 ? (
        <Text style={styles.empty}>
          {myServersFilter
            ? t('serverList.myServersEmpty')
            : (tab === 'finished' ? t('serverList.finishedEmpty') : t('serverList.empty'))}
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
      <Modal visible={showWelcomePicks} transparent animationType="fade" onRequestClose={() => setShowWelcomePicks(false)}>
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
      <Modal visible={!!referralBonusNotif} transparent animationType="fade" onRequestClose={() => setReferralBonusNotif(null)}>
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
      <Modal visible={!!referralBonusSelfNotif} transparent animationType="fade" onRequestClose={() => setReferralBonusSelfNotif(null)}>
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

      <LayerLockedModal
        visible={!!layerLockedInfo}
        currentMembers={layerLockedInfo?.current || 0}
        requiredMembers={layerLockedInfo?.required || 0}
        layerK={layerLockedInfo?.K ?? null}
        referralCode={myReferralCode}
        onClose={() => setLayerLockedInfo(null)}
      />

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
  filterChipInactive: { backgroundColor: 'transparent', borderColor: '#2a2a2a' },
  filterChipTxtActive: { color: '#5cb85c', fontWeight: '700', fontSize: 13 },
  filterChipTxtLocked: { color: '#777', fontWeight: '700', fontSize: 13 },

  // Crear server a medida (Fase 4)
  createCustomBtn: {
    backgroundColor: '#1a1a0a',
    borderWidth: 1,
    borderColor: '#5a5a2a',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  createCustomBtnTxt: { color: '#d4c95a', fontSize: 12, fontWeight: '700' },

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
  serverName: { color: '#fff', fontWeight: '800', fontSize: 16, flexShrink: 1 },
  serverMeta: { color: '#777', fontSize: 12, marginTop: 4 },
  prizeMeta: { color: '#ffd700', fontWeight: '700' },
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
    height: 36,
    paddingHorizontal: 16,
    minWidth: 70,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2e7d32',
  },
  mineTxt: { color: '#5cb85c', fontWeight: '700' },
  joinBtn: {
    backgroundColor: '#1565c0',
    borderRadius: 8,
    height: 36,
    paddingHorizontal: 16,
    minWidth: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unlockBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    height: 36,
    paddingHorizontal: 16,
    minWidth: 70,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  joinBtnDisabled: { backgroundColor: '#0d3a70' },
  joinTxt: { color: '#fff', fontWeight: '700' },
  unlockTxt: { color: '#888', fontWeight: '700', fontSize: 13 },

  // Name rows — flexWrap permite que el badge baje a otra línea si no entra.
  // Sin esto, en pantallas chicas el badge se solapa con los botones de la derecha.
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 4 },
  finishedNameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 4 },

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
  creatorBadge: {
    backgroundColor: '#2a2000',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#7a5a1a',
  },
  creatorBadgeTxt: { color: '#ffd700', fontWeight: '700', fontSize: 10 },
  freeBadge: {
    backgroundColor: '#0d2010',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#2e7d32',
  },
  freeBadgeTxt: { color: '#5cb85c', fontWeight: '900', fontSize: 10 },
  cardFree: { borderColor: '#2e7d32' },
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
