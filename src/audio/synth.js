// synth.js
//
// Low-level, reusable DSP building blocks used by every sound in the audio
// engine: noise buffer generation, procedural reverb impulses, envelope
// helpers, a waveshaper distortion curve, and small numeric utilities.
//
// Nothing in this file knows about game concepts (guns, missiles, UI...) —
// it is pure Web Audio plumbing so the sfx/* modules can stay focused on
// "what a sound should sound like".

// ---------------------------------------------------------------------------
// Numeric utilities
// ---------------------------------------------------------------------------

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function clamp01(v) {
  return clamp(v, 0, 1);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// exponentialRampToValueAtTime cannot target 0 — this is the floor we ramp
// towards instead so envelopes read as "silence" without throwing.
export const EPSILON = 0.0001;

export function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// Noise buffers
// ---------------------------------------------------------------------------

/**
 * Generates a mono noise AudioBuffer of the requested color.
 * These are generated once and cached (see AudioEngine._buildCaches) and
 * then sliced from at random offsets per one-shot sound, so we never pay
 * the generation cost at trigger time.
 */
export function createNoiseBuffer(ctx, duration = 2, color = "white") {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  if (color === "pink") {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink * 0.11;
    }
  } else if (color === "brown") {
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  } else {
    // white
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  // Safety clamp — pink/brown accumulators can occasionally drift outside
  // [-1, 1]; keep everything well behaved before it hits any gain stage.
  for (let i = 0; i < length; i++) {
    data[i] = clamp(data[i], -1, 1);
  }

  return buffer;
}

/**
 * Plays a short slice of a (long, cached) noise buffer starting at a random
 * offset, so many one-shots reusing the same buffer don't sound identical.
 * The node is self-stopping (AudioBufferSourceNode.start(when, offset, dur)).
 */
export function playNoiseSlice(ctx, buffer, t0, duration) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const safeDuration = Math.min(duration, buffer.duration - 0.02);
  const maxStart = Math.max(0, buffer.duration - safeDuration - 0.01);
  const offset = Math.random() * maxStart;
  src.start(t0, offset, safeDuration);
  return src;
}

// ---------------------------------------------------------------------------
// Procedural reverb impulse responses (for ConvolverNode)
// ---------------------------------------------------------------------------

/**
 * Builds a synthetic impulse response: exponentially-decaying filtered
 * noise, optionally layered as a bright fast "sheen" + a darker slow "body"
 * to approximate a metallic plate-reverb character (used by the sonar ping).
 */
export function createReverbImpulse(
  ctx,
  { duration = 2.5, decay = 3.0, reverse = false, brightness = 0.5 } = {}
) {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const impulse = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let lp = 0; // one-pole lowpass state for the "body" layer
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, decay);
      const white = Math.random() * 2 - 1;
      lp += (white - lp) * 0.35;
      // Blend a bright (raw noise) layer with a darker filtered layer —
      // more brightness = more shimmer/high end in the tail.
      const sample = (white * brightness + lp * (1 - brightness)) * env;
      data[reverse ? length - i - 1 : i] = sample;
    }
  }

  return impulse;
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

/**
 * Percussive attack/decay envelope on an AudioParam (typically a GainNode's
 * .gain). Rises linearly to `peak` over `attack` seconds, then relaxes
 * exponentially towards zero with time-constant `decayTau`.
 */
export function envAD(param, t0, { attack = 0.005, decayTau = 0.15, peak = 1 } = {}) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPSILON, t0);
  param.linearRampToValueAtTime(peak, t0 + Math.max(0.001, attack));
  param.setTargetAtTime(EPSILON, t0 + Math.max(0.001, attack), Math.max(0.001, decayTau));
}

/**
 * Attack/hold/decay envelope — like envAD but holds at `peak` for `hold`
 * seconds before relaxing. Useful for sounds with a sustained body
 * (missile ignition roar, alarm swell, etc).
 */
export function envAHD(
  param,
  t0,
  { attack = 0.01, hold = 0.1, decayTau = 0.3, peak = 1 } = {}
) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPSILON, t0);
  param.linearRampToValueAtTime(peak, t0 + Math.max(0.001, attack));
  param.setValueAtTime(peak, t0 + attack + hold);
  param.setTargetAtTime(EPSILON, t0 + attack + hold, Math.max(0.001, decayTau));
}

/** Simple linear fade of an AudioParam from its current value to `target`. */
export function linearFade(param, t0, target, duration) {
  param.cancelScheduledValues(t0);
  const current = param.value;
  param.setValueAtTime(current, t0);
  param.linearRampToValueAtTime(target, t0 + Math.max(0.001, duration));
}

/** Exponential-feeling fade (time-constant based, never truly reaches 0). */
export function expFade(param, t0, target, tau) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(param.value, t0);
  param.setTargetAtTime(Math.max(target, EPSILON), t0, Math.max(0.001, tau));
}

/** Schedules a pitch envelope (frequency ramp) on an oscillator/param. */
export function pitchRamp(param, t0, fromHz, toHz, duration, exponential = true) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(fromHz, 1), t0);
  if (exponential) {
    param.exponentialRampToValueAtTime(Math.max(toHz, 1), t0 + Math.max(0.001, duration));
  } else {
    param.linearRampToValueAtTime(toHz, t0 + Math.max(0.001, duration));
  }
}

// ---------------------------------------------------------------------------
// Distortion
// ---------------------------------------------------------------------------

/** Classic soft-clip waveshaper curve; `amount` roughly 0 (clean) - 400 (harsh). */
export function makeDistortionCurve(amount = 50, samples = 2048) {
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// ---------------------------------------------------------------------------
// Small oscillator/LFO helpers
// ---------------------------------------------------------------------------

/**
 * Creates a running LFO (oscillator + gain scaling it to +/- depth around
 * `center`) already connected to `targetParam`. Caller is responsible for
 * starting/stopping the returned oscillator.
 */
export function createLFO(ctx, targetParam, { frequency = 1, depth = 1, center = null } = {}) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = frequency;
  const depthGain = ctx.createGain();
  depthGain.gain.value = depth;
  osc.connect(depthGain);
  depthGain.connect(targetParam);
  if (center !== null && "value" in targetParam) {
    targetParam.value = center;
  }
  return { osc, depthGain };
}
