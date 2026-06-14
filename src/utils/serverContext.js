// CRIT-16: el contexto ahora se sincroniza en tiempo real con Firestore.
// Antes era un useState plano: cuando el server avanzaba de capa o cerraba
// episodio en el backend, `activeServer` quedaba stale y DynamicCube201
// (que lo lee vía useServer()) operaba con datos viejos. Resultado: el HUD
// mostraba capa N pero el backend ya estaba en N-1, o se intentaba minar en
// un server cerrado.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StorageKeys } from '../constants';

const ServerContext = createContext(null);

export function ServerProvider({ children }) {
  const [activeServer, setActiveServerInner] = useState(null);
  const unsubRef = useRef(null);

  // Cleanup helper.
  const detach = () => {
    if (unsubRef.current) {
      try { unsubRef.current(); } catch {}
      unsubRef.current = null;
    }
  };

  // Setter público: detacha listener anterior, persiste a AsyncStorage y
  // adjunta nuevo onSnapshot al doc servers/{id}.
  const setActiveServer = (next) => {
    detach();
    if (!next || !next.id) {
      setActiveServerInner(null);
      AsyncStorage.removeItem(StorageKeys.ACTIVE_SERVER).catch(() => {});
      return;
    }
    setActiveServerInner(next);
    AsyncStorage.setItem(StorageKeys.ACTIVE_SERVER, next.id).catch(() => {});
    try {
      const ref = doc(db, 'servers', next.id);
      unsubRef.current = onSnapshot(ref, (snap) => {
        if (!snap.exists()) {
          setActiveServerInner(null);
          AsyncStorage.removeItem(StorageKeys.ACTIVE_SERVER).catch(() => {});
          return;
        }
        // Mergear data fresca con id (que no viene en .data()).
        setActiveServerInner({ id: snap.id, ...snap.data() });
      }, (err) => {
        console.warn('serverContext snapshot error', err && err.message);
      });
    } catch (e) {
      console.warn('serverContext attach error', e && e.message);
    }
  };

  useEffect(() => () => detach(), []);

  // Memoizar el value para evitar re-renders inútiles de los consumidores
  // cada vez que el provider rerenderea por otro motivo.
  const value = useMemo(() => ({ activeServer, setActiveServer }), [activeServer]);

  return (
    <ServerContext.Provider value={value}>
      {children}
    </ServerContext.Provider>
  );
}

export function useServer() {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer must be used within ServerProvider');
  return ctx;
}
