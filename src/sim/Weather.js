import { clamp, NM } from './constants.js';

/*
 * Weather.
 *
 * Two things matter here and they are the same thing. Weather is the only reason
 * a five-hour transit across empty water looks different at hour four than it did
 * at hour one — and weather is a WEAPON. A squall line is a hole in the enemy's
 * radar picture that you can steer your task force into. A flat calm is a
 * submarine's nightmare and an ESM operator's holiday. Sea state six halves your
 * passive sonar and stops your helicopter flying.
 *
 * So the state here is continuous and slow-moving — nothing snaps, everything
 * eases, because an abrupt cut in the sky is worse than no weather at all — and
 * every value it produces is consumed by the sensor model as well as the
 * renderer.
 *
 * Squall cells are discrete: real, positioned, drifting bodies of rain with a
 * radius, which both the plot and the shader know about. Inside one you cannot
 * see and neither can anyone looking at you.
 */

const MIN = 60;

/** Named regimes the front system walks between. Each is a target, not a state. */
// Storm domes are brighter at the ZENITH, not the horizon.
//
// CIE S 011 / ISO 15469 gives the standard overcast sky as
//   L(theta) = L_zenith * (1 + 2 sin theta) / 3
// so the zenith is three times the horizon: looking straight up you are seeing
// through the least cloud. These regimes had it the other way round — an
// overcast zenith of 0x3b4854 under a horizon of 0x78858f, measured at an
// up-over-horizon ratio of 0.82 where the standard wants 2.07. I made that worse
// while fixing the overall level, by darkening the zeniths.
//
// The pairs below sit at a linear zenith/horizon ratio near 3, at a level that
// keeps a gale darker than an overcast overall — the first attempt at this held
// the ratio but raised the level, and turned the gale sky into the brightest of
// the four again. Haze still
// brightens the last few degrees above the sea; that comes from the aerial
// perspective in the ocean and sky shaders, not from the dome colours.
const REGIMES = [
  {
    id: 'CLEAR', name: 'CLEAR — EXCELLENT VISIBILITY',
    seaState: 2.2, coverage: 0.16, visNm: 26, rain: 0,
    zenith: 0x1d5aa0, horizon: 0xbcd6e6, fog: 0xc2d6e2, weight: 1.0,
  },
  {
    id: 'FAIR', name: 'FAIR — SCATTERED CUMULUS',
    seaState: 3.0, coverage: 0.42, visNm: 18, rain: 0,
    zenith: 0x1a4f92, horizon: 0xaecbdd, fog: 0xb8cbd8, weight: 1.6,
  },
  {
    id: 'BROKEN', name: 'BROKEN CLOUD — MODERATE SEA',
    seaState: 3.8, coverage: 0.62, visNm: 12, rain: 0.05,
    zenith: 0x2a4e6e, horizon: 0x99adbb, fog: 0x9dafbb, weight: 1.4,
  },
  {
    id: 'OVERCAST', name: 'OVERCAST — REDUCED VISIBILITY',
    seaState: 4.5, coverage: 0.86, visNm: 7, rain: 0.18,
    zenith: 0x7c8894, horizon: 0x474f57, fog: 0x59626a, weight: 1.0,
  },
  {
    id: 'GALE', name: 'GALE — HEAVY SEA, SENSORS DEGRADED',
    seaState: 5.6, coverage: 0.95, visNm: 3.5, rain: 0.55,
    zenith: 0x69737d, horizon: 0x3d444b, fog: 0x4a525a, weight: 0.55,
  },
];

/** Weather changes on the scale of hours, not minutes. */
const FRONT_MIN = 26 * MIN;
const FRONT_MAX = 52 * MIN;

export class WeatherSystem {
  constructor(world) {
    this.world = world;
    const start = REGIMES[1];
    this.regime = start;
    this.next = start;
    this.blend = 1;
    this.blendRate = 0;
    this.state = {
      seaState: start.seaState,
      coverage: start.coverage,
      visNm: start.visNm,
      rain: start.rain,
      zenith: start.zenith,
      horizon: start.horizon,
      fog: start.fog,
      name: start.name,
    };
    this.squalls = [];
    this._nextFront = world.time + FRONT_MIN;
    this._squallT = 0;
    this.frontEta = null;
  }

  /** Linear interpolation between two packed 0xRRGGBB colours. */
  static mixHex(a, b, t) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return (Math.round(ar + (br - ar) * t) << 16)
      | (Math.round(ag + (bg - ag) * t) << 8)
      | Math.round(ab + (bb - ab) * t);
  }

  step(dt) {
    const w = this.world;
    const now = w.time;

    // ── fronts ───────────────────────────────────────────────────────────
    if (this.blend >= 1 && now >= this._nextFront) {
      const pool = REGIMES.filter(r => r !== this.regime);
      let total = 0;
      for (const r of pool) total += r.weight;
      let pick = w.rng.next() * total;
      let chosen = pool[0];
      for (const r of pool) { pick -= r.weight; if (pick <= 0) { chosen = r; break; } }
      this.next = chosen;
      this.blend = 0;
      // Fifteen to twenty-five minutes to walk from one regime to the next, so
      // the sky is always visibly on its way somewhere and never jumps.
      this.blendRate = 1 / (15 * MIN + w.rng.next() * 10 * MIN);
      this._nextFront = now + FRONT_MIN + w.rng.next() * (FRONT_MAX - FRONT_MIN);
      w.comms.push({
        t: now, from: 'METOC',
        priority: chosen.seaState > this.regime.seaState + 0.9 ? 'PRIORITY' : 'ROUTINE',
        text: this._forecast(this.regime, chosen),
      });
    }
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + this.blendRate * dt);
      if (this.blend >= 1) this.regime = this.next;
    }

    const a = this.regime, b = this.next;
    const t = this.blend * this.blend * (3 - 2 * this.blend);
    const s = this.state;
    s.seaState = a.seaState + (b.seaState - a.seaState) * t;
    s.coverage = a.coverage + (b.coverage - a.coverage) * t;
    s.visNm = a.visNm + (b.visNm - a.visNm) * t;
    s.rain = a.rain + (b.rain - a.rain) * t;
    s.zenith = WeatherSystem.mixHex(a.zenith, b.zenith, t);
    s.horizon = WeatherSystem.mixHex(a.horizon, b.horizon, t);
    s.fog = WeatherSystem.mixHex(a.fog, b.fog, t);
    s.name = t < 0.5 ? a.name : b.name;
    this.frontEta = this.blend < 1 ? (1 - this.blend) / this.blendRate : null;

    // ── squall cells ─────────────────────────────────────────────────────
    // Discrete bodies of rain that drift downwind. Both the plot and the sensor
    // model know where they are, which is what makes them worth steering into.
    this._squallT += dt;
    if (this._squallT > 45) {
      this._squallT = 0;
      const want = Math.round(s.coverage * 5) + (s.rain > 0.3 ? 2 : 0);
      const g = w.blueGuide;
      if (g && this.squalls.length < want && w.rng.next() < 0.5) {
        const ang = w.rng.next() * Math.PI * 2;
        const r = 60000 + w.rng.next() * 120000;
        this.squalls.push({
          x: g.x + Math.sin(ang) * r,
          z: g.z + Math.cos(ang) * r,
          r: 14000 + w.rng.next() * 26000,
          strength: 0.45 + w.rng.next() * 0.55,
          born: now,
          life: 25 * MIN + w.rng.next() * 30 * MIN,
        });
      }
    }
    const windSpd = 3 + s.seaState * 3.1;
    for (let i = this.squalls.length - 1; i >= 0; i--) {
      const c = this.squalls[i];
      c.x += 0.97 * windSpd * dt * 0.6;
      c.z += 0.24 * windSpd * dt * 0.6;
      if (now - c.born > c.life) this.squalls.splice(i, 1);
    }

    // ── push into the sim's sensor factors ───────────────────────────────
    const wx = w.weather;
    wx.seaState = s.seaState;
    wx.visFactor = clamp((s.visNm * NM) / 26000, 0.10, 1.35);
    wx.radarFactor = clamp(1.05 - s.seaState * 0.045 - s.rain * 0.22, 0.45, 1.05);
    wx.acousticFactor = clamp(1.25 - s.seaState * 0.13, 0.35, 1.25);
    // Weather moves the layer: a mixed sea pushes it deeper and blunts it.
    wx.layerDepth = clamp(45 + s.seaState * 17, 40, 150);
    wx.layerStrength = clamp(1.25 - s.seaState * 0.14, 0.35, 1.25);
    wx.windSpeed = windSpd;
    wx.name = s.name;
    wx.rain = s.rain;
  }

  /**
   * Local degradation at a point: inside a squall, everybody's radar and every
   * pair of eyes get worse. Returns a multiplier in (0, 1].
   */
  localFactor(x, z) {
    let f = 1;
    for (const c of this.squalls) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > c.r) continue;
      const inside = 1 - (d / c.r);
      f *= 1 - c.strength * 0.65 * inside;
    }
    return Math.max(0.12, f);
  }

  _forecast(from, to) {
    if (to.seaState > from.seaState + 0.9) {
      return `METOC update: the front is coming through. Expect ${to.name.split(' — ')[0].toLowerCase()} within the half hour, sea state ${to.seaState.toFixed(0)}, visibility down to ${to.visNm.toFixed(0)} nautical miles. Flight operations will be marginal.`;
    }
    if (to.seaState < from.seaState - 0.9) {
      return `METOC update: it is lifting. Sea state easing to ${to.seaState.toFixed(0)} and visibility opening to ${to.visNm.toFixed(0)} miles over the next half hour. Good news for the sonar, less good for staying invisible.`;
    }
    return `METOC update: ${to.name.toLowerCase()} setting in over the next half hour. Visibility ${to.visNm.toFixed(0)} nautical miles.`;
  }
}
