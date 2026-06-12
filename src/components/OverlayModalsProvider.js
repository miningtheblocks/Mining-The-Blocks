import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { View } from 'react-native';
import ModalShell from './ModalShell';
import Profile from '../screens/Profile';
import Config from '../screens/Config';
import GetPeaks from '../screens/GetPeaks';
import Registration from '../screens/Registration';
import MyGems from '../screens/MyGems';
import HowToPlay from '../screens/HowToPlay';
import BuyCredits from '../screens/BuyCredits';
import ReportProblem from './ReportProblem';

// CQ-013: Subscribe.js eliminado — duplicaba la funcionalidad de Login.js
// (sólo hacía signInWithEmailAndPassword) y mostraba "cuenta creada" misleading.
// El drawer ahora abre Login directamente.
//
// CQ-010: cada modal renderiza su contenido sólo cuando `visible[key]`. Antes
// se montaban los 9 screens siempre, manteniendo onSnapshot listeners zombis
// a Firestore aunque el usuario nunca abriera el modal.

const OverlayModalsContext = createContext(null);

const INITIAL_VISIBLE = {
  profile: false,
  config: false,
  peaks: false,
  registration: false,
  gems: false,
  howToPlay: false,
  buyCredits: false,
  report: false,
};

export function OverlayModalsProvider({ children }) {
  const [visible, setVisible] = useState(INITIAL_VISIBLE);

  const openModal = useCallback((key) => {
    setVisible((v) => ({ ...v, [key]: true }));
  }, []);
  const closeModal = useCallback((key) => {
    setVisible((v) => ({ ...v, [key]: false }));
  }, []);
  const closeAll = useCallback(() => {
    setVisible(INITIAL_VISIBLE);
  }, []);

  const ctx = useMemo(() => ({ visible, openModal, closeModal, closeAll }), [visible, openModal, closeModal, closeAll]);

  return (
    <OverlayModalsContext.Provider value={ctx}>
      <View style={{ flex: 1 }}>
        {children}

        {/* Profile */}
        <ModalShell visible={visible.profile} onClose={() => closeModal('profile')} titleKey="drawer.profile">
          {visible.profile && <Profile asModal onClose={() => closeModal('profile')} />}
        </ModalShell>

        {/* Config */}
        <ModalShell visible={visible.config} onClose={() => closeModal('config')} titleKey="drawer.config">
          {visible.config && <Config asModal onClose={() => closeModal('config')} />}
        </ModalShell>

        {/* Peaks */}
        <ModalShell visible={visible.peaks} onClose={() => closeModal('peaks')} titleKey="drawer.getPeaks">
          {visible.peaks && <GetPeaks asModal onClose={() => closeModal('peaks')} />}
        </ModalShell>

        {/* Edit Profile (Registration form as modal) */}
        <ModalShell visible={visible.registration} onClose={() => closeModal('registration')} titleKey="registration.title">
          {visible.registration && <Registration asModal onClose={() => closeModal('registration')} />}
        </ModalShell>

        {/* Mis Gemas */}
        <ModalShell visible={visible.gems} onClose={() => closeModal('gems')} titleKey="drawer.gems">
          {visible.gems && <MyGems asModal visible={visible.gems} onClose={() => closeModal('gems')} />}
        </ModalShell>

        {/* How to Play */}
        <ModalShell visible={visible.howToPlay} onClose={() => closeModal('howToPlay')} titleKey="drawer.howToPlay">
          {visible.howToPlay && <HowToPlay />}
        </ModalShell>

        {/* Buy Credits */}
        <ModalShell visible={visible.buyCredits} onClose={() => closeModal('buyCredits')} titleKey="drawer.buyCredits">
          {visible.buyCredits && <BuyCredits onClose={() => closeModal('buyCredits')} />}
        </ModalShell>

        {/* Report Problem */}
        <ModalShell visible={visible.report} onClose={() => closeModal('report')} titleKey="report.title">
          {visible.report && <ReportProblem onClose={() => closeModal('report')} />}
        </ModalShell>
      </View>
    </OverlayModalsContext.Provider>
  );
}

export function useOverlayModals() {
  const ctx = useContext(OverlayModalsContext);
  if (!ctx) throw new Error('useOverlayModals must be used within OverlayModalsProvider');
  return ctx;
}
