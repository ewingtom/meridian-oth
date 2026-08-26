// sfx/sonarRadar.js — the iconic sonar ping, and a subtle radar UI blip.

import { createVoice } from "../voice.js";
import { envAD, playNoiseSlice } from "../synth.js";

/**
 * Classic submarine-movie sonar ping: a clean sine tone (with a quiet
 * octave-up partner for shimmer) and a long synthesized plate-reverb tail
 * via ConvolverNode. This is the flagship sound — kept pure and simple so
 * the reverb tail has room to breathe.
 */
export function playSonarPing(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.005;
  const baseFreq = opts.frequency ?? 950;

  // Dry signal bus — feeds both the direct sound and the reverb send.
  const dryBus = ctx.createGain();
  dryBus.gain.value = 1;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(baseFreq, t0);
  // A very slight downward drift gives the ping a touch of realism instead
  // of sounding like a dead-flat test tone.
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.97, t0 + 0.6);

  const oscGain = ctx.createGain();
  envAD(oscGain.gain, t0, { attack: 0.008, decayTau: 0.22, peak: 0.9 });
  osc.connect(oscGain).connect(dryBus);
  osc.start(t0);
  osc.stop(t0 + 1.2);

  // Quiet octave-up partner for a bit of metallic shimmer.
  const harm = ctx.createOscillator();
  harm.type = "sine";
  harm.frequency.setValueAtTime(baseFreq * 2, t0);
  harm.frequency.exponentialRampToValueAtTime(baseFreq * 2 * 0.97, t0 + 0.6);
  const harmGain = ctx.createGain();
  envAD(harmGain.gain, t0, { attack: 0.008, decayTau: 0.18, peak: 0.18 });
  harm.connect(harmGain).connect(dryBus);
  harm.start(t0);
  harm.stop(t0 + 1.2);

  // Direct path to output (quieter than the reverb send — the tail is the star).
  const directGain = ctx.createGain();
  directGain.gain.value = 0.5;
  dryBus.connect(directGain).connect(voice.input);

  // Long plate-style reverb tail.
  const convolver = ctx.createConvolver();
  convolver.buffer = engine._impulses.plate;
  const wetGain = ctx.createGain();
  wetGain.gain.value = opts.reverbAmount ?? 0.85;
  dryBus.connect(convolver).connect(wetGain).connect(voice.input);

  engine._scheduleCleanup(
    [voice.input, voice.panNode, dryBus, oscGain, harmGain, directGain, convolver, wetGain],
    t0 + 4.2
  );
}

/**
 * Subtle radar contact blip for UI sweep events — short, quiet, unobtrusive.
 */
export function playRadarBlip(engine, opts = {}) {
  const ctx = engine.ctx;
  const mergedOpts = { volume: 0.5, ...opts };
  const voice = createVoice(engine, engine.sfxBus, mergedOpts);
  const t0 = ctx.currentTime + 0.002;
  const freq = opts.frequency ?? 2000;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const oscGain = ctx.createGain();
  envAD(oscGain.gain, t0, { attack: 0.002, decayTau: 0.05, peak: 0.6 });
  osc.connect(oscGain).connect(voice.input);
  osc.start(t0);
  osc.stop(t0 + 0.2);

  // Tiny noise tick for texture.
  const filt = ctx.createBiquadFilter();
  filt.type = "highpass";
  filt.frequency.value = 4000;
  const tickGain = ctx.createGain();
  envAD(tickGain.gain, t0, { attack: 0.001, decayTau: 0.012, peak: 0.15 });
  const tick = playNoiseSlice(ctx, engine._buffers.white, t0, 0.03);
  tick.connect(filt).connect(tickGain).connect(voice.input);

  engine._scheduleCleanup([voice.input, voice.panNode, oscGain, filt, tickGain], t0 + 0.4);
}
