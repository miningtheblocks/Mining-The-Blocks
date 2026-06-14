import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ScrollView } from 'react-native';
import { ensureUser, auth, db } from '../firebase/client';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useI18n, languages } from '../utils/i18n';
// BAJO-CFG-07: import `navigate` removido — no se usa en este archivo.
import audioManager from '../utils/audioManager';
export default function Config({ asModal = false, onClose }) {
  const { t, language, setLanguage } = useI18n();

  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [photoURL, setPhotoURL] = useState(null);
  const [notifyAdReady, setNotifyAdReady] = useState(true);
  const [notifyDaily, setNotifyDaily] = useState(true);
  const [notifyRewards, setNotifyRewards] = useState(true);
  const [notifyNewLayer, setNotifyNewLayer] = useState(true);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [musicVolumeFactor, setMusicVolumeFactor] = useState(1.0);
  const [sfxVolumeFactor, setSfxVolumeFactor] = useState(1.0);
  const musicBarRef = useRef(null);
  const sfxBarRef = useRef(null);
  const settingsRef = useRef({});
  const sliderSaveTimer = useRef(null);

  const load = async () => {
    setLoading(true);
    await ensureUser();
    const uid = auth.currentUser?.uid;
    if (!uid) { setLoading(false); return; }
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    setDisplayName(data?.displayName || `user-${uid.slice(0,6)}`);
    setPhotoURL(data?.photoURL || null);
    const settings = data?.settings || {};
    setNotifyAdReady(settings?.notifyAdReady ?? true);
    setNotifyDaily(settings?.notifyDaily ?? true);
    setNotifyRewards(settings?.notifyRewards ?? true);
    setNotifyNewLayer(settings?.notifyNewLayer ?? true);
    setMusicEnabled(settings?.musicEnabled ?? true);
    setSoundEnabled(settings?.soundEnabled ?? true);
    const mvf = typeof settings?.musicVolumeFactor === 'number' ? Math.max(0, Math.min(1, settings.musicVolumeFactor)) : 1.0;
    const svf = typeof settings?.sfxVolumeFactor === 'number' ? Math.max(0, Math.min(1, settings.sfxVolumeFactor)) : 1.0;
    setMusicVolumeFactor(mvf);
    setSfxVolumeFactor(svf);
    try { await audioManager.setMusicVolumeFactor(mvf); } catch {}
    try { audioManager.setSfxVolumeFactor(svf); } catch {}
    settingsRef.current = {
      notifyAdReady: settings?.notifyAdReady ?? true,
      notifyDaily: settings?.notifyDaily ?? true,
      notifyRewards: settings?.notifyRewards ?? true,
      notifyNewLayer: settings?.notifyNewLayer ?? true,
      musicEnabled: settings?.musicEnabled ?? true,
      soundEnabled: settings?.soundEnabled ?? true,
      musicVolumeFactor: mvf,
      sfxVolumeFactor: svf,
    };
    setLoading(false);
  };

  const saveSettings = async (partial) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    settingsRef.current = { ...settingsRef.current, ...partial };
    const ref = doc(db, 'users', uid);
    await setDoc(ref, { settings: settingsRef.current }, { merge: true });
  };

  useEffect(() => { load(); }, []);

  // BAJO-CFG-03: limpiar sliderSaveTimer en unmount para no escribir a Firestore
  // después de que el modal de Config se cerró (puede dispararse con uid del
  // usuario anterior si hubo sign-out entre el slider move y el debounce de 400ms).
  useEffect(() => {
    return () => {
      if (sliderSaveTimer.current) {
        clearTimeout(sliderSaveTimer.current);
        sliderSaveTimer.current = null;
      }
    };
  }, []);

  const toggle = async (key, value) => {
    if (key === 'notifyAdReady') setNotifyAdReady(value);
    if (key === 'notifyDaily') setNotifyDaily(value);
    if (key === 'notifyRewards') setNotifyRewards(value);
    if (key === 'notifyNewLayer') setNotifyNewLayer(value);
    if (key === 'musicEnabled') setMusicEnabled(value);
    if (key === 'soundEnabled') setSoundEnabled(value);
    await saveSettings({ [key]: value });
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const onBarPress = async (evt, type) => {
    try {
      const ref = type === 'music' ? musicBarRef.current : sfxBarRef.current;
      if (!ref) return;
      ref.measure?.((x, y, width, height, pageX, pageY) => {
        const touchX = evt.nativeEvent.pageX - pageX;
        const factor = clamp01(touchX / width);
        if (type === 'music') {
          setMusicVolumeFactor(factor);
          audioManager.setMusicVolumeFactor(factor);
          if (sliderSaveTimer.current) clearTimeout(sliderSaveTimer.current);
          sliderSaveTimer.current = setTimeout(() => saveSettings({ musicVolumeFactor: factor }), 400);
        } else {
          setSfxVolumeFactor(factor);
          audioManager.setSfxVolumeFactor(factor);
          if (sliderSaveTimer.current) clearTimeout(sliderSaveTimer.current);
          sliderSaveTimer.current = setTimeout(() => saveSettings({ sfxVolumeFactor: factor }), 400);
        }
      });
    } catch {}
  };

  const knobLeft = (factor) => ({ left: `${(clamp01(factor) * 100).toFixed(2)}%` });

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Perfil */}
        <View style={styles.profileCard}>
          <View style={styles.profileRow}>
            <Image
              source={photoURL ? { uri: photoURL } : require('../../assets/icon.png')}
              style={styles.avatar}
            />
            <View style={{ marginLeft: 12 }}>
              <Text style={styles.username}>{displayName}</Text>
              <Text style={styles.subtle}>UID: {auth.currentUser?.uid?.slice(0,6)}…</Text>
            </View>
          </View>
        </View>

        {/* Audio */}
        <Text style={styles.sectionLabel}>🎵 {t('config.music')}</Text>
        <View style={[styles.cardRow, { flexDirection: 'column', alignItems: 'stretch', gap: 10 }]}>
          <Text style={styles.cardTitleRow}>{t('config.music')}</Text>
          <View style={styles.sliderRowInline}>
            <View
              ref={musicBarRef}
              style={styles.sliderBar}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(e) => onBarPress(e, 'music')}
              onResponderMove={(e) => onBarPress(e, 'music')}
            >
              <View style={[styles.sliderFill, { width: `${(clamp01(musicVolumeFactor) * 100).toFixed(2)}%` }]} />
              <View style={[styles.sliderKnob, knobLeft(musicVolumeFactor)]} />
            </View>
            <Text style={styles.sliderPct}>{Math.round(musicVolumeFactor * 100)}%</Text>
          </View>
        </View>

        <View style={[styles.cardRow, { flexDirection: 'column', alignItems: 'stretch', gap: 10, marginTop: 6 }]}>
          <Text style={styles.cardTitleRow}>{t('config.soundEffects')}</Text>
          <View style={styles.sliderRowInline}>
            <View
              ref={sfxBarRef}
              style={styles.sliderBar}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(e) => onBarPress(e, 'sfx')}
              onResponderMove={(e) => onBarPress(e, 'sfx')}
            >
              <View style={[styles.sliderFill, { width: `${(clamp01(sfxVolumeFactor) * 100).toFixed(2)}%` }]} />
              <View style={[styles.sliderKnob, knobLeft(sfxVolumeFactor)]} />
            </View>
            <Text style={styles.sliderPct}>{Math.round(sfxVolumeFactor * 100)}%</Text>
          </View>
        </View>

        {/* Notificaciones */}
        <Text style={styles.sectionLabel}>🔔 {t('config.adReady')}</Text>
        <View style={styles.cardRow}>
          <Text style={styles.cardTitleRow}>{t('config.adReady')}</Text>
          <TouchableOpacity
            style={[styles.toggleBtn, notifyAdReady && styles.toggleBtnOn]}
            onPress={() => toggle('notifyAdReady', !notifyAdReady)}
            activeOpacity={0.85}
          >
            <Text style={[styles.toggleTxt, notifyAdReady && styles.toggleTxtOn]}>
              {notifyAdReady ? t('common.on') : t('common.off')}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.cardRow}>
          <Text style={styles.cardTitleRow}>{t('config.dailyReady')}</Text>
          <TouchableOpacity
            style={[styles.toggleBtn, notifyDaily && styles.toggleBtnOn]}
            onPress={() => toggle('notifyDaily', !notifyDaily)}
            activeOpacity={0.85}
          >
            <Text style={[styles.toggleTxt, notifyDaily && styles.toggleTxtOn]}>
              {notifyDaily ? t('common.on') : t('common.off')}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.cardRow}>
          <Text style={styles.cardTitleRow}>{t('config.rewardsAdded')}</Text>
          <TouchableOpacity
            style={[styles.toggleBtn, notifyRewards && styles.toggleBtnOn]}
            onPress={() => toggle('notifyRewards', !notifyRewards)}
            activeOpacity={0.85}
          >
            <Text style={[styles.toggleTxt, notifyRewards && styles.toggleTxtOn]}>
              {notifyRewards ? t('common.on') : t('common.off')}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.cardRow}>
          <Text style={styles.cardTitleRow}>{t('config.newLayer')}</Text>
          <TouchableOpacity
            style={[styles.toggleBtn, notifyNewLayer && styles.toggleBtnOn]}
            onPress={() => toggle('notifyNewLayer', !notifyNewLayer)}
            activeOpacity={0.85}
          >
            <Text style={[styles.toggleTxt, notifyNewLayer && styles.toggleTxtOn]}>
              {notifyNewLayer ? t('common.on') : t('common.off')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Idioma */}
        <Text style={styles.sectionLabel}>🌐 {t('config.language')}</Text>
        <View style={styles.cardRow}>
          <Text style={styles.cardTitleRow}>{t('config.language')}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={[styles.toggleBtn, language === 'en' && styles.toggleBtnOn]}
              onPress={() => setLanguage('en')}
              activeOpacity={0.85}
            >
              <Text style={[styles.toggleTxt, language === 'en' && styles.toggleTxtOn]}>{t('config.english')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleBtn, language === 'es' && styles.toggleBtnOn]}
              onPress={() => setLanguage('es')}
              activeOpacity={0.85}
            >
              <Text style={[styles.toggleTxt, language === 'es' && styles.toggleTxtOn]}>{t('config.spanish')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: 16 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { paddingTop: 8, paddingHorizontal: 4, paddingBottom: 8 },

  sectionLabel: {
    color: '#555',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 18,
    marginBottom: 6,
    marginLeft: 2,
  },

  profileCard: {
    width: '100%',
    backgroundColor: '#111',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#222',
    marginBottom: 4,
  },
  profileRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#222', borderWidth: 2, borderColor: '#333' },
  username: { fontSize: 17, fontWeight: '800', color: '#fff' },
  subtle: { fontSize: 11, color: '#555', marginTop: 3, fontFamily: 'monospace' },

  cardRow: {
    width: '100%',
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitleRow: { fontSize: 15, fontWeight: '700', color: '#ccc', flex: 1 },

  toggleBtn: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
  },
  toggleBtnOn: {
    backgroundColor: '#1a1400',
    borderColor: '#ffd700',
  },
  toggleTxt: { fontSize: 13, fontWeight: '800', color: '#555' },
  toggleTxtOn: { color: '#ffd700' },

  // Sliders
  sliderRowInline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sliderBar: {
    flex: 1,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    overflow: 'visible',
    justifyContent: 'center',
  },
  sliderFill: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    backgroundColor: '#ffd70033',
    borderRadius: 7,
  },
  sliderKnob: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#ffd700',
    top: -4,
    marginLeft: -10,
    borderWidth: 2,
    borderColor: '#0a0a0a',
    shadowColor: '#ffd700',
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 4,
  },
  sliderPct: { width: 44, textAlign: 'right', color: '#888', fontWeight: '700', fontSize: 12 },
});
