import { clamp, angDiff, wrapAngle, DOMAIN, SIDE, IDENT, Rng } from './constants.js';
import { weapon } from './weapons.db.js';

const rng = new Rng(4242);
let _oid = 1;

/*
 * In-flight ordnance.
 *
 * The anti-ship missile is where every earlier decision gets its verdict. It is
 * launched at a PREDICTION — where the plot thinks the target will be in eleven
 * minutes — and its seeker only sees a fan a few tens of kilometres wide. So:
 *
 *   good track + custody maintained  -> the basket lands on the target
 *   good track + custody lost        -> the target has moved out of the basket
 *   poor track                       -> the basket was never in the right ocean
 *
 * Nothing about the missile changes between those three cases. That is the point.
 */

export class Ordnance {
  constructor(opts) {
    this.oid = _oid++;
    this.id = `W${this.oid}`;
    this.side = opts.side;
    this.def = weapon(opts.weaponId);
    this.weaponId = opts.weaponId;
    this.category = this.def.category;
    this.shooter = opts.shooter;
    this.shooterId = opts.shooter?.id;

    this.x = opts.x; this.z = opts.z; this.alt = opts.alt ?? 12;
    this.heading = opts.heading ?? 0;
    this.speed = 60;
    this.age = 0;
    this.alive = true;
    this.detectable = true;
    this.distance = 0;

    this.track = opts.track || null;         // the belief we are shooting at
    this.truth = null;                       // resolved once the seeker acquires
    this.aim = opts.aim ? { ...opts.aim } : { x: this.x, z: this.z };
    this.launchAim = { ...this.aim };
    this.seekerActivateRange = opts.seekerActivateRange ?? (this.def.seekerRange || 20000);
    this.seekerActive = false;
    this.acquired = false;
    this.passiveSeeker = this.weaponId === 'NSM';
    this.midcourseUpdates = 0;
    this.lastMidcourse = 0;
    this.phase = 'BOOST';
    this.decoyed = null;
    this.trail = [];
    this.launchTime = opts.now || 0;
    this.tqAtLaunch = opts.track?.tq ?? 0;
    // What the plot thought it was shooting at, as a radar size estimate. A
    // discriminating seeker uses this to reject the wrong ship; a plain active
    // seeker has no idea and simply takes the biggest return in the basket.
    this.expectRcs = opts.track?.truthRef?.rcs ?? null;
    this.salvoId = opts.salvoId || null;
    this.timeOnTop = opts.timeOnTop || null;   // coordinated arrival
    this.result = null;
    this.spawnedFx = false;
    this.evasiveTimer = 0;
    this.cruiseAlt = this.def.cruiseAlt ?? 15;
    this.lofted = (this.def.cruiseAlt || 0) > 1000;
  }

  get rcs() {
    // A high-flying supersonic missile is a much bigger radar problem than a
    // sea-skimmer — but the sea-skimmer is the one you cannot see coming.
    return this.def.rcs * (this.phase === 'TERMINAL' ? 1 : 1.1);
  }
  get acoustic() { return 0; }
  get isSub() { return false; }
  get isAir() { return true; }
  get domain() { return this.category === 'TORPEDO' ? DOMAIN.TORPEDO : DOMAIN.MISSILE; }
  get cls() { return { length: 5, mastHeight: 0 }; }
  get signatureHeight() { return Math.max(2, this.alt); }
  get name() { return this.def.name; }

  kill(reason) {
    this.alive = false;
    this.result = reason;
  }
}

export class OrdnanceSystem {
  constructor(world) {
    this.world = world;
    this.events = [];
  }

  /** Launch one round. Returns the Ordnance, or null if the magazine is dry. */
  fire(shooter, weaponId, track, opts = {}) {
    const def = weapon(weaponId);
    if ((shooter.mags[weaponId] || 0) <= 0) return null;
    shooter.mags[weaponId]--;
    shooter.lastFired = this.world.time;

    const now = this.world.time;
    let aim = opts.aim;
    if (!aim && track) {
      // Aim at where the track will be when we get there, using the track's own
      // velocity estimate. Everything wrong with that estimate becomes miss distance.
      const roughRange = Math.hypot(track.x - shooter.x, track.z - shooter.z);
      const tof = roughRange / (def.speed || 250);
      aim = track.predictAt(tof);
    }
    if (!aim) aim = { x: shooter.x, z: shooter.z };

    const hdg = Math.atan2(aim.x - shooter.x, aim.z - shooter.z);
    const o = new Ordnance({
      side: shooter.side, weaponId, shooter, track,
      x: shooter.x + Math.sin(hdg) * 30,
      z: shooter.z + Math.cos(hdg) * 30,
      alt: shooter.isSub ? -20 : (shooter.isAir ? shooter.alt : 14),
      heading: hdg, aim, now,
      seekerActivateRange: opts.seekerActivateRange,
      salvoId: opts.salvoId,
      timeOnTop: opts.timeOnTop,
    });
    if (def.category === 'TORPEDO') { o.alt = -30; o.phase = 'RUN'; }
    if (def.category === 'SAM' || def.category === 'CIWS') o.phase = 'INTERCEPT';
    // A cell-launched round does not leave on the target bearing — it leaves
    // straight up, and turns over once it is clear of the deck. Every round in
    // this game used to appear thirty metres ahead of the ship already pointed
    // at the enemy, which is how a canister works and not how a Mk 41 does.
    if (def.vls && def.category !== 'TORPEDO') {
      o.phase = 'VLAUNCH';
      o.x = shooter.x; o.z = shooter.z;
      o.alt = shooter.isAir ? shooter.alt : 6;
      o.speed = 0;
      o.vlt = 0; o.vSpd = 0; o.vPitch = Math.PI / 2;
    }
    this.world.weapons.push(o);
    this.events.push({ kind: 'LAUNCH', ord: o, shooter, t: now });
    if (track) track.engagedBy.add(o.id);
    return o;
  }

  step(dt, now) {
    const w = this.world;
    for (const o of w.weapons) {
      if (!o.alive) continue;
      o.age += dt;
      if (o.phase === 'VLAUNCH' && this._vlaunch(o, dt)) {
        o.trail.push({ x: o.x, z: o.z, y: o.alt, t: now });
        if (o.trail.length > 260) o.trail.shift();
        continue;
      }
      switch (o.category) {
        case 'ASM': this._asm(o, dt, now); break;
        case 'SAM': this._sam(o, dt, now); break;
        case 'TORPEDO': this._torpedo(o, dt, now); break;
        case 'DECOY': this._decoy(o, dt, now); break;
        default: this._asm(o, dt, now); break;
      }
      if (o.alive) {
        o.trail.push({ x: o.x, z: o.z, y: o.alt, t: now });
        if (o.trail.length > 260) o.trail.shift();
      }
    }
    // Reap
    for (let i = w.weapons.length - 1; i >= 0; i--) {
      const o = w.weapons[i];
      if (!o.alive && now - (o._deadAt || (o._deadAt = now)) > 8) w.weapons.splice(i, 1);
    }
  }

  /**
   * The first two seconds out of a vertical cell.
   *
   * The round comes out on the booster with no aerodynamic authority at all,
   * climbs clear of the ship, and only then pitches over onto the bearing. The
   * tip-over is smoothstepped rather than linear because a real one is limited
   * by how fast the airframe can be rotated, not by a clock — and because a
   * linear turn reads, from the inset camera, as the missile being hinged.
   *
   * A surface-to-air round does all this about twice as hard: it is climbing to
   * meet something that is already inbound, so it has no seconds to spend.
   *
   * Returns true while it still owns the round.
   */
  _vlaunch(o, dt) {
    const sam = o.category === 'SAM';
    const vMax = sam ? 260 : 95;
    const accel = sam ? 230 : 70;
    const tipStart = sam ? 0.45 : 0.95;
    const tipDur = sam ? 1.1 : 2.0;

    o.vlt += dt;
    o.vSpd = Math.min(vMax, o.vSpd + accel * dt);
    const k = clamp((o.vlt - tipStart) / tipDur, 0, 1);
    const ease = k * k * (3 - 2 * k);
    o.vPitch = (Math.PI / 2) * (1 - ease);

    const hs = o.vSpd * Math.cos(o.vPitch);
    o.alt += o.vSpd * Math.sin(o.vPitch) * dt;
    o.x += Math.sin(o.heading) * hs * dt;
    o.z += Math.cos(o.heading) * hs * dt;
    o.speed = hs;
    o.distance += hs * dt;

    if (k >= 1) {
      o.phase = sam ? 'INTERCEPT' : 'BOOST';
      o.speed = Math.max(hs, 60);
      return false;
    }
    return true;
  }

  // ── anti-ship missile ─────────────────────────────────────────────────────
  _asm(o, dt, now) {
    const def = o.def;

    // Boost
    if (o.phase === 'BOOST') {
      o.speed = Math.min(def.speed, o.speed + (def.speed / 3.5) * dt);
      o.alt += (o.lofted ? 320 : 40) * dt;
      if (o.age > 5) { o.phase = 'CRUISE'; }
    } else if (o.phase === 'CRUISE') {
      o.speed = Math.min(def.speed, o.speed + (def.speed / 6) * dt);
      const targetAlt = o.cruiseAlt;
      o.alt += clamp(targetAlt - o.alt, -180 * dt, 180 * dt);
    }

    // ── mid-course guidance ────────────────────────────────────────────────
    // If somebody in the network still holds the target and can talk to the
    // missile, the aim point is refreshed in flight. This is the whole reason a
    // task force cares about CUSTODY rather than just detection.
    if (def.datalink && o.track && !o.acquired && now - o.lastMidcourse > 12) {
      o.lastMidcourse = now;
      const t = o.track;
      const fresh = (now - t.lastUpdate) < 90;
      const usable = t.linked && fresh && t.tq >= 3;
      if (usable) {
        const rangeToGo = Math.hypot(t.x - o.x, t.z - o.z);
        const tof = rangeToGo / Math.max(50, o.speed);
        const p = t.predictAt(tof);
        o.aim.x = p.x; o.aim.z = p.z;
        o.midcourseUpdates++;
      }
    }

    // Coordinated time-on-top: hold back if we are early so the salvo arrives
    // together instead of trickling in one missile at a time into a hot defence.
    if (o.timeOnTop && !o.acquired) {
      const rangeToGo = Math.hypot(o.aim.x - o.x, o.aim.z - o.z);
      const timeLeft = o.timeOnTop - now;
      if (timeLeft > 1) {
        const needed = rangeToGo / timeLeft;
        o.speed = clamp(needed, def.speed * 0.62, def.speed);
      }
    }

    // ── terminal descent ───────────────────────────────────────────────────
    // A sea-skimmer does not wait for its seeker before it goes low. It drops to
    // wave-top height well before it expects to be detected, precisely so that it
    // arrives under the defender's radar horizon: at six metres, against a 38 m
    // mast, it is invisible until 35 km — about two minutes. Descending only
    // after acquisition (which is what happens if this is left to the TERMINAL
    // phase) hands the defender an extra two minutes of engagement time and makes
    // every anti-ship missile in the game a free kill for the escort screen.
    const dToAim = Math.hypot(o.aim.x - o.x, o.aim.z - o.z);
    const skimmer = (def.terminalAlt ?? 6) < 200;
    if (skimmer && dToAim < Math.max(80000, o.seekerActivateRange * 1.4) && o.phase !== 'BOOST') {
      o.alt += clamp((def.terminalAlt ?? 6) - o.alt, -70 * dt, 40 * dt);
    }

    // Steering
    let tx = o.aim.x, tz = o.aim.z;
    if (o.acquired && o.truth && o.truth.alive) { tx = o.truth.x; tz = o.truth.z; }
    else if (o.decoyed) { tx = o.decoyed.x; tz = o.decoyed.z; }
    const desired = Math.atan2(tx - o.x, tz - o.z);
    const rate = o.acquired ? 0.35 : 0.09;
    o.heading = wrapAngle(o.heading + clamp(angDiff(o.heading, desired), -rate * dt, rate * dt));

    // Seeker turn-on
    const dAim = Math.hypot(o.aim.x - o.x, o.aim.z - o.z);
    if (!o.seekerActive && dAim < o.seekerActivateRange) {
      o.seekerActive = true;
      o.phase = 'SEARCH';
      this.events.push({ kind: 'SEEKER_ON', ord: o, t: now });
    }

    // Seeker search
    if (o.seekerActive && !o.acquired) {
      const t = this._seekerScan(o);
      if (t) {
        o.acquired = true;
        o.truth = t;
        o.phase = 'TERMINAL';
        this.events.push({ kind: 'ACQUIRE', ord: o, target: t, t: now });
      }
    }

    if (o.phase === 'TERMINAL') {
      o.alt += clamp((def.terminalAlt ?? 6) - o.alt, -420 * dt, 200 * dt);
      const ts = def.terminalSpeed || def.speed;
      o.speed = Math.min(ts, o.speed + (ts / 8) * dt);
    }

    // Integrate
    const d = o.speed * dt;
    o.x += Math.sin(o.heading) * d;
    o.z += Math.cos(o.heading) * d;
    o.distance += d;

    // Impact
    if (o.acquired && o.truth) {
      const r = Math.hypot(o.truth.x - o.x, o.truth.z - o.z);
      if (r < Math.max(35, o.speed * dt * 1.2)) return this._impact(o, o.truth, now);
      if (!o.truth.alive) { o.acquired = false; o.truth = null; o.phase = 'SEARCH'; }
    }
    if (o.decoyed) {
      const r = Math.hypot(o.decoyed.x - o.x, o.decoyed.z - o.z);
      if (r < 120) { o.kill('DECOYED'); this.events.push({ kind: 'DECOYED', ord: o, t: now }); return; }
    }

    // Out of gas / no acquisition
    if (o.distance > def.range) {
      o.kill(o.acquired ? 'SPENT' : 'NO ACQUISITION');
      this.events.push({ kind: 'MISS', ord: o, t: now, reason: o.result });
    } else if (o.seekerActive && !o.acquired && dAim > (def.seekerRange || 30000) * 1.9) {
      // Flew through the basket and found nothing. It will keep searching until
      // its fuel runs out, but the shot is already lost.
      o.phase = 'SEARCH';
    }
  }

  /**
   * The seeker sees a fan: `seekerRange` deep, `seekerWidth` half-width at that
   * range. Anything of the right kind inside the fan gets locked — including,
   * memorably, a neutral merchant that happened to be in the basket.
   */
  _seekerScan(o) {
    const def = o.def;
    const range = def.seekerRange || 25000;
    const halfWidth = (def.seekerWidth || 10000);
    let best = null, bestScore = Infinity;
    for (const u of this.world.units) {
      if (!u.alive || u.isAir || u.isSub) continue;
      if (u.side === o.side) continue;               // seekers do have IFF logic
      const dx = u.x - o.x, dz = u.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d > range) continue;
      const off = Math.abs(angDiff(o.heading, Math.atan2(dx, dz)));
      const lateral = Math.sin(off) * d;
      if (lateral > halfWidth * (0.35 + 0.65 * (d / range))) continue;
      if (off > 1.05) continue;
      // Prefer the biggest return near boresight — which is exactly how a
      // merchant ends up wearing a missile meant for a frigate.
      // A discriminating seeker (LRASM's autonomous target recognition, NSM's
      // imaging infrared) was given a size class at launch and REJECTS anything
      // that does not match it, rather than merely preferring the match. That
      // distinction matters: the screen is between the missile and the cruiser,
      // so a screening corvette enters the seeker basket first and a seeker that
      // merely prefers the cruiser still locks the corvette, because at turn-on
      // the cruiser is not in range yet. Half a decade of RCS is about the
      // tolerance — a destroyer can pass for a cruiser, a corvette cannot.
      if (def.discriminates && o.expectRcs) {
        const mismatch = Math.abs(Math.log10(Math.max(10, u.rcs)) - Math.log10(o.expectRcs));
        if (mismatch > 0.5) continue;
      }
      // Otherwise: biggest return near boresight — which is exactly how a
      // merchant ends up wearing a missile meant for a frigate.
      const score = d * 0.7 - Math.log10(Math.max(10, u.rcs)) * 4000 + lateral * 0.5;
      if (score < bestScore) { bestScore = score; best = u; }
    }
    return best;
  }

  _impact(o, target, now) {
    o.kill('HIT');
    const def = o.def;
    // Damage scales with the square root of the warhead and falls off with hull
    // size — not linearly, because a bigger ship is not just more steel, it is
    // more compartments, more redundancy and more distance between the hit and
    // anything vital. The earlier linear-in-tonnage form made one 950 kg warhead
    // a near-certain kill on a destroyer and two on a 25,000 tonne amphibious
    // ship, which turned every leaker into a mission-ending event.
    const w = def.warhead || 200;
    const disp = Math.max(800, target.cls.displacement || 6000);
    const scale = clamp(Math.sqrt(w / 250) * Math.pow(6000 / disp, 0.35), 0.3, 2.2);
    const dmg = (target.maxHp * 0.42) * scale * (0.7 + rng.next() * 0.6);
    const killed = target.applyDamage(dmg, 'BLAST');
    this.events.push({ kind: 'HIT', ord: o, target, t: now, damage: dmg, killed, x: o.x, z: o.z });
    return true;
  }

  // ── surface-to-air / close-in ─────────────────────────────────────────────
  _sam(o, dt, now) {
    const def = o.def;
    o.speed = Math.min(def.speed, o.speed + (def.speed / 2.5) * dt);
    const t = o.truth;
    if (!t || !t.alive) { o.kill('TARGET GONE'); return; }
    const tAlt = t.alt ?? 0;
    const dx = t.x - o.x, dz = t.z - o.z, dy = tAlt - o.alt;
    const d = Math.hypot(dx, dz);
    const desired = Math.atan2(dx, dz);
    // Proportional navigation approximated by a hard turn-rate lead.
    o.heading = wrapAngle(o.heading + clamp(angDiff(o.heading, desired), -1.6 * dt, 1.6 * dt));
    const step = o.speed * dt;
    o.x += Math.sin(o.heading) * step;
    o.z += Math.cos(o.heading) * step;
    o.alt += clamp(dy, -700 * dt, 700 * dt);
    o.distance += step;

    if (d < Math.max(60, o.speed * dt * 1.3)) {
      // Terminal roll. A sea-skimmer beneath the radar horizon and a supersonic
      // high-diver are both hard, for opposite reasons.
      // Terminal roll. A sea-skimmer at wave-top height is hard because the
      // interceptor has to discriminate it from the sea; a supersonic high-diver
      // is hard because there is no time; a low-observable airframe is hard
      // because the fire-control solution keeps breaking. All three are penalties
      // on the same number.
      /*
       * Terminal penalties, recalibrated against the modern combat record.
       *
       * These were set as though the interceptor were a 1982 Sea Dart, which
       * managed 8 kills from 26 launches in the Falklands — about 31 percent —
       * and which could not engage a low-level target at all. That is a system
       * limitation of that era, not a probability penalty that belongs on a
       * weapon built specifically to defeat sea-skimmers.
       *
       * The best modern dataset is the Red Sea, October 2023 onward: the US Navy
       * engaged more than 400 drones, cruise missiles and anti-ship ballistic
       * missiles, expending 120 SM-2, 80 SM-6 and 20 ESSM/SM-3, at a stated rate
       * of "about two rounds per incoming missile", and no warship was hit. Two
       * rounds to near-certainty implies a single-shot probability around 0.83:
       *   1 - (1 - p)^2 = 0.97  ->  p = 0.83
       * The base numbers in weapons.db were already in that region. The
       * modifiers were not — stacked, they took an ESSM's 0.80 down to 0.40,
       * which is a worse result than the campaign actually produced against
       * targets of exactly this kind.
       *
       * So the two that modern seekers were designed to solve come up, and the
       * one that is still genuinely a discrimination problem stays where it is:
       *
       *   low altitude   0.74 -> 0.88   ESSM Block 2 and RAM carry active
       *                                 seekers for precisely this case
       *   supersonic     0.68 -> 0.80   anti-ship BALLISTIC missiles, far faster
       *                                 than this threshold, were intercepted
       *                                 repeatedly in the Red Sea
       *   low-observable    unchanged   the fire-control solution still breaks;
       *                                 nothing in the record says otherwise
       *
       * Worst case is now a supersonic sea-skimmer against ESSM at 0.80 x 0.88 x
       * 0.80 = 0.56, and the doctrinal second round takes that to 0.81. Leakers
       * still get through a saturation raid, which is the point — they just no
       * longer get through a two-missile raid.
       */
      let pk = def.pkSingle ?? 0.65;
      if (tAlt < 20) pk *= 0.88;
      if ((t.def?.terminalSpeed || 0) > 700) pk *= 0.80;
      if (t.def?.stealth !== undefined) pk *= clamp(t.def.stealth * 0.8 + 0.34, 0.44, 1.0);
      o.kill('INTERCEPT');
      if (rng.next() < pk) {
        // A SAM's target may be an in-flight round (which is killed outright) or
        // an aircraft (which takes damage and may survive a near miss).
        if (typeof t.kill === 'function') t.kill('SHOT DOWN');
        else if (typeof t.applyDamage === 'function') t.applyDamage(t.maxHp * (0.6 + rng.next() * 0.7), 'BLAST');
        this.events.push({ kind: 'INTERCEPT', ord: o, target: t, t: now, x: t.x, z: t.z, alt: t.alt, success: true });
      } else {
        this.events.push({ kind: 'INTERCEPT', ord: o, target: t, t: now, x: t.x, z: t.z, alt: t.alt, success: false });
      }
      return;
    }
    if (o.distance > def.range * 1.15 || o.age > 260) { o.kill('SPENT'); }
  }

  // ── torpedo ───────────────────────────────────────────────────────────────
  _torpedo(o, dt, now) {
    const def = o.def;
    o.speed = Math.min(def.speed, o.speed + 3 * dt);
    let tx = o.aim.x, tz = o.aim.z;
    if (o.acquired && o.truth?.alive) { tx = o.truth.x; tz = o.truth.z; }
    const desired = Math.atan2(tx - o.x, tz - o.z);
    o.heading = wrapAngle(o.heading + clamp(angDiff(o.heading, desired), -0.12 * dt, 0.12 * dt));
    const step = o.speed * dt;
    o.x += Math.sin(o.heading) * step;
    o.z += Math.cos(o.heading) * step;
    o.distance += step;
    o.alt = clamp(o.alt + (o.acquired ? ((o.truth?.isSub ? o.truth.alt : -8) - o.alt) * dt * 0.3 : 0), -300, -5);

    if (!o.acquired) {
      // Wire guidance: while the firing boat still holds the track it can steer
      // the fish. Cut the wire (or lose the track) and it is on its own.
      if (def.wireGuided && o.track && o.shooter?.alive && (now - o.track.lastUpdate) < 60) {
        const tof = Math.hypot(o.track.x - o.x, o.track.z - o.z) / Math.max(5, o.speed);
        const p = o.track.predictAt(tof);
        o.aim.x = p.x; o.aim.z = p.z;
        o.midcourseUpdates++;
      }
      const sr = def.seekerRange || 2000;
      for (const u of this.world.units) {
        if (!u.alive || u.side === o.side || u.isAir) continue;
        const d = Math.hypot(u.x - o.x, u.z - o.z);
        if (d < sr) {
          // Wake-homers ignore acoustic decoys and follow the churn instead.
          o.acquired = true; o.truth = u;
          this.events.push({ kind: 'ACQUIRE', ord: o, target: u, t: now });
          break;
        }
      }
    } else if (o.truth) {
      const d = Math.hypot(o.truth.x - o.x, o.truth.z - o.z);
      if (d < 90) {
        o.kill('HIT');
        // A torpedo under the keel is a structural event, not a fragment hit —
        // it stays far more lethal than a missile of the same warhead weight.
        const disp = Math.max(800, o.truth.cls.displacement || 6000);
        const tScale = clamp(Math.sqrt((def.warhead || 250) / 200) * Math.pow(9000 / disp, 0.28), 0.5, 2.4);
        const dmg = (o.truth.maxHp * 0.60) * tScale * (0.8 + rng.next() * 0.5);
        const killed = o.truth.applyDamage(dmg, 'TORPEDO');
        this.events.push({ kind: 'HIT', ord: o, target: o.truth, t: now, damage: dmg, killed, torpedo: true, x: o.x, z: o.z });
        return;
      }
    }
    if (o.distance > def.range || o.age > 2400) { o.kill('SPENT'); }
  }

  _decoy(o, dt, now) {
    o.speed = 0;
    o.age += 0;
    if (o.age > 90) o.kill('EXPIRED');
  }

  drain() { const e = this.events; this.events = []; return e; }
}
