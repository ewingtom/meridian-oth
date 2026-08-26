// sfx/ui.js — click, hover, confirm, error UI feedback sounds.

import { createVoice } from "../voice.js";
import { envAD, playNoiseSlice } from "../synth.js";

export function playUiClick(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, { volume: 0.6, ...opts });
  const t0 = ctx.currentTime + 0.001;

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 1100;
  const oscGain = ctx.createGain();
  envAD(oscGain.gain, t0, { attack: 0.001, decayTau: 0.012, peak: 0.5 });
  osc.connect(oscGain).connect(voice.input);
  osc.start(t0);
  osc.stop(t0 + 0.08);

  const filt = ctx.createBiquadFilter();
  filt.type = "highpass";
  filt.frequency.value = 3500;
  const tickGain = ctx.createGain();
  envAD(tickGain.gain, t0, { attack: 0.001, decayTau: 0.008, peak: 0.35 });
  const tick = playNoiseSlice(ctx, engine._buffers.white, t0, 0.02);
  tick.connect(filt).connect(tickGain).connect(voice.input);

  engine._scheduleCleanup([voice.input, voice.panNode, oscGain, filt, tickGain], t0 + 0.2);
}

export function playUiHover(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, { volume: 0.35, ...opts });
  const t0 = ctx.currentTime + 0.001;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 700;
  const oscGain = ctx.createGain();
  envAD(oscGain.gain, t0, { attack: 0.015, decayTau: 0.05, peak: 0.4 });
  osc.connect(oscGain).connect(voice.input);
  osc.start(t0);
  osc.stop(t0 + 0.15);

  engine._scheduleCleanup([voice.input, voice.panNode, oscGain], t0 + 0.25);
}

export function playUiConfirm(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, { volume: 0.55, ...opts });
  const t0 = ctx.currentTime + 0.002;

  // Two-note rising interval — reads as a clean "affirmative" chime.
  const notes = [
    { freq: 660, t: 0, dur: 0.14 },
    { freq: 990, t: 0.09, dur: 0.22 },
  ];

  const gains = [];
  for (const n of notes) {
    const nt = t0 + n.t;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    envAD(g.gain, nt, { attack: 0.006, decayTau: 0.08, peak: 0.5 });
    osc.connect(g).connect(voice.input);
    osc.start(nt);
    osc.stop(nt + n.dur + 0.05);
    gains.push(g);
  }

  engine._scheduleCleanup([voice.input, voice.panNode, ...gains], t0 + 0.5);
}

export function playUiError(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, { volume: 0.55, ...opts });
  const t0 = ctx.currentTime + 0.002;

  // Two slightly dissonant descending tones for a clear "negative" cue.
  const osc1 = ctx.createOscillator();
  osc1.type = "square";
  osc1.frequency.setValueAtTime(320, t0);
  osc1.frequency.linearRampToValueAtTime(220, t0 + 0.16);
  const g1 = ctx.createGain();
  envAD(g1.gain, t0, { attack: 0.004, decayTau: 0.09, peak: 0.28 });

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1400;

  osc1.connect(lp).connect(g1).connect(voice.input);
  osc1.start(t0);
  osc1.stop(t0 + 0.3);

  const osc2 = ctx.createOscillator();
  osc2.type = "square";
  const t2 = t0 + 0.1;
  osc2.frequency.setValueAtTime(300, t2);
  osc2.frequency.linearRampToValueAtTime(190, t2 + 0.18);
  const g2 = ctx.createGain();
  envAD(g2.gain, t2, { attack: 0.004, decayTau: 0.1, peak: 0.28 });
  osc2.connect(lp).connect(g2).connect(voice.input);
  osc2.start(t2);
  osc2.stop(t2 + 0.3);

  engine._scheduleCleanup([voice.input, voice.panNode, g1, g2, lp], t0 + 0.6);
}
