// sfx/explosions.js — small and large explosions.

import { createVoice } from "../voice.js";
import { envAD, envAHD, playNoiseSlice, randRange } from "../synth.js";

/**
 * Small explosion (grenade/small shell impact) — quick filtered noise
 * crack with a downward sweep, plus a short sine sub punch. Fast attack,
 * moderately fast decay so it reads as "small".
 */
export function playExplosionSmall(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;

  // --- Broadband crack, sweeping down in brightness ---
  const crackFilter = ctx.createBiquadFilter();
  crackFilter.type = "lowpass";
  crackFilter.Q.value = 0.6;
  crackFilter.frequency.setValueAtTime(4500, t0);
  crackFilter.frequency.exponentialRampToValueAtTime(400, t0 + 0.5);

  const shaper = ctx.createWaveShaper();
  shaper.curve = engine._curves.mildDrive;

  const crackGain = ctx.createGain();
  envAD(crackGain.gain, t0, { attack: 0.003, decayTau: 0.14, peak: 0.9 });

  const crackSrc = playNoiseSlice(ctx, engine._buffers.white, t0, 0.6);
  crackSrc.connect(crackFilter).connect(shaper).connect(crackGain).connect(voice.input);

  // --- Sub punch ---
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(120, t0);
  sub.frequency.exponentialRampToValueAtTime(45, t0 + 0.16);
  const subGain = ctx.createGain();
  envAD(subGain.gain, t0, { attack: 0.004, decayTau: 0.12, peak: 1 });
  sub.connect(subGain).connect(voice.input);
  sub.start(t0);
  sub.stop(t0 + 0.6);

  engine._scheduleCleanup([voice.input, voice.panNode, crackFilter, shaper, crackGain, subGain], t0 + 0.9);
}

/**
 * Large explosion — layered sub-bass hit with a long tail, a distorted
 * broadband crack, a touch of reverb for scale, and a scattered "debris
 * crackle" of decaying noise clicks over a couple of seconds.
 */
export function playExplosionLarge(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;

  const extraNodes = [];

  // --- Sub-bass body, long decay ---
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(85, t0);
  sub.frequency.exponentialRampToValueAtTime(28, t0 + 0.5);
  const sub2 = ctx.createOscillator();
  sub2.type = "triangle";
  sub2.frequency.setValueAtTime(42, t0);
  sub2.frequency.exponentialRampToValueAtTime(24, t0 + 0.9);
  const subGain = ctx.createGain();
  envAD(subGain.gain, t0, { attack: 0.005, decayTau: 0.6, peak: 1 });
  sub.connect(subGain);
  sub2.connect(subGain);
  subGain.connect(voice.input);
  sub.start(t0);
  sub.stop(t0 + 2.2);
  sub2.start(t0);
  sub2.stop(t0 + 2.2);

  // --- Distorted broadband crack ---
  const crackFilter = ctx.createBiquadFilter();
  crackFilter.type = "lowpass";
  crackFilter.Q.value = 0.5;
  crackFilter.frequency.setValueAtTime(6000, t0);
  crackFilter.frequency.exponentialRampToValueAtTime(300, t0 + 0.9);

  const shaper = ctx.createWaveShaper();
  shaper.curve = engine._curves.heavyDrive;

  const crackGain = ctx.createGain();
  envAHD(crackGain.gain, t0, { attack: 0.004, hold: 0.05, decayTau: 0.4, peak: 1 });

  const crackSrc = playNoiseSlice(ctx, engine._buffers.white, t0, 1.2);
  crackSrc.connect(crackFilter).connect(shaper).connect(crackGain);
  crackGain.connect(voice.input);

  // A touch of reverb send for scale/space.
  const convolver = ctx.createConvolver();
  convolver.buffer = engine._impulses.room;
  const wetGain = ctx.createGain();
  wetGain.gain.value = 0.35;
  crackGain.connect(convolver).connect(wetGain).connect(voice.input);

  // --- Debris crackle tail: scattered decaying clicks, thinning out over time ---
  const crackleEnd = 2.4;
  let ct = t0 + 0.1;
  let density = 55; // clicks/sec at the start
  while (ct < t0 + crackleEnd) {
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = randRange(1200, 5500);
    filt.Q.value = randRange(2, 8);
    const g = ctx.createGain();
    const progress = (ct - t0) / crackleEnd;
    const amp = randRange(0.05, 0.22) * (1 - progress);
    envAD(g.gain, ct, { attack: 0.001, decayTau: randRange(0.01, 0.035), peak: Math.max(amp, 0.01) });
    const src = playNoiseSlice(ctx, engine._buffers.white, ct, 0.05);
    src.connect(filt).connect(g).connect(voice.input);
    extraNodes.push(filt, g);

    density *= 0.94; // thin out the click rate as time goes on
    ct += 1 / Math.max(density, 3) + randRange(0, 0.02);
  }

  engine._scheduleCleanup(
    [voice.input, voice.panNode, subGain, crackFilter, shaper, crackGain, convolver, wetGain, ...extraNodes],
    t0 + crackleEnd + 0.5
  );
}
