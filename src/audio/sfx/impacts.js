// sfx/impacts.js — incoming hit impact (metallic clang + shudder) and splash.

import { createVoice } from "../voice.js";
import { envAD, envAHD, playNoiseSlice, randRange } from "../synth.js";

/**
 * Incoming fire hitting the player's hull — a metallic clang built from a
 * handful of inharmonic decaying partials (classic bell-synthesis trick),
 * a sharp noise transient for the strike itself, and a low-frequency
 * "shudder" as the hull absorbs the hit.
 */
export function playHitImpact(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;
  const extraNodes = [];

  // --- Sharp strike transient ---
  const strikeFilter = ctx.createBiquadFilter();
  strikeFilter.type = "highpass";
  strikeFilter.frequency.value = 1200;
  const strikeGain = ctx.createGain();
  envAD(strikeGain.gain, t0, { attack: 0.001, decayTau: 0.015, peak: 0.8 });
  const strikeSrc = playNoiseSlice(ctx, engine._buffers.white, t0, 0.05);
  strikeSrc.connect(strikeFilter).connect(strikeGain).connect(voice.input);
  extraNodes.push(strikeFilter, strikeGain);

  // --- Metallic clang: inharmonic partials, each its own resonant bandpass + decay ---
  const baseFreq = opts.pitch ?? 420;
  const ratios = [1, 1.62, 2.31, 3.38, 4.6];
  for (let i = 0; i < ratios.length; i++) {
    const freq = baseFreq * ratios[i];
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = randRange(8, 16);

    const g = ctx.createGain();
    const peak = 0.55 / (i + 1);
    const decayTau = 0.12 + i * 0.05;
    envAD(g.gain, t0 + 0.002, { attack: 0.001, decayTau, peak });

    osc.connect(bp).connect(g).connect(voice.input);
    osc.start(t0);
    osc.stop(t0 + 1.2 + decayTau * 3);
    extraNodes.push(bp, g);
  }

  // --- Low-frequency hull shudder trailing the clang ---
  const shudderFilter = ctx.createBiquadFilter();
  shudderFilter.type = "lowpass";
  shudderFilter.frequency.value = 220;
  const shudderGain = ctx.createGain();
  envAHD(shudderGain.gain, t0 + 0.01, { attack: 0.02, hold: 0.05, decayTau: 0.35, peak: 0.5 });
  const shudderSrc = playNoiseSlice(ctx, engine._buffers.brown, t0, 0.7);
  shudderSrc.connect(shudderFilter).connect(shudderGain).connect(voice.input);
  extraNodes.push(shudderFilter, shudderGain);

  engine._scheduleCleanup([voice.input, voice.panNode, ...extraNodes], t0 + 2.2);
}

/**
 * Shell/debris hitting water — a filtered noise "swell", a quick downward
 * pitched droplet ping, and a short bubbling tail.
 */
export function playSplash(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;
  const extraNodes = [];

  // --- Main splash swell: bandpass noise, quick rise then decay ---
  const swellFilter = ctx.createBiquadFilter();
  swellFilter.type = "bandpass";
  swellFilter.Q.value = 0.7;
  swellFilter.frequency.setValueAtTime(1800, t0);
  swellFilter.frequency.exponentialRampToValueAtTime(500, t0 + 0.35);
  const swellGain = ctx.createGain();
  envAHD(swellGain.gain, t0, { attack: 0.02, hold: 0.03, decayTau: 0.18, peak: 0.85 });
  const swellSrc = playNoiseSlice(ctx, engine._buffers.white, t0, 0.5);
  swellSrc.connect(swellFilter).connect(swellGain).connect(voice.input);
  extraNodes.push(swellFilter, swellGain);

  // --- Droplet "plink": fast downward sine sweep ---
  const plinkT = t0 + 0.02;
  const plink = ctx.createOscillator();
  plink.type = "sine";
  plink.frequency.setValueAtTime(1400, plinkT);
  plink.frequency.exponentialRampToValueAtTime(280, plinkT + 0.12);
  const plinkGain = ctx.createGain();
  envAD(plinkGain.gain, plinkT, { attack: 0.002, decayTau: 0.06, peak: 0.4 });
  plink.connect(plinkGain).connect(voice.input);
  plink.start(plinkT);
  plink.stop(plinkT + 0.25);
  extraNodes.push(plinkGain);

  // --- Bubbling tail: a handful of short high-passed noise "bloops" ---
  let bt = t0 + 0.1;
  for (let i = 0; i < 5; i++) {
    bt += randRange(0.04, 0.1);
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = randRange(400, 1200);
    filt.Q.value = 3;
    const g = ctx.createGain();
    envAD(g.gain, bt, { attack: 0.002, decayTau: 0.04, peak: randRange(0.08, 0.18) });
    const src = playNoiseSlice(ctx, engine._buffers.white, bt, 0.06);
    src.connect(filt).connect(g).connect(voice.input);
    extraNodes.push(filt, g);
  }

  engine._scheduleCleanup([voice.input, voice.panNode, ...extraNodes], t0 + 1.0);
}
