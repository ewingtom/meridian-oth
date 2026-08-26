// positional.js
//
// Lightweight listener tracking + a simple distance/pan attenuation model.
// This is intentionally NOT a full 3D PannerNode/HRTF setup — the brief
// asks for "simple distance/pan attenuation relative to a listener", which
// is cheaper, easier to tune for gameplay readability, and avoids HRTF
// coloration on short combat SFX.

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function length(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export class Listener {
  constructor() {
    this.position = { x: 0, y: 0, z: 0 };
    this.forward = { x: 0, y: 0, z: -1 };
    this.up = { x: 0, y: 1, z: 0 };
  }

  setPosition(x, y, z) {
    this.position = { x, y, z };
  }

  setOrientation(forward, up) {
    if (forward) this.forward = normalize(forward);
    if (up) this.up = normalize(up);
  }
}

/**
 * Computes a simple stereo pan (-1..1) and a distance-based gain multiplier
 * (0..1) for a sound source relative to the listener.
 *
 * Distance model: full volume inside `refDistance`, then an inverse-power
 * rolloff out to `maxDistance` (effectively silent beyond that).
 */
export function computeAttenuation(
  listener,
  sourcePos,
  { refDistance = 15, maxDistance = 1200, rolloff = 1.3 } = {}
) {
  if (!sourcePos) return { gain: 1, pan: 0, distance: 0 };

  const rel = sub(sourcePos, listener.position);
  const distance = length(rel);

  let gain;
  if (distance <= refDistance) {
    gain = 1;
  } else if (distance >= maxDistance) {
    gain = 0;
  } else {
    const clamped = clamp(distance, refDistance, maxDistance);
    gain = Math.pow(refDistance / clamped, rolloff);
  }

  const right = normalize(cross(listener.forward, listener.up));
  let pan = 0;
  if (distance > 0.0001) {
    const dir = { x: rel.x / distance, y: rel.y / distance, z: rel.z / distance };
    pan = clamp(dot(dir, right), -1, 1);
  }

  return { gain: clamp(gain, 0, 1), pan, distance };
}
