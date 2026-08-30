import { IDENT, DOMAIN, tqFromSigma, clamp, WEAPONS_QUALITY_TQ } from './constants.js';

/*
 * Track management — the part of the game that is actually the game.
 *
 * A "track" is not a unit. It is what the fleet BELIEVES about a unit: a position
 * estimate, a velocity estimate, and — critically — an error covariance that says
 * how wrong that belief might be. Every sensor report is a noisy measurement fed
 * into a Kalman filter; every second without a report lets the covariance grow at
 * the rate the target could plausibly manoeuvre.
 *
 * That single number, the size of the error ellipse, is what decides whether a
 * destroyer 300 km away can shoot. A missile's seeker sweeps a fan a few tens of
 * kilometres wide. If the target's error ellipse is bigger than that fan by the
 * time the missile arrives, the missile searches empty ocean. Which is why the
 * hard problem in modern naval warfare is not the missile. It is CUSTODY.
 *
 * State vector: [x, z, vx, vz] in metres and metres/second.
 */

// ── minimal 4x4 / 2x4 linear algebra ─────────────────────────────────────────
const N = 4;
function matI(s = 1) {
  const m = new Float64Array(16);
  for (let i = 0; i < N; i++) m[i * N + i] = s;
  return m;
}
function matMul(a, b, out = new Float64Array(16)) {
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let k = 0; k < N; k++) s += a[i * N + k] * b[k * N + j];
      out[i * N + j] = s;
    }
  }
  return out;
}
function matMulT(a, b, out = new Float64Array(16)) { // a * bᵀ
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let k = 0; k < N; k++) s += a[i * N + k] * b[j * N + k];
      out[i * N + j] = s;
    }
  }
  return out;
}
function matAdd(a, b, out = new Float64Array(16)) {
  for (let i = 0; i < 16; i++) out[i] = a[i] + b[i];
  return out;
}

let _tid = 1;

export class Track {
  constructor(side, truth, now) {
    this.id = `T${String(_tid++).padStart(3, '0')}`;
    this.side = side;
    this.truthId = truth.id;        // hidden — the sim's link back to reality
    this.truthRef = truth;
    this.domain = truth.domain;
    this.created = now;
    this.lastUpdate = now;
    this.lastGoodUpdate = now;

    // Belief
    this.x = truth.x; this.z = truth.z;
    this.vx = 0; this.vz = 0;
    this.alt = truth.alt;
    /*
     * A brand-new track has a position but no belief about it. This used to be
     * matI(1) — a covariance asserting the position was known to within a metre
     * before any sensor had reported. Two things fell out of that. _refresh()
     * recomputes sigma from P, so every track flashed TQ6 on creation and
     * latched everWeaponsQuality, making that flag true for every contact ever
     * held including ones with no contributors at all. And a filter that
     * confident in its prior barely moves for the first real measurement, so
     * tracks converged slowly for no reason. Start where the truth is: we do
     * not know where he is.
     */
    this.P = matI(1);
    this.P[0] = this.P[5] = 1e12;      // position variance — a 1000 km 1-sigma
    this.P[10] = this.P[15] = 2500;    // velocity variance — 50 m/s, i.e. anything
    /** Set once a sensor has actually contributed. No quality claim before that. */
    this.measured = false;

    this.tq = 0;
    this.sigma = 1e6;
    this.classification = 'UNKNOWN';
    this.identity = IDENT.PENDING;
    this.identityLocked = false;
    this.fingerprint = null;
    this.emitters = new Set();
    this.contributors = new Map();  // unitId -> { t, kind, unit }
    this.linked = false;
    this.linkAge = 999;
    this.label = null;
    this.threat = 0;
    this.engagedBy = new Set();     // weapon ids in flight against this track
    this.lostAt = null;
    this.faded = false;
    this.strength = 0;              // detection confidence build-up 0..1
    this.newFlag = true;
    this.speedEst = 0;
    this.courseEst = 0;
    this.bearingCuts = [];          // recent lines of bearing, for the plot
    this.everWeaponsQuality = false;
    this.assigned = null;           // player designation
    this.silentSince = null;
  }

  /** Seed a brand-new track from a positional measurement. */
  seedPosition(mx, mz, sigma, vx = 0, vz = 0, velSigma = 12) {
    this.measured = true;
    this.x = mx; this.z = mz; this.vx = vx; this.vz = vz;
    const P = new Float64Array(16);
    P[0] = sigma * sigma; P[5] = sigma * sigma;
    P[10] = velSigma * velSigma; P[15] = velSigma * velSigma;
    this.P = P;
  }

  /**
   * Seed from a bearing-only cut. The result is the classic ESM ellipse: a long
   * thin cigar pointing away from the receiver, because the bearing is good to a
   * degree or two and the range is essentially a guess. One cut tells you almost
   * nothing about where something is. Two cuts, from ships far apart, collapse the
   * ellipse to a point — and that is triangulation, the oldest trick in the book
   * and still the backbone of passive targeting.
   */
  seedBearing(sx, sz, bearing, assumedRange, bearingSigma) {
    this.measured = true;
    const mx = sx + Math.sin(bearing) * assumedRange;
    const mz = sz + Math.cos(bearing) * assumedRange;
    this.x = mx; this.z = mz; this.vx = 0; this.vz = 0;
    const along = assumedRange * 0.75;               // range is a guess
    const cross = Math.max(400, assumedRange * bearingSigma);
    // Rotate diag(cross², along²) into world frame along the bearing
    const c = Math.cos(bearing), s = Math.sin(bearing);
    // bearing unit vector (s, c) is "along"; perpendicular is (c, -s)
    const a2 = along * along, c2 = cross * cross;
    const pxx = a2 * s * s + c2 * c * c;
    const pzz = a2 * c * c + c2 * s * s;
    const pxz = a2 * s * c - c2 * c * s;
    const P = new Float64Array(16);
    P[0] = pxx; P[1] = pxz; P[4] = pxz; P[5] = pzz;
    P[10] = 400; P[15] = 400;
    this.P = P;
  }

  /** Time update. q is process-noise intensity (m²/s³) — how hard it can manoeuvre. */
  predict(dt, q) {
    if (dt <= 0) return;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    const P = this.P;
    // F * P * Fᵀ for the constant-velocity F, done in closed form (F is sparse).
    const p = Array.from(P);
    const idx = (r, c) => r * 4 + c;
    const FP = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      FP[idx(0, c)] = p[idx(0, c)] + dt * p[idx(2, c)];
      FP[idx(1, c)] = p[idx(1, c)] + dt * p[idx(3, c)];
      FP[idx(2, c)] = p[idx(2, c)];
      FP[idx(3, c)] = p[idx(3, c)];
    }
    const out = new Float64Array(16);
    for (let r = 0; r < 4; r++) {
      out[idx(r, 0)] = FP[idx(r, 0)] + dt * FP[idx(r, 2)];
      out[idx(r, 1)] = FP[idx(r, 1)] + dt * FP[idx(r, 3)];
      out[idx(r, 2)] = FP[idx(r, 2)];
      out[idx(r, 3)] = FP[idx(r, 3)];
    }
    // Continuous white-noise acceleration Q
    const d3 = (dt * dt * dt) / 3, d2 = (dt * dt) / 2;
    out[idx(0, 0)] += q * d3; out[idx(0, 2)] += q * d2;
    out[idx(2, 0)] += q * d2; out[idx(2, 2)] += q * dt;
    out[idx(1, 1)] += q * d3; out[idx(1, 3)] += q * d2;
    out[idx(3, 1)] += q * d2; out[idx(3, 3)] += q * dt;
    this.P = out;
    this._refresh();
  }

  /** Measurement update with a 2-D position fix (radar, active sonar, EO). */
  updatePosition(mx, mz, sigma) {
    this.measured = true;
    const P = this.P;
    const r = sigma * sigma;
    // S = H P Hᵀ + R  (H picks off x,z)
    const s00 = P[0] + r, s01 = P[1], s10 = P[4], s11 = P[5] + r;
    const det = s00 * s11 - s01 * s10;
    if (Math.abs(det) < 1e-9) return;
    const i00 = s11 / det, i01 = -s01 / det, i10 = -s10 / det, i11 = s00 / det;
    // K = P Hᵀ S⁻¹  (4x2)
    const K = new Float64Array(8);
    for (let i = 0; i < 4; i++) {
      const a = P[i * 4 + 0], b = P[i * 4 + 1];
      K[i * 2 + 0] = a * i00 + b * i10;
      K[i * 2 + 1] = a * i01 + b * i11;
    }
    const yx = mx - this.x, yz = mz - this.z;
    this.x += K[0] * yx + K[1] * yz;
    this.z += K[2] * yx + K[3] * yz;
    this.vx += K[4] * yx + K[5] * yz;
    this.vz += K[6] * yx + K[7] * yz;
    // P = (I - K H) P
    const out = new Float64Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[i * 4 + j] = P[i * 4 + j] - (K[i * 2 + 0] * P[0 * 4 + j] + K[i * 2 + 1] * P[1 * 4 + j]);
      }
    }
    this.P = out;
    this._refresh();
  }

  /**
   * Measurement update with a single line of bearing. Scalar EKF update: it
   * squeezes the ellipse only ACROSS the bearing and does nothing along it. Fire
   * two of these from widely separated receivers and the intersection is a fix.
   */
  updateBearing(sx, sz, bearing, bearingSigma) {
    this.measured = true;
    const dx = this.x - sx, dz = this.z - sz;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1) return;
    const H = [dz / d2, -dx / d2, 0, 0];
    const P = this.P;
    // PH = P * Hᵀ (4x1)
    const PH = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      PH[i] = P[i * 4 + 0] * H[0] + P[i * 4 + 1] * H[1];
    }
    const S = H[0] * PH[0] + H[1] * PH[1] + bearingSigma * bearingSigma;
    if (S < 1e-12) return;
    const K = [PH[0] / S, PH[1] / S, PH[2] / S, PH[3] / S];
    let y = bearing - Math.atan2(dx, dz);
    while (y > Math.PI) y -= Math.PI * 2;
    while (y < -Math.PI) y += Math.PI * 2;
    this.x += K[0] * y; this.z += K[1] * y;
    this.vx += K[2] * y; this.vz += K[3] * y;
    const out = new Float64Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[i * 4 + j] = P[i * 4 + j] - K[i] * (H[0] * P[0 * 4 + j] + H[1] * P[1 * 4 + j]);
      }
    }
    this.P = out;
    this._refresh();
  }

  /** Range-only update (rare — a ranging sonar cut or a laser). */
  updateRange(sx, sz, range, rangeSigma) {
    this.measured = true;
    const dx = this.x - sx, dz = this.z - sz;
    const d = Math.hypot(dx, dz);
    if (d < 1) return;
    const H = [dx / d, dz / d, 0, 0];
    const P = this.P;
    const PH = new Float64Array(4);
    for (let i = 0; i < 4; i++) PH[i] = P[i * 4] * H[0] + P[i * 4 + 1] * H[1];
    const S = H[0] * PH[0] + H[1] * PH[1] + rangeSigma * rangeSigma;
    const K = [PH[0] / S, PH[1] / S, PH[2] / S, PH[3] / S];
    const y = range - d;
    this.x += K[0] * y; this.z += K[1] * y; this.vx += K[2] * y; this.vz += K[3] * y;
    const out = new Float64Array(16);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        out[i * 4 + j] = P[i * 4 + j] - K[i] * (H[0] * P[j] + H[1] * P[4 + j]);
    this.P = out;
    this._refresh();
  }

  _refresh() {
    const P = this.P;
    // Guard against numerical drift making the covariance non-positive.
    if (!(P[0] > 0)) P[0] = 1e4;
    if (!(P[5] > 0)) P[5] = 1e4;
    this.sigma = Math.sqrt(Math.max(1, (P[0] + P[5]) * 0.5));
    this.tq = this.measured ? tqFromSigma(this.sigma) : 0;
    if (this.measured && this.tq >= WEAPONS_QUALITY_TQ) this.everWeaponsQuality = true;
    this.speedEst = Math.hypot(this.vx, this.vz);
    this.courseEst = Math.atan2(this.vx, this.vz);
    // 1-sigma error ellipse for the plot
    const a = P[0], b = P[1], c = P[5];
    const tr = a + c, det = a * c - b * b;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    this.ellipse = {
      major: Math.sqrt(Math.max(1, l1)),
      minor: Math.sqrt(Math.max(1, l2)),
      angle: Math.abs(b) < 1e-9 ? (a >= c ? 0 : Math.PI / 2) : Math.atan2(l1 - a, b),
    };
  }

  get age() { return this._age || 0; }
  get weaponsQuality() { return this.tq >= WEAPONS_QUALITY_TQ; }

  /** Predicted position of the target `t` seconds from now. */
  predictAt(t) {
    return { x: this.x + this.vx * t, z: this.z + this.vz * t };
  }
}

/**
 * The common tactical picture for one side. Everything a side "knows" lives here,
 * fused from every unit that is willing and able to put its detections on the link.
 */
export class TrackTable {
  constructor(side) {
    this.side = side;
    this.tracks = new Map();       // truthId -> Track
    this.byId = new Map();         // trackId -> Track
    this.events = [];
  }

  get list() { return [...this.tracks.values()]; }

  find(truthId) { return this.tracks.get(truthId); }
  get(trackId) { return this.byId.get(trackId); }

  ensure(truth, now) {
    let t = this.tracks.get(truth.id);
    if (!t) {
      t = new Track(this.side, truth, now);
      this.tracks.set(truth.id, t);
      this.byId.set(t.id, t);
      this.events.push({ kind: 'NEW', track: t, t: now });
    }
    if (t.faded) { t.faded = false; t.lostAt = null; t.newFlag = true; this.events.push({ kind: 'REGAIN', track: t, t: now }); }
    return t;
  }

  /** Time update for every track, plus custody / fade bookkeeping. */
  step(dt, now) {
    for (const t of this.tracks.values()) {
      // Process noise scales with what the target class can do. An aircraft can
      // change its position estimate far faster than a loaded merchant.
      const q = t.domain === DOMAIN.AIR ? 26
        : t.domain === DOMAIN.MISSILE ? 60
          : t.domain === DOMAIN.SUBSURFACE ? 0.35 : 0.7;
      t.predict(dt, q);
      t._age = now - t.lastUpdate;
      // Contributors time out of the web
      for (const [uid, c] of t.contributors) {
        if (now - c.t > 180) t.contributors.delete(uid);
      }
      let linked = false, best = 999;
      for (const [, c] of t.contributors) {
        if (c.link) { linked = true; best = Math.min(best, now - c.t); }
      }
      t.linked = linked;
      t.linkAge = best;
      t.bearingCuts = t.bearingCuts.filter(b => now - b.t < 45);
      if (t.sigma > 90000 || now - t.lastUpdate > 2400) {
        if (!t.faded) { t.faded = true; t.lostAt = now; this.events.push({ kind: 'FADE', track: t, t: now }); }
      }
      t.strength = clamp(t.strength - dt * 0.02, 0, 1);
    }
  }

  drain() { const e = this.events; this.events = []; return e; }

  remove(truthId) {
    const t = this.tracks.get(truthId);
    if (t) { this.tracks.delete(truthId); this.byId.delete(t.id); }
  }
}
