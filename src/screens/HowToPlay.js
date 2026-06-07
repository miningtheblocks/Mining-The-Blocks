import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useI18n } from '../utils/i18n';
import { GEMS } from '../utils/gems';

const GEM_PRIZES = [100000, 50000, 10000, 1000, 500, 100, 50, 25, 15];

const PYRAMID_ZONES = [
  { layers: '100–98', widthPct: '100%', bg: '#1c1200', border: '#8B6914', color: '#f0c040', prize: '⛏️ 283,241 picks' },
  { layers: '97–0',   widthPct: '88%',  bg: '#0a1a0a', border: '#2e7d32', color: '#6dbf67', prize: '$15 · $25 · $50 · $100 · $500 + picks' },
  { layers: '80–60',  widthPct: '73%',  bg: '#090920', border: '#1a3a9f', color: '#6699ff', prize: '$1,000 ×50' },
  { layers: '60–50',  widthPct: '57%',  bg: '#130920', border: '#6611bb', color: '#bb77ff', prize: '$10,000 ×5' },
  { layers: '50–30',  widthPct: '40%',  bg: '#1f0808', border: '#aa1133', color: '#ff6688', prize: '$50,000 ×1' },
  { layers: '30–0',   widthPct: '24%',  bg: '#2a0000', border: '#ff2200', color: '#ff6633', prize: '$100,000 ×1' },
];

export default function HowToPlay() {
  const { t, language } = useI18n();
  return (
    <View>
      <Text style={s.welcome}>{t('cube.howToPlayWelcome')}</Text>
      <Text style={s.text}>{t('cube.howToPlayCubeSize')}</Text>

      <Text style={s.subtitle}>{t('cube.howToPlayHowTitle')}</Text>
      <Text style={s.text}>{t('cube.howToPlayDaily')}</Text>
      <Text style={s.text}>{t('cube.howToPlayPick')}</Text>
      <Text style={s.bold}>{t('cube.howToPlayChooseFace')}</Text>
      <Text style={s.text}>{t('cube.howToPlaySlide')}</Text>
      <Text style={s.text}>{t('cube.howToPlayChangeFace')}</Text>
      <Text style={s.text}>{t('cube.howToPlayButtons')}</Text>
      <Text style={s.bold}>{t('cube.howToPlayMining')}</Text>

      <Text style={s.subtitle}>{t('cube.howToPlayChainsTitle')}</Text>
      <Text style={s.text}>{t('cube.howToPlayChainsBody')}</Text>
      <Text style={s.bold}>{t('cube.howToPlayEpisode10')}</Text>
      <Text style={s.text}>{t('cube.howToPlayChainsMax')}</Text>

      <Text style={s.subtitle}>{t('cube.howToPlayPyramidTitle')}</Text>
      <View style={{ alignItems: 'flex-start', marginBottom: 8 }}>
        {PYRAMID_ZONES.map((z, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
            <Text style={s.layerLabel}>{z.layers}</Text>
            <View style={[s.pyramidBar, { width: z.widthPct, backgroundColor: z.bg, borderColor: z.border }]}>
              <Text style={[s.pyramidTxt, { color: z.color }]}>{z.prize}</Text>
            </View>
          </View>
        ))}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
          <Text style={s.layerLabel}>0</Text>
          <View style={s.coreBar}>
            <Text style={s.coreTxt}>◆ CORE</Text>
          </View>
        </View>
      </View>

      <Text style={s.subtitle}>{t('cube.howToPlayGemsTitle')}</Text>
      <Text style={s.text}>{t('cube.howToPlayGemsSub')}</Text>
      <Text style={s.unlockNote}>{t('cube.howToPlayUnlockNote')}</Text>
      {GEMS.map((gem) => (
        <View key={gem.tier} style={[s.gemRow, { borderColor: gem.borderColor + '66' }]}>
          <View style={[s.gemIcon, { backgroundColor: gem.glowColor + '33', borderColor: gem.borderColor + '88' }]}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: 20, height: 20 }}>
              {gem.palette.slice(1).map((col, ci) => (
                <View key={ci} style={{ width: 4, height: 4, backgroundColor: col, opacity: 1 - ci * 0.15 }} />
              ))}
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Text style={[s.gemName, { color: gem.sparkleColor }]}>{language === 'en' ? gem.nameEn : gem.name}</Text>
              <View style={[s.gemPriceBadge, { borderColor: gem.borderColor + '88', backgroundColor: gem.glowColor + '22' }]}>
                <Text style={[s.gemPriceTxt, { color: gem.sparkleColor }]}>${GEM_PRIZES[gem.tier - 1].toLocaleString()}</Text>
              </View>
            </View>
            <Text style={s.gemQty}>×{gem.quantityPerServer.toLocaleString()} / server</Text>
            <Text style={s.gemUnlock}>🔒 {t('cube.howToPlayUnlockAt').replace('{n}', gem.unlockAt.toLocaleString())}</Text>
          </View>
        </View>
      ))}

      <Text style={s.text}>{t('cube.howToPlayShuffle')}</Text>
      <Text style={s.luck}>{t('cube.howToPlayLuck')}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  welcome:    { fontSize: 18, fontWeight: '800', color: '#22c55e', marginBottom: 8, lineHeight: 24 },
  subtitle:   { fontSize: 18, fontWeight: '800', color: '#fff', marginTop: 12, marginBottom: 8, lineHeight: 24 },
  text:       { fontSize: 14, color: '#ccc', marginBottom: 8, lineHeight: 20 },
  bold:       { fontSize: 14, fontWeight: '700', color: '#fff', marginBottom: 8, lineHeight: 20 },
  luck:       { fontSize: 16, fontWeight: '700', color: '#22c55e', marginTop: 8, marginBottom: 12, textAlign: 'center' },
  layerLabel: { width: 44, color: '#777', fontSize: 9, fontWeight: '700', textAlign: 'right', marginRight: 6 },
  pyramidBar: { borderWidth: 1, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 6 },
  pyramidTxt: { fontSize: 10, fontWeight: '700' },
  coreBar:    { width: '10%', backgroundColor: '#0a0005', borderWidth: 1, borderColor: '#440088', borderRadius: 5, paddingVertical: 5, paddingHorizontal: 6, alignItems: 'center' },
  coreTxt:    { color: '#8833cc', fontSize: 9, fontWeight: '900' },
  gemRow:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a1a1a', borderRadius: 10, borderWidth: 1, padding: 8, marginBottom: 6, gap: 8 },
  gemIcon:    { width: 36, height: 36, borderRadius: 7, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  gemName:    { fontWeight: '800', fontSize: 12 },
  gemPriceBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1 },
  gemPriceTxt:   { fontSize: 9, fontWeight: '800' },
  gemQty:     { color: '#888', fontSize: 10 },
  gemUnlock:  { color: '#666', fontSize: 10, marginTop: 2 },
  unlockNote: { fontSize: 12, color: '#888', fontStyle: 'italic', marginBottom: 10, lineHeight: 17 },
});
