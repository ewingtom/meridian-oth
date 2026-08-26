// AudioEngine.js
//
// Procedurally-synthesized audio engine for the naval combat game. Every
// sound — ambience beds, weapons, explosions, UI feedback, comms — is
// generated at runtime with the Web Audio API. No audio files are loaded.
//
// Bus architecture:
//
//   musicBus     -\
//   sfxBus        +--> masterGain --> DynamicsCompressor (limiter) --> destination
//   ambienceBus  -/
//
// setMasterVolume/setMusicVolume/setSfxVolume control the three named
// buses. There is no separate ambience volume control in the requested
// API, so ambienceBus tracks the sfx volume (ambience beds are treated as
// environmental "sfx"). See README.md for the full rationale.
//
// IMPORTANT: the AudioContext is NOT created in the constructor (browsers
// block audio until a user gesture). Call `await audioEngine.unlock()` on
// the first click/keydown before calling anything else.

import { Listener } from "./positional.js";
import { createNoiseBuffer, createReverbImpulse, makeDistortionCurve, clamp01 } from "./synth.js";

import {
  startOceanAmbience as _startOceanAmbience,
  startEngineHum as _startEngineHum,
  startWind as _startWind,
} from "./ambience.js";
import {
  playDeckGunFire as _playDeckGunFire,
  playMissileLaunch as _playMissileLaunch,
  playCiwsBurst as _playCiwsBurst,
  playTorpedoLaunch as _playTorpedoLaunch,
} from "./sfx/weapons.js";
import { playExplosionSmall as _playExplosionSmall, playExplosionLarge as _playExplosionLarge } from "./sfx/explosions.js";
import { playSonarPing as _playSonarPing, playRadarBlip as _playRadarBlip } from "./sfx/sonarRadar.js";
import {
  playUiClick as _playUiClick,
  playUiHover as _playUiHover,
  playUiConfirm as _playUiConfirm,
  playUiError as _playUiError,
} from "./sfx/ui.js";
import { playHitImpact as _playHitImpact, playSplash as _playSplash } from "./sfx/impacts.js";
import { playAlarmKlaxon as _playAlarmKlaxon, playRadioBlip as _playRadioBlip } from "./sfx/comms.js";

const AudioContextClass =
  typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;

    // Buses — created in unlock() once the AudioContext exists.
    this.masterGain = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.ambienceBus = null;
    this.compressor = null;

    // Cached generated assets (noise buffers, reverb IRs, distortion curves).
    this._buffers = null;
    this._impulses = null;
    this._curves = null;

    // Volume state, applied to the graph once it's built (and re-applied
    // any time the setters are called after that).
    this._masterVolume = 1;
    this._musicVolume = 0.8;
    this._sfxVolume = 1;

    this.listener = new Listener();
    this.attenuationOpts = { refDistance: 15, maxDistance: 1200, rolloff: 1.3 };

    this._unlockPromise = null;
    this._warnedNotUnlocked = false;
    this._cleanupTimers = new Set();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /**
   * Creates (once) and resumes the AudioContext. Safe to call multiple
   * times / concurrently — subsequent calls just ensure the context is
   * running. Must be invoked from inside a user-gesture handler
   * (click/keydown) per browser autoplay policy.
   */
  unlock() {
    if (this._unlockPromise) {
      // Already unlocking/unlocked — just make sure we're resumed
      // (a tab can suspend the context again after e.g. losing focus).
      return this._unlockPromise.then(() => {
        if (this.ctx && this.ctx.state !== "running") return this.ctx.resume();
      });
    }

    this._unlockPromise = (async () => {
      if (!AudioContextClass) {
        throw new Error("[AudioEngine] Web Audio API is not available in this environment.");
      }
      this.ctx = new AudioContextClass();
      this._buildGraph();
      this._buildCaches();
      if (this.ctx.state !== "running") {
        await this.ctx.resume();
      }
    })();

    return this._unlockPromise;
  }

  /** Tears down the audio graph and releases the AudioContext. Optional cleanup helper. */
  async dispose() {
    for (const id of this._cleanupTimers) clearTimeout(id);
    this._cleanupTimers.clear();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch (e) {
        /* ignore */
      }
    }
    this.ctx = null;
    this._unlockPromise = null;
  }

  _buildGraph() {
    const ctx = this.ctx;

    this.masterGain = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.ambienceBus = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();

    // Gentle master limiter — catches overlapping SFX peaks without
    // audibly pumping on isolated sounds.
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.musicBus.connect(this.masterGain);
    this.sfxBus.connect(this.masterGain);
    this.ambienceBus.connect(this.masterGain);
    this.masterGain.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    this.masterGain.gain.value = this._masterVolume;
    this.musicBus.gain.value = this._musicVolume;
    this.sfxBus.gain.value = this._sfxVolume;
    this.ambienceBus.gain.value = this._sfxVolume;
  }

  _buildCaches() {
    const ctx = this.ctx;

    // Shared noise buffers — one-shots slice random offsets from these
    // rather than generating fresh noise per trigger.
    this._buffers = {
      white: createNoiseBuffer(ctx, 4, "white"),
      pink: createNoiseBuffer(ctx, 4, "pink"),
      brown: createNoiseBuffer(ctx, 4, "brown"),
    };

    // Procedural reverb impulse responses.
    this._impulses = {
      // Bright, long, metallic-ish tail for the sonar ping.
      plate: createReverbImpulse(ctx, { duration: 3.2, decay: 2.6, brightness: 0.65 }),
      // Darker, shorter body for explosion "space".
      room: createReverbImpulse(ctx, { duration: 1.6, decay: 4.5, brightness: 0.3 }),
    };

    // Shared waveshaper distortion curves.
    this._curves = {
      mildDrive: makeDistortionCurve(20),
      heavyDrive: makeDistortionCurve(120),
      gunCrack: makeDistortionCurve(45),
    };
  }

  /** True if unlock() has completed and the graph is ready to use. */
  _ready() {
    if (!this.ctx) {
      if (!this._warnedNotUnlocked) {
        console.warn(
          "[AudioEngine] Call ignored — unlock() has not completed yet. " +
            "Call `await audioEngine.unlock()` from a user-gesture handler before triggering audio."
        );
        this._warnedNotUnlocked = true;
      }
      return false;
    }
    return true;
  }

  /** Schedules a batch of nodes to be disconnected once they're done producing sound. */
  _scheduleCleanup(nodes, ctxTime) {
    if (!this.ctx) return;
    const delayMs = Math.max(0, (ctxTime - this.ctx.currentTime) * 1000) + 30;
    const id = setTimeout(() => {
      for (const n of nodes) {
        if (n && typeof n.disconnect === "function") {
          try {
            n.disconnect();
          } catch (e) {
            /* already disconnected */
          }
        }
      }
      this._cleanupTimers.delete(id);
    }, delayMs);
    this._cleanupTimers.add(id);
  }

  _rampGain(param, value, duration = 0.05) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + duration);
  }

  // -------------------------------------------------------------------
  // Volume controls
  // -------------------------------------------------------------------

  setMasterVolume(v) {
    this._masterVolume = clamp01(v);
    if (this.masterGain) this._rampGain(this.masterGain.gain, this._masterVolume);
  }

  setMusicVolume(v) {
    this._musicVolume = clamp01(v);
    if (this.musicBus) this._rampGain(this.musicBus.gain, this._musicVolume);
  }

  setSfxVolume(v) {
    this._sfxVolume = clamp01(v);
    if (this.sfxBus) this._rampGain(this.sfxBus.gain, this._sfxVolume);
    if (this.ambienceBus) this._rampGain(this.ambienceBus.gain, this._sfxVolume);
  }

  // -------------------------------------------------------------------
  // Ambient / looping beds
  // -------------------------------------------------------------------

  startOceanAmbience(opts = {}) {
    if (!this._ready()) return null;
    return _startOceanAmbience(this, opts);
  }

  startEngineHum(rpmFraction = 0.3) {
    if (!this._ready()) return null;
    return _startEngineHum(this, clamp01(rpmFraction));
  }

  startWind(intensityFraction = 0.3) {
    if (!this._ready()) return null;
    return _startWind(this, clamp01(intensityFraction));
  }

  // -------------------------------------------------------------------
  // One-shot SFX
  // -------------------------------------------------------------------

  playDeckGunFire(opts = {}) {
    if (!this._ready()) return;
    _playDeckGunFire(this, opts);
  }

  playMissileLaunch(opts = {}) {
    if (!this._ready()) return;
    _playMissileLaunch(this, opts);
  }

  playCiwsBurst(opts = {}) {
    if (!this._ready()) return;
    _playCiwsBurst(this, opts);
  }

  playTorpedoLaunch(opts = {}) {
    if (!this._ready()) return;
    _playTorpedoLaunch(this, opts);
  }

  playExplosionSmall(opts = {}) {
    if (!this._ready()) return;
    _playExplosionSmall(this, opts);
  }

  playExplosionLarge(opts = {}) {
    if (!this._ready()) return;
    _playExplosionLarge(this, opts);
  }

  playSonarPing(opts = {}) {
    if (!this._ready()) return;
    _playSonarPing(this, opts);
  }

  playRadarBlip(opts = {}) {
    if (!this._ready()) return;
    _playRadarBlip(this, opts);
  }

  /** Loops until stopped — returns a handle with .stop(fadeSeconds). */
  playAlarmKlaxon(opts = {}) {
    if (!this._ready()) return null;
    return _playAlarmKlaxon(this, opts);
  }

  playUiClick(opts = {}) {
    if (!this._ready()) return;
    _playUiClick(this, opts);
  }

  playUiHover(opts = {}) {
    if (!this._ready()) return;
    _playUiHover(this, opts);
  }

  playUiConfirm(opts = {}) {
    if (!this._ready()) return;
    _playUiConfirm(this, opts);
  }

  playUiError(opts = {}) {
    if (!this._ready()) return;
    _playUiError(this, opts);
  }

  playHitImpact(opts = {}) {
    if (!this._ready()) return;
    _playHitImpact(this, opts);
  }

  playSplash(opts = {}) {
    if (!this._ready()) return;
    _playSplash(this, opts);
  }

  playRadioBlip(opts = {}) {
    if (!this._ready()) return;
    _playRadioBlip(this, opts);
  }

  // -------------------------------------------------------------------
  // Listener tracking (for position-based pan/attenuation on one-shots)
  // -------------------------------------------------------------------

  setListenerPosition(x, y, z) {
    this.listener.setPosition(x, y, z);
  }

  /** forwardVec3/upVec3 are plain {x,y,z} objects (need not be pre-normalized). */
  setListenerOrientation(forwardVec3, upVec3) {
    this.listener.setOrientation(forwardVec3, upVec3);
  }
}

export default AudioEngine;
