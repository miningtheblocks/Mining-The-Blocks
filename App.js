import React, { useEffect, useState } from 'react';
import { StatusBar as RNStatusBar, Platform, Text, View, TouchableOpacity, Linking, AppState } from 'react-native';
import MobileAds from 'react-native-google-mobile-ads';
// LAZY LOAD: Don't import Notifications at module level - causes EventEmitter crash
// import * as Notifications from 'expo-notifications';
import { NavigationContainer } from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { onAuthStateChanged, signOut, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { auth, ensureAnonLogin, db } from './src/firebase/client';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import UpdateModal from './src/components/UpdateModal';

const APP_VERSION = '1.0.0';
const TERMS_URL = 'https://miningtheblocks.github.io/Mining-The-Blocks/terms.html';

function compareVersions(v1, v2) {
  const a = (v1 || '0').split('.').map(Number);
  const b = (v2 || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) < (b[i] || 0)) return -1;
    if ((a[i] || 0) > (b[i] || 0)) return 1;
  }
  return 0;
}
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
  const { t } = useI18n();
  const [updateInfo, setUpdateInfo] = useState(null); // { forceUpdate, latestVersion, downloadUrl, messageEn, messageEs }
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    // LAZY LOAD: Load Notifications only when needed to avoid EventEmitter crash
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
      } catch (e) {
        console.warn('Notifications setup failed:', e.message);
      }
    };
    
    // Delay notifications setup to ensure React Native is fully ready
    setTimeout(setupNotifications, 1000);

    MobileAds().initialize().catch(e => console.warn('MobileAds init failed:', e?.message));

    // Version check against Firestore config/app
    const checkVersion = async () => {
      try {
        const snap = await getDoc(doc(db, 'config', 'app'));
        if (!snap.exists()) return;
        const cfg = snap.data();
        const { minVersion, latestVersion, downloadUrl, forceUpdate, updateMessageEn, updateMessageEs } = cfg;
        const needsForce = minVersion && compareVersions(APP_VERSION, minVersion) < 0;
        const needsSoft  = latestVersion && compareVersions(APP_VERSION, latestVersion) < 0;
        if (needsForce || needsSoft) {
          setUpdateInfo({ forceUpdate: needsForce || !!forceUpdate, latestVersion, downloadUrl, messageEn: updateMessageEn, messageEs: updateMessageEs });
        }
      } catch (e) {
        console.warn('Version check failed:', e.message);
      }
    };
    checkVersion();

    // Re-check when app comes back to foreground
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') checkVersion();
    });
    return () => appStateSub.remove();

    // CONFIGURAR PERSISTENCIA DE SESIÓN
    const setupAuth = async () => {
      try {
        // Web: forzar persistencia local (mantiene sesión tras refresh)
        if (Platform.OS === 'web') {
          try {
            await setPersistence(auth, browserLocalPersistence);
          } catch (pe) {
            console.warn('Failed to set web persistence:', pe?.message || pe);
          }
        } else {
          // En React Native, Firebase usa AsyncStorage y persiste por defecto
        }
      } catch (e) {
        console.warn('Auth persistence setup failed:', e.message);
      }
    };
    setupAuth();

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        if (!u) {
          setUser(null); // Mostrar pantalla de login
        } else {
          setUser(u);
        }
      } finally {
        setInitializing(false);
      }
    });
    return () => unsub();
  }, []);

  // Registrar permisos y guardar push token - LAZY LOADED
  useEffect(() => {
    if (!user) return;
    let active = true;
    
    const setupPushToken = async () => {
      try {
        // LAZY LOAD: Import Notifications only when user is authenticated
        const Notifications = await import('expo-notifications');
        
        // Pedir permisos
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted') {
          return;
        }
        // Obtener token Expo
        const tokenData = await Notifications.getExpoPushTokenAsync();
        const token = tokenData?.data || null;
        if (!token) return;
        // Guardar en Firestore
        const ref = doc(db, 'users', user.uid);
        await setDoc(ref, {
          pushToken: token,
          pushNotifications: { enabled: true, platform: Platform.OS, updatedAt: Date.now() },
        }, { merge: true });
      } catch (e) {
        console.warn('Push token setup failed:', e.message);
      }
    };
    
    // Delay push token setup to ensure everything is ready
    setTimeout(setupPushToken, 2000);
    
    return () => { active = false; };
  }, [user]);



  if (initializing) return null;

  const showUpdate = !!updateInfo && (updateInfo.forceUpdate || !updateDismissed);

  return (
    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#000' }}>
      <UpdateModal
        visible={showUpdate}
        forceUpdate={updateInfo?.forceUpdate}
        latestVersion={updateInfo?.latestVersion}
        downloadUrl={updateInfo?.downloadUrl}
        messageEn={updateInfo?.messageEn}
        messageEs={updateInfo?.messageEs}
        onDismiss={() => setUpdateDismissed(true)}
      />
      <OverlayModalsProvider>
        <NavigationContainer ref={navigationRef}>
          <RNStatusBar translucent={true} backgroundColor="transparent" barStyle="light-content" />
          {user ? (
            <Stack.Navigator
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

export default function App() {
  return (
    <I18nProvider initialLanguage="en">
      <ServerProvider>
        <RootApp />
      </ServerProvider>
    </I18nProvider>
  );
}

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
        <Text style={{ color: '#999', fontWeight: '800', fontSize: 12 }}>Menu</Text>
      </View>
      <DrawerItem label={t('drawer.home')} onPress={() => props.navigation.navigate('Home')} />
      <DrawerItem label={t('drawer.activity')} onPress={() => { props.navigation.closeDrawer(); navigate('Activity'); }} />
      <DrawerItem label={t('drawer.servers')} onPress={() => { props.navigation.closeDrawer(); navigate('ServerList'); }} />
      <DrawerItem label={t('drawer.profile')} onPress={() => { props.navigation.closeDrawer(); openModal('profile'); }} />
      <DrawerItem label={t('drawer.config')} onPress={() => { props.navigation.closeDrawer(); openModal('config'); }} />
      <DrawerItem label={t('drawer.gems')} onPress={() => { props.navigation.closeDrawer(); openModal('gems'); }} />
      <DrawerItem label={t('drawer.getPeaks')} onPress={() => { props.navigation.closeDrawer(); openModal('peaks'); }} />
      <DrawerItem label={t('drawer.subscribe')} onPress={() => { props.navigation.closeDrawer(); openModal('subscribe'); }} />
      <DrawerItem label={t('drawer.buyCredits')} onPress={() => { props.navigation.closeDrawer(); openModal('buyCredits'); }} />

      {/* Separador */}
      <View style={{ height: 1, backgroundColor: '#333', marginVertical: 8, marginHorizontal: 16 }} />

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
