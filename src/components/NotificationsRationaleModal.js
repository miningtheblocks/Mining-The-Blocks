import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useI18n } from '../utils/i18n';

// Round 2 audit feedback (sesión 2026-06-23+): pre-prompt explicativo antes
// del modal nativo de permisos de Android/iOS. El comentario en App.js:261
// describía este flow pero nunca se implementó — solo se llamaba directo a
// requestPermissionsAsync mostrando el modal genérico del OS sin context.
//
// Sigue la estética estándar de AppAlert (dark, #111 box, verde como CTA
// principal) pero agrega íconos y bullets para que el user entienda por qué
// pedimos el permiso antes de tomar la decisión.
export default function NotificationsRationaleModal({ visible, onAccept, onDecline }) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onDecline}>
      <View style={s.overlay}>
        <View style={s.box}>
          <View style={s.iconWrap}>
            <Text style={s.bellIcon}>🔔</Text>
          </View>
          <Text style={s.title}>{t('notifRationale.title', { defaultValue: 'Activar notificaciones' })}</Text>
          <Text style={s.subtitle}>{t('notifRationale.subtitle', { defaultValue: 'Te avisamos solo cuando importa:' })}</Text>

          <ScrollView style={s.bulletsScroll} contentContainerStyle={s.bullets}>
            <Bullet icon="💎" text={t('notifRationale.bulletGem', { defaultValue: 'Cuando ganás una gema o tu NFT está listo' })} />
            <Bullet icon="🏁" text={t('notifRationale.bulletEpisode', { defaultValue: 'Cuando termina un episodio y se libera el premio' })} />
            <Bullet icon="🤝" text={t('notifRationale.bulletReferral', { defaultValue: 'Cuando un referido tuyo compra un crédito' })} />
          </ScrollView>

          <Text style={s.privacy}>{t('notifRationale.privacy', { defaultValue: 'Nunca te mandamos spam ni promociones. Podés desactivarlo después desde Configuración.' })}</Text>

          <View style={s.btnRow}>
            <TouchableOpacity
              style={[s.btn, s.btnCancel]}
              onPress={onDecline}
              activeOpacity={0.85}
            >
              <Text style={[s.btnTxt, s.btnTxtCancel]}>{t('notifRationale.declineBtn', { defaultValue: 'Ahora no' })}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.btn, s.btnAccept]}
              onPress={onAccept}
              activeOpacity={0.85}
            >
              <Text style={s.btnTxt}>{t('notifRationale.acceptBtn', { defaultValue: 'Activar' })}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Bullet({ icon, text }) {
  return (
    <View style={s.bulletRow}>
      <Text style={s.bulletIcon}>{icon}</Text>
      <Text style={s.bulletText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  box: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#111',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    padding: 24,
  },
  iconWrap: {
    alignItems: 'center',
    marginBottom: 12,
  },
  bellIcon: {
    fontSize: 48,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 6,
  },
  subtitle: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  bulletsScroll: {
    maxHeight: 200,
  },
  bullets: {
    gap: 12,
    paddingVertical: 4,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  bulletIcon: {
    fontSize: 20,
    width: 28,
    textAlign: 'center',
  },
  bulletText: {
    flex: 1,
    color: '#ddd',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '500',
  },
  privacy: {
    color: '#666',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 16,
    fontStyle: 'italic',
    lineHeight: 16,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnAccept: {
    backgroundColor: '#1a3a1a',
    borderColor: '#2e7d32',
  },
  btnCancel: {
    backgroundColor: '#1a1a1a',
    borderColor: '#333',
  },
  btnTxt: {
    color: '#5cb85c',
    fontWeight: '800',
    fontSize: 14,
  },
  btnTxtCancel: {
    color: '#888',
  },
});
