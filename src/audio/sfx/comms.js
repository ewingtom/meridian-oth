// sfx/comms.js — alarm klaxon (looping) and radio comms blip (one-shot).

import { createVoice, LoopHandle } from "../voice.js";
import { envAD, playNoiseSlice } from "../synth.js";

/**
 * Damage/threat alarm klaxon — a warbling sawtooth between two pitches
 * (classic klaxon "wah-wah"), driven bandpass-filtered and lightly
 * distorted for grit. Loops until the caller invokes handle.stop().
 */
export function playAlarmKlaxon(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, { volume: 0.7, ...opts });
  const t0 = ctx.currentTime + 0.005;

  const loopGain = ctx.createGain();
  loopGain.gain.setValueAtTime(0.0001, t0);
  loopGain.gain.linearRampToValueAtTime(1, t0 + 0.15);

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";

  const lowFreq = opts.lowFreq ?? 340;
  const highFreq = opts.highFreq ?? 440;
  const warbleRate = opts.warbleRate ?? 2.2; // Hz — full low->high->low cycles per second

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = warbleRate;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = (highFreq - lowFreq) / 2;
  lfo.connect(lfoDepth);
  lfoDepth.connect(osc.frequency);
  osc.frequency.value = (highFreq + lowFreq) / 2;

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 900;
  bandpass.Q.value = 0.8;

  const shaper = ctx.createWaveShaper();
  shaper.curve = engine._curves.mildDrive;

  osc.connect(bandpass).connect(shaper).connect(loopGain).connect(voice.input);

  osc.start(t0);
  lfo.start(t0);

  const handle = new LoopHandle(engine, {
    gainNode: loopGain,
    onStop: (stopTime) => {
      osc.stop(stopTime);
      lfo.stop(stopTime);
      engine._scheduleCleanup([voice.input, voice.panNode, loopGain, bandpass, shaper, lfoDepth], stopTime + 0.1);
    },
  });

  return handle;
}

/**
 * Short comms static/beep chirp for radio-chatter barks — a brief
 * bandpassed static burst (squelch opening) followed by a quick tone blip.
 */
export function playRadioBlip(engine, opts = {}) {
  const ctx = engine.ctx;
  const voice = createVoice(engine, engine.sfxBus, { volume: 0.5, ...opts });
  const t0 = ctx.currentTime + 0.002;

  // --- Squelch/static burst ---
  const staticFilter = ctx.createBiquadFilter();
  staticFilter.type = "bandpass";
  staticFilter.frequency.value = 2200;
  staticFilter.Q.value = 0.6;
  const staticGain = ctx.createGain();
  envAD(staticGain.gain, t0, { attack: 0.003, decayTau: 0.04, peak: 0.5 });
  const staticSrc = playNoiseSlice(ctx, engine._buffers.white, t0, 0.1);
  staticSrc.connect(staticFilter).connect(staticGain).connect(voice.input);

  // --- Chirp beep ---
  const beepT = t0 + 0.03;
  const beep = ctx.createOscillator();
  beep.type = "square";
  beep.frequency.setValueAtTime(1000, beepT);
  beep.frequency.exponentialRampToValueAtTime(1400, beepT + 0.06);
  const beepFilter = ctx.createBiquadFilter();
  beepFilter.type = "lowpass";
  beepFilter.frequency.value = 2600;
  const beepGain = ctx.createGain();
  envAD(beepGain.gain, beepT, { attack: 0.004, decayTau: 0.045, peak: 0.35 });
  beep.connect(beepFilter).connect(beepGain).connect(voice.input);
  beep.start(beepT);
  beep.stop(beepT + 0.15);

  engine._scheduleCleanup(
    [voice.input, voice.panNode, staticFilter, staticGain, beepFilter, beepGain],
    t0 + 0.35
  );
}
