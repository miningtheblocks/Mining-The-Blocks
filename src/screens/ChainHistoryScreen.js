import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, TextInput,
  StyleSheet, ActivityIndicator, SafeAreaView, Linking,
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
  episode_redeemed: '💸',
};

const EVENT_COLORS = {
  mine: '#4a9eff',
  episode_complete: '#ffd700',
  episode_start: '#5cb85c',
  episode_redeemed: '#22c55e',
};

// Trunca una wallet 0x123456789abcdef... a 0x1234...cdef para UI.
function shortWallet(w) {
  if (!w || typeof w !== 'string') return '—';
  if (w.length < 12) return w;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

// Audit feedback 2026-06-23+: tx hashes públicos en Polygonscan post-canje.
// El user puede tap para abrir el tx en Polygon explorer y verificar.
function openPolygonscanTx(txHash) {
  if (!txHash) return;
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return;
  Linking.openURL(`https://polygonscan.com/tx/${txHash}`).catch(() => {});
}
function openPolygonscanAddr(addr) {
  if (!addr) return;
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return;
  Linking.openURL(`https://polygonscan.com/address/${addr}`).catch(() => {});
}

function formatDate(ts) {
  if (!ts) return '—';
  const ms = typeof ts === 'number' ? ts : (ts?.toMillis ? ts.toMillis() : Number(ts));
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Audit feedback 2026-06-23+: pill tipo "filter chip" para el toggle de
// tipo de evento. Variante activa con fondo + border más visibles.
function Pill({ active, onPress, color = '#5cb85c', children }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[
        pillStyles.pill,
        active && { backgroundColor: color + '22', borderColor: color },
      ]}
    >
      <Text style={[pillStyles.pillTxt, active && { color }]}>{children}</Text>
    </TouchableOpacity>
  );
}

const pillStyles = StyleSheet.create({
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    backgroundColor: '#0e0e0e',
  },
  pillTxt: {
    color: '#777',
    fontSize: 13,
    fontWeight: '700',
  },
});

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
          <Text style={[styles.rowTitle, { color }]} numberOfLines={1}>
            {t('chainHistory.episodeComplete', { n: item.episodeNumber ?? '—' })}
          </Text>
          {/* BAJO-CH-03: numberOfLines=1 para evitar que displayName larguísimo rompa layout */}
          <Text style={styles.rowSub} numberOfLines={2} ellipsizeMode="tail">
            {t('chainHistory.winner', { name: item.displayName || t('chainHistory.player') })}
            {item.totalMined ? `  ${t('chainHistory.blocks', { n: item.totalMined })}` : ''}
          </Text>
          <Text style={styles.rowDate}>{formatDate(item.ts)}</Text>
        </View>
      </View>
    );
  }

  if (item.type === 'episode_redeemed') {
    // Audit feedback 2026-06-23+: card de transparencia post-canje. Solo se
    // publica DESPUÉS de markGemRedeemed exitoso, así que toda esta info ya
    // es pública en blockchain. Cualquier miembro de la chain puede tocar los
    // hashes para verificar en Polygonscan.
    const tierLabel = item.gemTier ? `Tier ${item.gemTier}` : '—';
    const priceLabel = item.priceUSD ? `$${Number(item.priceUSD).toLocaleString()}` : '';
    return (
      <View style={[styles.row, styles.rowEpisode]}>
        <View style={styles.leftCol}>
          <SeqBadge seq={item.seq} color={color} />
          <View style={[styles.iconBadge, { backgroundColor: color + '18', borderColor: color + '40' }]}>
            <Text style={styles.iconText}>{icon}</Text>
          </View>
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.rowTitle, { color }]} numberOfLines={1}>
            {t('chainHistory.episodeRedeemed', { n: item.episodeNumber ?? '—', defaultValue: `Episodio ${item.episodeNumber ?? '—'} canjeado` })}
          </Text>
          <Text style={styles.rowSub}>
            {tierLabel}{priceLabel ? ` · ${priceLabel}` : ''}
          </Text>
          {item.gemCode && (
            <Text style={[styles.rowSub, styles.codeText]}>
              🎟  {item.gemCode}
            </Text>
          )}
          {item.winnerWallet && (
            <TouchableOpacity onPress={() => openPolygonscanAddr(item.winnerWallet)} activeOpacity={0.7}>
              <Text style={[styles.rowSub, styles.linkText]}>
                👤 {shortWallet(item.winnerWallet)}
              </Text>
            </TouchableOpacity>
          )}
          {item.nftTxHash && (
            <TouchableOpacity onPress={() => openPolygonscanTx(item.nftTxHash)} activeOpacity={0.7}>
              <Text style={[styles.rowSub, styles.linkText]}>
                🎁 {t('chainHistory.nftTransferLabel', { defaultValue: 'NFT transferido' })}: {shortWallet(item.nftTxHash)}
              </Text>
            </TouchableOpacity>
          )}
          {item.payoutTxHash && (
            <TouchableOpacity onPress={() => openPolygonscanTx(item.payoutTxHash)} activeOpacity={0.7}>
              <Text style={[styles.rowSub, styles.linkText]}>
                💵 {t('chainHistory.payoutLabel', { defaultValue: 'Pago USDC' })}: {shortWallet(item.payoutTxHash)}
              </Text>
            </TouchableOpacity>
          )}
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
            {t('chainHistory.episodeStart', { n: item.episodeNumber ?? '—' })}
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
  // Audit feedback 2026-06-23+: filtros para el historial.
  //   - searchText: texto libre, matchea contra gemCode/wallet/txHash/displayName/episodeNumber/cubeNumber
  //   - typeFilter: pill activa. 'all' | 'mine' | 'episode_complete' | 'episode_redeemed'
  //   episode_start no tiene pill propio porque siempre va junto a episode_complete del mismo episodio.
  const [searchText, setSearchText] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  useEffect(() => {
    // BAJO-CH-01: si no hay chainId, igual hay que dejar loading=false sino
    // queda spinner infinito.
    if (!chainId) { setLoading(false); setEvents([]); return; }
    setLoading(true);
    const q = query(
      collection(db, 'serverChains', chainId, 'history'),
      orderBy('seq', 'desc'),
      limit(500),
    );
    const unsub = onSnapshot(q, (snap) => {
      setEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, (err) => {
      // BAJO-CH-02: loguear el error en lugar de tragarlo — útil para distinguir
      // "lista vacía" vs "permission-denied".
      try { (async () => (await import('../utils/logError')).default('ChainHistory.snapshot', err, { chainId }))(); } catch (_) {}
      setLoading(false);
    });
    return () => unsub();
  }, [chainId]);

  const renderItem = useCallback(({ item }) => <EventRow item={item} t={t} />, [t]);
  const keyExtractor = useCallback((item) => item.id, []);

  const lastSeq = events.length > 0 ? (events[0]?.seq ?? events.length) : 0;

  // Audit feedback 2026-06-23+: filtros aplicados sobre `events`. Match
  // case-insensitive contra varios campos según el tipo de evento. typeFilter
  // 'episode' agrupa episode_complete + episode_start del mismo episodio
  // (visualmente van juntos en el feed).
  const filteredEvents = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return events.filter((ev) => {
      // Filtro de tipo (pill)
      if (typeFilter !== 'all') {
        if (typeFilter === 'episode') {
          if (ev.type !== 'episode_complete' && ev.type !== 'episode_start') return false;
        } else if (ev.type !== typeFilter) {
          return false;
        }
      }
      // Filtro de texto libre
      if (!q) return true;
      const haystack = [
        ev.gemCode, ev.winnerWallet, ev.nftTxHash, ev.payoutTxHash,
        ev.displayName, ev.episodeNumber, ev.cubeNumber, ev.layerK,
        ev.gemTier != null ? `tier ${ev.gemTier}` : null,
        ev.priceUSD != null ? `$${ev.priceUSD}` : null,
      ]
        .filter((x) => x !== null && x !== undefined)
        .map((x) => String(x).toLowerCase())
        .join(' | ');
      return haystack.includes(q);
    });
  }, [events, searchText, typeFilter]);

  return (
    <SafeAreaView style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('profile.back') || 'Back'}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
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

      {/* Filtros: input search + pills por tipo. Audit feedback 2026-06-23+. */}
      {events.length > 0 && (
        <View style={styles.filterBar}>
          <View style={styles.searchInputWrap}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              placeholder={t('chainHistory.searchPlaceholder', { defaultValue: 'Buscar código, wallet, hash…' })}
              placeholderTextColor="#555"
              value={searchText}
              onChangeText={setSearchText}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {searchText.length > 0 && (
              <TouchableOpacity
                onPress={() => setSearchText('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.7}
              >
                <Text style={styles.searchClear}>×</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.pillsRow}>
            <Pill active={typeFilter === 'all'} onPress={() => setTypeFilter('all')}>
              {t('chainHistory.filterAll', { defaultValue: 'Todos' })}
            </Pill>
            <Pill active={typeFilter === 'mine'} onPress={() => setTypeFilter('mine')} color="#4a9eff">⛏</Pill>
            <Pill active={typeFilter === 'episode'} onPress={() => setTypeFilter('episode')} color="#ffd700">🏆</Pill>
            <Pill active={typeFilter === 'episode_redeemed'} onPress={() => setTypeFilter('episode_redeemed')} color="#22c55e">💸</Pill>
          </View>
          {(searchText.length > 0 || typeFilter !== 'all') && (
            <Text style={styles.resultCount}>
              {t('chainHistory.resultsCount', {
                n: filteredEvents.length,
                defaultValue: `${filteredEvents.length} resultados`,
              })}
            </Text>
          )}
        </View>
      )}

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
      ) : filteredEvents.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🔍</Text>
          <Text style={styles.emptyTxt}>
            {t('chainHistory.noMatch', { defaultValue: 'Sin resultados' })}
          </Text>
          <Text style={styles.emptySub}>
            {t('chainHistory.noMatchSub', { defaultValue: 'Probá con otra búsqueda o cambiá el filtro.' })}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredEvents}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          maxToRenderPerBatch={25}
          windowSize={7}
        />
      )}

      {/* Report button */}
      <TouchableOpacity
        style={styles.reportBtn}
        onPress={() => openModal('report')}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t('login.report') || 'Report problem'}
      >
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
  // Audit feedback 2026-06-23+: links tappables a Polygonscan (tx hashes y
  // wallets post-canje). Mismo color verde MTB para consistencia.
  linkText: { color: '#5cb85c', textDecorationLine: 'underline' },
  // gemCode con look monospace para distinguirlo de hashes truncados.
  codeText: { fontFamily: 'monospace', color: '#888' },

  // Audit feedback 2026-06-23+: filter bar (search input + pills + result count).
  filterBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
    gap: 8,
  },
  searchInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0e0e0e',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 8,
  },
  searchIcon: {
    fontSize: 14,
    color: '#555',
  },
  searchInput: {
    flex: 1,
    color: '#ddd',
    fontSize: 14,
    paddingVertical: 8,
  },
  searchClear: {
    color: '#888',
    fontSize: 22,
    fontWeight: '800',
    paddingHorizontal: 4,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  resultCount: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
    fontStyle: 'italic',
  },

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
