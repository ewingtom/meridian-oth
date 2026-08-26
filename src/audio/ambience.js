// ambience.js — looping environmental beds: ocean, engine hum, wind.
//
// These are global environment beds (not positioned in 3D space), so they
// connect straight into the ambience bus rather than going through the
// per-voice pan/attenuation chain used by one-shot SFX.

import { LoopHandle } from "./voice.js";
import { envAHD, playNoiseSlice, randRange, clamp01, lerp, createLFO } from "./synth.js";

/**
 * Ocean ambience — a filtered noise swell bed (slow "breathing" lowpass
 * modulation), a quiet foam/spray hiss layer, and randomized wave-crash
 * swells scheduled on a lookahead timer. handle.setIntensity(0-1) scales
 * overall loudness, filter brightness, and crash frequency.
 */
export function startOceanAmbience(engine, opts = {}) {
  const ctx = engine.ctx;
  const t0 = ctx.currentTime + 0.02;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.linearRampToValueAtTime(1, t0 + 1.5);
  master.connect(engine.ambienceBus);

  // --- Base swell bed ---
  const bedGain = ctx.createGain();
  const bedFilter = ctx.createBiquadFilter();
  bedFilter.type = "lowpass";
  bedFilter.frequency.value = 500;
  bedFilter.Q.value = 0.5;

  const bedSrc = ctx.createBufferSource();
  bedSrc.buffer = engine._buffers.brown;
  bedSrc.loop = true;
  bedSrc.start(t0);
  bedSrc.connect(bedFilter).connect(bedGain).connect(master);

  const swell = createLFO(ctx, bedFilter.frequency, { frequency: 0.07, depth: 220, center: 500 });
  swell.osc.start(t0);

  // --- Foam / spray hiss layer ---
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = "bandpass";
  hissFilter.frequency.value = 3500;
  hissFilter.Q.value = 0.6;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0.1;
  const hissSrc = ctx.createBufferSource();
  hissSrc.buffer = engine._buffers.white;
  hissSrc.loop = true;
  hissSrc.start(t0);
  hissSrc.connect(hissFilter).connect(hissGain).connect(master);

  let intensity = clamp01(opts.intensity ?? 0.5);
  function applyIntensity(v) {
    intensity = v;
    const now = ctx.currentTime;
    bedGain.gain.setTargetAtTime(lerp(0.3, 0.9, v), now, 0.5);
    hissGain.gain.setTargetAtTime(lerp(0.04, 0.3, v), now, 0.5);
    swell.depthGain.gain.setTargetAtTime(lerp(150, 400, v), now, 0.5);
  }
  applyIntensity(intensity);

  // --- Randomized wave crashes on a lookahead JS timer ---
  let stopped = false;
  let timerId = null;
  const crashNodes = [];

  function scheduleCrash() {
    if (stopped) return;
    const delaySec = randRange(3, 9) / (0.4 + intensity);
    timerId = setTimeout(() => {
      if (stopped) return;
      playCrash();
      scheduleCrash();
    }, delaySec * 1000);
  }

  function playCrash() {
    const ct = ctx.currentTime + 0.02;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.setValueAtTime(1800, ct);
    filt.frequency.exponentialRampToValueAtTime(280, ct + 1.2);
    const g = ctx.createGain();
    envAHD(g.gain, ct, { attack: 0.25, hold: 0.15, decayTau: 0.6, peak: 0.2 + intensity * 0.4 });
    const src = playNoiseSlice(ctx, engine._buffers.white, ct, 1.6);
    src.connect(filt).connect(g).connect(master);
    engine._scheduleCleanup([filt, g], ct + 2.2);
  }

  scheduleCrash();

  return new LoopHandle(engine, {
    gainNode: master,
    onSetIntensity: applyIntensity,
    onStop: (stopTime) => {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      bedSrc.stop(stopTime);
      hissSrc.stop(stopTime);
      swell.osc.stop(stopTime);
      engine._scheduleCleanup(
        [master, bedGain, bedFilter, hissFilter, hissGain, swell.depthGain, ...crashNodes],
        stopTime + 0.2
      );
    },
  });
}

/**
 * Continuous engine drone — layered detuned sawtooth oscillators (fundamental
 * + slightly detuned octave + sub) through a lowpass filter, plus a subtle
 * tremolo and an rpm-scaled mechanical noise texture. handle.setRpm(fraction)
 * smoothly re-tunes everything.
 */
export function startEngineHum(engine, rpmFraction = 0.3) {
  const ctx = engine.ctx;
  const t0 = ctx.currentTime + 0.02;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.linearRampToValueAtTime(1, t0 + 1.2);
  master.connect(engine.ambienceBus);

  const rpmToFund = (r) => lerp(36, 95, clamp01(r));
  const rpmToCutoff = (r) => lerp(220, 1500, clamp01(r));

  const fundamental = ctx.createOscillator();
  fundamental.type = "sawtooth";
  fundamental.frequency.value = rpmToFund(rpmFraction);

  const detuned = ctx.createOscillator();
  detuned.type = "sawtooth";
  detuned.frequency.value = rpmToFund(rpmFraction) * 2.01;

  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.value = rpmToFund(rpmFraction) / 2;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.6;

  const toneFilter = ctx.createBiquadFilter();
  toneFilter.type = "lowpass";
  toneFilter.frequency.value = rpmToCutoff(rpmFraction);
  toneFilter.Q.value = 1.4;

  const toneGain = ctx.createGain();
  toneGain.gain.value = lerp(0.4, 0.65, rpmFraction);

  fundamental.connect(toneFilter);
  detuned.connect(toneFilter);
  sub.connect(subGain).connect(toneFilter);
  toneFilter.connect(toneGain).connect(master);

  // Subtle tremolo for a "thrumming" feel.
  const tremolo = createLFO(ctx, toneGain.gain, {
    frequency: 6 + rpmFraction * 4,
    depth: 0.05,
  });

  // Mechanical/turbine noise texture, scaling with rpm.
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = "bandpass";
  noiseFilter.frequency.value = 900;
  noiseFilter.Q.value = 0.7;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = lerp(0.04, 0.2, rpmFraction);
  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = engine._buffers.white;
  noiseSrc.loop = true;
  noiseSrc.start(t0);
  noiseSrc.connect(noiseFilter).connect(noiseGain).connect(master);

  fundamental.start(t0);
  detuned.start(t0);
  sub.start(t0);
  tremolo.osc.start(t0);

  function applyRpm(fraction) {
    const now = ctx.currentTime;
    const fund = rpmToFund(fraction);
    fundamental.frequency.setTargetAtTime(fund, now, 0.4);
    detuned.frequency.setTargetAtTime(fund * 2.01, now, 0.4);
    sub.frequency.setTargetAtTime(fund / 2, now, 0.4);
    toneFilter.frequency.setTargetAtTime(rpmToCutoff(fraction), now, 0.4);
    toneGain.gain.setTargetAtTime(lerp(0.4, 0.65, fraction), now, 0.4);
    noiseGain.gain.setTargetAtTime(lerp(0.04, 0.2, fraction), now, 0.4);
    tremolo.osc.frequency.setTargetAtTime(6 + fraction * 4, now, 0.4);
  }

  return new LoopHandle(engine, {
    gainNode: master,
    onSetRpm: applyRpm,
    onStop: (stopTime) => {
      fundamental.stop(stopTime);
      detuned.stop(stopTime);
      sub.stop(stopTime);
      tremolo.osc.stop(stopTime);
      noiseSrc.stop(stopTime);
      engine._scheduleCleanup(
        [master, subGain, toneFilter, toneGain, tremolo.depthGain, noiseFilter, noiseGain],
        stopTime + 0.2
      );
    },
  });
}

/**
 * Wind bed — bandpassed noise loop with two slow overlapping LFOs on gain
 * for organic gust movement. handle.setIntensity(0-1) shifts both the
 * brightness (filter cutoff) and loudness.
 */
export function startWind(engine, intensityFraction = 0.3) {
  const ctx = engine.ctx;
  const t0 = ctx.currentTime + 0.02;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.linearRampToValueAtTime(1, t0 + 1.0);
  master.connect(engine.ambienceBus);

  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 150;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = lerp(500, 2200, intensityFraction);
  filter.Q.value = 0.6;

  const windGain = ctx.createGain();
  windGain.gain.value = lerp(0.15, 0.55, intensityFraction);

  const src = ctx.createBufferSource();
  src.buffer = engine._buffers.white;
  src.loop = true;
  src.start(t0);
  src.connect(highpass).connect(filter).connect(windGain).connect(master);

  const gust1 = createLFO(ctx, windGain.gain, { frequency: 0.09, depth: 0.07 });
  const gust2 = createLFO(ctx, windGain.gain, { frequency: 0.23, depth: 0.04 });
  gust1.osc.start(t0);
  gust2.osc.start(t0);

  function applyIntensity(v) {
    const now = ctx.currentTime;
    filter.frequency.setTargetAtTime(lerp(500, 2200, v), now, 0.6);
    windGain.gain.setTargetAtTime(lerp(0.15, 0.55, v), now, 0.6);
  }
  applyIntensity(intensityFraction);

  return new LoopHandle(engine, {
    gainNode: master,
    onSetIntensity: applyIntensity,
    onStop: (stopTime) => {
      src.stop(stopTime);
      gust1.osc.stop(stopTime);
      gust2.osc.stop(stopTime);
      engine._scheduleCleanup(
        [master, filter, highpass, windGain, gust1.depthGain, gust2.depthGain],
        stopTime + 0.2
      );
    },
  });
}
