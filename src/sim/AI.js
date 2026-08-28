import { EMCON, ROE, IDENT, DOMAIN, SIDE, clamp, Rng, WEAPONS_QUALITY_TQ, NM } from './constants.js';
import { weapon } from './weapons.db.js';

const rng = new Rng(31337);

/*
 * The opposing commander.
 *
 * He is playing the same game you are, with the same physics, and he is
 * deliberately legible: he searches, he waits until he has a weapons-quality
 * track, he shoots his whole magazine at once, and he goes loud only when going
 * loud buys him something. If you can read what he is doing from your ESM
 * picture, you can beat him — and reading it is the lesson.
 */
export class RedCommander {
  constructor(world) {
    this.world = world;
    this.phase = 'SEARCH';
    this.lastStrike = -9999;
    this.lastReview = 0;
    this.strikesLaunched = 0;
    this.bombersScrambled = false;
    this.datumAge = 0;
    this.log = [];
    this.emconPolicy = EMCON.PASSIVE;
    this.searchStarted = false;
  }

  step(dt, now) {
    if (now - this.lastReview < 5) return;
    const d = now - this.lastReview;
    this.lastReview = now;
    const w = this.world;
    const table = w.picture(SIDE.RED);
    const red = w.units.filter(u => u.alive && u.side === SIDE.RED);
    if (!red.length) return;

    // Best available picture of the enemy task force
    const targets = table.list.filter(t =>
      !t.faded && t.identity === IDENT.HOSTILE &&
      (t.domain === DOMAIN.SURFACE) && (now - t.lastUpdate) < 900);
    const best = targets.sort((a, b) => (b.tq - a.tq) || (a.sigma - b.sigma))[0] || null;

    this._classify(table, now);
    this._runSearch(red, now, best);
    this._runEmcon(red, now, best, targets);
    this._runSAG(red, now, best);
    this._runSub(red, now, table);
    this._runBombers(red, now, best);
    this._runStrike(red, now, best, targets);
    this._runReturn(red, now);
  }

  /**
   * Identification by association and behaviour.
   *
   * Without this the opposing commander is paralysed: a task force in EMCON
   * ALPHA radiates nothing, so his ESM has no fingerprint to match, and a radar
   * return alone tells him a ship's size but not whose it is. He would hold six
   * unidentified surface contacts forever and never shoot — which is neither
   * realistic nor playable.
   *
   * What a real commander does is exactly what this does: a group of large
   * contacts, in company, holding formation at twenty knots, inside his declared
   * operating area, is a warship formation whatever it refuses to say about
   * itself. Merchants do not steam in company at that speed. He also stops
   * asking politely the moment somebody shoots at him.
   */
  _classify(table, now) {
    const w = this.world;
    const candidates = table.list.filter(t =>
      !t.own && !t.faded && t.domain === DOMAIN.SURFACE &&
      (t.identity === IDENT.PENDING || t.identity === IDENT.UNKNOWN) &&
      !t.identityLocked && t.tq >= 3 && (now - t.created) > 300);
    for (const t of candidates) {
      // Speed has to be SUSTAINED, not a single noisy estimate. A merchant on a
      // sloppy track will read twenty knots for one update, and a commander who
      // shoots on that will spend his magazines on container ships — which is
      // exactly what this AI used to do, killing more than half the neutral
      // shipping in the box every run.
      t._spdHist = t._spdHist === undefined ? t.speedEst : t._spdHist * 0.82 + t.speedEst * 0.18;
      const fast = t._spdHist > 9.0;                       // ~17.5 kt sustained
      // And formation means a GROUP: two other hulls holding station on it.
      const company = candidates.filter(o => o !== t &&
        Math.hypot(o.x - t.x, o.z - t.z) < 45000).length >= 2;
      // Being shot at makes a commander less patient, but it does not make a
      // trawler into a destroyer. It lowers the bar; it does not remove it.
      const provoked = w.blueStrikeDetected && fast;
      // Kinematic classification needs a track good enough to trust the
      // kinematics. Calling a formation off a TQ3 estimate is how a commander
      // ends up shooting at a shipping lane.
      const solid = t.tq >= 4;
      if ((fast && company && solid) || (provoked && solid)) {
        t.identity = IDENT.HOSTILE;
        if (!this._saidClassify) {
          this._saidClassify = true;
          this.say('Hostile commander has classified the formation as a warship group.', now);
        }
      }
    }
  }

  say(text, now) {
    this.log.push({ t: now, text });
    if (this.log.length > 40) this.log.shift();
  }

  _runSearch(red, now, best) {
    for (const u of red) {
      if (u.type !== 'MPA') continue;
      if (!u.patrol && !u.waypoints.length) {
        const box = this.world.scenario.redSearchBox;
        u.setSearchPattern(box.x, box.z, box.w, box.h, box.axis ?? 0, 62000);
        u.setEmcon(EMCON.FULL);          // a scout that will not radiate is a tourist
        this.searchStarted = true;
      }
      // Once the SAG has a good track the scout closes to keep custody.
      if (best && best.tq >= 3 && !best.faded) {
        const d = Math.hypot(best.x - u.x, best.z - u.z);
        if (d > 220000) {
          u.waypoints.length = 0;
          u.patrol = null;
          u.orderWaypoint(best.x, best.z, { speed: u.cls.maxSpeed * 0.85 });
        } else if (d < 150000) {
          u.setOrbit(best.x - Math.sin(u.heading) * 140000, best.z - Math.cos(u.heading) * 140000, 30000);
        }
      }
    }
  }

  _runEmcon(red, now, best, targets) {
    // Doctrine: stay quiet until a scout finds something, then light up the SAG's
    // big air-search radars because from that point survival matters more than
    // stealth. Exactly the trade the player has to make in the other direction.
    let policy = EMCON.PASSIVE;
    if (best && best.tq >= 2) policy = EMCON.FULL;
    if (this.world.blueStrikeDetected) policy = EMCON.FULL;
    if (policy !== this.emconPolicy) {
      this.emconPolicy = policy;
      this.say(policy === EMCON.FULL ? 'Hostile SAG has gone active — all radars radiating.' : 'Hostile SAG has gone quiet.', now);
    }
    for (const u of red) {
      if (u.type === 'MPA' || u.type === 'BOMBER') continue;
      if (u.isSub) continue;
      u.setEmcon(policy);
      u.ordered.roe = ROE.FREE;
    }
  }

  _runSAG(red, now, best) {
    const sag = red.filter(u => u.domain === DOMAIN.SURFACE);
    if (!sag.length) return;
    const guide = sag.find(u => u.type === 'CG') || sag[0];
    // Escorts screen the cruiser.
    let i = 0;
    for (const u of sag) {
      if (u === guide) continue;
      if (!u.station) {
        const slots = [[-0.9, 9000], [0.9, 9000], [0, 14000], [Math.PI, 11000]];
        const s = slots[i % slots.length];
        u.station = { guide, relBearing: s[0], range: s[1] };
      }
      i++;
    }
    // The cruiser advances on the best track but stops short of its own missile
    // range — it wants to shoot from outside the enemy's reach, not brawl.
    if (guide.station) guide.station = null;
    if (best && !best.faded) {
      const d = Math.hypot(best.x - guide.x, best.z - guide.z);
      const standoff = 300000;
      if (d > standoff) {
        guide.orderWaypoint(best.x, best.z, { speed: guide.cls.maxSpeed * 0.75 });
      } else if (d < standoff * 0.8) {
        const away = Math.atan2(guide.x - best.x, guide.z - best.z);
        guide.orderCourse(away, guide.cls.maxSpeed * 0.55);
      } else if (!guide.patrol) {
        guide.setOrbit(guide.x, guide.z, 22000);
      }
    } else if (!guide.patrol || guide.patrol.type !== 'BARRIER') {
      // No contact: hold the barrier. The group is here to deny an approach, not
      // to go looking — that is what the maritime patrol aircraft is for.
      const p = this.world.scenario.redPatrol;
      guide.setBarrier(p.ax, p.az, p.bx, p.bz, guide.cls.maxSpeed * 0.45);
    }
  }

  _runSub(red, now, table) {
    for (const u of red) {
      if (!u.isSub) continue;
      u.ordered.roe = ROE.FREE;
      const targets = table.list.filter(t => !t.faded && t.identity === IDENT.HOSTILE
        && t.domain === DOMAIN.SURFACE && (now - t.lastUpdate) < 1200);
      // Prefer the high value unit, exactly as a real skipper would.
      const prize = targets.sort((a, b) => {
        const av = (a.truthRef?.hvu ? 2 : 0) + a.tq * 0.2;
        const bv = (b.truthRef?.hvu ? 2 : 0) + b.tq * 0.2;
        return bv - av;
      })[0];
      if (!prize) {
        if (!u.patrol && !u.waypoints.length) {
          const b = this.world.scenario.redSubBarrier;
          u.setBarrier(b.ax, b.az, b.bx, b.bz, 4.0);
          u.depthOrdered = -140;
        }
        continue;
      }
      const d = Math.hypot(prize.x - u.x, prize.z - u.z);
      if (d > 60000) {
        // Sprint and drift: run fast to close, then slow to listen. Loud, then deaf.
        u.orderWaypoint(prize.x, prize.z, { speed: (u._sprint = !u._sprint) ? u.cls.maxSpeed * 0.75 : 4.0 });
        u.depthOrdered = -160;
      } else if (d > 22000) {
        u.orderWaypoint(prize.x, prize.z, { speed: 5.5 });
        u.depthOrdered = -90;
        if (prize.tq >= WEAPONS_QUALITY_TQ && u.ammo('KALIBR') > 0 && now - (u._lastShot || -999) > 300) {
          u._lastShot = now;
          const n = Math.min(4, u.ammo('KALIBR'));
          for (let k = 0; k < n; k++) this.world.ordnance.fire(u, 'KALIBR', prize);
          this.say('Hostile submarine has launched cruise missiles.', now);
        }
      } else if (d < 22000) {
        u.orderWaypoint(prize.x, prize.z, { speed: 6.5 });
        u.depthOrdered = -70;
        if (prize.tq >= 4 && u.ammo('TORP65') > 0 && now - (u._lastTorp || -999) > 240 && d < 18000) {
          u._lastTorp = now;
          for (let k = 0; k < 2; k++) this.world.ordnance.fire(u, 'TORP65', prize);
        }
      }
    }
  }

  _runBombers(red, now, best) {
    const bombers = red.filter(u => u.type === 'BOMBER');
    if (!bombers.length) return;
    for (const u of bombers) {
      if (u._committed) continue;
      if (!best || best.tq < 3) continue;
      u._committed = true;
      u.ordered.roe = ROE.FREE;
      u.setEmcon(EMCON.PASSIVE);
      u.orderWaypoint(best.x, best.z, { speed: u.cls.maxSpeed * 0.8, alt: 11000 });
      this.say('Bomber regiment has been vectored on your task force.', now);
    }
    for (const u of bombers) {
      if (!u._committed || u.ammo('KH32') <= 0) continue;
      const t = best;
      if (!t) continue;
      const d = Math.hypot(t.x - u.x, t.z - u.z);
      const def = weapon('KH32');
      if (d < def.range * 0.86 && t.tq >= WEAPONS_QUALITY_TQ) {
        const n = u.ammo('KH32');
        for (let k = 0; k < n; k++) this.world.ordnance.fire(u, 'KH32', t, { timeOnTop: now + d / def.speed + 30 });
        this.world.notifyRedStrike(u, n, 'KH32', now);
        // Turn for home the moment the pylons are empty.
        const home = this.world.scenario.redAirbase;
        u.orderWaypoint(home.x, home.z, { speed: u.cls.maxSpeed * 0.7, alt: 10000 });
      } else if (d < def.range * 1.4 && !u.radiating && t.tq < WEAPONS_QUALITY_TQ) {
        // Nobody has a good enough track: the bomber lights its own attack radar,
        // which is the moment your ESM picket earns its entire existence.
        u.setEmcon(EMCON.FULL);
      }
    }
  }

  _runStrike(red, now, best, targets) {
    if (!best || best.tq < WEAPONS_QUALITY_TQ) return;
    // Wave interval. A surface action group does not empty every launcher it
    // owns into one salvo and then sit there: it fires a wave, waits for the
    // scout's damage assessment, re-acquires and fires again. Modelling one
    // enormous alpha strike also made the fight a single unwinnable coin-flip
    // for the defender instead of four engagements they could actually manage.
    if (now - this.lastStrike < 1500) return;
    const shooters = red.filter(u => u.alive && u.domain === DOMAIN.SURFACE &&
      (u.ammo('VULKAN') > 0 || u.ammo('URAN') > 0));
    if (!shooters.length) return;

    // Pick the prize: the high value unit if it is held, otherwise the biggest
    // warship track. Sinking the amphib wins his war; sinking a destroyer does not.
    const prize = targets.filter(t => t.tq >= WEAPONS_QUALITY_TQ)
      .sort((a, b) => {
        const av = (a.truthRef?.hvu ? 3 : 1) * (a.tq / 6);
        const bv = (b.truthRef?.hvu ? 3 : 1) * (b.tq / 6);
        return bv - av;
      })[0] || best;

    let fired = 0;
    const WAVE_MAX = 14;                       // rounds committed per wave
    const arrival = now + Math.hypot(prize.x - shooters[0].x, prize.z - shooters[0].z) / weapon('VULKAN').speed + 90;
    for (const u of shooters) {
      if (fired >= WAVE_MAX) break;
      const d = Math.hypot(prize.x - u.x, prize.z - u.z);
      for (const wid of ['VULKAN', 'URAN']) {
        if (fired >= WAVE_MAX) break;
        if (!u.hasWeapon(wid)) continue;
        const def = weapon(wid);
        if (d > def.range * 0.9) continue;
        const salvo = Math.min(u.ammo(wid), wid === 'VULKAN' ? 8 : 4, WAVE_MAX - fired);
        for (let k = 0; k < salvo; k++) {
          this.world.ordnance.fire(u, wid, prize, { salvoId: `RED-${this.strikesLaunched}`, timeOnTop: arrival });
          fired++;
        }
      }
    }
    if (fired) {
      this.lastStrike = now;
      this.strikesLaunched++;
      this.world.notifyRedStrike(shooters[0], fired, 'VULKAN', now);
    }
  }

  _runReturn(red, now) {
    for (const u of red) {
      if (!u.isAir) continue;
      if (u.fuel < u.maxFuel * 0.22 && !u._rtb) {
        u._rtb = true;
        const home = this.world.scenario.redAirbase;
        u.waypoints.length = 0; u.patrol = null;
        u.orderWaypoint(home.x, home.z, { speed: u.cls.cruiseSpeed });
        u.setEmcon(EMCON.PASSIVE);
      }
      if (u._rtb) {
        const home = this.world.scenario.redAirbase;
        if (Math.hypot(home.x - u.x, home.z - u.z) < 25000) { u.alive = false; u.despawned = true; }
      }
      if (u.fuel <= 0) { u.alive = false; u.despawned = true; }
    }
  }
}

/**
 * Small amount of autonomy for BLUE aircraft so the player is commanding a task
 * force, not micro-managing fuel states.
 */
export class BlueAutonomy {
  constructor(world) { this.world = world; this.lastReview = 0; }

  step(dt, now) {
    if (now - this.lastReview < 4) return;
    this.lastReview = now;
    for (const u of this.world.units) {
      if (!u.alive || u.side !== SIDE.BLUE || !u.isAir) continue;
      this._flyMission(u, now);
      const bingo = u.maxFuel * (u.cls.helo ? 0.30 : 0.20);
      if (u.fuel < bingo && !u.rtb) {
        this._sendHome(u, now, 'BINGO fuel. Returning to base. Time on station expired.');
      }
      if (u.rtb) {
        const home = this._homeFor(u);
        if (home && Math.hypot(home.x - u.x, home.z - u.z) < (u.cls.helo ? 1200 : 30000)) {
          u.alive = false; u.despawned = true; u.recovered = true;
          // Into the groove. The deck takes the airframe back, holds the
          // catapults while she is on final, and then puts her in cooldown —
          // see FlightDeck.recover.
          if (u.deckFrame && home.deck) {
            home.deck.recover(u);
            home.deck._note(`${u.name} in the groove`);
          } else if (!u.cls.helo) {
            // Shore-based patrol and AEW stations are relieved, not abandoned.
            // Carrier aircraft are not: the player owns that deck.
            this.world.relieveOnStation(u);
          }
          this.world.onAircraftRecovered?.(u);
        }
      }
      if (u.fuel <= 0 && u.alive) {
        u.alive = false; u.despawned = true;
        if (u.deckFrame) u.homeBase?.deck?.lost(u);
        this.world.comms.push({ t: now, from: 'TF-44 OPS', priority: 'FLASH', text: `${u.name} is down — fuel exhaustion.` });
      }
    }
  }

  /**
   * Fly the mission the aircraft was tasked with.
   *
   * A strike aircraft is not a ship with wings. It goes out, it releases, and
   * the useful part of its life is over — everything after that is getting the
   * airframe back so it can be turned round. So this runs three beats:
   *
   *   INGRESS  steer at where the target will be, not where it was seen. Six
   *            minutes of flight against a cruiser doing twenty knots is four
   *            kilometres of lead, and the seeker basket is not that wide.
   *   RELEASE  inside about four fifths of the missile's reach, everything
   *            comes off the rails at once. A single aircraft dribbling shots
   *            is how you feed a defence one target at a time.
   *   EGRESS   turn away and go home. It has nothing left to contribute and it
   *            is now the most fragile thing in the sky.
   *
   * The aircraft shoots at a TRACK, with all the error that carries. If the
   * track is stale the missiles fly at a position the ship left ten minutes
   * ago, which is the honest outcome and the reason scouting matters.
   */
  _flyMission(u, now) {
    const trk = u.strikeTrack;
    if (!trk || u.rtb) return;

    if (trk.faded && now - trk.lastUpdate > 900) {
      this._sendHome(u, now, 'Lost the track. Nothing on the nose — going home with the load.');
      return;
    }

    const asm = (u.cls.weapons || [])
      .map(w => weapon(w.id))
      .filter(w => w && w.category === 'ASM' && u.ammo(w.id) > 0)
      .sort((a, b) => b.range - a.range)[0];
    if (!asm) { this._sendHome(u, now); return; }

    const range = Math.hypot(trk.x - u.x, trk.z - u.z);
    const tof = range / Math.max(60, asm.speed);
    const aim = trk.predictAt ? trk.predictAt(tof) : { x: trk.x, z: trk.z };

    /*
     * WHERE TO RELEASE is the whole judgement of a strike, and it is not a
     * fraction of the missile's range.
     *
     * LRASM will fly 560 km. It does not follow that a 560 km shot is a shot.
     * At 240 m/s that missile is in the air for thirty-nine minutes, and a
     * cruiser doing twenty knots goes twenty-four kilometres in that time — so
     * unless somebody is still watching her, the seeker arrives and searches an
     * empty piece of ocean. The binding constraint is not reach, it is whether
     * the target's position is still going to be inside the seeker's search
     * footprint when the missile gets there.
     *
     * The track's own Kalman covariance answers that. Position error grows as
     * sqrt(sigma_p^2 + (sigma_v * tof)^2); the seeker finds her if two sigma of
     * that still fits inside half the search width. Solve for the time of
     * flight that satisfies it and multiply by the missile's speed, and you get
     * a release range that falls straight out of how well the target is being
     * held.
     *
     * Which is the lesson: a weapons-quality track lets the package shoot from
     * two hundred miles and go home. A stale bearing-only fix makes it fly all
     * the way in and find the enemy itself — through whatever the enemy has put
     * up to stop exactly that.
     */
    const P = trk.P;
    const sigP = P ? Math.sqrt(Math.max(1, P[0])) : 4000;
    const sigV = P ? Math.sqrt(Math.max(0.25, P[10])) : 8;
    const half = (asm.seekerWidth || asm.seekerRange || 20000) * 0.5;
    // Two sigma inside the basket, and never claim more than the weapon's reach.
    const room = Math.sqrt(Math.max(0, (half / 2) ** 2 - sigP ** 2));
    const tofMax = room / Math.max(0.5, sigV);
    // The floor is where a strike aircraft stops being willing to press. Inside
    // about forty-five kilometres it is inside the area-defence envelope of
    // anything worth striking, and an aircraft that flies into an S-300 to
    // improve its firing solution has made a bad trade.
    const releaseAt = Math.min(asm.range * 0.85, Math.max(45000, tofMax * (asm.speed || 240)));
    u.releaseAt = releaseAt;

    /*
     * Going active on the run-in.
     *
     * A package cannot shoot at a track it cannot hold, and the covariance that
     * sets the release range above only shrinks if somebody is actually looking.
     * The aircraft ingresses passive — it has no wish to announce itself across
     * two hundred miles of ocean — and lights its own radar once it is close
     * enough for that radar to be worth the emission. From then on the strike is
     * refining its own targeting, the track tightens, the release range grows to
     * meet the aircraft, and it shoots without having to press any closer.
     *
     * That is also the moment the enemy's ESM hears it coming, which is the
     * price and is supposed to be.
     */
    if (range < 150000 && u.ordered.emcon !== EMCON.FULL) {
      u.setEmcon(EMCON.FULL);
      this.world.comms.push({
        t: now, from: u.name, priority: 'ROUTINE',
        text: 'Going active on the run-in — taking my own picture.',
      });
    }

    if (range < releaseAt) {
      let fired = 0;
      const salvo = this.world.ordnance.nextSalvoId ? this.world.ordnance.nextSalvoId() : now;
      for (const w of u.cls.weapons.slice()) {
        const def = weapon(w.id);
        if (!def || def.category !== 'ASM') continue;
        while (u.ammo(w.id) > 0) {
          const o = this.world.ordnance.fire(u, w.id, trk, { aim, salvoId: salvo });
          if (!o) break;
          fired++;
        }
      }
      if (fired) {
        this.world.comms.push({
          t: now, from: u.name, priority: 'FLASH',
          text: `Weapons away — ${fired} ${asm.name.split(' ').pop()} on ${trk.label || 'the surface contact'}. Off target, heading home.`,
        });
      }
      this._sendHome(u, now);
      return;
    }

    // Ingress. Re-aim every few seconds rather than every frame; the track only
    // moves when somebody looks at it.
    if (now - (u._ingressAt || 0) > 8) {
      u._ingressAt = now;
      u.waypoints.length = 0;
      u.patrol = null;
      u.orderWaypoint(aim.x, aim.z, { speed: u.cls.cruiseSpeed, alt: u.cls.cruiseAlt });
    }
  }

  /**
   * Turn an aircraft round and point it at the deck.
   *
   * This exists because it was originally three places. Bingo fuel set the
   * course home; releasing on a target and losing the track both set `rtb` and
   * nothing else — so a strike that had just shot its load kept flying the
   * ingress waypoint it had been given, straight into the ship it had shot at,
   * and the package died to the SAG's own air defences a few minutes after a
   * successful attack. From the outside it looked like the strike worked and
   * then the aircraft evaporated.
   */
  _sendHome(u, now, why) {
    if (u.rtb) return;
    u.rtb = true;
    u.strikeTrack = null;
    u.waypoints.length = 0;
    u.patrol = null;
    const home = this._homeFor(u);
    if (home) u.orderWaypoint(home.x, home.z, { speed: u.cls.cruiseSpeed, alt: u.cls.cruiseAlt });
    if (why) {
      this.world.comms.push({ t: now, from: u.name, priority: 'ROUTINE', text: why });
    }
  }

  _homeFor(u) {
    if (u.homeBase && u.homeBase.alive) return u.homeBase;
    if (u.cls.helo) {
      const deck = this.world.units.find(x => x.alive && x.side === u.side && x.cls.aircraft?.length);
      return deck || null;
    }
    return this.world.scenario.blueAirbase;
  }
}
