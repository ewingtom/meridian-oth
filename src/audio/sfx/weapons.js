// sfx/weapons.js — deck gun, missile launch, CIWS burst, torpedo launch.

import { createVoice } from "../voice.js";
import { envAD, envAHD, pitchRamp, randRange, playNoiseSlice } from "../synth.js";

/**
 * Deck gun (naval 5"/76mm style) — a sharp bandpassed noise "crack",
 * a low-frequency body thump for weight, and a very short mechanical
 * breech "clack" tail.
 */
export function playDeckGunFire(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;

  // --- Crack: filtered noise transient, mildly distorted for punch ---
  const crackFilter = ctx.createBiquadFilter();
  crackFilter.type = "bandpass";
  crackFilter.frequency.value = 2600;
  crackFilter.Q.value = 0.9;

  const shaper = ctx.createWaveShaper();
  shaper.curve = engine._curves.gunCrack;

  const crackGain = ctx.createGain();
  envAD(crackGain.gain, t0, { attack: 0.001, decayTau: 0.028, peak: 1 });

  const crackSrc = playNoiseSlice(ctx, engine._buffers.white, t0, 0.18);
  crackSrc.connect(crackFilter).connect(shaper).connect(crackGain).connect(voice.input);

  // --- Body thump: low sine/triangle with a fast downward pitch drop ---
  const thumpOsc = ctx.createOscillator();
  thumpOsc.type = "triangle";
  pitchRamp(thumpOsc.frequency, t0, 150, 58, 0.09);
  const thumpGain = ctx.createGain();
  envAD(thumpGain.gain, t0, { attack: 0.002, decayTau: 0.045, peak: 0.9 });
  thumpOsc.connect(thumpGain).connect(voice.input);
  thumpOsc.start(t0);
  thumpOsc.stop(t0 + 0.3);

  // --- Mechanical breech clack, slightly delayed ---
  const clackT = t0 + 0.028;
  const clackFilter = ctx.createBiquadFilter();
  clackFilter.type = "bandpass";
  clackFilter.frequency.value = 950;
  clackFilter.Q.value = 3;
  const clackGain = ctx.createGain();
  envAD(clackGain.gain, clackT, { attack: 0.001, decayTau: 0.018, peak: 0.35 });
  const clackSrc = playNoiseSlice(ctx, engine._buffers.white, clackT, 0.05);
  clackSrc.connect(clackFilter).connect(clackGain).connect(voice.input);

  engine._scheduleCleanup([voice.input, voice.panNode, crackFilter, shaper, crackGain, thumpGain, clackFilter, clackGain], t0 + 0.5);
}

/**
 * Missile launch — sub-bass ignition thump, a sustained filtered-noise
 * ignition roar, and a rising bandpass "whoosh" as it clears the rail.
 */
export function playMissileLaunch(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;

  // --- Ignition sub thump ---
  const thump = ctx.createOscillator();
  thump.type = "sine";
  pitchRamp(thump.frequency, t0, 58, 32, 0.22);
  const thumpGain = ctx.createGain();
  envAD(thumpGain.gain, t0, { attack: 0.006, decayTau: 0.18, peak: 1 });
  thump.connect(thumpGain).connect(voice.input);
  thump.start(t0);
  thump.stop(t0 + 0.9);

  // --- Ignition roar: filtered brown noise, opens up then settles ---
  const roarFilter = ctx.createBiquadFilter();
  roarFilter.type = "lowpass";
  roarFilter.Q.value = 0.7;
  roarFilter.frequency.setValueAtTime(250, t0);
  roarFilter.frequency.linearRampToValueAtTime(2200, t0 + 0.25);
  roarFilter.frequency.linearRampToValueAtTime(900, t0 + 1.1);

  const roarShaper = ctx.createWaveShaper();
  roarShaper.curve = engine._curves.mildDrive;

  const roarGain = ctx.createGain();
  envAHD(roarGain.gain, t0, { attack: 0.04, hold: 0.35, decayTau: 0.55, peak: 0.85 });

  const roarSrc = playNoiseSlice(ctx, engine._buffers.brown, t0, 1.3);
  roarSrc.connect(roarFilter).connect(roarShaper).connect(roarGain).connect(voice.input);

  // --- Whoosh: bandpass sweeping upward as the missile accelerates away ---
  const whooshT = t0 + 0.08;
  const whooshFilter = ctx.createBiquadFilter();
  whooshFilter.type = "bandpass";
  whooshFilter.Q.value = 1.1;
  whooshFilter.frequency.setValueAtTime(500, whooshT);
  whooshFilter.frequency.exponentialRampToValueAtTime(4200, whooshT + 0.9);

  const whooshGain = ctx.createGain();
  envAHD(whooshGain.gain, whooshT, { attack: 0.15, hold: 0.2, decayTau: 0.35, peak: 0.55 });

  const whooshSrc = playNoiseSlice(ctx, engine._buffers.white, whooshT, 1.0);
  whooshSrc.connect(whooshFilter).connect(whooshGain).connect(voice.input);

  engine._scheduleCleanup(
    [voice.input, voice.panNode, thumpGain, roarFilter, roarShaper, roarGain, whooshFilter, whooshGain],
    t0 + 1.6
  );
}

/**
 * CIWS burst (Phalanx-style) — very high rate of fire "buzzsaw" texture
 * made from rapidly retriggered short noise bursts, faster than the deck
 * gun and denser.
 */
export function playCiwsBurst(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;
  const duration = opts.duration ?? 0.55;
  const rate = opts.rate ?? 62; // bursts per second — Phalanx is ~75rps, keep a hair under for clarity

  const bedFilter = ctx.createBiquadFilter();
  bedFilter.type = "bandpass";
  bedFilter.frequency.value = 2100;
  bedFilter.Q.value = 0.8;
  const bedGain = ctx.createGain();
  envAHD(bedGain.gain, t0, { attack: 0.01, hold: duration * 0.6, decayTau: 0.08, peak: 0.25 });
  const bedSrc = playNoiseSlice(ctx, engine._buffers.white, t0, duration + 0.1);
  bedSrc.connect(bedFilter).connect(bedGain).connect(voice.input);

  const nBursts = Math.round(duration * rate);
  const extraNodes = [bedFilter, bedGain];
  for (let i = 0; i < nBursts; i++) {
    const bt = t0 + i / rate;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = randRange(1500, 3200);
    filt.Q.value = 4;
    const g = ctx.createGain();
    // Slight fade-out across the burst so it doesn't cut off abruptly.
    const tailFactor = 1 - (i / nBursts) * 0.35;
    envAD(g.gain, bt, { attack: 0.0008, decayTau: 0.006, peak: 0.9 * tailFactor });
    const src = playNoiseSlice(ctx, engine._buffers.white, bt, 0.012);
    src.connect(filt).connect(g).connect(voice.input);
    extraNodes.push(filt, g);
  }

  engine._scheduleCleanup([voice.input, voice.panNode, ...extraNodes], t0 + duration + 0.3);
}

/**
 * Torpedo launch — pneumatic/compressed-air ejection hiss, a metallic tube
 * release "clank", and a trailing series of underwater bubble blips as the
 * propulsion spins up.
 */
export function playTorpedoLaunch(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, opts);
  const t0 = ctx.currentTime + 0.002;

  // --- Metallic tube-release clank ---
  const clankFilter = ctx.createBiquadFilter();
  clankFilter.type = "bandpass";
  clankFilter.frequency.value = 1250;
  clankFilter.Q.value = 5;
  const clankGain = ctx.createGain();
  envAD(clankGain.gain, t0, { attack: 0.001, decayTau: 0.03, peak: 0.6 });
  const clankSrc = playNoiseSlice(ctx, engine._buffers.white, t0, 0.08);
  clankSrc.connect(clankFilter).connect(clankGain).connect(voice.input);

  // --- Pneumatic hiss: muffled lowpassed noise burst ---
  const hissT = t0 + 0.01;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = "bandpass";
  hissFilter.frequency.setValueAtTime(900, hissT);
  hissFilter.frequency.exponentialRampToValueAtTime(300, hissT + 0.55);
  hissFilter.Q.value = 0.9;
  const hissGain = ctx.createGain();
  envAHD(hissGain.gain, hissT, { attack: 0.02, hold: 0.12, decayTau: 0.3, peak: 0.75 });
  const hissSrc = playNoiseSlice(ctx, engine._buffers.white, hissT, 0.7);
  hissSrc.connect(hissFilter).connect(hissGain).connect(voice.input);

  // --- Low wobble as the torpedo motor engages ---
  const wobble = ctx.createOscillator();
  wobble.type = "sine";
  wobble.frequency.setValueAtTime(70, t0);
  wobble.frequency.linearRampToValueAtTime(95, t0 + 1.0);
  const wobbleGain = ctx.createGain();
  envAHD(wobbleGain.gain, t0 + 0.05, { attack: 0.15, hold: 0.5, decayTau: 0.4, peak: 0.3 });
  wobble.connect(wobbleGain).connect(voice.input);
  wobble.start(t0);
  wobble.stop(t0 + 1.3);

  // --- Underwater bubble blips trailing off ---
  const extraNodes = [clankFilter, clankGain, hissFilter, hissGain, wobbleGain];
  const nBlips = 8;
  let bt = t0 + 0.2;
  for (let i = 0; i < nBlips; i++) {
    bt += randRange(0.05, 0.14);
    const blip = ctx.createOscillator();
    blip.type = "sine";
    const freq = randRange(180, 420);
    blip.frequency.setValueAtTime(freq, bt);
    blip.frequency.exponentialRampToValueAtTime(freq * 0.6, bt + 0.06);
    const bg = ctx.createGain();
    const amp = 0.18 * (1 - i / nBlips);
    envAD(bg.gain, bt, { attack: 0.003, decayTau: 0.03, peak: Math.max(amp, 0.02) });
    blip.connect(bg).connect(voice.input);
    blip.start(bt);
    blip.stop(bt + 0.15);
    extraNodes.push(bg);
  }

  engine._scheduleCleanup([voice.input, voice.panNode, ...extraNodes], t0 + 1.6);
}
