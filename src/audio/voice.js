// voice.js
//
// Shared plumbing for wiring an individual sound into the bus graph:
//   synthesis graph -> voice gain -> [stereo panner] -> destination bus
//
// `createVoice` handles the {volume, pan, position} option contract shared
// by every one-shot SFX method on AudioEngine. `LoopHandle` is the common
// return type for the looping ambience beds and the alarm klaxon.

import { computeAttenuation } from "./positional.js";
import { clamp01 } from "./synth.js";

/**
 * Builds the output chain for a sound and returns the node synthesis code
 * should connect into (`input`), plus the resolved gain/pan for reference.
 */
export function createVoice(engine, destinationBus, opts = {}) {
  const ctx = engine.ctx;
  const input = ctx.createGain();
  const baseVolume = opts.volume != null ? opts.volume : 1;

  let pan = opts.pan != null ? opts.pan : 0;
  let distGain = 1;
  let distance = 0;

  if (opts.position) {
    const att = computeAttenuation(engine.listener, opts.position, engine.attenuationOpts);
    if (opts.pan == null) pan = att.pan;
    distGain = att.gain;
    distance = att.distance;
  }

  input.gain.value = Math.max(0, baseVolume * distGain);

  let panNode = null;
  let tail = input;
  if (pan !== 0) {
    panNode = ctx.createStereoPanner();
    panNode.pan.value = Math.min(1, Math.max(-1, pan));
    input.connect(panNode);
    tail = panNode;
  }
  tail.connect(destinationBus);

  return { input, panNode, gain: input.gain.value, pan, distance };
}

/**
 * Handle returned by looping ambience beds (and the alarm klaxon). Wraps a
 * master gain node for the loop plus optional setters for intensity/rpm
 * controlled by the caller's synthesis code.
 */
export class LoopHandle {
  constructor(engine, { gainNode, onStop, onSetIntensity, onSetRpm } = {}) {
    this._engine = engine;
    this._gainNode = gainNode;
    this._onStop = onStop;
    this._onSetIntensity = onSetIntensity;
    this._onSetRpm = onSetRpm;
    this._stopped = false;
  }

  /** 0-1 relative intensity control, meaning is bed-specific (see docs). */
  setIntensity(v) {
    if (this._stopped || !this._onSetIntensity) return;
    this._onSetIntensity(clamp01(v));
  }

  /** 0-1 engine RPM fraction (engine hum bed only). */
  setRpm(v) {
    if (this._stopped || !this._onSetRpm) return;
    this._onSetRpm(clamp01(v));
  }

  get stopped() {
    return this._stopped;
  }

  /** Fades the bed out over `fadeSeconds` and tears down its nodes. */
  stop(fadeSeconds = 0.5) {
    if (this._stopped) return;
    this._stopped = true;
    const ctx = this._engine.ctx;
    const now = ctx.currentTime;
    const fade = Math.max(0.02, fadeSeconds);

    if (this._gainNode) {
      const g = this._gainNode.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(g.value, 0.0001), now);
      g.linearRampToValueAtTime(0.0001, now + fade);
    }

    if (this._onStop) this._onStop(now + fade + 0.05);
  }
}
