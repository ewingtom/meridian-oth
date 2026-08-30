import { SIDE, EMCON, ROE, DOMAIN, IDENT, clamp, NM, KNOT, Rng, WEAPONS_QUALITY_TQ, tqFromSigma } from './constants.js';
import { Unit } from './Unit.js';
import { TrackTable } from './Tracks.js';
import { SensorSystem } from './Sensors.js';
import { OrdnanceSystem } from './Ordnance.js';
import { DefenseSystem } from './Defense.js';
import { RedCommander, BlueAutonomy } from './AI.js';
import { weapon } from './weapons.db.js';
import { FlightDeck } from './FlightDeck.js';
import { Sonobuoy } from './Sonobuoy.js';
import { SignalSystem } from './Signals.js';
import { WeatherSystem } from './Weather.js';

/**
 * The simulation world. Owns everything that is TRUE; the track tables own
 * everything that is merely BELIEVED. Keeping those two apart is what makes fog
 * of war a mechanic instead of a UI filter.
 */
export class World {
  constructor(scenario) {
    this.scenario = scenario;
    this.time = 0;
    this.units = [];
    this.weapons = [];
    this.tables = {
      [SIDE.BLUE]: new TrackTable(SIDE.BLUE),
      [SIDE.RED]: new TrackTable(SIDE.RED),
    };
    this.comms = [];
    this.buoys = [];
    this._buoyN = 0;
    this.rng = new Rng(scenario.seed || 20260825);

    this.weather = {
      seaState: scenario.seaState ?? 3,
      windDir: scenario.windDir ?? 2.4,
      windSpeed: 9,
      visFactor: 1.0,
      radarFactor: 1.0,
      acousticFactor: 1.0,
      czRange: 55000,
      // Depth of the thermocline, and how sharp it is. See layerFactor().
      layerDepth: 85,
      layerStrength: 1.0,
      name: 'MODERATE SEA — GOOD VISIBILITY',
    };
    this._applyWeather();

    this.sensors = new SensorSystem(this);
    this.ordnance = new OrdnanceSystem(this);
    this.defense = new DefenseSystem(this);
    this.red = new RedCommander(this);
    this.blueAuto = new BlueAutonomy(this);

    this._sensorAccum = 0;
    this.blueStrikeDetected = false;
    this.stats = {
      blueLosses: [], redLosses: [], neutralLosses: [],
      asmFired: 0, asmHit: 0, samFired: 0, samHit: 0,
      redAsmFired: 0, redAsmLeakers: 0,
      timeToFirstWeaponsQuality: null,
      emconViolations: 0,
      /*
       * The watch, as it will be remembered. A short ledger of the handful of
       * things that actually turned the engagement — first contact, the shot,
       * the hit, the loss — so the debrief can show a player what happened
       * rather than only what it added up to. Ranked, and capped, because a
       * two-hour action produces thousands of events and about eight moments.
       */
      moments: [],
    };
    this.listeners = [];
    this.paused = false;
    this.startedAt = 0;
    this.signals = new SignalSystem(this);
    this.weatherSys = new WeatherSystem(this);
  }

  on(fn) { this.listeners.push(fn); }
  emit(ev) { for (const f of this.listeners) f(ev); }

  /**
   * Record a moment for the after-action. `rank` is how much it mattered, so
   * the debrief can show the top of a busy watch rather than the start of it.
   */
  moment(rank, text) {
    const m = this.stats.moments;
    m.push({ t: this.time - this.startedAt, rank, text });
    // A hard cap. If a long action overflows it, drop the least important
    // half rather than the oldest — the opening contact still matters at 21:00.
    if (m.length > 240) {
      m.sort((x, y) => y.rank - x.rank || x.t - y.t);
      m.length = 120;
      m.sort((x, y) => x.t - y.t);
    }
  }

  picture(side) { return this.tables[side]; }

  add(unit) { this.units.push(unit); return unit; }

  spawn(opts) {
    const u = this.add(new Unit(opts));
    u.world = this;
    if ((u.cls.aircraft || []).length) u.deck = new FlightDeck(u);
    return u;
  }

  byId(id) { return this.units.find(u => u.id === id); }

  get blue() { return this.units.filter(u => u.alive && u.side === SIDE.BLUE); }
  get redUnits() { return this.units.filter(u => u.alive && u.side === SIDE.RED); }

  _applyWeather() {
    const w = this.weather;
    const ss = w.seaState;
    w.visFactor = clamp(1.25 - ss * 0.11, 0.35, 1.25);
    w.radarFactor = clamp(1.05 - ss * 0.045, 0.6, 1.05);
    // A rough sea is a wall of noise: passive sonar ranges collapse.
    w.acousticFactor = clamp(1.25 - ss * 0.13, 0.4, 1.25);
    /*
     * The layer. A rough sea mixes the top of the water column, which pushes
     * the boundary deeper and blunts it; a calm sunlit sea leaves a shallow,
     * knife-sharp one. So heavy weather is bad for passive sonar in general and
     * simultaneously takes away the submarine's best hiding place — which is
     * the sort of trade this game should be making the player think about.
     */
    w.layerDepth = clamp(45 + ss * 17, 40, 150);
    w.layerStrength = clamp(1.25 - ss * 0.14, 0.35, 1.25);
    w.windSpeed = 3 + ss * 3.1;
    w.name = ss <= 2 ? 'CALM — EXCELLENT VISIBILITY'
      : ss <= 3 ? 'MODERATE SEA — GOOD VISIBILITY'
        : ss <= 4 ? 'ROUGH SEA — REDUCED SONAR' : 'HEAVY SEA — DEGRADED SENSORS';
  }

  setSeaState(ss) { this.weather.seaState = clamp(ss, 0, 6); this._applyWeather(); }

  /**
   * Advance the simulation. dt is REAL seconds; scale is the time-compression
   * factor. Kinematics are subdivided so a 64x step never lets a Mach 4 missile
   * teleport through a ship.
   */
  step(dtReal, scale) {
    if (this.paused) return;
    const total = dtReal * scale;
    const maxStep = 0.5;
    let remaining = Math.min(total, 8);   // never simulate more than 8 s per frame
    let guard = 0;
    while (remaining > 0.0001 && guard++ < 40) {
      const dt = Math.min(maxStep, remaining);
      remaining -= dt;
      this._substep(dt);
    }
  }

  _substep(dt) {
    this.time += dt;
    const now = this.time;

    for (const u of this.units) {
      u._wasRadiating = u.radiating;
      if (u.alive) u.step(dt, this);
    }
    this.ordnance.step(dt, now);
    this.defense.step(dt, now);
    for (const u of this.units) {
      if (u.alive && u.deck) u.deck.step(dt, now, this);
    }
    this.signals.step(dt);
    this.weatherSys.step(dt);
    this._detachedTasks(now);

    // Buoys run out of battery. A barrier laid an hour ago is not a barrier.
    if (this.buoys.length) {
      for (let i = this.buoys.length - 1; i >= 0; i--) {
        const b = this.buoys[i];
        if (now >= b.expiresAt) { b.alive = false; this.buoys.splice(i, 1); }
      }
    }

    // Sensors are expensive and slow-moving: run them on a 2-second cadence.
    this._sensorAccum += dt;
    if (this._sensorAccum >= 2) {
      const sdt = this._sensorAccum;
      this._sensorAccum = 0;
      this.sensors.run(sdt, now);
    }
    for (const side of [SIDE.BLUE, SIDE.RED]) this.tables[side].step(dt, now);

    /*
     * Time to a weapons-quality track. This stat was declared, scored and
     * written into the after-action text, and nothing ever assigned it — so
     * every debrief ever shown told the player they never developed one, and
     * the score line for it never fired. It is the single number this game is
     * about: detection is not targeting.
     */
    if (this.stats.timeToFirstWeaponsQuality === null) {
      for (const t of this.tables[SIDE.BLUE].tracks.values()) {
        // Surface and subsurface only. A radar fix on an inbound bomber is
        // free and instantaneous, and counting it would report "two seconds to
        // weapons quality" on a watch where the enemy surface group was never
        // localised at all — which is the opposite of what this measures.
        if (!t.weaponsQuality || t.truthRef?.side !== SIDE.RED) continue;
        if (t.domain !== DOMAIN.SURFACE && t.domain !== DOMAIN.SUBSURFACE) continue;
        this.stats.timeToFirstWeaponsQuality = now - this.startedAt;
        this.moment(8, `Weapons-quality track on ${t.id} — ${t.classification.toLowerCase()}.`);
        break;
      }
    }

    this.red.step(dt, now);
    this.blueAuto.step(dt, now);

    this._friendlyPicture(now);
    this._drainEvents(now);
    this._reap(now);
  }

  /**
   * Friendly units are on the link, so their positions are known exactly — until
   * a unit goes EMCON silent, at which point the rest of the force is navigating
   * on its last reported position too.
   */
  _friendlyPicture(now) {
    for (const side of [SIDE.BLUE, SIDE.RED]) {
      const table = this.tables[side];
      for (const u of this.units) {
        if (!u.alive || u.side !== side) continue;
        const t = table.ensure(u, now);
        if (u.linkTx || u.emcon === EMCON.PASSIVE || u.emcon === EMCON.RESTRICTED || u.emcon === EMCON.FULL) {
          t.x = u.x; t.z = u.z; t.vx = Math.sin(u.heading) * u.speed; t.vz = Math.cos(u.heading) * u.speed;
          t.alt = u.alt; t.sigma = 25; t.tq = 6; t.lastUpdate = now;
          t.P[0] = 625; t.P[5] = 625;
          t.lastReport = now;
        } else {
          /*
           * DEAD RECKONING, not filter decay.
           *
           * A unit under EMCON silence used to be left to coast on its Kalman
           * estimate, which coasts toward nothing in particular: measured 88 km
           * of error after five minutes silent and 211 km after fifteen, and
           * then the symbol SNAPPED back to truth the moment the unit rejoined
           * the link. Ordering a silent aircraft to search an area puts it back
           * on the link, so the snap landed exactly on the order — reported as
           * "I ordered it to search an area and it just jumped there".
           *
           * Nobody loses their own aircraft by two hundred kilometres. A silent
           * consort is not an unknown contact: the force knows the course and
           * speed it was ordered to hold, and that is what dead reckoning is.
           * So the position stays good and only the CONFIDENCE decays, which
           * shows as a growing ellipse — the honest cost of going quiet —
           * instead of a symbol wandering off the plot.
           */
          t.x = u.x; t.z = u.z;
          t.vx = Math.sin(u.heading) * u.speed; t.vz = Math.cos(u.heading) * u.speed;
          t.alt = u.alt;
          t.lastUpdate = now;
          const stale = now - (t.lastReport ?? now);
          const err = Math.min(3500, 90 + stale * 1.2);
          t.sigma = err;
          t.P[0] = err * err; t.P[5] = err * err;
          t.tq = tqFromSigma(err);
        }
        t.measured = true;
        t.identity = IDENT.FRIEND;
        t.identityLocked = true;
        t.classification = u.cls.display;
        t.label = u.name;
        t.own = true;
        t.faded = false;
      }
    }
  }

  _drainEvents(now) {
    for (const e of this.sensors.drain()) this._onSensorEvent(e, now);
    for (const e of this.ordnance.drain()) this._onOrdnanceEvent(e, now);
    for (const e of this.defense.drain()) this._onDefenseEvent(e, now);
  }

  _onSensorEvent(e, now) {
    const t = e.track;
    if (e.unit && e.unit.side !== SIDE.BLUE) return;   // the player only hears his own net
    if (e.kind === 'NEW_CONTACT') {
      if (t.identity === IDENT.FRIEND) return;
      const brg = e.unit ? Math.round((((Math.atan2(t.x - e.unit.x, t.z - e.unit.z) * 180 / Math.PI) + 360) % 360)) : 0;
      this.comms.push({
        t: now, from: e.unit.name, priority: t.identity === IDENT.HOSTILE ? 'PRIORITY' : 'ROUTINE',
        text: `New contact ${t.id} — ${t.classification.toLowerCase()} bearing ${String(brg).padStart(3, '0')}${t.fingerprint ? `, emitter ${t.fingerprint}` : ''}.`,
        trackId: t.id,
      });
      this.emit({ type: 'CONTACT', track: t, unit: e.unit, source: e.source });
      if (!this._firstContact && t.identity !== IDENT.FRIEND) {
        this._firstContact = true;
        this.moment(6, `First contact — ${t.classification.toLowerCase()} bearing ${String(brg).padStart(3, '0')}, held by ${e.unit.name}.`);
      }
    } else if (e.kind === 'ILLUM' || e.kind === 'SEEKER' || e.kind === 'TORPEDO') {
      this.comms.push({ t: now, from: e.unit.name, priority: 'FLASH', text: e.text, trackId: t?.id });
      this.emit({ type: e.kind, track: t, unit: e.unit });
    }
  }

  _onOrdnanceEvent(e, now) {
    const o = e.ord;
    if (e.kind === 'LAUNCH') {
      if (o.category === 'ASM') {
        if (o.side === SIDE.BLUE) this.stats.asmFired++;
        else this.stats.redAsmFired++;
      }
      if (o.category === 'SAM') this.stats.samFired++;
      this.emit({ type: 'LAUNCH', ord: o, unit: e.shooter });
      if (o.category === 'ASM' && o.side === SIDE.BLUE && !this._firstShot) {
        this._firstShot = true;
        this.moment(7, `First anti-ship missile away — ${o.def.name} from ${e.shooter ? e.shooter.name : 'the task force'}.`);
      }
    } else if (e.kind === 'HIT') {
      const tgt = e.target;
      // Remember whose weapon did it. Without this the debrief cannot tell a
      // neutral the player shot from a neutral the enemy shot, and scored the
      // player for both — which is not merely unfair, it teaches the wrong thing
      // about a mechanic (seekers taking the biggest return) that is doing
      // exactly what it should.
      tgt._lastHitBy = o.side;
      if (o.category === 'ASM' && o.side === SIDE.BLUE) this.stats.asmHit++;
      this.emit({ type: 'HIT', ord: o, target: tgt, x: e.x, z: e.z, killed: e.killed, torpedo: e.torpedo });
      const isBlue = tgt.side === SIDE.BLUE;
      this.comms.push({
        t: now, from: isBlue ? tgt.name : 'TF-44 OPS', priority: 'FLASH',
        text: isBlue
          ? `WE ARE HIT. ${e.torpedo ? 'Torpedo' : 'Missile'} impact${e.killed ? ' — abandoning ship' : `, ${Math.round((tgt.hp / tgt.maxHp) * 100)} percent combat capability remaining`}.`
          : `${e.torpedo ? 'Torpedo' : 'Missile'} impact on ${tgt.side === SIDE.NEUTRAL ? 'NEUTRAL VESSEL' : tgt.name}${e.killed ? ' — target destroyed' : ''}.`,
      });
      if (tgt.side === SIDE.NEUTRAL) {
        this.emit({ type: 'NEUTRAL_HIT', target: tgt });
        this.moment(o.side === SIDE.BLUE ? 10 : 6,
          o.side === SIDE.BLUE
            ? `Our ${o.def.name} struck the neutral ${tgt.name}.`
            : `A hostile round struck the neutral ${tgt.name}.`);
      } else if (isBlue && (tgt.alive || e.killed)) {
        this.moment(e.killed ? 9 : 7,
          e.killed ? `${tgt.name} lost.`
            : `${tgt.name} hit — ${Math.round((tgt.hp / tgt.maxHp) * 100)} percent capability remaining.`);
      } else if (e.killed) {
        this.moment(8, `${tgt.name} destroyed — ${tgt.cls.display}.`);
      }
    } else if (e.kind === 'MISS') {
      if (o.side === SIDE.BLUE) {
        this.comms.push({ t: now, from: 'WEAPONS', priority: 'ROUTINE', text: `${o.def.name} ${o.id}: ${e.reason.toLowerCase()}. Round expended.` });
      }
      this.emit({ type: 'MISS', ord: o });
    } else if (e.kind === 'ACQUIRE') {
      this.emit({ type: 'ACQUIRE', ord: o, target: e.target });
      if (o.side === SIDE.RED && e.target.side === SIDE.BLUE) this.stats.redAsmLeakers++;
    } else if (e.kind === 'SEEKER_ON') {
      this.emit({ type: 'SEEKER_ON', ord: o });
    } else if (e.kind === 'INTERCEPT') {
      this.emit({ type: 'INTERCEPT', ord: o, target: e.target, success: e.success, x: e.x, z: e.z, alt: e.alt });
      if (e.success && o.side === SIDE.BLUE) this.stats.samHit++;
    } else if (e.kind === 'DECOYED') {
      this.emit({ type: 'DECOYED', ord: o });
    }
  }

  _onDefenseEvent(e, now) {
    if (e.kind === 'SAM_LAUNCH') {
      this.emit({ type: 'LAUNCH', ord: e.ord, unit: e.unit });
      if (e.unit.side === SIDE.BLUE && now - (this._lastSamCall || -99) > 6) {
        this._lastSamCall = now;
        this.comms.push({ t: now, from: e.unit.name, priority: 'FLASH', text: `Engaging inbound — birds away.` });
      }
    } else if (e.kind === 'CIWS_KILL') {
      this.emit({ type: 'CIWS_KILL', ord: e.ord, x: e.x, z: e.z, alt: e.alt, unit: e.unit });
    } else if (e.kind === 'CIWS_FIRE') {
      this.emit({ type: 'CIWS_FIRE', unit: e.unit, ord: e.ord });
    } else if (e.kind === 'DECOY') {
      this.emit({ type: 'DECOY', unit: e.unit, x: e.x, z: e.z });
      if (e.unit.side === SIDE.BLUE) {
        this.comms.push({ t: now, from: e.unit.name, priority: 'PRIORITY', text: `Launching decoys, coming hard to starboard.` });
      }
    } else if (e.kind === 'ASW_LAUNCH') {
      this.emit({ type: 'LAUNCH', ord: e.ord, unit: e.unit });
      this.comms.push({ t: now, from: e.unit.name, priority: 'PRIORITY', text: `ASROC away on ${e.track.id}.` });
    }
  }

  /**
   * A destroyed contact stops being a contact.
   *
   * Nothing used to clear a track when its truth died: the symbol simply
   * stopped being updated, so it sat on the plot at full quality for about two
   * minutes and then decayed out over another ten — all while the comms channel
   * had already reported "confirmed kill". The player was told it was dead and
   * shown that it wasn't.
   *
   * The track is dropped only for a side that was actually HOLDING it when it
   * died. A kill you had no sensor on does not quietly confirm itself, and a
   * stale track on something that sank an hour ago is a real and useful mistake
   * to be able to make — it just should not be the normal case for a target you
   * were watching at the moment it blew up.
   */
  _dropTracksOn(u, now) {
    for (const side of [SIDE.BLUE, SIDE.RED]) {
      const table = this.tables[side];
      const t = table.find(u.id);
      if (!t || t.own) continue;
      // Held means: we had it, and it had not already gone stale on us.
      const held = !t.faded && (now - t.lastUpdate) < 180;
      if (!held) continue;
      table.remove(u.id);
      if (side === SIDE.BLUE) {
        this.comms.push({
          t: now, from: 'TF-44 OPS', priority: 'ROUTINE',
          text: `${t.id} drops from the plot — target destroyed.`,
        });
      }
    }
  }

  _reap(now) {
    for (const u of this.units) {
      if (u.alive || u._reaped) continue;
      u._reaped = true;
      u.sunkAt = now;
      if (u.despawned) continue;
      const list = u.side === SIDE.BLUE ? this.stats.blueLosses
        : u.side === SIDE.RED ? this.stats.redLosses : this.stats.neutralLosses;
      list.push({ id: u.id, name: u.name, cls: u.cls.display, t: now, by: u._lastHitBy || 'UNKNOWN' });
      this._dropTracksOn(u, now);
      this.emit({ type: 'SUNK', unit: u });
      if (u.side === SIDE.BLUE) {
        this.comms.push({ t: now, from: 'TF-44 OPS', priority: 'FLASH', text: `${u.name} is lost. All hands, search and rescue.` });
      } else if (u.side === SIDE.RED) {
        this.comms.push({ t: now, from: 'TF-44 OPS', priority: 'PRIORITY', text: `Splash ${u.name} — ${u.cls.display}. Confirmed kill.` });
      } else {
        const ours = u._lastHitBy === SIDE.BLUE;
        this.comms.push({
          t: now, from: 'TF-44 OPS', priority: 'FLASH',
          text: ours
            ? `NEUTRAL VESSEL ${u.name} DESTROYED BY OUR ORDNANCE. Log the position. There will be an inquiry.`
            : `${u.name} has been sunk by a Volsk anti-ship missile. She was a merchant on a declared route. Their seekers are taking the biggest return in the basket and they do not appear to care.`,
        });
      }
    }
  }

  notifyRedStrike(shooter, count, wid, now) {
    this.emit({ type: 'RED_STRIKE', shooter, count, wid });
  }

  // ─────────────────────────── player command API ───────────────────────────

  /** Fire a salvo at a track. Returns { fired, reason }. */
  engage(shooters, track, weaponId, count, opts = {}) {
    if (!track) return { fired: 0, reason: 'no track designated' };
    const def = weapon(weaponId);
    let fired = 0;
    const now = this.time;
    // Coordinated time on top: every round in the salvo arrives together, so the
    // defender has to solve all of them at once instead of one at a time.
    let tot = 0;
    for (const s of shooters) {
      const d = Math.hypot(track.x - s.x, track.z - s.z);
      tot = Math.max(tot, d / def.speed);
    }
    // A caller that is splitting one raid across several ships passes the raid's
    // shared arrival time in; only fall back to this ship's own flight time when
    // nobody has coordinated it.
    const arrival = opts.timeOnTop || (now + tot + 45);
    const salvoId = `BLUE-${Math.floor(now)}`;
    for (const s of shooters) {
      if (!s.alive) continue;
      const d = Math.hypot(track.x - s.x, track.z - s.z);
      if (d > def.range * 0.95) continue;
      const n = Math.min(count, s.ammo(weaponId));
      for (let i = 0; i < n; i++) {
        const o = this.ordnance.fire(s, weaponId, track, {
          salvoId,
          timeOnTop: opts.coordinated === false ? null : arrival,
          seekerActivateRange: opts.seekerActivateRange,
        });
        if (o) fired++;
      }
    }
    if (fired) {
      this.comms.push({
        t: now, from: 'TF-44 WEAPONS', priority: 'PRIORITY',
        text: `${fired} × ${def.name} away on ${track.id}. Time of flight ${Math.round(tot / 60)} minutes. Track quality at launch: TQ${track.tq}.`,
      });
      this.blueStrikeDetected = true;
    }
    return { fired, reason: fired ? null : 'out of range or magazine empty' };
  }

  /**
   * Relieve an aircraft that has landed.
   *
   * A maritime patrol station is not one sortie, it is a rotation: the squadron
   * launches a relief before the aircraft on station reaches bingo. Modelling a
   * single sortie meant the task force permanently lost its eyes five hours in,
   * which is not how anybody operates and made the back half of the mission a
   * fight the player could not see.
   */
  relieveOnStation(u) {
    if (!u || u._relieved) return null;
    u._relieved = true;
    const base = this.scenario.blueAirbase;
    const n = (this._reliefCount = (this._reliefCount || 0) + 1);
    const relief = this.spawn({
      className: u.className, side: u.side,
      id: `${u.id}-R${n}`,
      name: `${u.name.replace(/ \d+$/, '')} ${70 + n}`,
      x: base.x + 20000, z: base.z + 20000,
      heading: Math.atan2(u.x - base.x, u.z - base.z),
      alt: u.cls.cruiseAlt, emcon: u.emcon, roe: u.ordered.roe,
    });
    // Send the relief to whatever station its predecessor was holding.
    if (u.patrol && u.patrol.type === 'ORBIT') relief.setOrbit(u.patrol.x, u.patrol.z, u.patrol.radius);
    else relief.orderWaypoint(u.x, u.z, { speed: relief.cls.cruiseSpeed, alt: relief.cls.cruiseAlt });
    this.comms.push({
      t: this.time, from: 'TF-44 OPS', priority: 'ROUTINE',
      text: `${u.name} is down safe. ${relief.name} launched to relieve on station — she will be up in about ${Math.round(Math.hypot(u.x - base.x, u.z - base.z) / relief.cls.cruiseSpeed / 60)} minutes.`,
    });
    return relief;
  }

  /**
   * Ships sent away from the screen on a signal — replenishment, a prosecution,
   * a rescue — come back when the job is done. Without this the player pays for
   * every "yes" forever, which makes the only safe answer "no" and kills the
   * whole point of asking.
   */
  _detachedTasks(now) {
    const win = this.signals.standing.emconWindow;
    for (const u of this.units) {
      if (!u.alive || u.side !== SIDE.BLUE) continue;
      if (win && !win.violated && u.radiating) {
        win.violated = true;
        this.comms.push({
          t: now, from: 'TF-44 TAO', priority: 'FLASH',
          text: `${u.name} is radiating inside the quiet window. We have just burned the collection pass.`,
        });
      }
      if (u._rasUntil && now > u._rasUntil) {
        u._rasUntil = null;
        for (const k in u.magsMax) u.mags[k] = u.magsMax[k];
        this.rejoinScreen?.(u);
        this.comms.push({ t: now, from: u.name, priority: 'ROUTINE', text: 'Replenishment complete, cells full. Rejoining the screen.' });
      }
      if (u._prosecuting && now > u._prosecuting) {
        u._prosecuting = null;
        u.ordered.emcon = EMCON.PASSIVE;
        this.rejoinScreen?.(u);
        this.comms.push({ t: now, from: u.name, priority: 'ROUTINE', text: 'Datum is cold. Breaking off and rejoining the screen.' });
      }
      if (u._sarUntil && now > u._sarUntil) {
        u._sarUntil = null;
        this.rejoinScreen?.(u);
        this.comms.push({ t: now, from: u.name, priority: 'ROUTINE', text: 'Survivors are aboard and stable. Rejoining the screen.' });
      }
    }
  }

  /** Put a detached escort back on a screening station around the guide. */
  rejoinScreen(u) {
    const g = this.blueGuide;
    if (!g || !u || !u.alive) return;
    const peers = this.units.filter(x => x.alive && x.side === SIDE.BLUE && !x.isAir && !x.isSub && !x.hvu);
    const i = Math.max(0, peers.indexOf(u));
    const slots = [[35, 11000], [-35, 11000], [110, 9000], [-110, 9000], [180, 12000], [0, 14000]];
    const s = slots[i % slots.length];
    u.station = { guide: g, relBearing: s[0] * Math.PI / 180, range: s[1] };
    u.waypoints.length = 0; u.patrol = null; u.dip = null;
  }

  /**
   * Drop a sonobuoy from an aircraft. The buoy is a listening post that outlives
   * the aircraft's time on station — which is the whole reason airborne ASW is a
   * search you can actually win.
   */
  dropSonobuoy(u) {
    if (!u || !u.alive || !u.isAir) return null;
    if ((u.mags.SONOBUOY || 0) <= 0) return null;
    u.mags.SONOBUOY -= 1;
    const b = new Sonobuoy(u.side, u.x, u.z, {
      id: `SB${String(++this._buoyN).padStart(2, '0')}`,
      droppedAt: this.time,
      expiresAt: this.time + 3600,
      range: 9000,
    });
    this.buoys.push(b);
    this.emit({ type: 'BUOY', unit: u, buoy: b, x: b.x, z: b.z });
    this.comms.push({
      t: this.time, from: u.name, priority: 'ROUTINE',
      text: `Buoy ${b.id} away. ${u.mags.SONOBUOY} remaining on the rack.`,
    });
    return b;
  }

  /** Launch an embarked aircraft from a parent unit. */
  /**
   * Put an airframe in the air. `ld` is the loadout it was armed with — the
   * airframe's own class carries no weapons, so this is where a Super Hornet
   * finds out whether it is an interceptor or an anti-ship strike.
   */
  launchAircraft(parent, type, ld = null) {
    const slot = (parent.cls.aircraft || []).find(a => a.type === type);
    if (!slot) return null;
    const already = this.units.filter(u => u.alive && u.homeBase === parent && u.className === type).length;
    if (already >= slot.count) return null;
    const callsign = this._callsign(parent, type, ld);
    const u = this.spawn({
      className: type, side: parent.side,
      name: callsign,
      x: parent.x + Math.sin(parent.heading) * 400,
      z: parent.z + Math.cos(parent.heading) * 400,
      heading: parent.heading, emcon: EMCON.PASSIVE,
    });
    u.homeBase = parent;
    u.alt = 40;
    u.ordered.alt = u.cls.cruiseAlt;
    if (ld) {
      u.airRole = ld.role;
      u.loadoutId = ld.id;
      // The loadout is the magazine. Overwrite rather than add: the class
      // defines no weapons for a strike fighter on purpose.
      for (const w of ld.weapons) {
        u.mags[w.id] = w.count;
        u.magsMax[w.id] = w.count;
      }
      u.cls = { ...u.cls, weapons: ld.weapons.slice() };
    }
    this._stationOnLaunch(u, parent, ld);
    this.comms.push({
      t: this.time, from: parent.name, priority: 'ROUTINE',
      text: `${u.name} is airborne${ld ? ` — ${ld.name}` : ''}.`,
    });
    return u;
  }

  /**
   * Put a newly-launched aircraft somewhere sensible.
   *
   * Without this an aircraft came off the catapult with no orders at all and
   * flew the carrier's heading in a straight line until it ran out of fuel —
   * which is not a thing that has ever happened on a flight deck, and it made
   * the whole air wing feel like it needed babysitting from the second it left.
   *
   * A fighter goes to a barrier station between the force and the threat. Early
   * warning goes further out on the same bearing, because that is the whole
   * point of it. A helicopter stays close. Strike aircraft hold overhead and
   * wait to be told where to go, since sending them anywhere before the player
   * has designated a target would just burn the fuel they need to get there.
   */
  _stationOnLaunch(u, parent, ld) {
    const role = ld ? ld.role : null;
    // Threat bearing: toward the nearest thing we hold that is not ours.
    const table = this.picture(parent.side);
    let bx = parent.x + Math.sin(parent.heading) * 1000;
    let bz = parent.z + Math.cos(parent.heading) * 1000;
    let best = Infinity;
    for (const t of (table ? table.list : [])) {
      if (t.faded || t.own) continue;
      if (t.identity === 'FRIEND' || t.identity === 'NEUTRAL') continue;
      const d = Math.hypot(t.x - parent.x, t.z - parent.z);
      if (d < best) { best = d; bx = t.x; bz = t.z; }
    }
    const brg = Math.atan2(bx - parent.x, bz - parent.z);
    const at = (r) => ({ x: parent.x + Math.sin(brg) * r, z: parent.z + Math.cos(brg) * r });

    // A strike released by the flag is tasked as it comes off the deck, so the
    // player does not have to re-designate the target for each aircraft in a
    // package that takes two minutes to launch.
    if ((role === 'STRIKE' || role === 'RECON') && this.pendingStrikeTrack) {
      const t = this.pendingStrikeTrack;
      if (!t.faded && this.time - t.lastUpdate < 900) {
        u.strikeTrack = t;
        u._ingressAt = 0;
        return;
      }
      this.pendingStrikeTrack = null;
    }

    if (role === 'CAP') {
      const p = at(55000);
      u.setOrbit(p.x, p.z, 18000);
    } else if (role === 'AEW') {
      const p = at(95000);
      u.setOrbit(p.x, p.z, 26000);
    } else if (role === 'STRIKE' || role === 'RECON') {
      // Overhead, waiting for tasking. Tight orbit so it is easy to find.
      u.setOrbit(parent.x, parent.z, 12000);
    } else {
      // Helicopters: a short leg out on the threat bearing.
      const p = at(14000);
      u.setOrbit(p.x, p.z, 7000);
    }
  }

  /**
   * Callsigns, because "MERIDIAN AIR 3" is not how anybody talks and the fleet
   * net is most of this game's texture. Squadron names by mission, a two-digit
   * modex that increments.
   */
  _callsign(parent, type, ld) {
    const stem = type === 'MH60R' ? 'SABRE'
      : type === 'AEW_E2D' ? 'WALLBANGER'
        : ld && ld.role === 'CAP' ? 'VICTORY'
          : ld && ld.role === 'STRIKE' ? 'HAMMER'
            : 'RANGER';
    this._modex = this._modex || {};
    const n = (this._modex[stem] = (this._modex[stem] || 100) + 1);
    return `${stem} ${n}`;
  }
}
