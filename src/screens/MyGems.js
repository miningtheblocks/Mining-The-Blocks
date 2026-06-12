import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Share, ScrollView,
} from 'react-native';
import { GEMS } from '../utils/gems';
import { callGetUserGems, callClaimGemNFT } from '../firebase/functions';
import { auth, db } from '../firebase/client';
import { doc, onSnapshot } from 'firebase/firestore';
import { useI18n } from '../utils/i18n';
import GemPixelArt from '../components/GemPixelArt';
import { useAppAlert } from '../components/AppAlert';
import { logError } from '../utils/logError';

const STATUS_COLORS = {
  unclaimed: '#888',
  minting:   '#cc7722',
  minted:    '#00cc44',
};

function shortenAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function MyGems({ asModal = false, visible = true, onClose }) {
  const { t, language } = useI18n();
  const { showAlert, AlertComponent } = useAppAlert();
  const [gems, setGems]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [wallet, setWallet]     = useState(null);
  const [claiming, setClaiming] = useState(null); // gemId en proceso
  const [selected, setSelected] = useState(null); // gemId para detalle

  // Escuchar wallet del usuario en tiempo real
  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    const ref = doc(db, 'users', u.uid);
    const unsub = onSnapshot(ref, (snap) => {
      setWallet(snap.exists() ? (snap.data().walletAddress || null) : null);
    });
    return () => unsub();
  }, []);

  const loadGems = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) { setLoading(false); return; }
    setLoading(true);
    try {
      const { gems: list } = await callGetUserGems();
      setGems(list || []);
    } catch (e) {
      showAlert('Error', e?.message || t('myGems.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load when modal opens (visible goes true) or on standalone mount
  useEffect(() => {
    if (asModal ? visible : true) loadGems();
  }, [visible]);

  const copyCode = async (code) => {
    try { await Share.share({ message: code }); } catch {}
  };

  const handleClaimNFT = async (gem) => {
    if (!wallet) {
      showAlert(t('myGems.noWalletTitle'), t('myGems.noWalletMsg'));
      return;
    }
    setClaiming(gem.id);
    try {
      await callClaimGemNFT(gem.id, wallet);
      await loadGems();
    } catch (e) {
      logError('MyGems.handleClaimNFT', e, { gemId: gem.id, tier: gem.gemTier });
      showAlert('Error', e?.message || t('myGems.errorClaim'));
    } finally {
      setClaiming(null);
    }
  };

  const gemData = (tier) => GEMS[(tier ?? 1) - 1] || GEMS[0];

  const renderGem = ({ item }) => {
    const gd = gemData(item.gemTier);
    const isSelected = selected === item.id;
    return (
      <TouchableOpacity
        style={[styles.card, { borderColor: gd.borderColor + '66' }, isSelected && { borderColor: gd.borderColor }]}
        onPress={() => setSelected(isSelected ? null : item.id)}
        activeOpacity={0.85}
      >
        {/* Fila principal */}
        <View style={styles.cardRow}>
          {/* Mini gem */}
          <View style={[styles.gemDot, { backgroundColor: gd.glowColor + '33', borderColor: gd.borderColor + '88' }]}>
            <View style={styles.gemDotInner}>
              {gd.palette.slice(1).map((color, i) => (
                <View key={i} style={[styles.gemDotPx, { backgroundColor: color, opacity: 1 - i * 0.15 }]} />
              ))}
            </View>
          </View>

          {/* Info */}
          <View style={{ flex: 1 }}>
            <View style={styles.gemNameRow}>
              <Text style={[styles.gemName, { color: gd.sparkleColor }]}>{language === 'en' ? gd.nameEn : gd.name}</Text>
              <View style={[styles.tierBadge, { backgroundColor: gd.glowColor + '33', borderColor: gd.borderColor + '66' }]}>
                <Text style={[styles.tierTxt, { color: gd.sparkleColor }]}>T{item.gemTier}</Text>
              </View>
            </View>
            <Text style={styles.gemPrice}>${gd.price} USD</Text>
            <Text style={styles.gemDate}>{new Date(item.discoveredAt).toLocaleDateString()}</Text>
          </View>

          {/* Status */}
          <View style={[styles.statusBadge, { borderColor: STATUS_COLORS[item.status] + '66' }]}>
            <Text style={[styles.statusTxt, { color: STATUS_COLORS[item.status] }]}>
              {t(`myGems.status_${item.status}`)}
            </Text>
          </View>
        </View>

        {/* Detalle expandible */}
        {isSelected && (
          <View style={styles.detail}>
            <View style={styles.detailGemArt}>
              <GemPixelArt gemIndex={item.gemTier} />
            </View>

            {/* Código */}
            <Text style={styles.detailLabel}>{t('myGems.code')}</Text>
            <TouchableOpacity style={styles.codeBox} onPress={() => copyCode(item.code)}>
              <Text style={styles.codeText}>{item.code}</Text>
              <Text style={styles.copyHint}>{t('myGems.tapCopy')}</Text>
            </TouchableOpacity>

            {/* Info del server */}
            <Text style={styles.detailMeta}>
              {t('myGems.foundAt')} EP {item.episodeNumber} · {t('myGems.layer')} {item.layerK} · #{item.cubeNumber}
            </Text>

            {/* Acciones */}
            {item.status === 'unclaimed' && (
              <View style={styles.actions}>
                {wallet ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnNFT]}
                    onPress={() => handleClaimNFT(item)}
                    disabled={claiming === item.id}
                  >
                    {claiming === item.id
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={styles.actionBtnTxt}>{t('myGems.claimNFT')}</Text>
                    }
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.noWalletHint}>{t('myGems.linkWalletHint')}</Text>
                )}
              </View>
            )}
            {item.status === 'minting' && (
              <Text style={[styles.detailMeta, { color: '#cc7722', marginTop: 8 }]}>
                {t('myGems.mintingMsg')} {shortenAddress(item.walletAddress)}
              </Text>
            )}
            {item.status === 'minted' && (
              <Text style={[styles.detailMeta, { color: '#00cc44', marginTop: 8 }]}>
                ✓ NFT → {shortenAddress(item.walletAddress)}
              </Text>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>{t('myGems.title')}</Text>
        <TouchableOpacity onPress={loadGems} style={styles.refreshBtn}>
          <Text style={styles.refreshTxt}>↻</Text>
        </TouchableOpacity>
      </View>

      {/* Wallet hint */}
      {!wallet && (
        <View style={styles.walletBanner}>
          <Text style={styles.walletBannerTxt}>{t('myGems.walletBanner')}</Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color="#fff" style={{ marginTop: 40 }} size="large" />
      ) : gems.length === 0 ? (
        <Text style={styles.empty}>{t('myGems.empty')}</Text>
      ) : (
        <FlatList
          data={gems}
          keyExtractor={(item) => item.id}
          renderItem={renderGem}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={true}
          initialNumToRender={8}
          windowSize={5}
        />
      )}
      {AlertComponent}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', paddingHorizontal: 16, paddingTop: 8 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: '#fff', fontSize: 20, fontWeight: '900' },
  refreshBtn: { padding: 6 },
  refreshTxt: { color: '#666', fontSize: 20, fontWeight: '700' },

  walletBanner: {
    backgroundColor: '#1a1400',
    borderWidth: 1,
    borderColor: '#554400',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  walletBannerTxt: { color: '#cc9900', fontSize: 12, fontWeight: '600', textAlign: 'center' },

  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 16 },

  card: {
    backgroundColor: '#0d0d0d',
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 10,
    padding: 12,
    overflow: 'hidden',
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  gemDot: {
    width: 40,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gemDotInner: { flexDirection: 'row', flexWrap: 'wrap', width: 20, height: 20 },
  gemDotPx: { width: 4, height: 4 },

  gemNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  gemName: { fontWeight: '800', fontSize: 14 },
  tierBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  tierTxt: { fontSize: 10, fontWeight: '800' },
  gemPrice: { color: '#aaa', fontSize: 12, fontWeight: '700' },
  gemDate: { color: '#555', fontSize: 11, marginTop: 1 },

  statusBadge: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusTxt: { fontSize: 11, fontWeight: '700' },

  // Detalle expandido
  detail: { marginTop: 12, borderTopWidth: 1, borderTopColor: '#222', paddingTop: 12 },
  detailGemArt: { alignItems: 'center', marginBottom: 12 },

  detailLabel: { color: '#666', fontSize: 11, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 },
  codeBox: {
    backgroundColor: '#111',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    padding: 10,
    marginBottom: 8,
  },
  codeText: { color: '#fff', fontWeight: '700', fontSize: 13, letterSpacing: 1 },
  copyHint: { color: '#555', fontSize: 11, marginTop: 3 },

  detailMeta: { color: '#666', fontSize: 12 },

  actions: { marginTop: 10 },
  actionBtn: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  actionBtnNFT: { backgroundColor: '#1a0a3a', borderWidth: 1, borderColor: '#6633cc' },
  actionBtnTxt: { color: '#cc88ff', fontWeight: '800', fontSize: 14 },

  noWalletHint: { color: '#664400', fontSize: 12, textAlign: 'center', fontStyle: 'italic' },
});
