import { Audio } from 'expo-av';

// Sistema de gestión de audio para el juego
class AudioManager {
  constructor() {
    this.backgroundMusic = null;
    this.sounds = {};
    this.activeSounds = [];
    this.musicEnabled = true;
    this.soundEnabled = true;
    this.initialized = false;
    this.currentTrack = null;
    this.musicVolume = 0;
    // Volúmenes base máximos (no superar)
    this.baseMusicMax = 0.5; // 50% volumen máximo de música
    // Factores ajustables por el usuario (0..1)
    this.musicVolumeFactor = 1.0;
    this.sfxVolumeFactor = 1.0;
    // Objetivo actual de música = base * factor
    this.targetMusicVolume = this.baseMusicMax * this.musicVolumeFactor;
    this.crescendoInterval = null;
  }

  // Inicializar sistema de audio
  async init() {
    if (this.initialized) return; // evitar doble inicialización
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true, // Mantener audio en background
        shouldDuckAndroid: true, // Reducir volumen cuando otras apps usan audio
        interruptionModeIOS: 1, // Duck others
        interruptionModeAndroid: 1, // Duck others
      });
      this.initialized = true;
    } catch (error) {
      console.error('Error inicializando audio:', error);
    }
  }

  // Cargar y precargar sonidos (guardar solo las fuentes)
  async loadSounds() {
    try {
      // Guardar las FUENTES de los sonidos, no las instancias
      this.sounds = {
        rotura: require('../../assets/sonidos/rotura.m4a'),
        explosion: require('../../assets/sonidos/explosion.m4a'),
        win: require('../../assets/sonidos/win.m4a'),
        lose: require('../../assets/sonidos/lose.m4a'),
      };

    } catch (error) {
      console.error('Error cargando sonidos:', error);
    }
  }

  // Reproducir música de fondo aleatoria con crescendo
  async playBackgroundMusic() {
    if (!this.musicEnabled) return;
    if (!this.initialized) return; // esperar a que init() termine

    // Si ya hay música sonando, no reiniciar
    if (this.backgroundMusic) {
      try {
        const status = await this.backgroundMusic.getStatusAsync();
        if (status.isLoaded && status.isPlaying) return;
      } catch {}
    }

    try {
      // Detener música anterior si existe
      if (this.backgroundMusic) {
        await this.backgroundMusic.stopAsync();
        await this.backgroundMusic.unloadAsync();
      }

      // Seleccionar track aleatorio
      const tracks = [
        require('../../assets/sonidos/corte.m4a'),
        require('../../assets/sonidos/invention.m4a'),
      ];
      const randomTrack = tracks[Math.floor(Math.random() * tracks.length)];
      this.currentTrack = randomTrack;

      // Crear y configurar música
      const { sound } = await Audio.Sound.createAsync(randomTrack, {
        volume: 0, // Iniciar en 0 para crescendo
        isLooping: false,
      });
      
      this.backgroundMusic = sound;
      this.musicVolume = 0;

      // Reproducir
      await sound.playAsync();

      // Escuchar cuando termine para reproducir siguiente track
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          this.playBackgroundMusic(); // Reproducir siguiente track aleatorio
        }
      });

      // Iniciar crescendo (de 0 a 0.5 en 3 segundos)
      this.startCrescendo();
    } catch (error) {
      console.error('Error reproduciendo música de fondo:', error);
    }
  }

  // Crescendo gradual de volumen
  startCrescendo() {
    if (this.crescendoInterval) {
      clearInterval(this.crescendoInterval);
    }

    const duration = 3000; // 3 segundos
    const steps = 30; // 30 pasos
    // recalcular target por si cambió el factor
    this.targetMusicVolume = this.baseMusicMax * this.musicVolumeFactor;
    const increment = this.targetMusicVolume / steps;
    const interval = duration / steps;

    this.crescendoInterval = setInterval(async () => {
      if (this.musicVolume < this.targetMusicVolume) {
        this.musicVolume += increment;
        if (this.backgroundMusic) {
          try {
            await this.backgroundMusic.setVolumeAsync(Math.min(this.musicVolume, this.targetMusicVolume));
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

  // Reproducir efecto de sonido (con superposición permitida)
  async playSound(soundName, volumeMultiplier = 1.0) {
    if (!this.soundEnabled) return;

    try {
      const soundSource = this.sounds[soundName];
      if (!soundSource) {
        console.warn(`Sonido '${soundName}' no encontrado`);
        return;
      }

      // Crear NUEVA instancia del sonido (permite superposición)
      const vol = Math.max(0, Math.min(1.0, volumeMultiplier * this.sfxVolumeFactor));
      const { sound } = await Audio.Sound.createAsync(soundSource, {
        volume: vol,
        shouldPlay: true, // Reproducir inmediatamente
      });

      // Agregar al pool de sonidos activos
      this.activeSounds.push(sound);

      // Auto-limpieza cuando termine de reproducirse
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          const index = this.activeSounds.indexOf(sound);
          if (index > -1) {
            this.activeSounds.splice(index, 1);
          }
        }
      });
    } catch (error) {
      console.error(`Error reproduciendo ${soundName}:`, error);
    }
  }

  // Pausar música de fondo (mantener instancia)
  async pauseBackgroundMusic() {
    try {
      if (this.crescendoInterval) {
        clearInterval(this.crescendoInterval);
        this.crescendoInterval = null;
      }

      if (this.backgroundMusic) {
        const status = await this.backgroundMusic.getStatusAsync();
        if (status.isLoaded && status.isPlaying) {
          await this.backgroundMusic.pauseAsync();
        }
      }
    } catch (error) {
      console.error('Error pausando música:', error);
    }
  }

  // Reanudar música de fondo
  async resumeBackgroundMusic() {
    try {
      if (this.backgroundMusic) {
        const status = await this.backgroundMusic.getStatusAsync();
        if (status.isLoaded && !status.isPlaying) {
          await this.backgroundMusic.playAsync();
        }
      }
    } catch (error) {
      console.error('Error reanudando música:', error);
    }
  }

  // Detener música de fondo (eliminar instancia)
  async stopMusic() {
    try {
      if (this.crescendoInterval) {
        clearInterval(this.crescendoInterval);
        this.crescendoInterval = null;
      }

      if (this.backgroundMusic) {
        await this.backgroundMusic.stopAsync();
        await this.backgroundMusic.unloadAsync();
        this.backgroundMusic = null;
      }
    } catch (error) {
      console.error('Error deteniendo música:', error);
    }
  }

  // Actualizar configuración de audio
  async updateSettings(musicEnabled, soundEnabled) {
    this.musicEnabled = musicEnabled;
    this.soundEnabled = soundEnabled;

    if (!musicEnabled && this.backgroundMusic) {
      await this.stopMusic();
    } else if (musicEnabled && !this.backgroundMusic) {
      await this.playBackgroundMusic();
    }
  }

  // Limpiar recursos al salir
  async cleanup() {
    try {
      if (this.crescendoInterval) {
        clearInterval(this.crescendoInterval);
      }

      if (this.backgroundMusic) {
        await this.backgroundMusic.unloadAsync();
      }

      // Limpiar todas las instancias activas de sonidos
      for (const sound of this.activeSounds) {
        try {
          await sound.unloadAsync();
        } catch {}
      }
      this.activeSounds = [];
    } catch (error) {
      console.error('Error limpiando audio:', error);
    }
  }

  // Setters para factores de volumen de usuario (0..1)
  async setMusicVolumeFactor(factor) {
    const f = Math.max(0, Math.min(1, Number(factor) || 0));
    this.musicVolumeFactor = f;
    this.targetMusicVolume = this.baseMusicMax * this.musicVolumeFactor;
    // Aplicar inmediatamente si hay música sonando
    if (this.backgroundMusic) {
      try {
        await this.backgroundMusic.setVolumeAsync(Math.min(this.musicVolume, this.targetMusicVolume));
      } catch {}
    }
  }

  setSfxVolumeFactor(factor) {
    const f = Math.max(0, Math.min(1, Number(factor) || 0));
    this.sfxVolumeFactor = f;
  }
}

// Exportar instancia singleton
export default new AudioManager();
