import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, SafeAreaView, TouchableOpacity } from 'react-native';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/client';
import { useNavigation } from '@react-navigation/native';
import { useI18n } from '../utils/i18n';
import { GEMS } from '../utils/gems';

function formatTimeAgo(ts, t) {
  if (!ts) return '';
  const diff = Date.now() - (typeof ts === 'number' ? ts : (ts?.toMillis ? ts.toMillis() : Number(ts)));
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('activity.timeNow');
  if (m < 60) return t('activity.timeMin').replace('{m}', m);
  const h = Math.floor(m / 60);
  if (h < 24) return t('activity.timeHour').replace('{h}', h);
  return t('activity.timeDay').replace('{d}', Math.floor(h / 24));
}

function EventRow({ item, t, language }) {
  const chainLabel = item.chainName || t('activity.chain');

  if (item.type === 'gem_found') {
    const gem = GEMS[item.gemTier - 1];
    const color = gem?.glowColor || '#ffd700';
    const gemDisplayName = gem ? (language === 'en' ? gem.nameEn : gem.name) : item.gemName;
    return (
      <View style={[styles.row, { borderLeftColor: color }]}>
        <Text style={[styles.icon, { color }]}>💎</Text>
        <View style={styles.body}>
          <Text style={[styles.title, { color }]}>
            {gemDisplayName} — ${(item.priceUSD || 0).toLocaleString()}
          </Text>
          <Text style={styles.sub}>
            {t('activity.gemFoundSub')
              .replace('{k}', item.layerK ?? '—')
              .replace('{chain}', chainLabel)
              .replace('{ep}', item.episodeNumber ?? 1)}
          </Text>
        </View>
        <Text style={styles.time}>{formatTimeAgo(item.ts, t)}</Text>
      </View>
    );
  }

  if (item.type === 'layer_complete') {
    return (
      <View style={[styles.row, { borderLeftColor: '#4a9eff' }]}>
        <Text style={styles.icon}>🏔️</Text>
        <View style={styles.body}>
          <Text style={[styles.title, { color: '#4a9eff' }]}>
            {t('activity.layerCompletedTitle').replace('{k}', item.layerK)}
          </Text>
          <Text style={styles.sub}>
            {t('activity.layerNextSub')
              .replace('{chain}', chainLabel)
              .replace('{k}', item.nextLayerK)}
          </Text>
        </View>
        <Text style={styles.time}>{formatTimeAgo(item.ts, t)}</Text>
      </View>
    );
  }

  if (item.type === 'episode_complete') {
    return (
      <View style={[styles.row, { borderLeftColor: '#ffd700' }]}>
        <Text style={styles.icon}>🏆</Text>
        <View style={styles.body}>
          <Text style={[styles.title, { color: '#ffd700' }]}>
            {t('activity.episodeTitle').replace('{n}', item.episodeNumber)}
          </Text>
          <Text style={styles.sub}>
            {t('activity.episodeSub')
              .replace('{chain}', chainLabel)
              .replace('{n}', (item.totalMined || 0).toLocaleString())}
          </Text>
        </View>
        <Text style={styles.time}>{formatTimeAgo(item.ts, t)}</Text>
      </View>
    );
  }

  if (item.type === 'player_joined') {
    return (
      <View style={[styles.row, { borderLeftColor: '#5cb85c' }]}>
        <Text style={styles.icon}>👤</Text>
        <View style={styles.body}>
          <Text style={[styles.title, { color: '#5cb85c' }]}>{t('activity.playerJoinedTitle')}</Text>
          <Text style={styles.sub}>{chainLabel}</Text>
        </View>
        <Text style={styles.time}>{formatTimeAgo(item.ts, t)}</Text>
      </View>
    );
  }

  return null;
}

export default function ActivityScreen() {
  const navigation = useNavigation();
  const { t, language } = useI18n();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(
      collection(db, 'activityFeed'),
      orderBy('ts', 'desc'),
      limit(100),
    );
    const unsub = onSnapshot(q, (snap) => {
      setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return () => unsub();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backTxt}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('activity.title')}</Text>
        <View style={styles.dot} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <Text style={styles.loadingTxt}>{t('activity.loading')}</Text>
        </View>
      ) : events.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTxt}>{t('activity.empty')}</Text>
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={i => i.id}
          renderItem={({ item }) => <EventRow item={item} t={t} language={language} />}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1e1e2e',
  },
  back: { padding: 4, marginRight: 8 },
  backTxt: { color: '#aaa', fontSize: 20 },
  headerTitle: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '700' },
  dot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: '#5cb85c',
    shadowColor: '#5cb85c', shadowRadius: 4, shadowOpacity: 0.8,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingTxt: { color: '#666' },
  emptyTxt: { color: '#555', fontSize: 15 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 16,
    borderLeftWidth: 3, marginHorizontal: 12,
    marginTop: 8, borderRadius: 6,
    backgroundColor: '#12121a',
  },
  icon: { fontSize: 22, marginRight: 12 },
  body: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  sub: { fontSize: 12, color: '#888' },
  time: { fontSize: 11, color: '#555', marginLeft: 8 },
});
