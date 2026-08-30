/**
 * MERIDIAN: OVER THE HORIZON — simulation constants.
 *
 * Everything in the sim is SI: metres, metres/second, seconds, radians.
 * The UI converts to the units a bridge watch actually uses (nautical miles,
 * knots, feet, degrees true) at the very edge, in ui/format.js.
 *
 * World frame: +X = East, +Z = North, +Y = up. Heading is radians clockwise
 * from North, so forward = (sin h, 0, cos h). That matches the GLB assets,
 * which are all authored bow = +Z / up = +Y / waterline at Y = 0, meaning a
 * hull's yaw is just `rotation.y = heading` with no reconciling rotation.
 */

export const NM = 1852;           // metres per nautical mile
export const KNOT = 1852 / 3600;  // m/s per knot
export const FT = 0.3048;

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

/** Operating area half-extent (metres). ~367 nm across — a real ASUW problem. */
export const AO_HALF = 340000;

/**
 * 4/3-earth radio/radar horizon. Range in metres at which a sensor at height
 * hs can see a target at height ht, both in metres.
 *
 *   R_km = 4.12 * ( sqrt(hs_m) + sqrt(ht_m) )
 *
 * This single line is the reason modern navies fly. A destroyer's SPY array at
 * 30 m sees another warship's 20 m superstructure at 39 km — but a sea-skimming
 * missile at 8 m only at 34 km, which is ninety seconds of warning. Put the same
 * radar in an aircraft at 9000 m and the horizon jumps past 400 km. Everything
 * about scouting, EMCON and kill webs falls out of this curve.
 */
export function radarHorizon(hs, ht) {
  return 4120 * (Math.sqrt(Math.max(0.5, hs)) + Math.sqrt(Math.max(0.5, ht)));
}

/**
 * THE LAYER.
 *
 * Sea water is not one medium. Sun warms the top of it, and somewhere between
 * thirty and a hundred and fifty metres down the temperature falls off a cliff.
 * Sound crossing that boundary refracts hard downward, so a sensor on one side
 * of it hears very little of what is on the other — which is the single most
 * important fact in submarine warfare, and the reason a submarine's first
 * question is what depth to take.
 *
 * A destroyer's hull array hangs a few metres under the keel, well ABOVE the
 * layer. Go below it and she loses most of her range on you. That is why a
 * towed array exists at all: it is streamed deep specifically so the ship has
 * an ear on the far side of the boundary, and why a helicopter's dipping sonar
 * can be lowered through it.
 *
 * Returns a multiplier on detection range.
 *   - same side of the layer: full range, and slightly better in the surface
 *     duct where sound is trapped and bounces along
 *   - opposite sides: a hard cut
 *
 * `strength` is how sharp the boundary is — a well-mixed winter sea barely has
 * one, a calm sunlit summer sea has a very sharp one.
 */
export function layerFactor(sensorDepth, targetDepth, layerDepth, strength = 1) {
  const sBelow = sensorDepth > layerDepth;
  const tBelow = targetDepth > layerDepth;
  if (sBelow !== tBelow) {
    // Crossing it. A sharp layer can take three quarters of your range.
    const cut = 0.62 * strength;
    // The cut eases if either party is sitting right at the boundary, where
    // some energy still leaks across.
    const near = Math.min(Math.abs(sensorDepth - layerDepth), Math.abs(targetDepth - layerDepth));
    const ease = clamp(1 - near / 90, 0, 1) * 0.45;
    return clamp(1 - cut * (1 - ease), 0.16, 1);
  }
  // Both above: the surface duct carries sound further than open water.
  if (!sBelow) return 1 + 0.18 * strength;
  // Both below: the deep sound channel, quieter and steadier still.
  return 1 + 0.10 * strength;
}

/** EMCON postures, most restrictive first. */
export const EMCON = {
  SILENT: 'SILENT',       // nothing radiates. Passive sensors only.
  PASSIVE: 'PASSIVE',     // ESM + passive sonar; nav radar off.
  RESTRICTED: 'RESTRICTED', // intermittent surface-search sweeps
  FULL: 'FULL',           // everything radiating, including fire control
};

export const EMCON_ORDER = [EMCON.SILENT, EMCON.PASSIVE, EMCON.RESTRICTED, EMCON.FULL];

export const EMCON_INFO = {
  [EMCON.SILENT]: {
    label: 'EMCON ALPHA',
    short: 'SILENT',
    desc: 'Total emission control. No radar, no active sonar, no datalink transmit. You are a hole in the ocean — and you are blind beyond the lookout\'s horizon.',
    radarDuty: 0, sonarActive: false, linkTx: false, color: '#4ad6a0',
  },
  [EMCON.PASSIVE]: {
    label: 'EMCON BRAVO',
    short: 'PASSIVE',
    desc: 'Receive only. ESM and passive sonar feed the plot; datalink receives but does not transmit. The cheapest way to stay in the web.',
    radarDuty: 0, sonarActive: false, linkTx: false, color: '#7fd4ff',
  },
  [EMCON.RESTRICTED]: {
    label: 'EMCON CHARLIE',
    short: 'RESTRICTED',
    desc: 'Intermittent surface-search sweeps and datalink transmit. Detection range improves; so does the odds a hostile ESM operator gets a bearing on you.',
    radarDuty: 0.25, sonarActive: false, linkTx: true, color: '#ffd166',
  },
  [EMCON.FULL]: {
    label: 'EMCON DELTA',
    short: 'RADIATE',
    desc: 'All sensors radiating, fire control illuminating. Maximum detection and engagement capability. Every ESM receiver over the horizon knows your class, your bearing, and roughly your intent.',
    radarDuty: 1, sonarActive: true, linkTx: true, color: '#ff6b6b',
  },
};

/** Rules of engagement / weapons posture. */
export const ROE = {
  HOLD: 'WEAPONS HOLD',
  TIGHT: 'WEAPONS TIGHT',
  FREE: 'WEAPONS FREE',
};

/**
 * Track quality bands. TQ is the whole game: it is the number that decides
 * whether a shooter 200 km away can take the shot on someone else's picture.
 * Derived from the position-error ellipse of the track's Kalman covariance.
 */
export const TQ_BANDS = [
  { tq: 6, sigma: 90, label: 'FIRE CONTROL', color: '#4ade80' },
  { tq: 5, sigma: 300, label: 'PRECISE', color: '#4ade80' },
  { tq: 4, sigma: 1200, label: 'WEAPONS QUALITY', color: '#a3e635' },
  { tq: 3, sigma: 4500, label: 'TRACKING', color: '#facc15' },
  { tq: 2, sigma: 14000, label: 'COARSE', color: '#fb923c' },
  { tq: 1, sigma: 45000, label: 'AMBIGUOUS', color: '#f87171' },
  { tq: 0, sigma: Infinity, label: 'BEARING ONLY', color: '#9ca3af' },
];

/** The line every TAO knows: below this you are shooting at an assumption. */
export const WEAPONS_QUALITY_TQ = 4;

export function tqFromSigma(sigma) {
  for (const b of TQ_BANDS) if (sigma <= b.sigma) return b.tq;
  return 0;
}
export function tqBand(tq) {
  return TQ_BANDS.find(b => b.tq === tq) || TQ_BANDS[TQ_BANDS.length - 1];
}

/** Sides. */
export const SIDE = { BLUE: 'BLUE', RED: 'RED', NEUTRAL: 'NEUTRAL' };

/** Track identity as held by the plot (not truth). */
export const IDENT = {
  PENDING: 'PENDING',
  FRIEND: 'FRIEND',
  NEUTRAL: 'NEUTRAL',
  HOSTILE: 'HOSTILE',
  UNKNOWN: 'UNKNOWN',
};

/** Broad platform domain — drives symbology and which weapons can engage. */
export const DOMAIN = {
  SURFACE: 'SURFACE',
  SUBSURFACE: 'SUBSURFACE',
  AIR: 'AIR',
  MISSILE: 'MISSILE',
  TORPEDO: 'TORPEDO',
  LAND: 'LAND',
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Shortest signed angular difference b - a, wrapped to [-pi, pi]. */
export function angDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function wrapAngle(a) {
  let x = a % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x;
}

/** Deterministic-ish RNG so a scenario replays the same way for a given seed. */
export class Rng {
  constructor(seed = 1337) { this.s = seed >>> 0 || 1; }
  next() {
    // xorshift32
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  /** Box-Muller normal. */
  normal(mu = 0, sigma = 1) {
    const u = Math.max(1e-7, this.next());
    const v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
