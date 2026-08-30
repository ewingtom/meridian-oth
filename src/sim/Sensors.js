import {
  radarHorizon, DOMAIN, IDENT, SIDE, clamp, D2R, Rng,
  layerFactor,
} from './constants.js';

/*
 * Detection model.
 *
 * Three ideas do all the work here, and between them they explain most of what
 * happens in a modern naval engagement:
 *
 *  1. THE HORIZON IS THE LIMIT. A radar's power tells you how far it *could*
 *     see; the curvature of the earth tells you how far it *does*. A destroyer
 *     with a 320 km radar detects another destroyer at 39 km, because that is
 *     where the target's mast drops below the line of sight. Put the same radar
 *     at 9,000 m and it reaches 400 km. Altitude is the only real currency.
 *
 *  2. LISTENING BEATS LOOKING. Radar pays the range-to-the-fourth penalty on a
 *     two-way trip; a passive receiver only pays the one-way trip. So an ESM set
 *     hears a radar at roughly 1.6x the distance at which that radar can see a
 *     ship. Whoever radiates first is found first. That is EMCON.
 *
 *  3. A BEARING IS NOT A POSITION. Passive sensors give you a line, not a point.
 *     One line is nearly useless. Two lines from ships a hundred miles apart give
 *     you a fix. This is why a task force is a sensor network, not a pile of ships.
 */

const RADAR_BEARING_SIGMA = 0.12 * D2R;
const NAV_RADAR_BEARING_SIGMA = 0.4 * D2R;
const ESM_BEARING_SIGMA = 1.9 * D2R;
const ESM_GOOD_BEARING_SIGMA = 0.9 * D2R;
const SONAR_BEARING_SIGMA = 3.2 * D2R;
const TOWED_BEARING_SIGMA = 1.4 * D2R;

/** Reference targets the refRange numbers are quoted against. */
const REF_RCS_SURFACE = 10000;
const REF_RCS_AIR = 5;
const REF_ACOUSTIC = 1.0;

/** Fingerprints that a competent ESM operator reads straight off the pulse train. */
function emitterFingerprint(unit, sensor) {
  if (sensor.fingerprint) return sensor.fingerprint;
  return sensor.name || 'UNIDENTIFIED EMITTER';
}

export class SensorSystem {
  constructor(world) {
    this.world = world;
    this.rng = new Rng(90210);
    this.duct = 1.0;          // anomalous propagation multiplier on surface horizons
    this._ductPhase = 0;
    this.events = [];
  }

  /** Slowly varying surface-duct conditions. Real, and a nice source of doubt. */
  stepEnvironment(dt) {
    this._ductPhase += dt * 0.0008;
    this.duct = 1.0 + 0.34 * (0.5 + 0.5 * Math.sin(this._ductPhase)) *
      (0.5 + 0.5 * Math.sin(this._ductPhase * 2.7 + 1.1));
  }

  /** ESM detection range against one emitting sensor. */
  esmRange(emitterUnit, emitterSensor, receiverSensor) {
    const base = (emitterSensor.refRange || 50000) * 1.65 * (emitterSensor.emitPower || 0.5);
    return base * (receiverSensor.sensitivity || 1);
  }

  /**
   * Main pass. Called on the sensor cadence (a couple of simulated seconds), not
   * every frame — detection is a slow business compared with rendering.
   */
  run(dt, now) {
    const world = this.world;
    this.stepEnvironment(dt);

    const units = world.units.filter(u => u.alive);
    const weapons = world.weapons.filter(w => w.alive && w.detectable);
    // Sonobuoys observe but are never observed: they join the loop as sensor
    // platforms and never appear in the candidate-target list.
    const observers = world.buoys?.length ? units.concat(world.buoys) : units;

    for (const u of observers) {
      if (u.damage.sensors > 0.95) continue;
      const table = world.picture(u.side);
      if (!table) continue;

      // Candidate targets: everything not on my own side, plus in-flight ordnance.
      for (const t of units) {
        if (t === u || !t.alive) continue;
        if (t.side === u.side) continue;
        this._evaluate(u, t, table, dt, now, false);
      }
      for (const w of weapons) {
        if (w.side === u.side) continue;
        this._evaluate(u, w, table, dt, now, true);
      }
    }
  }

  /**
   * Terrain masking.
   *
   * A headland between two ships blocks radar and eyeballs exactly the way it
   * blocks a rifle shot, and putting one there deliberately is one of the oldest
   * moves in coastal warfare. The test is the honest one: find where the
   * sightline passes closest to each island, work out how high the ground is
   * there, and compare it with how high the sightline is at that point.
   */
  _masked(u, t, hs, ht) {
    const islands = this.world.scenario?.islands;
    if (!islands || !islands.length) return false;
    const dx = t.x - u.x, dz = t.z - u.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1) return false;
    for (const isl of islands) {
      // Parametric closest approach of the segment to the island centre.
      let s = ((isl.x - u.x) * dx + (isl.z - u.z) * dz) / len2;
      if (s <= 0.01 || s >= 0.99) continue;              // island is behind either end
      const cx = u.x + dx * s, cz = u.z + dz * s;
      const d = Math.hypot(cx - isl.x, cz - isl.z);
      if (d >= isl.radius) continue;
      // Cone approximation of the ground profile — good enough, and it keeps the
      // mask soft at the edges of the island rather than a hard circular wall.
      const ground = isl.height * (1 - d / isl.radius);
      const los = hs + (ht - hs) * s;
      if (ground > los + 8) return true;
    }
    return false;
  }

  _evaluate(u, t, table, dt, now, isWeapon) {
    const dx = t.x - u.x, dz = t.z - u.z;
    const range = Math.hypot(dx, dz);
    // Weather is local. A squall sitting on the midpoint between two ships is a
    // hole in the picture for both of them, and steering into one is a real and
    // usable tactic rather than set dressing.
    this._localWx = this.world.weatherSys
      ? Math.min(this.world.weatherSys.localFactor(u.x, u.z),
                 this.world.weatherSys.localFactor(t.x, t.z))
      : 1;
    if (range > 700000) return;
    const trueBearing = Math.atan2(dx, dz);
    const domain = isWeapon ? DOMAIN.MISSILE : t.domain;

    for (const s of u.sensors) {
      if (!s.ok) continue;
      if (s.domains && !s.domains.includes(domain) && !(isWeapon && s.domains.includes(DOMAIN.MISSILE))) continue;
      if (s.needsShallow && u.alt < -25) continue;

      switch (s.type) {
        case 'RADAR': this._radar(u, t, s, range, trueBearing, table, dt, now, isWeapon, domain); break;
        case 'ESM': this._esm(u, t, s, range, trueBearing, table, dt, now, isWeapon); break;
        case 'SONAR': this._sonar(u, t, s, range, trueBearing, table, dt, now, isWeapon, domain); break;
        case 'VISUAL': this._visual(u, t, s, range, trueBearing, table, dt, now, isWeapon, domain); break;
        case 'MAD': this._mad(u, t, s, range, table, dt, now, domain); break;
        default: break;
      }
    }
  }

  // ── active radar ──────────────────────────────────────────────────────────
  _radar(u, t, s, range, bearing, table, dt, now, isWeapon, domain) {
    if (!u.radiating) return;
    const duty = u.radarDuty ?? 0;
    if (duty <= 0) return;
    if (domain === DOMAIN.SUBSURFACE) return;
    if (t.isSub && t.alt < -8) return;

    const isAirTarget = domain === DOMAIN.AIR || domain === DOMAIN.MISSILE;
    const ref = isAirTarget ? (s.refAir || s.refRange * 0.6) : s.refRange;
    const refRcs = isAirTarget ? REF_RCS_AIR : REF_RCS_SURFACE;
    const rcs = isWeapon ? (t.rcs || 0.2) : t.rcs;
    const power = ref * Math.pow(Math.max(1e-4, rcs / refRcs), 0.25);

    const hs = u.sensorHeight(s);
    const ht = isWeapon ? Math.max(3, t.alt) : t.signatureHeight;
    if (this._masked(u, t, hs, ht)) return;
    let horizon = radarHorizon(hs, ht);
    if (!u.isAir && !t.isAir && !isWeapon) horizon *= this.duct;
    else if (isWeapon && !u.isAir) horizon *= this.duct;

    const rmax = Math.min(power, horizon);
    if (range > rmax) return;

    // Detection probability: near-certain well inside rmax, falls off a cliff at it.
    const ratio = range / rmax;
    let pd = 1 / (1 + Math.pow(ratio / 0.86, 9));
    pd *= duty;
    pd *= (1 - u.damage.sensors * 0.7);
    pd *= this.world.weather.radarFactor * (0.45 + 0.55 * (this._localWx ?? 1));
    if (isWeapon) {
      // Sea clutter. A radar looking down at a target a few metres above a moving
      // sea is competing with the returns off the wave tops, and the lower the
      // target the worse it gets — this is half of why sea-skimming works.
      pd *= 0.35 + 0.65 * Math.pow(clamp((t.alt - 4) / 140, 0, 1), 0.6);
      // Low observability is not just a smaller RCS; a shaped airframe also
      // scintillates and breaks track. Applied on top of the RCS term.
      const st = t.def?.stealth;
      if (st !== undefined) pd *= clamp(st + 0.42, 0.34, 1.15);
    }

    const trk = this._contact(u, t, table, now, pd, dt, s.scan || 4);
    if (!trk) return;

    const sigmaBearing = s.navRadar ? NAV_RADAR_BEARING_SIGMA : RADAR_BEARING_SIGMA;
    const sigmaRange = 25 + range * 0.0025;
    const sigma = Math.max(sigmaRange, range * sigmaBearing);
    const nb = bearing + this.rng.normal(0, sigmaBearing);
    const nr = range + this.rng.normal(0, sigmaRange);
    const mx = u.x + Math.sin(nb) * nr;
    const mz = u.z + Math.cos(nb) * nr;
    if (trk.contributors.size === 0 && trk.sigma > 20000) trk.seedPosition(mx, mz, sigma, 0, 0, 14);
    else trk.updatePosition(mx, mz, sigma);
    trk.alt = t.alt;
    this._classifyRadar(trk, t, isWeapon, rcs, s, range, rmax);
    this._contribute(trk, u, now, 'RADAR');
  }

  _classifyRadar(trk, t, isWeapon, rcs, s, range, rmax) {
    if (isWeapon) { trk.classification = 'MISSILE'; trk.identity = IDENT.HOSTILE; trk.domain = DOMAIN.MISSILE; return; }
    if (trk.identityLocked) return;
    if (t.isAir) { trk.classification = trk.classification === 'UNKNOWN' ? 'AIR CONTACT' : trk.classification; return; }
    if (trk.classification === 'UNKNOWN' || trk.classification === 'SURFACE CONTACT') {
      trk.classification = rcs > 9000 ? 'LARGE SURFACE CONTACT'
        : rcs > 1500 ? 'SURFACE CONTACT' : 'SMALL SURFACE CONTACT';
    }

    /*
     * ISAR — what a maritime patrol radar is actually for.
     *
     * Identification used to require eyes-on, full stop, which made the P-8 and
     * the E-2D nearly useless for the one job a scout exists to do: telling you
     * whether the thing forty miles ahead is a freighter or a destroyer. The
     * player was left flying a helicopter to within twenty-two kilometres of
     * every contact on the plot.
     *
     * A real maritime search radar images a ship's profile using its own roll
     * and pitch to synthesise an aperture, and reads the hull and superstructure
     * off it — hull length, mast count, where the blocks sit. That is a HULL
     * TYPE at long range, and it is genuinely different from an identity: it
     * tells you what kind of ship, not whose. A merchant hull with a military
     * fit still images as a merchant.
     *
     * So this narrows the classification and never touches identity. To learn
     * whose it is you still have to look at it.
     */
    if (s?.isar && range < rmax * 0.6 && !trk.visualId) {
      const warship = !t.neutral && (t.cls.weapons || []).length > 0;
      trk.classification = warship
        ? `WARSHIP — ${t.cls.type || 'COMBATANT'} PROFILE (ISAR)`
        : 'MERCHANT HULL (ISAR)';
      if (trk.identity === IDENT.PENDING) trk.identity = IDENT.UNKNOWN;
      trk.isarProfile = true;
    }
  }

  // ── electronic support (ESM) ──────────────────────────────────────────────
  _esm(u, t, s, range, bearing, table, dt, now, isWeapon) {
    if (isWeapon) {
      // Active-seeker missiles announce themselves the moment they turn on. That
      // is the single most valuable warning a defending ship ever gets.
      if (!t.seekerActive || t.passiveSeeker) return;
      const hs = u.sensorHeight(s);
      const rmax = Math.min(140000 * (s.sensitivity || 1), radarHorizon(hs, Math.max(3, t.alt)) * this.duct);
      if (range > rmax) return;
      const trk = this._contact(u, t, table, now, 0.97, dt, 1);
      if (!trk) return;
      trk.classification = 'MISSILE SEEKER';
      trk.identity = IDENT.HOSTILE;
      trk.domain = DOMAIN.MISSILE;
      trk.updateBearing(u.x, u.z, bearing + this.rng.normal(0, ESM_BEARING_SIGMA), ESM_BEARING_SIGMA);
      this._contribute(trk, u, now, 'ESM');
      this._raise('SEEKER', u, trk, now, `${u.name}: MISSILE SEEKER, bearing ${Math.round(((bearing * 180 / Math.PI) + 360) % 360).toString().padStart(3, '0')}`);
      return;
    }

    if (!t.radiating) {
      if (t._wasRadiating) {
        const trk = table.find(t.id);
        if (trk && !trk.silentSince) trk.silentSince = now;
      }
      return;
    }

    // Find the target's loudest active emitter that we can hear.
    let best = null, bestRange = 0;
    for (const es of t.sensors) {
      if (!es.ok || es.mode !== 'ACTIVE' || !es.emits) continue;
      if (es.type !== 'RADAR') continue;
      const r = this.esmRange(t, es, s);
      if (r > bestRange) { bestRange = r; best = es; }
    }
    if (!best) return;

    const hs = u.sensorHeight(s);
    const ht = t.isAir ? Math.max(10, t.alt) : (best.height || t.cls.mastHeight || 20);
    let horizon = radarHorizon(hs, ht);
    if (!u.isAir && !t.isAir) horizon *= this.duct;
    const rmax = Math.min(bestRange, horizon);
    if (range > rmax) return;

    const ratio = range / rmax;
    let pd = 1 / (1 + Math.pow(ratio / 0.9, 10));
    pd *= t.radarDuty ?? 1;
    pd *= (1 - u.damage.sensors * 0.6);

    const trk = this._contact(u, t, table, now, pd, dt, s.scan || 1);
    if (!trk) return;

    const sigmaB = (s.sensitivity || 1) >= 1.15 ? ESM_GOOD_BEARING_SIGMA : ESM_BEARING_SIGMA;
    const nb = bearing + this.rng.normal(0, sigmaB);
    if (trk.contributors.size === 0 && trk.sigma > 60000) {
      // No prior information at all: assume the emitter is at about two thirds of
      // the range we could have heard it from and let the ellipse be honest about
      // how bad that guess is.
      trk.seedBearing(u.x, u.z, nb, rmax * 0.62, sigmaB);
    } else {
      trk.updateBearing(u.x, u.z, nb, sigmaB);
    }
    trk.bearingCuts.push({ x: u.x, z: u.z, b: nb, t: now, range: rmax, unit: u.id });
    if (trk.bearingCuts.length > 8) trk.bearingCuts.shift();

    // Emitter identification — this is where ESM earns its keep. The pulse train
    // does not just say "something is out there", it says which class of ship it is.
    const fp = emitterFingerprint(t, best);
    trk.fingerprint = fp;
    trk.emitters.add(fp);
    if (!trk.identityLocked) {
      if (best.navRadar && !best.fireControl) {
        if (trk.classification === 'UNKNOWN') trk.classification = 'MERCHANT (PROBABLE)';
        if (trk.identity === IDENT.PENDING) trk.identity = IDENT.UNKNOWN;
      } else {
        trk.classification = t.isAir ? 'AIR CONTACT — MILITARY EMITTER' : 'WARSHIP (EMITTER MATCH)';
        trk.identity = IDENT.HOSTILE;
        if (best.fireControl) {
          this._raise('ILLUM', u, trk, now,
            `${u.name}: FIRE CONTROL RADAR — ${fp} — bearing ${Math.round(((nb * 180 / Math.PI) + 360) % 360).toString().padStart(3, '0')}`);
        }
      }
    }
    trk.alt = t.isAir ? t.alt : 0;
    this._contribute(trk, u, now, 'ESM');
  }

  // ── sonar ─────────────────────────────────────────────────────────────────
  _sonar(u, t, s, range, bearing, table, dt, now, isWeapon, domain) {
    if (t.isAir) return;
    if (u.isAir && !s.dipping && !u.sonobuoyMode) return;
    if (s.dipping && now > (u.dippingUntil || 0)) return;

    const acoustic = isWeapon ? (t.acoustic || 2.2) : t.acoustic;
    const layer = this.world.weather.acousticFactor;

    /*
     * THE LAYER. Until now sonar had no idea how deep anything was: a hull
     * array at twelve metres performed identically against a boat at twenty
     * and a boat at three hundred, which made a submarine's depth a number
     * that gated the datalink and nothing else. It is now the decision it
     * should be — and the reason a towed array exists, because it is streamed
     * below the boundary while the ship stays above it.
     */
    const wx = this.world.weather;
    const sDepth = u.sonarDepth(s, wx.layerDepth);
    const tDepth = isWeapon ? 30 : t.acousticDepth;
    const lf = layerFactor(sDepth, tDepth, wx.layerDepth, wx.layerStrength);

    // Passive
    if ((s.mode === 'PASSIVE' || s.mode === 'DUAL') && s.passiveRange) {
      const selfNoise = s.towed ? Math.max(u.sonarSelfNoiseFactor, 0.5) : u.sonarSelfNoiseFactor;
      let rmax = s.passiveRange * Math.pow(Math.max(0.02, acoustic / REF_ACOUSTIC), 0.55) * selfNoise * layer * lf;
      let pd = 0;
      if (range < rmax) {
        pd = 1 / (1 + Math.pow(range / (rmax * 0.8), 7));
      } else {
        // Convergence zone: sound bends back down and re-surfaces in an annulus.
        // A quiet boat you cannot hear at 30 km can be plain at 55 km.
        const cz = this.world.weather.czRange;
        for (let n = 1; n <= 2; n++) {
          const r0 = cz * n;
          const d = Math.abs(range - r0);
          if (d < 5500) pd = Math.max(pd, 0.55 * (1 - d / 5500) * Math.pow(Math.max(0.02, acoustic), 0.4) / n);
        }
      }
      pd *= (1 - u.damage.sensors * 0.7);
      if (pd > 0.01) {
        const trk = this._contact(u, t, table, now, pd, dt, s.scan || 6);
        if (trk) {
          const sig = s.towed ? TOWED_BEARING_SIGMA : SONAR_BEARING_SIGMA;
          const nb = bearing + this.rng.normal(0, sig);
          if (trk.contributors.size === 0 && trk.sigma > 60000) trk.seedBearing(u.x, u.z, nb, rmax * 0.55, sig);
          else trk.updateBearing(u.x, u.z, nb, sig);
          trk.bearingCuts.push({ x: u.x, z: u.z, b: nb, t: now, range: rmax, unit: u.id, kind: 'SONAR' });
          if (trk.bearingCuts.length > 8) trk.bearingCuts.shift();
          if (!trk.identityLocked) {
            if (isWeapon) { trk.classification = 'TORPEDO'; trk.identity = IDENT.HOSTILE; trk.domain = DOMAIN.TORPEDO; }
            else if (t.isSub) { trk.classification = 'SUBMERGED CONTACT'; trk.domain = DOMAIN.SUBSURFACE; if (trk.identity === IDENT.PENDING) trk.identity = IDENT.UNKNOWN; }
            else if (trk.classification === 'UNKNOWN') trk.classification = 'SURFACE CONTACT (ACOUSTIC)';
          }
          this._contribute(trk, u, now, 'SONAR-P');
          if (isWeapon && trk.newFlag) {
            this._raise('TORPEDO', u, trk, now, `${u.name}: TORPEDO IN THE WATER, bearing ${Math.round(((nb * 180 / Math.PI) + 360) % 360).toString().padStart(3, '0')}`);
          }
        }
      }
    }

    // Active
    if ((s.mode === 'ACTIVE' || s.mode === 'DUAL') && s.activeRange && (u.activeSonar || s.dipping)) {
      const ts = isWeapon ? 0.4 : (t.isSub ? 1.0 : 2.4);
      const rmax = s.activeRange * Math.pow(ts, 0.25) * layer * lf;
      if (range < rmax) {
        const pd = 1 / (1 + Math.pow(range / (rmax * 0.85), 8));
        const trk = this._contact(u, t, table, now, pd, dt, s.scan || 6);
        if (trk) {
          const sigma = Math.max(120, range * 0.02);
          const nb = bearing + this.rng.normal(0, 1.2 * D2R);
          const nr = range + this.rng.normal(0, sigma * 0.6);
          if (trk.contributors.size === 0 && trk.sigma > 20000) {
            trk.seedPosition(u.x + Math.sin(nb) * nr, u.z + Math.cos(nb) * nr, sigma, 0, 0, 6);
          } else {
            trk.updatePosition(u.x + Math.sin(nb) * nr, u.z + Math.cos(nb) * nr, sigma);
          }
          trk.alt = t.alt;
          if (!trk.identityLocked && t.isSub) { trk.classification = 'SUBMARINE'; trk.domain = DOMAIN.SUBSURFACE; }
          this._contribute(trk, u, now, 'SONAR-A');
        }
      }
    }
  }

  // ── visual / electro-optical ──────────────────────────────────────────────
  _visual(u, t, s, range, bearing, table, dt, now, isWeapon, domain) {
    if (t.isSub && t.alt < -8) return;
    const sizeFactor = isWeapon ? 0.12 : clamp(Math.pow((t.cls?.length || 40) / 150, 0.7), 0.15, 1.6);
    const hs = u.sensorHeight(s);
    const ht = isWeapon ? Math.max(3, t.alt) : t.signatureHeight;
    if (this._masked(u, t, hs, ht)) return;
    const horizon = radarHorizon(hs, ht) * (u.isAir || t.isAir ? 1 : this.duct);
    const rmax = Math.min(s.refRange * sizeFactor * this.world.weather.visFactor * (this._localWx ?? 1), horizon);
    if (range > rmax) return;
    const pd = (1 / (1 + Math.pow(range / (rmax * 0.8), 8))) * (1 - u.damage.sensors * 0.5);
    const trk = this._contact(u, t, table, now, pd, dt, s.scan || 2);
    if (!trk) return;
    const sigma = Math.max(40, range * 0.006);
    trk.updatePosition(t.x + this.rng.normal(0, sigma), t.z + this.rng.normal(0, sigma), sigma);
    trk.alt = t.alt;
    // Eyes-on (or a good FLIR) is the only thing that gives positive identification.
    if (s.identifies || range < rmax * 0.55) {
      trk.identityLocked = true;
      trk.identity = t.side === SIDE.NEUTRAL ? IDENT.NEUTRAL
        : t.side === u.side ? IDENT.FRIEND : IDENT.HOSTILE;
      trk.classification = isWeapon ? 'MISSILE' : (t.cls.display || t.type);
      trk.label = isWeapon ? 'INBOUND' : t.name;
      trk.visualId = true;
    } else if (trk.classification === 'UNKNOWN') {
      trk.classification = 'VISUAL CONTACT';
    }
    this._contribute(trk, u, now, 'EO');
  }

  _mad(u, t, s, range, table, dt, now, domain) {
    if (domain !== DOMAIN.SUBSURFACE) return;
    if (range > s.refRange) return;
    const trk = this._contact(u, t, table, now, 0.9, dt, 1);
    if (!trk) return;
    trk.updatePosition(t.x + this.rng.normal(0, 200), t.z + this.rng.normal(0, 200), 220);
    trk.classification = 'SUBMARINE (MAD)';
    trk.identityLocked = true;
    trk.identity = t.side === u.side ? IDENT.FRIEND : IDENT.HOSTILE;
    this._contribute(trk, u, now, 'MAD');
  }

  /**
   * Detection build-up. Sensors do not flick on and off — an operator needs a
   * few consistent returns before they call a contact, and a marginal contact
   * fades if the returns stop. Returns the track once it is firmly held.
   */
  _contact(u, t, table, now, pd, dt, scanPeriod) {
    if (pd <= 0.005) return null;
    const trk = table.ensure(t, now);
    const looks = dt / Math.max(0.5, scanPeriod);
    trk.strength = clamp(trk.strength + (pd * 1.5 - 0.25) * looks * 0.7, 0, 1);
    if (trk.strength < 0.3) return null;
    return trk;
  }

  _contribute(trk, u, now, kind) {
    trk.lastUpdate = now;
    trk.contributors.set(u.id, { t: now, kind, link: !!u.linkTx || u.side === trk.side && u.isSelf, unit: u });
    // A unit only puts its picture on the link if its EMCON posture allows it to
    // transmit. A ship in EMCON ALPHA sees things nobody else in the task force
    // will ever know about — which is exactly the price of being silent.
    const c = trk.contributors.get(u.id);
    c.link = !!u.linkTx;
    u.contributingTo.add(trk.id);
    if (trk.newFlag && trk.tq > 0) {
      trk.newFlag = false;
      this.events.push({ kind: 'NEW_CONTACT', unit: u, track: trk, t: now, source: kind });
    }
  }

  _raise(kind, unit, track, now, text) {
    this.events.push({ kind, unit, track, t: now, text });
  }

  drain() { const e = this.events; this.events = []; return e; }
}
