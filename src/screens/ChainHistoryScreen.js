import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/client';
import { useI18n } from '../utils/i18n';
import { useOverlayModals } from '../components/OverlayModalsProvider';

const EVENT_ICONS = {
  mine: '⛏',
  episode_complete: '🏆',
  episode_start: '🔄',
};

const EVENT_COLORS = {
  mine: '#4a9eff',
  episode_complete: '#ffd700',
  episode_start: '#5cb85c',
};

function formatDate(ts) {
  if (!ts) return '—';
  const ms = typeof ts === 'number' ? ts : (ts?.toMillis ? ts.toMillis() : Number(ts));
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SeqBadge({ seq, color }) {
  if (!seq) return null;
  return (
    <View style={[styles.seqBadge, { borderColor: color + '40' }]}>
      <Text style={[styles.seqTxt, { color: color + 'cc' }]}>#{seq}</Text>
    </View>
  );
}

function EventRow({ item, t }) {
  const color = EVENT_COLORS[item.type] || '#aaa';
  const icon = EVENT_ICONS[item.type] || '•';

  if (item.type === 'mine') {
    return (
      <View style={styles.row}>
        <View style={styles.leftCol}>
          <SeqBadge seq={item.seq} color={color} />
          <View style={[styles.iconBadge, { backgroundColor: color + '18', borderColor: color + '40' }]}>
            <Text style={styles.iconText}>{icon}</Text>
          </View>
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowTitle, { color }]} numberOfLines={1}>
              {item.displayName || t('chainHistory.player')}
            </Text>
            {item.rewardPicks > 0 && (
              <View style={styles.rewardBadge}>
                <Text style={styles.rewardTxt}>+{item.rewardPicks} ⛏</Text>
              </View>
            )}
          </View>
          <Text style={styles.rowSub}>
            #{item.cubeNumber ?? '—'}
            {item.layerK != null ? `  ·  ${t('chainHistory.layer')} ${item.layerK}` : ''}
            {item.episodeNumber != null ? `  ·  Ep.${item.episodeNumber}` : ''}
          </Text>
          <Text style={styles.rowDate}>{formatDate(item.ts)}</Text>
        </View>
      </View>
    );
  }

  if (item.type === 'episode_complete') {
    return (
      <View style={[styles.row, styles.rowEpisode]}>
        <View style={styles.leftCol}>
          <SeqBadge seq={item.seq} color={color} />
          <View style={[styles.iconBadge, { backgroundColor: color + '18', borderColor: color + '40' }]}>
            <Text style={styles.iconText}>{icon}</Text>
          </View>
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.rowTitle, { color }]}>
            {t('chainHistory.episodeComplete').replace('{n}', item.episodeNumber ?? '—')}
          </Text>
          <Text style={styles.rowSub}>
            {t('chainHistory.winner').replace('{name}', item.displayName || t('chainHistory.player'))}
            {item.totalMined ? `  ${t('chainHistory.blocks').replace('{n}', item.totalMined)}` : ''}
          </Text>
          <Text style={styles.rowDate}>{formatDate(item.ts)}</Text>
        </View>
      </View>
    );
  }

  if (item.type === 'episode_start') {
    return (
      <View style={[styles.row, styles.rowEpisode]}>
        <View style={styles.leftCol}>
          <SeqBadge seq={item.seq} color={color} />
          <View style={[styles.iconBadge, { backgroundColor: color + '18', borderColor: color + '40' }]}>
            <Text style={styles.iconText}>{icon}</Text>
          </View>
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.rowTitle, { color }]}>
            {t('chainHistory.episodeStart').replace('{n}', item.episodeNumber ?? '—')}
          </Text>
          <Text style={styles.rowDate}>{formatDate(item.ts)}</Text>
        </View>
      </View>
    );
  }

  return null;
}

export default function ChainHistoryScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { t } = useI18n();
  const { openModal } = useOverlayModals();
  const { chainId, chainName } = route.params || {};

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!chainId) return;
    setLoading(true);
    const q = query(
      collection(db, 'serverChains', chainId, 'history'),
      orderBy('seq', 'desc'),
      limit(500),
    );
    const unsub = onSnapshot(q, (snap) => {
      setEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return () => unsub();
  }, [chainId]);

  const renderItem = useCallback(({ item }) => <EventRow item={item} t={t} />, [t]);
  const keyExtractor = useCallback((item) => item.id, []);

  const lastSeq = events.length > 0 ? (events[0]?.seq ?? events.length) : 0;

  return (
    <SafeAreaView style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.8}>
          <Text style={styles.backArrow}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t('chainHistory.title')}</Text>
          <Text style={styles.headerSub} numberOfLines={1}>{chainName || t('chainHistory.chain')}</Text>
        </View>
        {lastSeq > 0 ? (
          <View style={styles.totalBadge}>
            <Text style={styles.totalTxt}>{lastSeq}</Text>
            <Text style={styles.totalLabel}>{t('chainHistory.records')}</Text>
          </View>
        ) : (
          <View style={{ width: 56 }} />
        )}
      </View>

      <View style={styles.divider} />

      {/* Content */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#4a9eff" size="large" />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyTxt}>{t('chainHistory.empty')}</Text>
          <Text style={styles.emptySub}>{t('chainHistory.emptySub')}</Text>
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          maxToRenderPerBatch={25}
          windowSize={7}
        />
      )}

      {/* Report button */}
      <TouchableOpacity style={styles.reportBtn} onPress={() => openModal('report')} activeOpacity={0.8}>
        <Text style={styles.reportTxt}>⚠ {t('login.report')}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 16,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backArrow: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '300',
    lineHeight: 30,
    marginTop: -2,
  },
  headerCenter: {
    flex: 1,
    paddingHorizontal: 14,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
  },
  headerSub: {
    color: '#555',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 1,
  },
  totalBadge: {
    width: 56,
    alignItems: 'center',
    backgroundColor: '#111',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#252525',
    paddingVertical: 6,
  },
  totalTxt: {
    color: '#ccc',
    fontSize: 14,
    fontWeight: '900',
  },
  totalLabel: {
    color: '#555',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: '#141414',
    marginHorizontal: 16,
  },

  // States
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 60,
  },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTxt: { color: '#777', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  emptySub: { color: '#444', fontSize: 13, marginTop: 6, textAlign: 'center' },

  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 40,
  },

  // Rows
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#0f0f0f',
  },
  rowEpisode: {
    backgroundColor: '#080808',
    marginHorizontal: -16,
    paddingHorizontal: 16,
  },

  // Left column
  leftCol: {
    alignItems: 'center',
    width: 44,
    marginRight: 14,
    flexShrink: 0,
  },
  seqBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginBottom: 5,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  seqTxt: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  iconBadge: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontSize: 15 },

  // Row body
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowTitle: { fontSize: 14, fontWeight: '800' },
  rowSub: { color: '#555', fontSize: 12, marginTop: 3 },
  rowDate: { color: '#383838', fontSize: 11, marginTop: 3 },

  rewardBadge: {
    backgroundColor: '#0c1805',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#1e4010',
  },
  rewardTxt: { color: '#6ab060', fontSize: 11, fontWeight: '700' },

  reportBtn: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 20, marginBottom: 8 },
  reportTxt: { color: '#444', fontWeight: '700', fontSize: 13 },
});
