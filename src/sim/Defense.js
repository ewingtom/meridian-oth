import { DOMAIN, ROE, IDENT, clamp, Rng, WEAPONS_QUALITY_TQ } from './constants.js';
import { weapon } from './weapons.db.js';

const rng = new Rng(777);

/*
 * Layered defence.
 *
 * A ship does not have "a" defence against anti-ship missiles; it has four, in
 * series, and the whole design of a modern escort is about buying enough seconds
 * to use them all:
 *
 *   AREA SAM   170 km of reach — but only as far as you can SEE, which against a
 *              sea-skimmer is about 30 km, or ninety seconds.
 *   POINT SAM  quad-packed, because the binding constraint in a saturation raid
 *              is not range, it is how many cells you have.
 *   SOFT KILL  a decoy that makes the seeker prefer empty water. Costs nothing
 *              and needs no fire-control channel.
 *   CIWS       twenty millimetres and a prayer.
 *
 * Note that everything here works off the TRACK TABLE, not the truth. A ship
 * cannot shoot at a missile it has not detected — which is why the E-2D matters
 * more than another magazine.
 */

export class DefenseSystem {
  constructor(world) {
    this.world = world;
    this.events = [];
    this._t = 0;
  }

  step(dt, now) {
    const w = this.world;
    for (const u of w.units) {
      if (!u.alive || u.neutral) continue;
      if (u.ordered.roe === ROE.HOLD) continue;
      u.fcBusy = 0;
      const table = w.picture(u.side);
      if (!table) continue;
      this._airDefense(u, table, dt, now);
      this._ciws(u, dt, now);
      this._softKill(u, dt, now);
      this._asw(u, table, dt, now);
    }
  }

  _airDefense(u, table, dt, now) {
    const sams = (u.cls.weapons || [])
      .map(x => weapon(x.id))
      .filter(x => x.category === 'SAM' && u.ammo(x.id) > 0)
      .sort((a, b) => b.range - a.range);
    if (!sams.length) return;
    if (u.fcChannels <= 0) return;

    // Threats: held tracks in the missile or air domain that are actually closing.
    const threats = [];
    for (const t of table.list) {
      if (t.faded) continue;
      if (t.domain !== DOMAIN.MISSILE && t.domain !== DOMAIN.AIR) continue;
      if (t.identity === IDENT.FRIEND || t.identity === IDENT.NEUTRAL) continue;
      if (t.domain === DOMAIN.AIR && t.identity !== IDENT.HOSTILE) continue;
      if (t.tq < 3) continue;
      if (now - t.lastUpdate > 12) continue;
      // System reaction time. A track has to be established, classified as a
      // threat, and assigned before a round leaves the cell — nobody shoots at
      // the first return. Fifteen seconds of a missile's life is four kilometres.
      if (now - t.created < 15) continue;
      const dx = t.x - u.x, dz = t.z - u.z;
      const r = Math.hypot(dx, dz);
      if (r > 180000) continue;
      const closing = -((t.vx * dx + t.vz * dz) / Math.max(1, r));
      // A missile that is not closing is not a threat. An AIRCRAFT that is not
      // closing very much IS one — a maritime patrol aircraft orbiting at the
      // edge of the SAM envelope, holding the task force on radar and passing
      // its position to a bomber regiment, is the single most dangerous thing in
      // the sky and the one thing most worth spending a Standard on. Requiring it
      // to be inbound before anyone would shoot at it removed the player's whole
      // counter to being shadowed.
      if (closing < 40 && t.domain === DOMAIN.MISSILE) continue;
      const tti = t.domain === DOMAIN.AIR
        ? r / 250                                  // rank shadowers by range
        : r / Math.max(60, closing);
      threats.push({ t, r, tti, closing });
    }
    if (!threats.length) return;
    threats.sort((a, b) => a.tti - b.tti);

    // ── fire-control channels ────────────────────────────────────────────
    // A channel is not freed the instant a round detonates. The engagement
    // occupies it for the whole cycle: assign, launch, fly out, intercept, and
    // then assess whether the target actually died before the same channel can
    // be handed a new one. Modelling only the flyout — never mind only the
    // launch — lets a single cruiser service seventy engagements in the two
    // minutes a sea-skimming raid is inside its horizon, which makes saturation
    // arithmetically impossible and quietly removes the point of the whole game.
    const ASSESS = 13;                 // seconds of kill assessment per cycle
    u._samAssign = u._samAssign || new Map();
    const engaged = new Set();
    const inFlight = new Map();
    for (const [tid, a] of u._samAssign) {
      if (now < a.until) { engaged.add(tid); inFlight.set(tid, a.rounds); }
      else u._samAssign.delete(tid);
    }

    const total = u.fcChannels - Math.round(u.damage.weapons * u.fcChannels);
    let channels = total - engaged.size;
    for (const th of threats) {
      if (channels <= 0) break;
      const truth = th.t.truthRef;
      if (!truth || !truth.alive) continue;
      const assign = u._samAssign.get(truth.id);
      const already = assign ? assign.rounds : 0;
      // Doctrine: two rounds per leaker while the magazine allows it, one when
      // the raid is big enough that husbanding rounds matters more than certainty.
      const wanted = threats.length > 8 ? 1 : 2;
      if (already >= wanted) continue;

      for (const sam of sams) {
        if (u.ammo(sam.id) <= 0) continue;
        if (th.r > sam.range * 0.92) continue;
        if ((truth.alt ?? 0) > (sam.maxAlt || 20000)) continue;
        if (sam.range > 100000 && th.r < 12000) continue;
        u._samCooldown = u._samCooldown || {};
        if (now - (u._samCooldown[sam.id] ?? -999) < (sam.cyclesToFire || 1) * 2.0) continue;
        const o = this.world.ordnance.fire(u, sam.id, th.t, { aim: { x: truth.x, z: truth.z } });
        if (o) {
          o.truth = truth;
          o.acquired = true;
          u._samCooldown[sam.id] = now;
          const flyout = th.r / Math.max(200, sam.speed || 900);
          const until = now + flyout + ASSESS;
          if (assign) { assign.rounds++; assign.until = Math.max(assign.until, until); }
          else {
            u._samAssign.set(truth.id, { rounds: 1, until });
            if (!sam.fireAndForget) channels--;
            engaged.add(truth.id);
          }
        }
        break;
      }
    }
    u.fcBusy = engaged.size;
    u.fcChannelsTotal = total;

  }

  _ciws(u, dt, now) {
    const ciws = (u.cls.weapons || []).map(x => weapon(x.id)).filter(x => x.category === 'CIWS');
    if (!ciws.length) return;
    const mounts = ciws[0];
    const count = (u.cls.weapons.find(x => x.id === mounts.id) || {}).count || 1;
    // A mount tracks ONE round at a time. Letting every mount shoot at every
    // inbound simultaneously made close-in defence an impenetrable wall and
    // removed the entire point of a saturation raid.
    const inbound = [];
    for (const o of this.world.weapons) {
      if (!o.alive || o.side === u.side || o.category !== 'ASM') continue;
      const r = Math.hypot(o.x - u.x, o.z - u.z);
      if (r > mounts.range) continue;
      inbound.push({ o, r });
    }
    if (!inbound.length) return;
    inbound.sort((a, b) => a.r - b.r);
    for (let i = 0; i < Math.min(count, inbound.length); i++) {
      const { o } = inbound[i];
      // Closed-loop spotting: the longer it is in the envelope the better the
      // odds. Calibrated as a per-SECOND hazard rate so the result depends on the
      // crossing time rather than on the simulation's step size — a subsonic
      // sea-skimmer takes about eight seconds to cross the envelope and ends up
      // around 45% killed by one mount, which is roughly what a Phalanx-class
      // system is credited with. A Mach 2.5 diver crosses in two seconds and the
      // same rate gives it a 7% chance of being stopped, which is the honest
      // answer and the reason nobody plans to defeat one with a gun.
      const fast = (o.def.terminalSpeed || o.def.speed) > 600 ? 0.45 : 1;
      const rate = (mounts.pkSingle || 0.5) * 0.14 * fast * (1 - u.damage.weapons * 0.7);
      const p = 1 - Math.pow(1 - rate, dt);
      if (rng.next() < p) {
        o.kill('CIWS');
        this.events.push({ kind: 'CIWS_KILL', unit: u, ord: o, t: now, x: o.x, z: o.z, alt: o.alt });
      } else {
        this.events.push({ kind: 'CIWS_FIRE', unit: u, ord: o, t: now });
      }
    }
  }

  _softKill(u, dt, now) {
    if (!u.hasWeapon('NULKA') || u.ammo('NULKA') <= 0) return;
    const def = weapon('NULKA');
    for (const o of this.world.weapons) {
      if (!o.alive || o.side === u.side || o.category !== 'ASM') continue;
      if (o.decoyed) continue;
      const r = Math.hypot(o.x - u.x, o.z - u.z);
      if (r > 8500 || r < 900) continue;
      if (now - (u._lastDecoy || -99) < 22) continue;
      u.mags.NULKA--;
      u._lastDecoy = now;
      // Put the false target off the disengaged beam and turn away from it —
      // the decoy only works if the ship gives the seeker a better option.
      const off = u.heading + Math.PI * 0.5 * (rng.next() < 0.5 ? 1 : -1);
      const dp = { x: u.x + Math.sin(off) * 1400, z: u.z + Math.cos(off) * 1400 };
      const seduce = (def.seduceChance || 0.4) * (o.passiveSeeker ? 0.45 : 1) * (o.def.stealth > 1 ? 0.7 : 1);
      this.events.push({ kind: 'DECOY', unit: u, ord: o, t: now, x: dp.x, z: dp.z });
      if (rng.next() < seduce) {
        o.decoyed = dp;
        o.acquired = false; o.truth = null;
      }
    }
  }

  _asw(u, table, dt, now) {
    if (u.ordered.roe !== ROE.FREE) return;
    const hasVla = u.ammo('VLA') > 0;
    const hasTorp = u.ammo('MK54') > 0;
    if (!hasVla && !hasTorp) return;
    for (const t of table.list) {
      if (t.faded || t.domain !== DOMAIN.SUBSURFACE) continue;
      if (t.identity !== IDENT.HOSTILE) continue;
      if (t.tq < WEAPONS_QUALITY_TQ) continue;
      if (now - t.lastUpdate > 45) continue;
      if (now - (u._lastAsw || -999) < 60) continue;
      const r = Math.hypot(t.x - u.x, t.z - u.z);
      const wid = hasVla && r < weapon('VLA').range * 0.9 ? 'VLA'
        : (hasTorp && r < weapon('MK54').range * 0.9 ? 'MK54' : null);
      if (!wid) continue;
      const o = this.world.ordnance.fire(u, wid, t, { aim: { x: t.x, z: t.z } });
      if (o) {
        u._lastAsw = now;
        this.events.push({ kind: 'ASW_LAUNCH', unit: u, ord: o, track: t, t: now });
      }
      break;
    }
  }

  drain() { const e = this.events; this.events = []; return e; }
}
