import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { auth } from '../firebase/client';
import { callReportProblem } from '../firebase/functions';
import { useI18n } from '../utils/i18n';
import { useAppAlert } from './AppAlert';

export default function ReportProblem({ onClose }) {
  const { t } = useI18n();
  const { showAlert, AlertComponent } = useAppAlert();

  const u = auth.currentUser;
  const [reportType, setReportType] = useState('bug');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState(u?.email || '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    setEmail(auth.currentUser?.email || '');
  }, []);

  const onSend = async () => {
    if (!description.trim() || description.trim().length < 5) {
      showAlert(t('report.errorTitle'), t('report.descriptionRequired'));
      return;
    }
    setSending(true);
    try {
      await callReportProblem({
        userType: auth.currentUser ? 'registered' : 'unregistered',
        reportType,
        description: description.trim(),
        email: email.trim() || null,
      });
      setSent(true);
    } catch (e) {
      showAlert(t('report.errorTitle'), e?.message || t('report.sendError'));
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <View style={styles.sentBox}>
        <Text style={styles.sentIcon}>✅</Text>
        <Text style={styles.sentTitle}>{t('report.sentTitle')}</Text>
        <Text style={styles.sentBody}>{t('report.sentBody')}</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.85}>
          <Text style={styles.closeBtnTxt}>{t('report.close')}</Text>
        </TouchableOpacity>
        {AlertComponent}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Report type */}
      <Text style={styles.label}>{t('report.reportTypeLabel')}</Text>
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleBtn, reportType === 'bug' && styles.toggleBtnActive]}
          onPress={() => setReportType('bug')}
          activeOpacity={0.8}
        >
          <Text style={[styles.toggleTxt, reportType === 'bug' && styles.toggleTxtActive]}>
            {t('report.bug')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, reportType === 'error' && styles.toggleBtnActive]}
          onPress={() => setReportType('error')}
          activeOpacity={0.8}
        >
          <Text style={[styles.toggleTxt, reportType === 'error' && styles.toggleTxtActive]}>
            {t('report.error')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Description */}
      <Text style={styles.label}>{t('report.descriptionLabel')}</Text>
      <TextInput
        style={styles.textArea}
        value={description}
        onChangeText={setDescription}
        placeholder={t('report.descriptionPlaceholder')}
        placeholderTextColor="#555"
        multiline
        numberOfLines={5}
        textAlignVertical="top"
        maxLength={1000}
      />
      <Text style={styles.charCount}>{description.length}/1000</Text>

      {/* Email */}
      <Text style={styles.label}>{t('report.emailLabel')}</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder={t('report.emailPlaceholder')}
        placeholderTextColor="#555"
        autoCapitalize="none"
        keyboardType="email-address"
        textContentType="emailAddress"
      />

      {/* Send */}
      <TouchableOpacity
        style={[styles.sendBtn, sending && { opacity: 0.6 }]}
        onPress={onSend}
        disabled={sending}
        activeOpacity={0.85}
      >
        {sending
          ? <ActivityIndicator color="#000" />
          : <Text style={styles.sendTxt}>{t('report.send')}</Text>
        }
      </TouchableOpacity>
      {AlertComponent}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingBottom: 8 },
  label: { color: '#888', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 16, marginBottom: 6 },
  toggleRow: { flexDirection: 'row', gap: 8 },
  toggleBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
    backgroundColor: '#111',
  },
  toggleBtnActive: { backgroundColor: '#fff', borderColor: '#fff' },
  toggleTxt: { color: '#666', fontWeight: '700', fontSize: 14 },
  toggleTxtActive: { color: '#000' },
  textArea: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    padding: 12,
    color: '#fff',
    fontSize: 14,
    minHeight: 110,
    lineHeight: 20,
  },
  charCount: { color: '#444', fontSize: 11, textAlign: 'right', marginTop: 4 },
  input: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#fff',
    fontSize: 14,
  },
  sendBtn: {
    marginTop: 20,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  sendTxt: { color: '#000', fontWeight: '900', fontSize: 15 },
  sentBox: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 8 },
  sentIcon: { fontSize: 48, marginBottom: 12 },
  sentTitle: { color: '#fff', fontSize: 20, fontWeight: '900', marginBottom: 8 },
  sentBody: { color: '#aaa', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  closeBtn: { backgroundColor: '#222', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 32, borderWidth: 1, borderColor: '#333' },
  closeBtnTxt: { color: '#ccc', fontWeight: '700', fontSize: 14 },
});
