import {
  EMCON, EMCON_INFO, ROE, DOMAIN, clamp, angDiff, wrapAngle, KNOT,
} from './constants.js';
import { platform } from './platforms.db.js';
import { weapon } from './weapons.db.js';

let _uid = 1;

/**
 * A single platform in the simulation: ship, submarine, aircraft.
 *
 * Kinematics are deliberately simple but honest about the thing that matters at
 * this scale — inertia. A 9,000-tonne destroyer takes ninety seconds to work up
 * from twelve knots to thirty, and turns at three degrees a second. That lag is
 * why "reposition the picket" is a decision you make twenty minutes early, and
 * why a torpedo evasion order has to be given the instant the datum appears.
 */
export class Unit {
  constructor(opts) {
    const cls = platform(opts.className);
    this.uid = _uid++;
    this.id = opts.id || `${cls.type}-${this.uid}`;
    this.name = opts.name || cls.display;
    this.hullNo = opts.hullNo || '';
    this.side = opts.side;
    this.cls = cls;
    this.className = cls.id;
    this.domain = cls.domain;
    this.type = cls.type;

    // Position: metres in world frame. y is altitude for air, negative depth for subs.
    this.x = opts.x || 0;
    this.z = opts.z || 0;
    this.alt = opts.alt !== undefined ? opts.alt : (cls.air ? cls.cruiseAlt : (cls.sub ? -60 : 0));

    this.heading = opts.heading || 0;
    this.speed = opts.speed !== undefined ? opts.speed : (cls.air ? cls.cruiseSpeed : 5);

    // Ordered state — what the bridge is being told to do.
    this.ordered = {
      heading: this.heading,
      speed: this.speed,
      alt: this.alt,
      emcon: opts.emcon || (cls.sub ? EMCON.SILENT : EMCON.PASSIVE),
      roe: opts.roe || ROE.TIGHT,
    };
    this.waypoints = [];
    this.patrol = null;      // { type:'LADDER'|'ORBIT'|'BARRIER', ... }
    this.station = opts.station || null; // formation slot relative to guide

    this.alive = true;
    this.hp = cls.hp;
    this.maxHp = cls.hp;
    this.damage = { mobility: 0, sensors: 0, weapons: 0, fire: 0, flooding: 0 };

    // Magazines
    this.mags = {};
    for (const w of cls.weapons || []) this.mags[w.id] = w.count;
    this.magsMax = { ...this.mags };
    // Anything that can operate aircraft gets a deck — a destroyer's hangar and
    // a carrier's flight deck are the same scheduler with different numbers.
    // Built lazily by World.spawn so the deck can see a fully-formed unit.
    this.deck = null;
    /** Set on an airborne aircraft: the deck frame it launched from. */
    this.deckFrame = null;
    /** Set from the loadout at launch; decides what mission it is flying. */
    this.airRole = null;
    this.loadoutId = null;
    this.launchers = {};
    for (const w of cls.weapons || []) this.launchers[w.id] = w.launcher;
    this.reloadTimer = {};      // per-weapon cooldown
    this.fcChannels = cls.fireControlChannels || 0;
    this.fcBusy = 0;

    // Sensors — live per-sensor state (each can be individually damaged/downed)
    this.sensors = (cls.sensors || []).map(s => ({ ...s, ok: true, lastEmit: -999 }));

    // Air unit state
    this.fuel = cls.endurance || 0;
    this.maxFuel = cls.endurance || 0;
    this.airborne = !!cls.air;
    this.homeBase = opts.homeBase || null;
    this.embarkedOn = opts.embarkedOn || null;
    this.aircraft = [];             // Unit refs currently embarked
    this.dippingUntil = 0;
    this.dip = null;            // { x, z } — helo hover datum for the dipping sonar
    this.landedTimer = 0;

    // Sub state
    this.depthOrdered = cls.sub ? (opts.alt !== undefined ? opts.alt : -120) : 0;
    this.snorting = false;

    // Sensor/emission bookkeeping
    this.radiating = false;
    this.activeSonar = false;
    this.lastPing = -999;
    this.detectedByEsmAt = -999;

    // Datalink participation
    this.linkOk = true;
    this.linkQuality = 1;

    // Per-unit contribution to the plot, for the kill-web view
    this.contributingTo = new Set();

    // Cosmetic / audio bookkeeping
    this.wakeIntensity = 0;
    this.lastFired = -999;
    this.selected = false;
    this.escorting = null;

    this.history = [];   // sparse breadcrumb trail for the plot
    this._histT = 0;

    this.threatState = 'NORMAL'; // NORMAL | ALERT | ENGAGED | DEFENDING
    this.evading = null;
  }

  get emcon() { return this.ordered.emcon; }
  get isAir() { return !!this.cls.air; }
  get isSub() { return !!this.cls.sub; }
  get isSurface() { return this.domain === DOMAIN.SURFACE; }
  get hvu() { return !!this.cls.hvu; }
  get neutral() { return !!this.cls.neutral; }
  get speedKts() { return this.speed / KNOT; }
  get deep() { return this.isSub && this.alt < -35; }

  /** Effective sensor height for horizon maths. */
  sensorHeight(sensor) {
    if (this.isAir) return Math.max(10, this.alt);
    if (this.isSub) return this.alt > -20 ? (sensor.height || 4) : 0;
    return sensor.height || this.cls.mastHeight || 20;
  }

  /** The height a hostile sensor "sees" of this unit. */
  get signatureHeight() {
    if (this.isAir) return Math.max(10, this.alt);
    if (this.isSub) return this.alt < -8 ? 0 : 6;
    return this.cls.mastHeight || 20;
  }

  get rcs() {
    let r = this.cls.rcs;
    if (this.damage.fire > 0.3) r *= 1.25;
    return r;
  }

  /**
   * Radiated acoustic signature. Speed is the dominant term — this is why a
   * submarine hunting at five knots is a ghost and the same boat sprinting at
   * twenty-five is a beacon, and why a frigate towing an array slows down to
   * listen.
   */
  get acoustic() {
    const base = this.cls.acoustic || 1;
    const sf = this.isSub
      ? 0.35 + Math.pow(clamp(this.speed / this.cls.maxSpeed, 0, 1), 2.1) * 4.2
      : 0.6 + clamp(this.speed / this.cls.maxSpeed, 0, 1) * 1.5;
    let a = base * sf;
    if (this.damage.mobility > 0.4) a *= 1.6;   // damaged machinery is loud
    if (this.isAir) a = 0;
    return a;
  }

  /** Self-noise degrades own passive sonar as speed rises. */
  get sonarSelfNoiseFactor() {
    const f = clamp(this.speed / (this.cls.maxSpeed || 15), 0, 1);
    return clamp(1.25 - Math.pow(f, 1.5) * 1.5, 0.12, 1.25);
  }

  ammo(wid) { return this.mags[wid] || 0; }
  hasWeapon(wid) { return this.magsMax[wid] !== undefined; }

  weaponsOfCategory(cat) {
    return (this.cls.weapons || [])
      .map(w => weapon(w.id))
      .filter(w => w.category === cat && this.ammo(w.id) > 0);
  }

  setEmcon(e) {
    if (this.ordered.emcon === e) return false;
    this.ordered.emcon = e;
    return true;
  }

  orderCourse(heading, speed) {
    this.ordered.heading = wrapAngle(heading);
    if (speed !== undefined) this.ordered.speed = clamp(speed, 0, this.maxSpeedNow);
    this.waypoints.length = 0;
    this.patrol = null;
    this.station = null;
    this.dip = null;
  }

  orderWaypoint(x, z, { speed, append = false, alt } = {}) {
    if (!append) this.waypoints.length = 0;
    this.waypoints.push({ x, z, speed, alt });
    this.patrol = null;
    this.dip = null;
    if (!append) this.station = null;
  }

  get maxSpeedNow() {
    return this.cls.maxSpeed * (1 - this.damage.mobility * 0.8);
  }

  /** Apply damage; returns true if this killed the unit. */
  applyDamage(amount, kind = 'BLAST') {
    if (!this.alive) return false;
    this.hp -= amount;
    const frac = amount / this.maxHp;
    this.damage.mobility = clamp(this.damage.mobility + frac * (kind === 'TORPEDO' ? 1.4 : 0.7), 0, 1);
    this.damage.sensors = clamp(this.damage.sensors + frac * 0.85, 0, 1);
    this.damage.weapons = clamp(this.damage.weapons + frac * 0.6, 0, 1);
    this.damage.fire = clamp(this.damage.fire + frac * 1.1, 0, 1);
    if (kind === 'TORPEDO') this.damage.flooding = clamp(this.damage.flooding + frac * 1.6, 0, 1);

    // Knock out individual sensors as the damage mounts.
    for (const s of this.sensors) {
      if (s.ok && Math.random() < frac * 1.2) s.ok = false;
    }

    if (this.hp <= 0) {
      this.alive = false;
      this.hp = 0;
      return true;
    }
    return false;
  }

  /**
   * Kinematic integration. `dt` is simulated seconds (already scaled by the
   * time-compression factor upstream and subdivided so a single step is small).
   */
  step(dt, world) {
    if (!this.alive) return;

    // ── Navigation: waypoint / patrol / station keeping resolves into an ordered
    //    course and speed, then the hull chases that with real inertia.
    this._navigate(dt, world);

    // Speed: acceleration limited. accelTime is roughly the seconds to go from
    // rest to full power, which for a warship is on the order of a minute and a half.
    const maxSp = this.maxSpeedNow;
    const target = clamp(this.ordered.speed, 0, maxSp);
    const accel = maxSp / Math.max(5, this.cls.accelTime);
    const decel = accel * 1.8;
    if (this.speed < target) this.speed = Math.min(target, this.speed + accel * dt);
    else this.speed = Math.max(target, this.speed - decel * dt);
    if (this.isAir && !this.cls.helo) this.speed = Math.max(this.speed, this.cls.cruiseSpeed * 0.55);

    // Heading: rate limited. Turning also scrubs speed on a surface ship.
    const dh = angDiff(this.heading, this.ordered.heading);
    let rate = this.cls.turnRate * (1 - this.damage.mobility * 0.6);
    if (this.isSurface) rate *= clamp(0.35 + this.speed / (maxSp || 1), 0.35, 1.15);
    const turn = clamp(dh, -rate * dt, rate * dt);
    this.heading = wrapAngle(this.heading + turn);
    if (this.isSurface && Math.abs(turn) > 1e-5) {
      this.speed *= 1 - Math.abs(turn) * 0.35;
    }

    // Altitude / depth
    const altTarget = this.isSub ? this.depthOrdered : this.ordered.alt;
    if (Math.abs(this.alt - altTarget) > 0.5) {
      const rateA = this.isSub ? 3.0 : (this.cls.helo ? 8 : 22);
      this.alt += clamp(altTarget - this.alt, -rateA * dt, rateA * dt);
    }

    // Position
    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;

    // The dipping sonar only hears anything while the transducer is in the
    // water, which means a hover, low, over the datum — not a fly-past.
    if (this.dip && this.cls.helo) {
      const onDatum = Math.hypot(this.dip.x - this.x, this.dip.z - this.z) < 320
        && this.speed < 5 && this.alt < 70;
      if (onDatum) this.dippingUntil = (world?.time || 0) + 6;
    }

    // Fuel
    if (this.isAir && this.maxFuel > 0) {
      const burn = 1 + Math.max(0, this.speed / this.cls.cruiseSpeed - 1) * 1.6;
      this.fuel = Math.max(0, this.fuel - dt * burn);
    }

    // Damage progression: fires spread and flooding drags you down unless the
    // damage-control party gets ahead of it.
    if (this.damage.fire > 0.02) {
      this.hp -= this.damage.fire * 0.22 * dt;
      this.damage.fire = clamp(this.damage.fire - dt * 0.010, 0, 1);
      if (this.hp <= 0) { this.alive = false; this.hp = 0; }
    }
    if (this.damage.flooding > 0.02) {
      this.hp -= this.damage.flooding * 0.30 * dt;
      this.damage.flooding = clamp(this.damage.flooding - dt * 0.004, 0, 1);
      this.damage.mobility = clamp(this.damage.mobility + dt * 0.004 * this.damage.flooding, 0, 1);
      if (this.hp <= 0) { this.alive = false; this.hp = 0; }
    }

    // Emission state derived from EMCON posture
    const info = EMCON_INFO[this.ordered.emcon];
    const forced = this.cls.alwaysRadiates;
    this.radiating = forced || (info.radarDuty > 0 && this.damage.sensors < 0.9);
    this.radarDuty = forced ? 1 : info.radarDuty;
    this.activeSonar = info.sonarActive && this.sensors.some(s => s.type === 'SONAR' && s.ok && s.activeRange);
    this.linkTx = forced ? false : (info.linkTx && !this.deep);

    // Breadcrumb trail for the tactical plot
    this._histT += dt;
    if (this._histT > 40) {
      this._histT = 0;
      this.history.push({ x: this.x, z: this.z, t: world?.time || 0 });
      if (this.history.length > 90) this.history.shift();
    }
  }

  _navigate(dt, world) {
    // Dipping station. A helicopter with its transducer in the water is not
    // flying anywhere: it transits to the datum, descends to the hover, and
    // stays there until the player moves it.
    if (this.dip) {
      const dx = this.dip.x - this.x, dz = this.dip.z - this.z;
      const r = Math.hypot(dx, dz);
      if (r > 60) this.ordered.heading = Math.atan2(dx, dz);
      this.ordered.alt = r < 900 ? 20 : (this.cls.cruiseAlt || 600);
      this.ordered.speed = r < 200 ? 0 : Math.min(this.maxSpeedNow, r / 10);
      return;
    }

    // Formation station-keeping: hold a bearing/range from the guide.
    if (this.station && this.station.guide && this.station.guide.alive) {
      const g = this.station.guide;
      const brg = g.heading + this.station.relBearing;
      const tx = g.x + Math.sin(brg) * this.station.range;
      const tz = g.z + Math.cos(brg) * this.station.range;
      const dx = tx - this.x, dz = tz - this.z;
      const d = Math.hypot(dx, dz);
      this.ordered.heading = Math.atan2(dx, dz);
      // Close the gap smoothly instead of sawing back and forth on station.
      const closing = clamp((d - 150) / 2500, -0.35, 1);
      this.ordered.speed = clamp(g.speed + closing * 5.5, 0, this.maxSpeedNow);
      if (d < 220) this.ordered.heading = g.heading;
      return;
    }

    if (this.patrol) { this._patrolNav(dt, world); return; }

    if (this.waypoints.length) {
      const wp = this.waypoints[0];
      const dx = wp.x - this.x, dz = wp.z - this.z;
      const d = Math.hypot(dx, dz);
      const arriveR = this.isAir ? 2500 : 900;
      if (d < arriveR) {
        this.waypoints.shift();
        if (!this.waypoints.length) {
          if (this.isAir && !this.cls.helo) {
            // Aircraft cannot stop — fall into a holding orbit at the last point.
            this.patrol = { type: 'ORBIT', x: wp.x, z: wp.z, radius: 12000, dir: 1 };
          } else {
            this.ordered.speed = Math.min(this.ordered.speed, this.cls.maxSpeed * 0.35);
          }
        }
        return;
      }
      this.ordered.heading = Math.atan2(dx, dz);
      if (wp.speed !== undefined) this.ordered.speed = wp.speed;
      if (wp.alt !== undefined) this.ordered.alt = wp.alt;
    }
  }

  _patrolNav(dt, world) {
    const p = this.patrol;
    if (p.type === 'ORBIT') {
      const dx = this.x - p.x, dz = this.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      const tangential = Math.atan2(dx, dz) + p.dir * Math.PI * 0.5;
      const radialCorr = clamp((d - p.radius) / (p.radius * 0.6), -1, 1);
      this.ordered.heading = tangential - p.dir * radialCorr * 0.8;
      this.ordered.speed = this.cls.cruiseSpeed || this.cls.maxSpeed * 0.6;
    } else if (p.type === 'LADDER') {
      // Classic MPA expanding ladder: run a leg, turn, offset, run back.
      if (!p.legs) this._buildLadder(p);
      const leg = p.legs[p.i % p.legs.length];
      const dx = leg.x - this.x, dz = leg.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 3000) { p.i++; if (p.i >= p.legs.length) { p.i = 0; p.laps = (p.laps || 0) + 1; } }
      this.ordered.heading = Math.atan2(dx, dz);
      this.ordered.speed = this.cls.cruiseSpeed;
    } else if (p.type === 'BARRIER') {
      const t = (p.t = (p.t || 0) + dt);
      const phase = (t / p.period) % 1;
      const s = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const tx = p.ax + (p.bx - p.ax) * s;
      const tz = p.az + (p.bz - p.az) * s;
      const dx = tx - this.x, dz = tz - this.z;
      this.ordered.heading = Math.atan2(dx, dz);
      this.ordered.speed = p.speed ?? (this.cls.cruiseSpeed || this.cls.maxSpeed * 0.5);
    }
  }

  _buildLadder(p) {
    const legs = [];
    const n = Math.max(2, Math.round(p.height / p.spacing));
    for (let i = 0; i <= n; i++) {
      const along = (i % 2 === 0) ? -p.width / 2 : p.width / 2;
      const across = -p.height / 2 + i * p.spacing;
      const c = Math.cos(p.axis), s = Math.sin(p.axis);
      legs.push({ x: p.x + along * c - across * s, z: p.z + along * s + across * c });
    }
    p.legs = legs;
    p.i = 0;
  }

  /** Assign a search ladder centred on (x,z) covering width x height metres. */
  setSearchPattern(x, z, width, height, axis = 0, spacing = 55000) {
    this.patrol = { type: 'LADDER', x, z, width, height, axis, spacing };
    this.waypoints.length = 0;
    this.station = null;
    this.dip = null;
  }

  /** Hold a hover over a datum with the dipping sonar down. Helicopters only. */
  setDip(x, z) {
    if (!this.cls.helo) return false;
    this.dip = { x, z };
    this.waypoints.length = 0;
    this.patrol = null;
    this.station = null;
    return true;
  }

  setOrbit(x, z, radius = 14000) {
    this.patrol = { type: 'ORBIT', x, z, radius, dir: 1 };
    this.waypoints.length = 0;
    this.station = null;
    this.dip = null;
  }

  setBarrier(ax, az, bx, bz, speed) {
    this.patrol = {
      type: 'BARRIER', ax, az, bx, bz, speed,
      period: (Math.hypot(bx - ax, bz - az) * 2) / Math.max(2, speed || 5),
    };
    this.waypoints.length = 0;
    this.station = null;
    this.dip = null;
  }

  distanceTo(o) { return Math.hypot(o.x - this.x, o.z - this.z); }
  bearingTo(o) { return Math.atan2(o.x - this.x, o.z - this.z); }
}
