import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Image } from 'react-native';
import { useAppAlert } from '../components/AppAlert';
import { callPreviewServerConfig, callCreateServerCustom } from '../firebase/functions';
import { useServer } from '../utils/serverContext';
import { navigate } from '../utils/navigationRef';
import { GEMS } from '../utils/gems';
import { GEM_IMAGES } from '../components/GemPixelArt';
import { useI18n } from '../utils/i18n';

// Cambio 3 (Fase 4): formulario de creación de servers a medida.
// SE ENTREGA COMPLETO PERO INACTIVO — esta pantalla solo se monta si
// config/app.paramServerCreationEnabled es true (ver ServerList.js). El
// backend (createServerCustom/previewServerConfig) también rechaza todo si
// el flag está apagado, así que esto es defensa en profundidad, no el único
// gate. Ver functions/serverConfig.js para el modelo matemático completo.
//
// Flujo de 2 etapas (D7/D8 del plan aprobado):
//   Etapa A: el usuario elige jugadores (N) y precio (P) -> Premio Total y
//            capas se calculan y muestran de solo lectura (previewServerConfig).
//   Etapa B: distribución manual opcional de ese Premio Total entre los 9
//            tiers -- tiers con precio > Premio Total quedan deshabilitados.
export default function CreateCustomServer({ onClose }) {
  const { t } = useI18n();
  const { setActiveServer } = useServer();
  const { showAlert, AlertComponent } = useAppAlert();

  const [name, setName] = useState('');
  const [playersStr, setPlayersStr] = useState('1000');
  const [priceStr, setPriceStr] = useState('15');
  const [preview, setPreview] = useState(null); // { config } de previewServerConfig
  const [previewError, setPreviewError] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [tierQuantities, setTierQuantities] = useState(null); // array de 9, editable
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef(null);

  // Parseo tolerante a formato local: "0,10" (coma decimal) y "1.000.000"
  // (punto como separador de miles) rompían Number() -> NaN -> la preview
  // desaparecía y no volvía aunque se corrigiera el otro campo (el efecto
  // de abajo depende de AMBOS N y P siendo finitos a la vez).
  const N = Math.floor(Number(String(playersStr).replace(/[.,]/g, '')));
  const P = Number(String(priceStr).replace(',', '.'));

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!Number.isFinite(N) || !Number.isFinite(P)) {
      setPreview(null);
      return;
    }
    setLoadingPreview(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await callPreviewServerConfig(N, P);
        if (res.ok) {
          setPreview(res.config);
          setPreviewError(null);
          setTierQuantities(res.config.quantityPerTier.slice());
        } else {
          setPreview(null);
          setPreviewError(res.errors ? res.errors.join(', ') : 'error');
        }
      } catch (e) {
        setPreview(null);
        setPreviewError(e?.message || 'error');
      } finally {
        setLoadingPreview(false);
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [N, P]);

  const distributedTotal = (tierQuantities || []).reduce(
    (sum, q, i) => sum + (Number(q) || 0) * GEMS[i].price, 0,
  );
  const target = preview ? Math.round(preview.totalPrizePoolUSD) : 0;
  // Jugadores necesarios para liberar el primer premio (el tier con unlockAt
  // más bajo entre los que realmente tienen cantidad > 0) y el premio máximo
  // del server (el tier con unlockAt más alto) -- mismos umbrales 1,25×costo
  // que ya calcula el backend (previewServerConfig), solo mostrados acá.
  const activeTiers = (preview?.tierTable || []).filter((t) => t.count > 0);
  const firstTier = activeTiers.length
    ? activeTiers.reduce((a, b) => (a.unlockAt <= b.unlockAt ? a : b))
    : null;
  const maxTier = activeTiers.length
    ? activeTiers.reduce((a, b) => (a.unlockAt >= b.unlockAt ? a : b))
    : null;
  const remaining = target - distributedTotal;

  const setTierQty = (index, value) => {
    setTierQuantities((prev) => {
      const next = (prev || []).slice();
      next[index] = Math.max(0, Math.floor(Number(value) || 0));
      return next;
    });
  };

  const autoComplete = () => {
    if (!preview || !tierQuantities) return;
    // Completa el resto en el tier más chico (más barato) HABILITADO
    // (precio <= Premio Total), de atrás para adelante (tier 9 primero).
    for (let i = 8; i >= 0; i--) {
      const price = GEMS[i].price;
      if (price > target) continue;
      const addUnits = Math.floor(remaining / price);
      if (addUnits !== 0) {
        setTierQty(i, (tierQuantities[i] || 0) + addUnits);
        return;
      }
    }
  };

  const onCreate = async () => {
    if (!name.trim()) { showAlert(t('serverList.errorCreate'), t('serverList.serverNamePlaceholder')); return; }
    if (!preview) { showAlert('Error', previewError || 'invalid config'); return; }
    if (remaining !== 0) { showAlert('Error', `La distribución no cierra: faltan/sobran $${remaining}`); return; }
    setCreating(true);
    try {
      const result = await callCreateServerCustom(name.trim(), N, P, tierQuantities);
      setActiveServer({ id: result.serverId, chainId: result.chainId, name: name.trim(), currentLayer: result.config.layerCount, status: 'active', totalMined: 0, config: result.config });
      if (onClose) onClose();
      navigate('GameDrawer');
    } catch (e) {
      const msg = e?.message === 'must_join_server_first'
        ? 'Primero tenés que haber jugado en un server real (el Free no cuenta) antes de poder crear el tuyo.'
        : (e?.message || 'No se pudo crear el server');
      showAlert('Error', msg);
    } finally {
      setCreating(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 12 }}>
      <Text style={styles.label}>Nombre</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={40} placeholder="Nombre del server" placeholderTextColor="#666" />

      <Text style={styles.label}>Jugadores (100 - 100.000)</Text>
      <TextInput style={styles.input} value={playersStr} onChangeText={setPlayersStr} keyboardType="numeric" />

      <Text style={styles.label}>Precio de entrada USD ($0.10 - $100)</Text>
      <TextInput style={styles.input} value={priceStr} onChangeText={setPriceStr} keyboardType="numeric" />

      {loadingPreview && <ActivityIndicator color="#ffd700" style={{ marginVertical: 12 }} />}

      {previewError && !loadingPreview && (
        <Text style={styles.error}>⚠️ {previewError}</Text>
      )}

      {preview && !loadingPreview && (
        <>
          <View style={styles.previewBox}>
            <View style={[styles.previewCol, styles.previewColLeft]}>
              <Text style={styles.previewTitle}>Info</Text>
              <Text style={styles.previewRow}>Premio total: ${target.toLocaleString()}</Text>
              <Text style={styles.previewRow}>Capas: {preview.layerCount}</Text>
              <Text style={styles.previewRow}>Picos regalo: {(preview.expectedPicks || 0).toLocaleString()}</Text>
            </View>
            <View style={styles.previewDivider} />
            <View style={[styles.previewCol, styles.previewColRight]}>
              <Text style={styles.previewTitle}>Liberación</Text>
              <Text style={styles.previewRow}>Premio ${(firstTier?.price || 0).toLocaleString()}: {(firstTier?.unlockAt || 0).toLocaleString()} jug.</Text>
              <Text style={styles.previewRow}>Premio ${(maxTier?.price || 0).toLocaleString()}: {(maxTier?.unlockAt || 0).toLocaleString()} jug.</Text>
            </View>
          </View>

          <Text style={styles.label}>Distribución de premios por tier</Text>
          <Text style={[styles.previewRow, remaining !== 0 && styles.error]}>
            Asignado: ${distributedTotal.toLocaleString()} / ${target.toLocaleString()} (resta ${remaining.toLocaleString()})
          </Text>
          {GEMS.map((gem, i) => {
            const disabled = gem.price > target;
            return (
              <View key={gem.tier} style={[styles.tierRow, disabled && styles.tierRowDisabled]}>
                <Image source={GEM_IMAGES[gem.tier]} style={styles.tierGemImage} resizeMode="contain" />
                <Text style={styles.tierLabel}>${gem.price.toLocaleString()} ({gem.name})</Text>
                <TextInput
                  style={styles.tierInput}
                  editable={!disabled}
                  value={String((tierQuantities && tierQuantities[i]) || 0)}
                  onChangeText={(v) => setTierQty(i, v)}
                  keyboardType="numeric"
                />
              </View>
            );
          })}
          <TouchableOpacity style={styles.autoBtn} onPress={autoComplete} activeOpacity={0.8}>
            <Text style={styles.autoBtnTxt}>Completar resto automáticamente</Text>
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity
        style={[styles.createBtn, (creating || !preview || remaining !== 0) && styles.createBtnDisabled]}
        onPress={onCreate}
        disabled={creating || !preview || remaining !== 0}
        activeOpacity={0.85}
      >
        {creating ? <ActivityIndicator color="#000" /> : <Text style={styles.createBtnTxt}>Crear server</Text>}
      </TouchableOpacity>

      {AlertComponent}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  label: { color: '#999', fontSize: 12, fontWeight: '700', marginTop: 6, marginBottom: 2 },
  input: { backgroundColor: '#111', borderWidth: 1, borderColor: '#333', borderRadius: 8, padding: 7, color: '#fff' },
  error: { color: '#e57373', fontSize: 12, marginTop: 6 },
  previewBox: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#111', borderRadius: 8, borderWidth: 1, borderColor: '#2e7d32', padding: 7, marginTop: 6 },
  previewCol: { justifyContent: 'flex-start' },
  previewColLeft: { flex: 1 },
  previewColRight: { flex: 1 },
  previewDivider: { width: 1, alignSelf: 'stretch', backgroundColor: '#2e7d32', marginHorizontal: 8 },
  previewTitle: { color: '#5cb85c', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', marginBottom: 3 },
  previewRow: { color: '#ccc', fontSize: 12, marginBottom: 2 },
  tierRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  tierRowDisabled: { opacity: 0.35 },
  tierGemImage: { width: 18, height: 18 },
  tierLabel: { color: '#ccc', fontSize: 12, flex: 1 },
  tierInput: { backgroundColor: '#111', borderWidth: 1, borderColor: '#333', borderRadius: 8, padding: 5, color: '#fff', width: 84, textAlign: 'right' },
  autoBtn: { marginTop: 4, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#333', borderRadius: 10, padding: 7, alignItems: 'center' },
  autoBtnTxt: { color: '#888', fontSize: 12, fontWeight: '700' },
  createBtn: { marginTop: 8, backgroundColor: '#ffd700', borderRadius: 12, padding: 11, alignItems: 'center' },
  createBtnDisabled: { opacity: 0.4 },
  createBtnTxt: { color: '#000', fontWeight: '900', fontSize: 15 },
});
