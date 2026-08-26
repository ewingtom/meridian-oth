import { DOMAIN, EMCON, SIDE } from './constants.js';

/**
 * A deployed sonobuoy.
 *
 * The buoy is not a unit — it cannot be shot at, given orders, or selected — but
 * it IS a sensor platform, so it presents exactly the interface the detection
 * pass expects of an observer and nothing more. That is the whole trick: a
 * pattern of buoys turns a single aircraft's one-hour endurance into a listening
 * barrier that keeps working after the aircraft has gone home, which is what
 * makes airborne ASW a search problem rather than a chase.
 *
 * A buoy always transmits. Its entire purpose is to put a contact on the link.
 */
export class Sonobuoy {
  constructor(side, x, z, opts = {}) {
    this.id = opts.id || 'SB';
    this.name = opts.name || this.id;
    this.side = side ?? SIDE.BLUE;
    this.x = x; this.z = z; this.alt = -1;
    this.heading = 0; this.speed = 0;
    this.alive = true;
    this.isBuoy = true;
    this.isAir = false;
    this.isSub = false;
    this.isSurface = false;
    this.damage = { sensors: 0 };
    this.contributingTo = new Set();
    // A free-drifting hydrophone has none of a warship's self-noise, which is
    // why a cheap buoy out-hears a destroyer's hull array.
    this.sonarSelfNoiseFactor = 1.35;
    this.activeSonar = false;
    this.radiating = false;
    this.radarDuty = 0;
    this.linkTx = true;
    this.emcon = EMCON.PASSIVE;
    this.droppedAt = opts.droppedAt ?? 0;
    this.expiresAt = opts.expiresAt ?? (this.droppedAt + 3600);
    this.range = opts.range ?? 9000;
    this.sensors = [{
      type: 'SONAR', id: 'DIFAR', name: 'AN/SSQ-53G DIFAR',
      ok: true, mode: 'PASSIVE', passiveRange: this.range,
      domains: [DOMAIN.SUBSURFACE], scan: 4,
    }];
  }

  sensorHeight() { return 0; }
  get lifeFrac() { return 1; }
}
