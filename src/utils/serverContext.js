import React, { createContext, useContext, useState } from 'react';

const ServerContext = createContext(null);

export function ServerProvider({ children }) {
  const [activeServer, setActiveServer] = useState(null); // { id, name, currentLayer, ... }
  return (
    <ServerContext.Provider value={{ activeServer, setActiveServer }}>
      {children}
    </ServerContext.Provider>
  );
}

export function useServer() {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer must be used within ServerProvider');
  return ctx;
}
