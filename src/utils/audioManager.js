// Round 2 audit #5 MED-2: migrado de expo-av (deprecated) a expo-audio.
// expo-av va a ser eliminado en Expo SDK 55. La API nueva es similar pero
// con cambios significativos:
//   - createAudioPlayer(source) devuelve el player directo (no { sound })
//   - play/pause/seekTo son síncronos (no async); volumen es propiedad
//     setteable (no setVolumeAsync)
//   - Status: player.currentStatus (sync) en vez de getStatusAsync()
//   - Listeners: addListener('playbackStatusUpdate', cb) devuelve subscription
//     con .remove() en vez de setOnPlaybackStatusUpdate(null)
//   - setAudioModeAsync sin namespace Audio; flags renombrados.

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

class AudioManager {
  constructor() {
    this.backgroundMusic = null;
    this.backgroundMusicSub = null;
    this.sounds = {};
    this.activeSounds = []; // array de { player, sub }
    this.musicEnabled = true;
    this.soundEnabled = true;
    this.initialized = false;
    this.currentTrack = null;
    this.musicVolume = 0;
    this.baseMusicMax = 0.5;
    this.musicVolumeFactor = 1.0;
    this.sfxVolumeFactor = 1.0;
    this.targetMusicVolume = this.baseMusicMax * this.musicVolumeFactor;
    this.crescendoInterval = null;
    this.miningSound = null;
    this.miningSoundSub = null;
    this.miningCancelled = false;
    this.miningOkPreloaded = null;
  }

  async playMiningOkSound() {
    if (!this.soundEnabled) return;
    try {
      if (!this.miningOkPreloaded) {
        const source = this.sounds.mining_ok;
        if (!source) return;
        const vol = Math.max(0, Math.min(1.0, this.sfxVolumeFactor));
        const player = createAudioPlayer(source);
        player.volume = vol;
        this.miningOkPreloaded = player;
      }
      try { this.miningOkPreloaded.seekTo(0); } catch {}
      try { this.miningOkPreloaded.play(); } catch {}
    } catch (error) {
      console.warn('Error reproduciendo mining_ok:', error?.message || error);
    }
  }

  async playMiningSound() {
    if (!this.soundEnabled) return;
    await this.stopMiningSound();
    this.miningCancelled = false;
    try {
      const source = this.sounds.mining;
      if (!source) return;
      const vol = Math.max(0, Math.min(1.0, this.sfxVolumeFactor));
      const player = createAudioPlayer(source);
      player.volume = vol;
      if (this.miningCancelled) {
        try { player.remove(); } catch {}
        return;
      }
      this.miningSound = player;
      this.miningSoundSub = player.addListener('playbackStatusUpdate', (status) => {
        if (status && status.didJustFinish) {
          try { this.miningSoundSub && this.miningSoundSub.remove(); } catch {}
          this.miningSoundSub = null;
          try { player.remove(); } catch {}
          if (this.miningSound === player) this.miningSound = null;
        }
      });
      try { player.play(); } catch {}
    } catch (error) {
      console.warn('Error reproduciendo mining:', error?.message || error);
    }
  }

  async stopMiningSound() {
    this.miningCancelled = true;
    const s = this.miningSound;
    const sub = this.miningSoundSub;
    this.miningSound = null;
    this.miningSoundSub = null;
    if (sub) { try { sub.remove(); } catch {} }
    if (s) {
      try { s.pause(); } catch {}
      try { s.seekTo(0); } catch {}
      try { s.remove(); } catch {}
    }
  }

  async init() {
    if (this.initialized) return;
    try {
      // Round 2 audit #5 MED-2: API de audio mode en expo-audio.
      // Flags renombrados respecto a expo-av:
      //   allowsRecordingIOS    -> allowsRecording
      //   playsInSilentModeIOS  -> playsInSilentMode
      //   staysActiveInBackground -> shouldPlayInBackground
      //   shouldDuckAndroid     -> (implícito en interruptionMode='duckOthers')
      //   interruptionMode*     -> interruptionMode unificado
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'duckOthers',
        interruptionModeAndroid: 'duckOthers',
      });
      this.initialized = true;
    } catch (error) {
      console.error('Error inicializando audio:', error);
    }
  }

  async loadSounds() {
    try {
      this.sounds = {
        rotura: require('../../assets/sonidos/rotura.m4a'),
        explosion: require('../../assets/sonidos/explosion.m4a'),
        win: require('../../assets/sonidos/win.m4a'),
        lose: require('../../assets/sonidos/lose.m4a'),
        mining: require('../../assets/sonidos/mining.m4a'),
        mining_ok: require('../../assets/sonidos/mining_ok.m4a'),
      };

      // B3 fix (audit gráfico 2026-06-23+): warmup explícito del decoder.
      // expo-audio no carga el archivo hasta el primer play(), causando
      // ~200-300ms latency en el primer mining_ok del juego. Forzamos un
      // play() + pause() inmediato para que el buffer esté ready en RAM
      // cuando el user toque por primera vez. Además: dispose del player
      // anterior si loadSounds() se llama 2 veces (anti-leak entre re-inits).
      try {
        if (this.miningOkPreloaded) {
          try { this.miningOkPreloaded.remove(); } catch {}
          this.miningOkPreloaded = null;
        }
        const vol = Math.max(0, Math.min(1.0, this.sfxVolumeFactor));
        const player = createAudioPlayer(this.sounds.mining_ok);
        player.volume = 0; // silencio para el warmup (no audible)
        try {
          player.play();
          // Pequeño delay para que el decoder cargue el buffer; después
          // pause + seek + restore volume.
          setTimeout(() => {
            try { player.pause(); } catch {}
            try { player.seekTo(0); } catch {}
            try { player.volume = vol; } catch {}
          }, 50);
        } catch (warmupErr) {
          // Si el warmup falla (uncommon), seteamos volume normal y seguimos.
          try { player.volume = vol; } catch {}
        }
        this.miningOkPreloaded = player;
      } catch (e) {
        console.warn('No se pudo precargar mining_ok:', e?.message || e);
      }
    } catch (error) {
      console.error('Error cargando sonidos:', error);
    }
  }

  async playBackgroundMusic() {
    if (!this.musicEnabled) return;
    if (!this.initialized) return;

    if (this.backgroundMusic) {
      try {
        const status = this.backgroundMusic.currentStatus;
        if (status && status.isLoaded && status.playing) return;
      } catch {}
    }

    try {
      if (this.backgroundMusic) {
        try { this.backgroundMusicSub && this.backgroundMusicSub.remove(); } catch {}
        this.backgroundMusicSub = null;
        try { this.backgroundMusic.pause(); } catch {}
        try { this.backgroundMusic.remove(); } catch {}
        this.backgroundMusic = null;
      }

      const tracks = [
        require('../../assets/sonidos/corte.m4a'),
        require('../../assets/sonidos/invention.m4a'),
      ];
      const randomTrack = tracks[Math.floor(Math.random() * tracks.length)];
      this.currentTrack = randomTrack;

      const player = createAudioPlayer(randomTrack);
      player.volume = 0; // Iniciar en 0 para crescendo
      player.loop = false;

      this.backgroundMusic = player;
      this.musicVolume = 0;

      this.backgroundMusicSub = player.addListener('playbackStatusUpdate', (status) => {
        if (status && status.didJustFinish) {
          this.playBackgroundMusic();
        }
      });

      try { player.play(); } catch {}
      this.startCrescendo();
    } catch (error) {
      console.error('Error reproduciendo música de fondo:', error);
    }
  }

  startCrescendo() {
    if (this.crescendoInterval) {
      clearInterval(this.crescendoInterval);
    }

    const duration = 3000;
    const steps = 30;
    this.targetMusicVolume = this.baseMusicMax * this.musicVolumeFactor;
    const increment = this.targetMusicVolume / steps;
    const interval = duration / steps;

    this.crescendoInterval = setInterval(() => {
      if (this.musicVolume < this.targetMusicVolume) {
        this.musicVolume += increment;
        if (this.backgroundMusic) {
          try {
            this.backgroundMusic.volume = Math.min(this.musicVolume, this.targetMusicVolume);
          } catch (error) {
            console.warn('Error en crescendo:', error);
          }
        }
      } else {
        clearInterval(this.crescendoInterval);
        this.crescendoInterval = null;
      }
    }, interval);
  }

  async playSound(soundName, volumeMultiplier = 1.0) {
    if (!this.soundEnabled) return;

    try {
      const soundSource = this.sounds[soundName];
      if (!soundSource) {
        console.warn(`Sonido '${soundName}' no encontrado`);
        return;
      }

      const vol = Math.max(0, Math.min(1.0, volumeMultiplier * this.sfxVolumeFactor));
      const player = createAudioPlayer(soundSource);
      player.volume = vol;

      // MEDIO-AM-06: cap del pool a 8 sonidos simultáneos. Si se supera,
      // forzar remove del más viejo para evitar leak ante interruptions.
      if (this.activeSounds.length >= 8) {
        const oldest = this.activeSounds.shift();
        if (oldest) {
          try { oldest.sub && oldest.sub.remove(); } catch (_) {}
          try { oldest.player && oldest.player.remove(); } catch (_) {}
        }
      }

      const sub = player.addListener('playbackStatusUpdate', (status) => {
        if (status && status.didJustFinish) {
          const index = this.activeSounds.findIndex((s) => s.player === player);
          if (index > -1) {
            this.activeSounds.splice(index, 1);
            try { sub.remove(); } catch {}
            try { player.remove(); } catch {}
          }
        }
      });

      this.activeSounds.push({ player, sub });
      try { player.play(); } catch {}
    } catch (error) {
      console.error(`Error reproduciendo ${soundName}:`, error);
    }
  }

  async pauseBackgroundMusic() {
    try {
      if (this.crescendoInterval) {
        clearInterval(this.crescendoInterval);
        this.crescendoInterval = null;
      }

      if (this.backgroundMusic) {
        const status = this.backgroundMusic.currentStatus;
        if (status && status.isLoaded && status.playing) {
          try { this.backgroundMusic.pause(); } catch {}
        }
      }
    } catch (error) {
      console.error('Error pausando música:', error);
    }
  }

  async resumeBackgroundMusic() {
    try {
      if (this.backgroundMusic) {
        const status = this.backgroundMusic.currentStatus;
        if (status && status.isLoaded && !status.playing) {
          try { this.backgroundMusic.play(); } catch {}
        }
      }
    } catch (error) {
      console.error('Error reanudando música:', error);
    }
  }

  async stopMusic() {
    try {
      if (this.crescendoInterval) {
        clearInterval(this.crescendoInterval);
        this.crescendoInterval = null;
      }

      if (this.backgroundMusic) {
        try { this.backgroundMusicSub && this.backgroundMusicSub.remove(); } catch {}
        this.backgroundMusicSub = null;
        try { this.backgroundMusic.pause(); } catch {}
        try { this.backgroundMusic.remove(); } catch {}
        this.backgroundMusic = null;
      }
    } catch (error) {
      console.error('Error deteniendo música:', error);
    }
  }

  async updateSettings(musicEnabled, soundEnabled) {
    this.musicEnabled = musicEnabled;
    this.soundEnabled = soundEnabled;

    if (!musicEnabled && this.backgroundMusic) {
      await this.stopMusic();
    } else if (musicEnabled && !this.backgroundMusic) {
      await this.playBackgroundMusic();
    }
  }

  async cleanup() {
    try {
      if (this.crescendoInterval) {
        clearInterval(this.crescendoInterval);
      }

      if (this.backgroundMusic) {
        try { this.backgroundMusicSub && this.backgroundMusicSub.remove(); } catch {}
        this.backgroundMusicSub = null;
        try { this.backgroundMusic.remove(); } catch {}
      }

      // Limpiar todas las instancias activas de sonidos
      for (const entry of this.activeSounds) {
        try { entry.sub && entry.sub.remove(); } catch {}
        try { entry.player && entry.player.remove(); } catch {}
      }
      this.activeSounds = [];

      if (this.miningOkPreloaded) {
        try { this.miningOkPreloaded.remove(); } catch {}
        this.miningOkPreloaded = null;
      }

      this.initialized = false;
      this.backgroundMusic = null;
      this.crescendoInterval = null;
    } catch (error) {
      console.error('Error limpiando audio:', error);
    }
  }

  async setMusicVolumeFactor(factor) {
    const f = Math.max(0, Math.min(1, Number(factor) || 0));
    this.musicVolumeFactor = f;
    this.targetMusicVolume = this.baseMusicMax * this.musicVolumeFactor;
    if (this.backgroundMusic) {
      try {
        this.backgroundMusic.volume = Math.min(this.musicVolume, this.targetMusicVolume);
      } catch {}
    }
  }

  setSfxVolumeFactor(factor) {
    const f = Math.max(0, Math.min(1, Number(factor) || 0));
    this.sfxVolumeFactor = f;
  }
}

export default new AudioManager();
