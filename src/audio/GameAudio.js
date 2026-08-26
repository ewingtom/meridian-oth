import { AudioEngine } from './AudioEngine.js';
import { clamp } from '../sim/constants.js';

/**
 * Game audio.
 *
 * Everything is synthesised at runtime — there are no sound files anywhere in
 * this project. The bed changes with where the camera is: at chart altitude you
 * hear the CIC (a low room tone, the sweep of a radar repeater, distant radio
 * traffic); drop to sea level and the ocean and the wind come up; ride a missile
 * and it is all rocket motor and airflow.
 *
 * Radio traffic is deliberately NOT speech synthesis. A vocoded squelch-and-
 * syllable burst under the text of a message reads as authentic circuit traffic,
 * where a browser TTS voice reads as a browser.
 */
export class GameAudio {
  constructor() {
    this.engine = new AudioEngine();
    this.ready = false;
    this.mode = null;
    this.loops = {};
    this.enabled = true;
    this._lastRadio = 0;
    this._cicNodes = null;
    this._sweepT = 0;
  }

  async unlock() {
    if (this.ready) return;
    try {
      await this.engine.unlock();
      this.ready = true;
      this._startBed();
    } catch (e) {
      this.enabled = false;
    }
  }

  setVolume(v) { this.engine.setMasterVolume?.(v); }

  _startBed() {
    if (!this.ready) return;
    this.loops.ocean = this.engine.startOceanAmbience({ intensity: 0.4 });
    this.loops.wind = this.engine.startWind(0.28);
    this._buildCic();
  }

  /**
   * Combat information centre room tone: a filtered low rumble plus the faint
   * hum of a hundred cooling fans. It is what a warship sounds like from inside.
   */
  _buildCic() {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const g = ctx.createGain();
    g.gain.value = 0.0;
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 58;
    const humG = ctx.createGain(); humG.gain.value = 0.035;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 0.6;
    hum.connect(humG).connect(lp).connect(g);

    // Fan noise
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const nG = ctx.createGain(); nG.gain.value = 0.055;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.55;
    src.connect(bp).connect(nG).connect(g);

    g.connect(this.engine.ambienceBus || this.engine.masterGain);
    hum.start(); src.start();
    this._cicNodes = { g };
  }

  /** Crossfade the bed as the camera moves between the plot and the sea. */
  setContext(mode, altitude, speedFrac = 0.3) {
    if (!this.ready) return;
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    const chart = clamp((altitude - 3000) / 24000, 0, 1);
    const sea = 1 - chart;
    if (this._cicNodes) {
      const target = mode === 'MISSILE' ? 0.15 : (0.25 + chart * 0.85);
      this._cicNodes.g.gain.setTargetAtTime(target, now, 0.6);
    }
    if (this.loops.ocean?.setIntensity) this.loops.ocean.setIntensity(sea * (mode === 'BRIDGE' ? 0.9 : 0.55));
    else if (this.loops.ocean?.gain) this.loops.ocean.gain.gain?.setTargetAtTime?.(sea * 0.5, now, 0.7);
    if (this.loops.wind?.setIntensity) this.loops.wind.setIntensity(mode === 'BRIDGE' ? 0.55 : sea * 0.3);
  }

  // ── one-shots ─────────────────────────────────────────────────────────────
  launch(kind = 'ASM', dist = 0) {
    if (!this.ready) return;
    const v = this._att(dist);
    if (v < 0.02) return;
    if (kind === 'TORPEDO') this.engine.playTorpedoLaunch({ volume: v });
    else this.engine.playMissileLaunch({ volume: v, gain: v });
  }
  boom(big, dist = 0) {
    if (!this.ready) return;
    const v = this._att(dist);
    if (v < 0.02) return;
    if (big) this.engine.playExplosionLarge({ volume: v, gain: v });
    else this.engine.playExplosionSmall({ volume: v, gain: v });
  }
  ciws(dist = 0) {
    if (!this.ready) return;
    const v = this._att(dist);
    if (v > 0.05) this.engine.playCiwsBurst({ volume: v, gain: v });
  }
  ping(dist = 0) { if (this.ready) this.engine.playSonarPing({ volume: this._att(dist) }); }
  klaxon() { if (this.ready) this.engine.playAlarmKlaxon({ volume: 0.55 }); }
  blip() { if (this.ready) this.engine.playRadarBlip({ volume: 0.25 }); }

  ui(kind) {
    if (!this.ready) return;
    if (kind === 'click') this.engine.playUiClick({ volume: 0.3 });
    else if (kind === 'hover') this.engine.playUiHover({ volume: 0.13 });
    else if (kind === 'confirm') this.engine.playUiConfirm({ volume: 0.32 });
    else if (kind === 'error') this.engine.playUiError({ volume: 0.35 });
  }

  /** Squelch + syllabic burst under a comms message. Cheap, and it sells. */
  radio(priority = 'ROUTINE') {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this._lastRadio < 260) return;
    this._lastRadio = now;
    const ctx = this.engine.ctx;
    const t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = priority === 'FLASH' ? 0.16 : 0.085;
    out.connect(this.engine.sfxBus || this.engine.masterGain);

    // Band-limited noise carrier shaped into 3-6 "syllables"
    const buf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 420;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    let t = t0 + 0.02;
    const syl = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < syl; i++) {
      const dur = 0.055 + Math.random() * 0.09;
      env.gain.linearRampToValueAtTime(0.5 + Math.random() * 0.5, t + 0.012);
      env.gain.linearRampToValueAtTime(0.06, t + dur);
      bp.frequency.setValueAtTime(900 + Math.random() * 1500, t);
      t += dur + 0.02 + Math.random() * 0.04;
    }
    env.gain.linearRampToValueAtTime(0, t + 0.05);
    src.connect(bp).connect(hp).connect(env).connect(out);
    src.start(t0);
    src.stop(t + 0.2);

    // Squelch tail
    const sq = ctx.createOscillator();
    sq.type = 'square'; sq.frequency.value = 2400;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0, t);
    sg.gain.linearRampToValueAtTime(0.06, t + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.0005, t + 0.07);
    sq.connect(sg).connect(out);
    sq.start(t); sq.stop(t + 0.1);
  }

  _att(dist) {
    if (dist <= 0) return 0.6;
    return clamp(1 - dist / 26000, 0, 1) ** 1.6 * 0.9;
  }
}
