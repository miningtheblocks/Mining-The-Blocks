import React, { useEffect, useRef, useState } from 'react';
import { StatusBar as RNStatusBar, Platform, Text, View, TouchableOpacity, Linking, AppState, Alert } from 'react-native';
// Round 2 Commit Q: react-native-google-mobile-ads removido. Pre-fix se
// inicializaba el SDK aunque NO se renderizaban native ads (las ads están
// en docs/adpick.html via Linking.openURL en GetPeaks.js). Sin el package:
// APK más liviano + permisos AD_ID/ACCESS_ADSERVICES_* + AppMeasurementJobService
// no se inyectan más en el manifest.
// LAZY LOAD: Don't import Notifications at module level - causes EventEmitter crash
// import * as Notifications from 'expo-notifications';
import { NavigationContainer } from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { onAuthStateChanged, signOut, setPersistence, browserLocalPersistence } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, ensureUser, db } from './src/firebase/client';
import audioManager from './src/utils/audioManager';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import UpdateModal from './src/components/UpdateModal';
import ErrorBoundary from './src/components/ErrorBoundary';
import { initSentry, Sentry } from './src/utils/sentry';

// Inicializar Sentry lo antes posible — antes de cualquier render para
// capturar errores tempranos (init de Firebase, lazy imports, etc.).
// Si EXPO_PUBLIC_SENTRY_DSN está vacío queda no-op.
initSentry();

import { APP_VERSION, TERMS_URL, compareVersions, StorageKeys } from './src/constants';
import Home from './src/screens/Home';
import ServerList from './src/screens/ServerList';
import ChainHistoryScreen from './src/screens/ChainHistoryScreen';
import ActivityScreen from './src/screens/ActivityScreen';
import Registration from './src/screens/Registration';
import Login from './src/screens/Login';
import { I18nProvider, useI18n } from './src/utils/i18n';
import { ServerProvider } from './src/utils/serverContext';
import { OverlayModalsProvider, useOverlayModals } from './src/components/OverlayModalsProvider';
import { navigationRef, navigate } from './src/utils/navigationRef';

const Drawer = createDrawerNavigator();
const Stack = createNativeStackNavigator();

function RootApp() {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState(null);
  const isFirstAuthCheck = useRef(true);
  const [updateInfo, setUpdateInfo] = useState(null); // { forceUpdate, latestVersion, downloadUrl, messageEn, messageEs }

  useEffect(() => {
    // LAZY LOAD: Load Notifications only when needed to avoid EventEmitter crash
    // HIGH (Round 2 Agente #10 HIGH-10-09): registrar
    // addNotificationResponseReceivedListener para que el TAP de un push
    // dispare deep-link a la screen relevante. Sin esto, el tap solo abre la
    // app en la última screen — el user que recibe "Tu NFT llegó!" no llega
    // automáticamente a MyGems.
    let responseSubscription = null;
    const setupNotifications = async () => {
      try {
        const Notifications = await import('expo-notifications');
        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldPlaySound: false,
            shouldSetBadge: false,
          }),
        });
        // Round 2 Agente #10 HIGH-10-10: canales Android granulares.
        // Pre-fix: solo 'default' channel → el user solo podía mute/unmute
        // el channel entero. Ahora 4 canales por tipo de notificación —
        // mute granular en Settings → App → Notificaciones.
        //
        // 'default' se conserva por backwards-compat con tokens viejos / push
        // mal-canalizadas.
        if (Platform.OS === 'android') {
          const baseChannel = {
            importance: Notifications.AndroidImportance.HIGH,
            sound: 'default',
            vibrationPattern: [0, 250, 250, 250],
          };
          await Notifications.setNotificationChannelAsync('default', { name: 'Default', ...baseChannel });
          await Notifications.setNotificationChannelAsync('mint', { name: 'NFT mints', description: 'When your gem is minted on Polygon', ...baseChannel });
          await Notifications.setNotificationChannelAsync('payment', { name: 'Pagos', description: 'Credit purchase confirmations', ...baseChannel });
          await Notifications.setNotificationChannelAsync('referral', { name: 'Referidos', description: 'Referral bonuses', ...baseChannel });
          // marketing: importance DEFAULT (no high-priority), siempre opt-out fácil.
          await Notifications.setNotificationChannelAsync('marketing', {
            name: 'Anuncios y novedades',
            description: 'Mensajes broadcast del equipo',
            importance: Notifications.AndroidImportance.DEFAULT,
            sound: 'default',
            vibrationPattern: [0, 250, 250, 250],
          });
        }
        // Round 2 #10 HIGH-10-09: deep-link al tap. Backend manda data.url
        // (e.g. 'exp+miningtheblocks://gems') en el payload de mint complete,
        // payment received, etc. Linking.openURL dispara el DeepLinkHandler
        // de abajo, que ya conoce el scheme.
        responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
          try {
            const data = response?.notification?.request?.content?.data || {};
            if (data && typeof data.url === 'string' && data.url.startsWith('exp+miningtheblocks://')) {
              Linking.openURL(data.url).catch(() => {});
            }
          } catch (handlerErr) {
            console.warn('Notification response handler error:', handlerErr?.message);
          }
        });
      } catch (e) {
        console.warn('Notifications setup failed:', e.message);
      }
    };

    // BAJO-APP-02: guardar el id del timer para limpiarlo en cleanup. Sin esto,
    // si el componente se desmonta en el primer segundo (hot-reload, navegación
    // muy rápida), setupNotifications corre con árbol React desmontado.
    const notifSetupTimer = setTimeout(setupNotifications, 1000);

    // MobileAds init removido en Commit Q — ads se sirven via docs/adpick.html.

    // CRIT-14: version check con anti-downgrade + cache (mismo patrón que
    // ServerList.js). Antes era getDoc one-shot sin protección: si Firebase
    // se compromete (o hay MITM al primer fetch en cold-start), un atacante
    // puede colocar un `latestVersion` inferior y desactivar la barrera.
    const VERSION_CACHE_KEY = '@mtb/lastSeenLatestVersion';
    const CONFIG_CACHE_KEY = '@mtb/cachedConfigApp';
    let cachedMax = null;

    const processConfig = (cfg, fromCache) => {
      const { minVersion, latestVersion, downloadUrl, forceUpdate, updateMessageEn, updateMessageEs } = cfg || {};
      let effectiveLatest = latestVersion;
      if (latestVersion) {
        if (cachedMax && compareVersions(latestVersion, cachedMax) < 0) {
          // Anti-downgrade: ignorar latestVersion menor al máximo histórico visto.
          effectiveLatest = cachedMax;
        } else if (!cachedMax || compareVersions(latestVersion, cachedMax) > 0) {
          cachedMax = latestVersion;
          if (!fromCache) AsyncStorage.setItem(VERSION_CACHE_KEY, latestVersion).catch(() => {});
        }
      }
      const needsForce = minVersion && compareVersions(APP_VERSION, minVersion) < 0;
      const needsSoft  = effectiveLatest && compareVersions(APP_VERSION, effectiveLatest) < 0;
      if (needsForce || needsSoft) {
        setUpdateInfo({ forceUpdate: needsForce || !!forceUpdate, latestVersion: effectiveLatest, downloadUrl, messageEn: updateMessageEn, messageEs: updateMessageEs });
      }
    };

    const checkVersion = async () => {
      try {
        if (!cachedMax) {
          try { cachedMax = await AsyncStorage.getItem(VERSION_CACHE_KEY); } catch {}
          // Fallback config cacheado (offline / Firebase outage al cold start)
          try {
            const cachedRaw = await AsyncStorage.getItem(CONFIG_CACHE_KEY);
            if (cachedRaw) processConfig(JSON.parse(cachedRaw), true);
          } catch {}
        }
        const snap = await getDoc(doc(db, 'config', 'app'));
        if (!snap.exists()) return;
        const cfg = snap.data();
        processConfig(cfg, false);
        AsyncStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg)).catch(() => {});
      } catch (e) {
        console.warn('Version check failed:', e && e.message);
      }
    };
    checkVersion();

    // Re-check when app comes back to foreground (throttle: 30s mínimo).
    let lastCheckAt = Date.now();
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && Date.now() - lastCheckAt > 30000) {
        lastCheckAt = Date.now();
        checkVersion();
      }
    });

    // CONFIGURAR PERSISTENCIA DE SESIÓN
    const setupAuth = async () => {
      try {
        if (Platform.OS === 'web') {
          try {
            await setPersistence(auth, browserLocalPersistence);
          } catch (pe) {
            console.warn('Failed to set web persistence:', pe?.message || pe);
          }
        }
      } catch (e) {
        console.warn('Auth persistence setup failed:', e.message);
      }
    };
    setupAuth();

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        // V1.1.0: sin modo anónimo. Si no hay user → null (App muestra Login).
        if (!u) {
          // Round 2 Agente #4 MEDIO-FE-21: teardown del audio cuando el user
          // hace signOut. Pre-fix: la música seguía sonando sobre la pantalla
          // de Login (~5MB residente + UX disonante). cleanup() es idempotente
          // y resetea flags para que un re-init después funcione.
          try { await audioManager.cleanup(); } catch (_) {}
          isFirstAuthCheck.current = false;
          setUser(null);
        } else if (isFirstAuthCheck.current) {
          // Cold start: Firebase restored a session — honor the "keep signed in" preference
          isFirstAuthCheck.current = false;
          const keepVal = await AsyncStorage.getItem(StorageKeys.KEEP_SIGNED_IN);
          if (keepVal === '0') {
            await signOut(auth);
            setUser(null);
            return;
          }
          // ALTO-42: gate también el cold start por email_verified.
          // Antes solo se gating en eventos posteriores, lo que permitía a un
          // usuario no verificado que se registró previamente quedar logueado
          // entre cold starts. Excepción: providers OAuth (google.com, etc.)
          // que verifican email upstream.
          const provider = u.providerData && u.providerData[0] && u.providerData[0].providerId;
          if (provider === 'password' && !u.emailVerified) {
            await signOut(auth);
            setUser(null);
            return;
          }
          setUser(u);
        } else {
          // Subsequent event (e.g. new account just created).
          // Don't navigate unverified users to the game — leave Registration on screen
          // so the verify-email modal can render. Verified users proceed normally.
          if (!u.emailVerified) return;
          setUser(u);
        }
      } finally {
        setInitializing(false);
      }
    });

    return () => {
      clearTimeout(notifSetupTimer);
      if (responseSubscription) {
        try { responseSubscription.remove(); } catch (_) {}
      }
      appStateSub.remove();
      unsub();
    };
  }, []);

  // Registrar permisos y guardar push token - LAZY LOADED
  // CRIT (Round 2 Agente #4 CRIT-FE-01 + Agente #10 HIGH-10-06): pre-permission
  // UI antes del system prompt nativo. Pre-fix: requestPermissionsAsync se
  // disparaba auto a los 2s del login sin contexto — Apple HIG y Google Play
  // recomiendan modal explicativo ANTES del prompt nativo, sino el user
  // rechaza por sorpresa y queda imposible de re-promptear sin deep-link a
  // Settings.
  //
  // Flow:
  //   1. Cold start con user logueado → leer AsyncStorage NOTIFICATIONS_CONSENT.
  //   2. Si 'yes' → setupPushToken (sin prompt nativo si ya está granted).
  //   3. Si 'no' → skip (no más prompts, respetar opt-out).
  //   4. Si absent → mostrar custom Alert explicando los 3 tipos de notif +
  //      "Activar" / "No gracias". Solo después de "Activar" se llama
  //      requestPermissionsAsync.
  useEffect(() => {
    if (!user) return;
    let active = true;
    const { I18nText } = {};  // shim para evitar import circular; usamos hardcoded EN strings con fallback

    const setupPushToken = async () => {
      try {
        if (!active) return;
        // LAZY LOAD: Import Notifications only when user is authenticated
        const Notifications = await import('expo-notifications');

        // Pedir permisos (ya con consent del user vía nuestro pre-prompt).
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted' || !active) return;

        // Usar token FCM nativo (funciona sin credenciales Expo)
        let tokenData;
        try {
          tokenData = await Notifications.getDevicePushTokenAsync();
        } catch (te) {
          console.warn('getDevicePushTokenAsync failed:', String(te));
          return;
        }
        if (!active) return;
        const token = tokenData?.data || null;
        if (!token) return;
        // Guardar en Firestore
        const ref = doc(db, 'users', user.uid);
        await setDoc(ref, {
          pushToken: token,
          pushTokenType: 'fcm',
          pushNotifications: { enabled: true, platform: Platform.OS, updatedAt: Date.now() },
        }, { merge: true });
      } catch (e) {
        console.warn('Push token setup failed:', String(e));
      }
    };

    const askConsentThenSetup = async () => {
      try {
        const stored = await AsyncStorage.getItem(StorageKeys.NOTIFICATIONS_CONSENT);
        if (stored === 'no') {
          // User opt-out previo — respetar, no preguntar más.
          return;
        }
        if (stored === 'yes') {
          // User opt-in previo — push token setup directo.
          return setupPushToken();
        }
        // No preguntado → mostrar pre-permission Alert.
        // Strings hardcoded EN/ES porque i18n context no es accesible desde acá.
        // El user todavía puede preferir el idioma device default; cuando vaya
        // a Profile/Config y vea las strings traducidas, ya estará consistente.
        const lang = Platform.OS === 'ios' ? 'en' : 'es'; // heurística simple; mejor sería leer settings.language post-login
        const strings = lang === 'es' ? {
          title: '¿Querés enterarte cuándo pasa algo?',
          body: 'Mandamos 3 tipos de notificaciones: cuando se mintea tu NFT, cuando se acredita un pago tuyo, y cuando llega un bonus de referido. Podés mutear cada categoría en Configuración. Sin spam.',
          accept: 'Activar',
          decline: 'No gracias',
        } : {
          title: 'Stay in the loop?',
          body: 'We send 3 kinds of notifications: when your NFT is minted, when your payment is credited, and when referral bonuses arrive. You can mute each category in Settings. No marketing spam.',
          accept: 'Enable',
          decline: 'No thanks',
        };
        Alert.alert(
          strings.title,
          strings.body,
          [
            {
              text: strings.decline,
              style: 'cancel',
              onPress: async () => {
                try { await AsyncStorage.setItem(StorageKeys.NOTIFICATIONS_CONSENT, 'no'); } catch {}
              },
            },
            {
              text: strings.accept,
              onPress: async () => {
                try { await AsyncStorage.setItem(StorageKeys.NOTIFICATIONS_CONSENT, 'yes'); } catch {}
                if (active) setupPushToken();
              },
            },
          ],
          { cancelable: false },
        );
      } catch (e) {
        console.warn('askConsentThenSetup error:', String(e));
      }
    };

    // Delay 2s para que el cold-start no compita con auth restore + push setup.
    const timer = setTimeout(askConsentThenSetup, 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [user]);



  if (initializing) return null;

  return (
    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#000' }}>
      <UpdateModal
        visible={!!updateInfo}
        forceUpdate={!!updateInfo?.forceUpdate}
        latestVersion={updateInfo?.latestVersion}
        downloadUrl={updateInfo?.downloadUrl}
        messageEn={updateInfo?.messageEn}
        messageEs={updateInfo?.messageEs}
        onDismiss={() => setUpdateInfo(null)}
      />
      <OverlayModalsProvider>
        <DeepLinkHandler />
        <NavigationContainer ref={navigationRef}>
          <RNStatusBar translucent={true} backgroundColor="transparent" barStyle="light-content" />
          {user ? (
            <Stack.Navigator
              key="game"
              screenOptions={{
                headerShown: false,
                statusBarTranslucent: true,
                contentStyle: { backgroundColor: '#000', paddingTop: 0, marginTop: 0 },
              }}
            >
              <Stack.Screen name="ServerList" component={ServerList} />
              <Stack.Screen name="ChainHistory" component={ChainHistoryScreen} />
              <Stack.Screen name="Activity" component={ActivityScreen} />
              <Stack.Screen name="GameDrawer" component={GameDrawer} />
              <Stack.Screen name="Registration" component={Registration} />
            </Stack.Navigator>
          ) : (
            <Stack.Navigator
              key="auth"
              screenOptions={{
                headerShown: false,
                statusBarTranslucent: true,
                contentStyle: { backgroundColor: '#000', paddingTop: 0, marginTop: 0 },
              }}
            >
              <Stack.Screen name="Login" component={Login} />
              <Stack.Screen name="Registration" component={Registration} />
            </Stack.Navigator>
          )}
        </NavigationContainer>
      </OverlayModalsProvider>
    </View>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <I18nProvider initialLanguage="en">
        <ServerProvider>
          <RootApp />
        </ServerProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}

// Sentry.wrap añade auto-tracking de navigation/screen + breadcrumbs de
// React lifecycle. Si Sentry no está inicializado (DSN vacío), wrap es
// efectivamente identity-función — no rompe nada.
export default Sentry.wrap(App);

function GameDrawer() {
  const { t } = useI18n();
  return (
    <Drawer.Navigator
      initialRouteName="Home"
      backBehavior="none"
      screenOptions={{
        headerShown: false,
        swipeEnabled: false,
        gestureEnabled: false,
        swipeEdgeWidth: 0,
        statusBarTranslucent: true,
        sceneContainerStyle: { backgroundColor: '#000', paddingTop: 0, marginTop: 0 },
      }}
      drawerContent={(props) => <CustomDrawerContent {...props} />}
    >
      <Drawer.Screen name="Home" component={Home} options={{ drawerLabel: () => <Text>{t('drawer.home')}</Text> }} />
      <Drawer.Screen
        name="Registration"
        component={Registration}
        options={{ drawerItemStyle: { height: 0 }, drawerLabel: () => null, title: '' }}
      />
    </Drawer.Navigator>
  );
}

function CustomDrawerContent(props) {
  const { t } = useI18n();
  const { openModal } = useOverlayModals();

  const handleSignOut = async () => {
    try {
      props.navigation.closeDrawer();
      await signOut(auth);
    } catch (e) {
      console.warn('Sign out error:', e);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000', paddingTop: 40 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Text style={{ color: '#999', fontWeight: '800', fontSize: 12 }}>{t('drawer.menu')}</Text>
      </View>
      <DrawerItem label={t('drawer.home')} onPress={() => props.navigation.navigate('Home')} />
      <DrawerItem label={t('drawer.activity')} onPress={() => { props.navigation.closeDrawer(); navigate('Activity'); }} />
      <DrawerItem label={t('drawer.servers')} onPress={() => { props.navigation.closeDrawer(); navigate('ServerList'); }} />
      <DrawerItem label={t('drawer.profile')} onPress={() => { props.navigation.closeDrawer(); openModal('profile'); }} />
      <DrawerItem label={t('drawer.config')} onPress={() => { props.navigation.closeDrawer(); openModal('config'); }} />
      <DrawerItem label={t('drawer.gems')} onPress={() => { props.navigation.closeDrawer(); openModal('gems'); }} />
      <DrawerItem label={t('drawer.getPeaks')} onPress={() => { props.navigation.closeDrawer(); openModal('peaks'); }} />
      <DrawerItem label={t('drawer.buyCredits')} onPress={() => { props.navigation.closeDrawer(); openModal('buyCredits'); }} />

      {/* Separador */}
      <View style={{ height: 1, backgroundColor: '#333', marginVertical: 8, marginHorizontal: 16 }} />

      <DrawerItem label={t('drawer.report')} onPress={() => { props.navigation.closeDrawer(); openModal('report'); }} />
      <DrawerItem label={t('drawer.terms')} onPress={() => { props.navigation.closeDrawer(); Linking.openURL(TERMS_URL).catch(() => {}); }} dim />
      <DrawerItem label={t('drawer.signOut')} onPress={handleSignOut} />
    </View>
  );
}

function DrawerItem({ label, onPress, dim = false }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={{ paddingVertical: 14, paddingHorizontal: 16 }}>
      <Text style={{ color: dim ? '#555' : '#ccc', fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function DeepLinkHandler() {
  const { openModal } = useOverlayModals();

  useEffect(() => {
    const handle = ({ url }) => {
      // Round 2 #10 HIGH-10-09: ampliado a más URLs. Backend manda data.url
      // en push payloads (mint complete → gems, payment → servers, etc.).
      // El response listener llama Linking.openURL que entra acá.
      // Round 2 #9 MED-09-13: aceptar también el nuevo scheme `mtb://`.
      if (!url) return;
      let host = '';
      if (url.startsWith('exp+miningtheblocks://')) {
        host = url.replace('exp+miningtheblocks://', '').split(/[?\/]/)[0].toLowerCase();
      } else if (url.startsWith('mtb://')) {
        host = url.replace('mtb://', '').split(/[?\/]/)[0].toLowerCase();
      } else {
        return;
      }
      switch (host) {
        case 'peaks':       openModal('peaks');      break;
        case 'gems':
        case 'mygems':      openModal('gems');       break;
        case 'profile':     openModal('profile');    break;
        case 'buycredits':  openModal('buyCredits'); break;
        case 'config':      openModal('config');     break;
        case 'servers':     navigate('ServerList');  break;
        default: /* unknown host — ignore */         break;
      }
    };
    Linking.getInitialURL().then(url => { if (url) handle({ url }); }).catch(() => {});
    const sub = Linking.addEventListener('url', handle);
    return () => sub.remove();
  }, [openModal]);

  return null;
}
