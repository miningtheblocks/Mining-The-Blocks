import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Share, ScrollView,
} from 'react-native';
import { GEMS } from '../utils/gems';
import { callGetUserGems, callClaimGemNFT } from '../firebase/functions';
import { auth, db } from '../firebase/client';
import { doc, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
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

// Audit feedback 2026-06-23+: countdown de expiración (90d desde fin del
// episodio). El backend (getUserGems) enriquece cada gem con `expiresAt`
// derivado del completedAt del episode. Si la gem no tiene expiresAt
// significa que el episodio sigue activo → no expira todavía.
//
// Devuelve { state, label, color }:
//   - 'active' (episodio en curso): null/null/null — no mostrar nada
//   - 'days' (>=2 días) verde
//   - 'soon' (1 día o menos) naranja
//   - 'expired' (ya pasó) rojo
function getExpiryInfo(expiresAt) {
  if (!expiresAt) return null;
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return { state: 'expired', color: '#e57373' };
  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  if (days >= 2) return { state: 'days', days, color: '#5cb85c' };
  if (days >= 1) return { state: 'soon', days, hours, color: '#f59e0b' };
  return { state: 'soon', days: 0, hours, color: '#f59e0b' };
}

export default function MyGems({ asModal = false, visible = true, onClose }) {
  const { t, language } = useI18n();
  const { showAlert, AlertComponent } = useAppAlert();
  const [gems, setGems]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [wallet, setWallet]     = useState(null);
  const [claiming, setClaiming] = useState(null); // gemId en proceso
  const [selected, setSelected] = useState(null); // gemId para detalle

  // Escuchar wallet del usuario en tiempo real.
  // v1.3.14: reactivar suscripción cuando el user de auth cambia. Antes solo
  // se suscribía si `auth.currentUser` ya existía en el mount → si el modal
  // se abría antes de que auth hidratara, nunca aparecía la wallet.
  useEffect(() => {
    let unsubDoc = null;
    const subscribeFor = (uid) => {
      try { if (unsubDoc) unsubDoc(); } catch {}
      unsubDoc = null;
      if (!uid) { setWallet(null); return; }
      const ref = doc(db, 'users', uid);
      unsubDoc = onSnapshot(ref, (snap) => {
        setWallet(snap.exists() ? (snap.data().walletAddress || null) : null);
      }, (err) => {
        console.warn('MyGems.walletListener error', err?.code, err?.message);
      });
    };
    subscribeFor(auth.currentUser?.uid || null);
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      subscribeFor(user?.uid || null);
    });
    return () => {
      try { if (unsubDoc) unsubDoc(); } catch {}
      try { unsubAuth && unsubAuth(); } catch {}
    };
  }, []);

  // v1.3.14: refactor para resolver "unauthenticated" intermitente.
  //   1. Esperar `auth.authStateReady()` antes de la primera llamada — el
  //      modal puede abrirse antes que el SDK termine de hidratar el user
  //      desde el storage, y `currentUser` es null aunque haya sesión válida.
  //   2. Tres intentos con backoff (0ms, 500ms, 2s) si el server devuelve
  //      `unauth`. Antes solo había UNO con `getIdToken(true)`; si la fuga
  //      es por token refresh todavía en curso, el reintento tarda 1-2s.
  //   3. Listener `onAuthStateChanged` que dispara `loadGems` si el user
  //      cambia mientras el modal está abierto.
  //   4. console.warn detallado en cada fallo para diagnosticar via logcat.
  // v1.3.16: mutex para deduplicar calls concurrentes. El useEffect [visible]
  // y el listener onAuthStateChanged podían disparar loadGems al mismo tiempo
  // → dos calls al backend, una fallaba con unauth (token siendo refrescado)
  // y mostraba el alert aunque la otra hubiera tenido éxito.
  const loadingRef = useRef(false);
  const loadGems = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      try { await auth.authStateReady(); } catch (e) {
        console.warn('MyGems.loadGems: authStateReady failed', e?.message);
      }
      const u = auth.currentUser;
      if (!u) {
        console.warn('MyGems.loadGems: no currentUser tras authStateReady');
        setLoading(false);
        return;
      }
      const attemptOnce = async (forceRefresh) => {
        try { await u.getIdToken(forceRefresh); } catch (e) {
          console.warn('MyGems.loadGems: getIdToken failed', { force: forceRefresh, msg: e?.message });
        }
        return callGetUserGems();
      };
      // Intento 1: token actual.
      try {
        const { gems: list } = await attemptOnce(false);
        setGems(list || []);
        return;
      } catch (e1) {
        const code1 = String(e1?.code || e1?.message || '').toLowerCase();
        console.warn('MyGems.loadGems attempt 1 failed', { uid: u.uid, code: e1?.code, msg: e1?.message });
        if (!code1.includes('unauth') || !auth.currentUser) {
          showAlert('Error', e1?.message || t('myGems.errorLoad'));
          return;
        }
      }
      // Intento 2: force refresh del token, 500ms después.
      await new Promise((r) => setTimeout(r, 500));
      try {
        const { gems: list } = await attemptOnce(true);
        setGems(list || []);
        return;
      } catch (e2) {
        console.warn('MyGems.loadGems attempt 2 failed', { uid: u.uid, code: e2?.code, msg: e2?.message });
      }
      // Intento 3: último retry con backoff 2s + force refresh.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const { gems: list } = await attemptOnce(true);
        setGems(list || []);
        return;
      } catch (e3) {
        console.warn('MyGems.loadGems attempt 3 failed', { uid: u.uid, code: e3?.code, msg: e3?.message });
        showAlert('Error', e3?.message || t('myGems.errorLoad'));
      }
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Load cuando el modal se abre (visible→true) o en mount standalone.
  useEffect(() => {
    if (asModal ? visible : true) loadGems();
  }, [visible]);

  // v1.3.14: reintentar si el user de auth cambia mientras el modal está
  // abierto (login tardío, refresh de sesión, etc.).
  // v1.3.16: el listener disparaba `loadGems` también en el mount inicial con
  // el user actual → call duplicado con el useEffect [visible]. Ahora solo
  // dispara si el uid CAMBIA respecto al inicial.
  useEffect(() => {
    if (!(asModal ? visible : true)) return;
    const initialUid = auth.currentUser?.uid || null;
    const unsub = onAuthStateChanged(auth, (user) => {
      const newUid = user?.uid || null;
      if (newUid && newUid !== initialUid) loadGems();
    });
    return () => unsub();
  }, [visible, loadGems]);

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
      // Round 2 Commit B: el segundo arg (wallet) se removió de la signature;
      // el backend ahora lee users/{uid}.walletAddress (set via callSetUserWallet
      // con cooldown 24h) para evitar wallet hot-swap.
      await callClaimGemNFT(gem.id);
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
            {(() => {
              // Audit feedback 2026-06-23+: countdown de expiración. Solo se
              // muestra si el episodio cerró (gem.expiresAt definido) y la
              // gem aún no fue canjeada (status != 'redeemed').
              if (item.status === 'redeemed') return null;
              const exp = getExpiryInfo(item.expiresAt);
              if (!exp) return null;
              if (exp.state === 'expired') {
                return (
                  <Text style={[styles.gemExpiry, { color: exp.color }]}>
                    ⚠ {t('myGems.expired', { defaultValue: 'Expirado' })}
                  </Text>
                );
              }
              if (exp.state === 'soon') {
                return (
                  <Text style={[styles.gemExpiry, { color: exp.color }]}>
                    ⏰ {t('myGems.expiresHours', { hours: exp.hours, defaultValue: `Expira en ${exp.hours} hs` })}
                  </Text>
                );
              }
              return (
                <Text style={[styles.gemExpiry, { color: exp.color }]}>
                  ⏳ {t('myGems.expiresDays', { days: exp.days, defaultValue: `Expira en ${exp.days} días` })}
                </Text>
              );
            })()}
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
            <TouchableOpacity
              style={styles.codeBox}
              onPress={() => copyCode(item.code)}
              accessibilityLabel={`${t('myGems.tapCopy')} ${item.code}`}
              accessibilityHint={t('myGems.code')}
            >
              <Text style={styles.codeText}>{item.code}</Text>
              <Text style={styles.copyHint}>{t('myGems.tapCopy')}</Text>
            </TouchableOpacity>

            {/* Info del server */}
            <Text style={styles.detailMeta}>
              {t('myGems.foundAt')} EP {item.episodeNumber} · {t('myGems.layer')} {item.layerK} · #{item.cubeNumber}
            </Text>

            {/* Audit feedback 2026-06-23+: ventana de canje exacta en el detalle. */}
            {item.status !== 'redeemed' && item.expiresAt && (() => {
              const exp = getExpiryInfo(item.expiresAt);
              if (!exp) return null;
              const expDate = new Date(item.expiresAt).toLocaleDateString();
              return (
                <View style={[styles.expiryBox, { borderColor: exp.color + '55', backgroundColor: exp.color + '10' }]}>
                  <Text style={[styles.expiryBoxTitle, { color: exp.color }]}>
                    {exp.state === 'expired'
                      ? t('myGems.expiryDetailExpired', { defaultValue: 'Ventana de canje vencida' })
                      : t('myGems.expiryDetailActive', { defaultValue: 'Ventana de canje' })}
                  </Text>
                  <Text style={styles.expiryBoxBody}>
                    {exp.state === 'expired'
                      ? t('myGems.expiryDetailBodyExpired', { date: expDate, defaultValue: `El plazo venció el ${expDate}. Ya no se puede canjear.` })
                      : t('myGems.expiryDetailBodyActive', { date: expDate, defaultValue: `Tenés hasta el ${expDate} para reclamar (90 días desde el cierre del episodio).` })}
                  </Text>
                </View>
              );
            })()}
            {/* Si la gema NO tiene expiresAt (episodio sigue activo), avisar
                que la ventana se activa cuando termine. */}
            {item.status !== 'redeemed' && !item.expiresAt && (
              <View style={[styles.expiryBox, { borderColor: '#5cb85c55', backgroundColor: '#5cb85c10' }]}>
                <Text style={[styles.expiryBoxTitle, { color: '#5cb85c' }]}>
                  ✓ {t('myGems.expiryEpisodeActive', { defaultValue: 'Episodio en curso' })}
                </Text>
                <Text style={styles.expiryBoxBody}>
                  {t('myGems.expiryEpisodeActiveBody', { defaultValue: 'El premio no expira mientras el episodio sigue activo. Después tendrás 90 días para canjearlo.' })}
                </Text>
              </View>
            )}

            {/* Acciones */}
            {item.status === 'unclaimed' && (
              <View style={styles.actions}>
                {wallet ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnNFT]}
                    onPress={() => handleClaimNFT(item)}
                    disabled={claiming === item.id}
                    accessibilityLabel={t('myGems.claimNFT')}
                    accessibilityState={{ disabled: claiming === item.id, busy: claiming === item.id }}
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
        <TouchableOpacity
          onPress={loadGems}
          style={styles.refreshBtn}
          accessibilityLabel={t('myGems.refresh') || 'Refresh'}
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
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
  // Audit feedback 2026-06-23+: countdown de expiración en la card principal
  // (línea debajo de la fecha de discovery). Color dinámico según urgencia
  // (verde >2d / naranja <=1d / rojo expired).
  gemExpiry: { fontSize: 11, marginTop: 3, fontWeight: '700' },

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
  // Audit feedback 2026-06-23+: cajita info de expiración en el panel
  // expandible. Color dinámico inline según el estado (verde/naranja/rojo).
  expiryBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  expiryBoxTitle: { fontSize: 12, fontWeight: '800', marginBottom: 4 },
  expiryBoxBody: { color: '#bbb', fontSize: 11, lineHeight: 16 },

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
