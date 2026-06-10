import React, { useCallback, useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

export function AppAlert({ visible, title, message, buttons, onRequestClose }) {
  if (!visible) return null;
  const btns = buttons?.length ? buttons : [{ text: 'OK', onPress: onRequestClose }];
  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onRequestClose}>
      <View style={s.overlay}>
        <View style={s.box}>
          {!!title && <Text style={s.title}>{title}</Text>}
          {!!message && <Text style={s.message}>{message}</Text>}
          <View style={[s.btnRow, btns.length === 1 && { justifyContent: 'center' }]}>
            {btns.map((btn, i) => (
              <TouchableOpacity
                key={i}
                style={[s.btn, btn.style === 'cancel' && s.btnCancel, btn.style === 'destructive' && s.btnDestructive]}
                onPress={btn.onPress || onRequestClose}
                activeOpacity={0.85}
              >
                <Text style={[s.btnTxt, btn.style === 'cancel' && s.btnTxtCancel, btn.style === 'destructive' && s.btnTxtDestructive]}>
                  {btn.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function useAppAlert() {
  const [state, setState] = useState(null);

  const showAlert = useCallback((title, message, buttons) => {
    setState({ title, message, buttons });
  }, []);

  const hide = useCallback(() => setState(null), []);

  const AlertComponent = state ? (
    <AppAlert
      visible
      title={state.title}
      message={state.message}
      buttons={(state.buttons || [{ text: 'OK' }]).map(b => ({
        ...b,
        onPress: () => { hide(); b.onPress?.(); },
      }))}
      onRequestClose={hide}
    />
  ) : null;

  return { showAlert, AlertComponent };
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  box: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#111',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    padding: 24,
  },
  title: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 10,
  },
  message: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 22,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: '#1a3a1a',
    borderWidth: 1,
    borderColor: '#2e7d32',
  },
  btnCancel: {
    backgroundColor: '#1a1a1a',
    borderColor: '#333',
  },
  btnDestructive: {
    backgroundColor: '#2a0a0a',
    borderColor: '#7d2e2e',
  },
  btnTxt: {
    color: '#5cb85c',
    fontWeight: '800',
    fontSize: 14,
  },
  btnTxtCancel: {
    color: '#888',
  },
  btnTxtDestructive: {
    color: '#e57373',
  },
});
