import { SIDE, DOMAIN, EMCON, ROE, NM, KNOT, clamp } from './constants.js';

/*
 * Signal traffic — the thing that turns a sandbox into a watch.
 *
 * A task force commander does not sit in silence looking at a plot. The circuit
 * is never quiet: the flagship's staff pushes fragmentary orders down, subordinate
 * COs push problems up, and the civilian world blunders through the middle of it
 * asking for help. Most of it is not about the enemy at all, and that is exactly
 * what makes the enemy's arrival matter when it comes.
 *
 * Every signal in here is TRIGGERED BY REAL STATE — a magazine that is actually
 * low, a hull that is actually damaged, a neutral that is actually inside the
 * screen, an aircraft that is actually short of fuel. Nothing fires on a timer
 * alone. And every choice has a mechanical consequence in the simulation, not
 * just a line of text: approving a replenishment really does take a destroyer out
 * of the screen for twenty minutes, and the hole it leaves is a real hole.
 *
 * A signal that needs an answer sits on the DECISION STACK with a deadline. Let
 * it expire and the subordinate does whatever their standing orders say, which is
 * usually the cautious thing and occasionally the wrong thing. Not answering is
 * itself a decision.
 */

let _sigN = 0;

export class Signal {
  constructor(o) {
    this.id = `SIG${String(++_sigN).padStart(3, '0')}`;
    this.kind = o.kind;
    this.from = o.from;
    this.priority = o.priority || 'ROUTINE';
    this.subject = o.subject || '';
    this.text = o.text;
    this.detail = o.detail || '';
    this.choices = o.choices || null;     // [{ key, label, hint, apply(world, sig) }]
    this.deadline = o.deadline || null;   // absolute sim time
    this.opened = o.opened;
    this.unit = o.unit || null;           // subject unit, if any
    this.track = o.track || null;
    this.resolved = false;
    this.answer = null;
    this.defaultKey = o.defaultKey || (o.choices ? o.choices[o.choices.length - 1].key : null);
    this.pin = o.pin || null;             // { x, z } to mark on the plot
  }

  get needsAnswer() { return !!this.choices && !this.resolved; }
  timeLeft(now) { return this.deadline === null ? Infinity : this.deadline - now; }
}

const MIN = 60;

/**
 * When the flag is going to talk to you, regardless of what your own captains
 * happen to be asking for at that moment.
 */
const SCHEDULED = [
  { kind: 'EMCON_WINDOW', at: 7 * MIN },
  { kind: 'WEAPONS_FREE', at: 22 * MIN },
  { kind: 'CONVOY', at: 40 * MIN },
];

export class SignalSystem {
  constructor(world) {
    this.world = world;
    this.active = [];          // signals awaiting an answer
    this.log = [];             // everything, newest last
    this.fired = new Set();    // one-shot keys
    this.cooldown = new Map(); // kind -> earliest next fire
    this._t = 0;
    this.standing = {
      // Theatre-level directives currently in force. The mission scorer reads these.
      emconWindow: null,       // { until, level } — comply or be marked down
      coverConvoy: null,       // { until, unitIds, point }
      intelBox: null,          // { until, x, z, r }
    };
    this.credit = 0;           // accumulated "did the right thing" score
    this.demerit = 0;
  }

  /** Fire at most one new signal per evaluation, so the stack never floods. */
  step(dt) {
    const w = this.world;
    const now = w.time;
    this._t += dt;

    // Expire anything the player let run out.
    for (const s of this.active) {
      if (s.resolved) continue;
      if (s.deadline !== null && now >= s.deadline) this.answer(s, s.defaultKey, true);
    }
    this.active = this.active.filter(s => !s.resolved);

    // Standing directives lapse.
    const st = this.standing;
    if (st.emconWindow && now > st.emconWindow.until) {
      this._judgeEmconWindow();
      st.emconWindow = null;
    }
    if (st.coverConvoy && now > st.coverConvoy.until) st.coverConvoy = null;
    if (st.intelBox && now > st.intelBox.until) {
      st.intelBox = null;
      this.push({
        kind: 'INTEL_STALE', from: 'CTF-40 INTEL', priority: 'ROUTINE',
        text: 'The cued box is stale now. Whatever put that emitter on the air has moved.',
      });
    }

    if (this._t < 11) return;
    this._t = 0;
    if (this.active.length >= 3) return;      // never more than three open decisions

    // Theatre-level traffic is SCHEDULED, not entered into the lottery. Left to
    // compete with the subordinates' requests, the fragmentary orders never got
    // a turn at all — over a seven-hour run the player heard from three
    // generators and never once from CTF-40, which is the opposite of the point.
    const el = now - w.startedAt;
    for (const beat of SCHEDULED) {
      if (el < beat.at || this.fired.has(`sched:${beat.kind}`)) continue;
      const gen = GENERATORS.find(g => g.kind === beat.kind);
      if (!gen) continue;
      const sig = gen.check(this, w, now);
      if (!sig) continue;
      this.fired.add(`sched:${beat.kind}`);
      this.cooldown.set(gen.kind, now + 1e9);
      this.push(sig);
      return;
    }

    // Walk the generators from a rotating start so a cheap, frequently-eligible
    // signal near the top of the list cannot starve the expensive ones at the
    // bottom — the theatre-level orders were never getting a turn.
    this._rot = ((this._rot || 0) + 1) % GENERATORS.length;
    for (let i = 0; i < GENERATORS.length; i++) {
      const gen = GENERATORS[(this._rot + i) % GENERATORS.length];
      if (!this._ready(gen.kind, now, gen.cooldown)) continue;
      const sig = gen.check(this, w, now);
      if (sig) {
        this.cooldown.set(gen.kind, now + (gen.cooldown || 600));
        this.push(sig);
        return;
      }
    }
  }

  _ready(kind, now, cd) {
    const t = this.cooldown.get(kind);
    return t === undefined || now >= t;
  }

  once(key) {
    if (this.fired.has(key)) return false;
    this.fired.add(key);
    return true;
  }

  push(o) {
    const w = this.world;
    const s = o instanceof Signal ? o : new Signal({ ...o, opened: w.time });
    if (s.choices && s.deadline === null) s.deadline = w.time + (o.window || 240);
    this.log.push(s);
    if (s.needsAnswer) this.active.push(s);
    w.comms.push({
      t: w.time, from: s.from, priority: s.priority, text: s.text,
      signalId: s.needsAnswer ? s.id : null,
    });
    w.emit({ type: 'SIGNAL', signal: s });
    return s;
  }

  /** Resolve a decision. `expired` marks it as having timed out rather than been chosen. */
  answer(sig, key, expired = false) {
    if (!sig || sig.resolved) return;
    const c = (sig.choices || []).find(x => x.key === key) || (sig.choices || [])[0];
    sig.resolved = true;
    sig.answer = c ? c.key : null;
    sig.expired = expired;
    if (c && c.apply) {
      try { c.apply(this.world, sig, this); } catch (e) { /* a bad option must not kill the sim */ }
    }
    if (c && c.credit) this.credit += c.credit;
    if (c && c.demerit) this.demerit += c.demerit;
    if (expired) {
      this.world.comms.push({
        t: this.world.time, from: sig.unit ? sig.unit.name : sig.from, priority: 'ROUTINE',
        text: c && c.onExpire ? c.onExpire : 'No answer from the flag. Proceeding on standing orders.',
      });
    } else if (c && c.reply) {
      this.world.comms.push({
        t: this.world.time, from: sig.unit ? sig.unit.name : sig.from,
        priority: 'ROUTINE', text: c.reply,
      });
    }
    this.world.emit({ type: 'SIGNAL_ANSWERED', signal: sig, choice: c, expired });
  }

  byId(id) { return this.active.find(s => s.id === id) || this.log.find(s => s.id === id); }

  _judgeEmconWindow() {
    const w = this.world;
    const win = this.standing.emconWindow;
    if (!win) return;
    if (win.violated) {
      this.demerit += 1;
      this.push({
        kind: 'EMCON_JUDGE', from: 'CTF-40', priority: 'PRIORITY',
        text: 'Your radiators were up inside the quiet window. The collection pass is a write-off and the Volsk ESM operators had a free look at you.',
      });
    } else {
      this.credit += 1;
      this.push({
        kind: 'EMCON_JUDGE', from: 'CTF-40 INTEL', priority: 'PRIORITY',
        text: 'Quiet window complete, and the pass produced. Cueing you now — stand by for a datum.',
      });
      // The reward is real: a cued box on the SAG.
      const sag = w.units.filter(u => u.side === SIDE.RED && u.domain === DOMAIN.SURFACE && u.alive);
      if (sag.length) {
        const c = sag[Math.floor(sag.length / 2)];
        const jitter = 26000;
        this.standing.intelBox = {
          until: w.time + 45 * MIN,
          x: c.x + (w.rng.next() - 0.5) * jitter,
          z: c.z + (w.rng.next() - 0.5) * jitter,
          r: 34000,
        };
        this.push({
          kind: 'INTEL_CUE', from: 'CTF-40 INTEL', priority: 'FLASH',
          text: 'Cued datum on the plot. Emitter consistent with a Volna-class fire control set, thirty-four kilometre uncertainty, good for the next forty-five minutes.',
          pin: { x: this.standing.intelBox.x, z: this.standing.intelBox.z },
        });
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Generators. Each inspects real world state and returns a Signal or null.
// ───────────────────────────────────────────────────────────────────────────

const blueCombatants = (w) => w.units.filter(u =>
  u.alive && u.side === SIDE.BLUE && !u.isAir && !u.isSub && !u.hvu && !u.cls.softHvu);

function magFraction(u) {
  let worst = 1;
  for (const wd of u.cls.weapons || []) {
    const max = u.magsMax[wd.id] || 1;
    if (max < 4) continue;
    worst = Math.min(worst, (u.mags[wd.id] || 0) / max);
  }
  return worst;
}

export const GENERATORS = [
  // ── replenishment ────────────────────────────────────────────────────────
  {
    kind: 'RAS', cooldown: 25 * MIN,
    check(sys, w, now) {
      const oiler = w.units.find(u => u.alive && u.side === SIDE.BLUE && u.cls.softHvu);
      if (!oiler) return null;
      const cand = blueCombatants(w).find(u => magFraction(u) < 0.34 && !u._rasUntil);
      if (!cand) return null;
      return new Signal({
        kind: 'RAS', from: cand.name, unit: cand, priority: 'PRIORITY', opened: now,
        subject: 'REQUEST TO DETACH FOR REPLENISHMENT',
        text: `${cand.name} is down to ${Math.round(magFraction(cand) * 100)} percent on her heaviest magazine. Request permission to detach and go alongside ${oiler.name} for a vertical replenishment.`,
        detail: 'Twenty minutes off the screen. She comes back with full cells; until then that is one less shooter and one less SAM engagement channel.',
        window: 300,
        choices: [
          {
            key: 'APPROVE', label: 'APPROVE — DETACH FOR RAS',
            hint: 'Full magazines in ~20 min. She is out of the screen until then.',
            reply: 'Detaching to close the oiler. Twenty minutes.',
            credit: 1,
            apply(world, sig) {
              const u = sig.unit, o = world.units.find(x => x.alive && x.cls.softHvu);
              if (!u || !o) return;
              u._rasUntil = world.time + 20 * MIN;
              u.station = null; u.patrol = null;
              u.orderWaypoint(o.x + 900, o.z - 900, { speed: u.cls.maxSpeed * 0.6 });
            },
          },
          {
            key: 'HOLD', label: 'DENY — HOLD STATION',
            hint: 'Keeps the screen intact. She fights with what she has.',
            reply: 'Holding station. We will make do.',
            onExpire: 'No word from the flag. Holding station with what we have.',
          },
        ],
      });
    },
  },

  // ── subsurface contact the escort cannot classify ────────────────────────
  {
    kind: 'PROSECUTE', cooldown: 14 * MIN,
    check(sys, w, now) {
      const table = w.picture(SIDE.BLUE);
      const sub = table.list.find(t => !t.faded && t.domain === DOMAIN.SUBSURFACE
        && t.tq >= 2 && now - t.lastUpdate < 200);
      if (!sub) return null;
      const holder = blueCombatants(w)
        .map(u => ({ u, d: Math.hypot(u.x - sub.x, u.z - sub.z) }))
        .sort((a, b) => a.d - b.d)[0];
      if (!holder || holder.d > 60000) return null;
      const u = holder.u;
      const nm = (holder.d / NM).toFixed(0);
      return new Signal({
        kind: 'PROSECUTE', from: u.name, unit: u, track: sub, priority: 'FLASH', opened: now,
        subject: 'SUBSURFACE CONTACT — REQUEST INTENTIONS',
        text: `${u.name} holds a subsurface contact, ${nm} miles, track quality ${sub.tq}. Classification is ambiguous. Request intentions.`,
        detail: 'A torpedo run from a boat you have not localised is the fastest way to lose a high value unit. Prosecuting costs you a hull off the screen and announces that you know he is there.',
        window: 220,
        pin: { x: sub.x, z: sub.z },
        choices: [
          {
            key: 'DETACH', label: 'DETACH TO PROSECUTE',
            hint: 'She leaves the screen and runs the datum down. Best chance of a kill.',
            reply: 'Detaching to prosecute. Going active on the bow array.',
            credit: 1,
            apply(world, sig) {
              const u = sig.unit; if (!u) return;
              u.station = null;
              u.ordered.emcon = EMCON.FULL;
              u.orderWaypoint(sig.track.x, sig.track.z, { speed: u.cls.maxSpeed * 0.75 });
              u._prosecuting = world.time + 15 * MIN;
            },
          },
          {
            key: 'HELO', label: 'LAUNCH THE HELO INSTEAD',
            hint: 'Keeps the screen intact. Slower, but the dipping sonar is the better sensor.',
            reply: 'Launching the alert helo to the datum.',
            credit: 1,
            apply(world, sig) {
              const u = sig.unit; if (!u) return;
              const h = world.launchAircraft(u, 'MH60R');
              if (h) { h.setDip?.(sig.track.x, sig.track.z); h.ordered.emcon = EMCON.RESTRICTED; }
            },
          },
          {
            key: 'HOLD', label: 'MAINTAIN CUSTODY ONLY',
            hint: 'Nobody leaves the screen. You keep the track and hope it stays a track.',
            reply: 'Maintaining passive custody. Nothing radiating.',
            onExpire: 'No answer. Maintaining passive custody per standing orders.',
          },
        ],
      });
    },
  },

  // ── a neutral inside the screen ──────────────────────────────────────────
  {
    kind: 'NEUTRAL_CLOSE', cooldown: 12 * MIN,
    check(sys, w, now) {
      const hvu = w.units.find(u => u.alive && u.hvu);
      if (!hvu) return null;
      const n = w.units.find(u => u.alive && u.side === SIDE.NEUTRAL
        && Math.hypot(u.x - hvu.x, u.z - hvu.z) < 26000 && !u._warned);
      if (!n) return null;
      const nm = (Math.hypot(n.x - hvu.x, n.z - hvu.z) / NM).toFixed(0);
      return new Signal({
        kind: 'NEUTRAL_CLOSE', from: 'TF-44 TAO', unit: n, priority: 'PRIORITY', opened: now,
        subject: 'NEUTRAL CONTACT INSIDE THE SCREEN',
        text: `A neutral merchant is ${nm} miles from ${hvu.name} and still closing. He has no idea we are here.`,
        detail: 'A hull that close masks anything behind it and will absorb a missile meant for us. Warning him off means transmitting.',
        window: 260,
        pin: { x: n.x, z: n.z },
        choices: [
          {
            key: 'WARN', label: 'WARN HIM OFF (BRIDGE-TO-BRIDGE)',
            hint: 'He alters away. Anyone listening on channel 16 now knows a warship is here.',
            reply: 'Bridge to bridge, warning him clear of our track.',
            credit: 1,
            apply(world, sig) {
              const n2 = sig.unit; if (!n2) return;
              n2._warned = true;
              const g = world.blueGuide;
              const away = Math.atan2(n2.x - g.x, n2.z - g.z);
              n2.orderWaypoint(n2.x + Math.sin(away) * 90000, n2.z + Math.cos(away) * 90000,
                { speed: n2.cls.cruiseSpeed });
              // Transmitting on a marine band is not free.
              world.sensors._raise?.('EMIT', g, null, world.time, 'bridge-to-bridge transmission');
            },
          },
          {
            key: 'SHOULDER', label: 'SHOULDER HIM OUT — SEND AN ESCORT',
            hint: 'Silent. Costs you a hull off the screen for ten minutes.',
            reply: 'Detaching an escort to shoulder him clear.',
            credit: 1,
            apply(world, sig) {
              const n2 = sig.unit; if (!n2) return;
              n2._warned = true;
              const esc = blueCombatants(world)[0];
              if (esc) { esc.station = null; esc.orderWaypoint(n2.x, n2.z, { speed: esc.cls.maxSpeed * 0.7 }); }
            },
          },
          {
            key: 'IGNORE', label: 'LET HIM PASS',
            hint: 'Costs nothing now. He is inside your envelope when the missiles arrive.',
            onExpire: 'Neutral passing down our port side, no action taken.',
            demerit: 1,
          },
        ],
      });
    },
  },

  // ── civilian distress ────────────────────────────────────────────────────
  {
    kind: 'DISTRESS', cooldown: 30 * MIN,
    check(sys, w, now) {
      if (now - w.startedAt < 8 * MIN) return null;
      const n = w.units.find(u => u.alive && u.side === SIDE.NEUTRAL && !u._distress
        && Math.hypot(u.x - w.blueGuide.x, u.z - w.blueGuide.z) < 140000);
      if (!n) return null;
      if (w.rng.next() > 0.55) return null;
      n._distress = true;
      const kinds = [
        'has a man overboard and no boat that will start',
        'is reporting an engine-room fire and asking for anyone who can close',
        'has lost steering and is broaching in the swell',
      ];
      const what = kinds[Math.floor(w.rng.next() * kinds.length)];
      return new Signal({
        kind: 'DISTRESS', from: 'MAYDAY RELAY', unit: n, priority: 'FLASH', opened: now,
        subject: 'MAYDAY — CIVILIAN VESSEL',
        text: `Mayday relay on 2182. A civilian vessel ${what}, ${(Math.hypot(n.x - w.blueGuide.x, n.z - w.blueGuide.z) / NM).toFixed(0)} miles from us. We are the closest hull in the Kestrel Sea.`,
        detail: 'You are under no operational obligation. You are under every other kind.',
        window: 300,
        pin: { x: n.x, z: n.z },
        choices: [
          {
            key: 'DIVERT', label: 'DIVERT AN ESCORT',
            hint: 'Right thing. One hull off the screen for a while, and you will have to transmit.',
            reply: 'Detaching to render assistance. We will have her alongside in the hour.',
            credit: 3,
            apply(world, sig) {
              const esc = blueCombatants(world).sort((a, b) =>
                Math.hypot(a.x - sig.unit.x, a.z - sig.unit.z) - Math.hypot(b.x - sig.unit.x, b.z - sig.unit.z))[0];
              if (!esc) return;
              esc.station = null; esc.patrol = null;
              esc.orderWaypoint(sig.unit.x, sig.unit.z, { speed: esc.cls.maxSpeed * 0.85 });
              esc._sarUntil = world.time + 22 * MIN;
              sig.unit.ordered.speed = 0;
            },
          },
          {
            key: 'HELO', label: 'SEND A HELO',
            hint: 'Faster, keeps the screen intact, less capable if she is actually sinking.',
            reply: 'Alert helo launching for the SAR.',
            credit: 2,
            apply(world, sig) {
              const base = blueCombatants(world).find(u => (u.cls.aircraft || []).length);
              const h = base && world.launchAircraft(base, 'MH60R');
              if (h) h.setOrbit(sig.unit.x, sig.unit.z, 3000);
            },
          },
          {
            key: 'RELAY', label: 'RELAY TO RESCUE COORDINATION',
            hint: 'Costs nothing. Nobody else is within two hundred miles.',
            reply: 'Relaying the mayday to the rescue coordination centre.',
            onExpire: 'Mayday relayed onward. No unit assigned.',
            demerit: 1,
          },
        ],
      });
    },
  },

  // ── theatre EMCON window ─────────────────────────────────────────────────
  {
    kind: 'EMCON_WINDOW', cooldown: 40 * MIN,
    check(sys, w, now) {
      if (now - w.startedAt < 6 * MIN) return null;
      // once() CONSUMES the flag, so it has to be the last guard. Calling it
      // first meant an early ineligible pass burned the one-shot and CTF-40
      // never spoke for the rest of the mission.
      if (!sys.once('EMCON_WINDOW')) return null;
      return new Signal({
        kind: 'EMCON_WINDOW', from: 'CTF-40', priority: 'FLASH', opened: now,
        subject: 'FRAGO 01 — EMISSION CONTROL WINDOW',
        text: 'A national asset is on task over your operating area for the next twenty minutes. All units EMCON ALPHA for the duration. If you light up you will burn the pass.',
        detail: 'Comply and Intel will cue you a datum on the SAG. Radiate anyway and you get nothing, and the Volsk ESM operators get a bearing.',
        window: 200,
        choices: [
          {
            key: 'WILCO', label: 'WILCO — SET EMCON ALPHA',
            hint: 'Everything goes quiet for 20 minutes. You are blind, and then you are cued.',
            reply: 'Wilco. All units EMCON ALPHA.',
            credit: 1,
            apply(world, sig, sys2) {
              sys2.standing.emconWindow = { until: world.time + 20 * MIN, violated: false };
              for (const u of world.units) {
                if (u.side === SIDE.BLUE && u.alive) u.ordered.emcon = EMCON.SILENT;
              }
            },
          },
          {
            key: 'ACK', label: 'ACKNOWLEDGE — KEEP THE PICTURE',
            hint: 'You keep your sensors. The pass is wasted and CTF-40 will notice.',
            reply: 'Acknowledged. We are holding our own picture.',
            demerit: 1,
            apply(world, sig, sys2) {
              sys2.standing.emconWindow = { until: world.time + 20 * MIN, violated: true };
            },
          },
        ],
      });
    },
  },

  // ── the shadower ─────────────────────────────────────────────────────────
  {
    kind: 'SHADOWER', cooldown: 18 * MIN,
    check(sys, w, now) {
      const g = w.blueGuide;
      const bear = w.units.find(u => u.alive && u.side === SIDE.RED && u.isAir
        && Math.hypot(u.x - g.x, u.z - g.z) < 130000);
      if (!bear) return null;
      const nm = (Math.hypot(bear.x - g.x, bear.z - g.z) / NM).toFixed(0);
      return new Signal({
        kind: 'SHADOWER', from: 'TF-44 TAO', unit: bear, priority: 'FLASH', opened: now,
        subject: 'HOSTILE MARITIME PATROL AIRCRAFT SHADOWING',
        text: `A Volsk maritime patrol aircraft is holding station ${nm} miles off our starboard quarter. He is not here to look at the weather — he is a targeting cue for a cruiser we have not found yet.`,
        detail: 'Killing him means going active with fire control, which tells the SAG exactly where you are. Leaving him means the SAG shoots first.',
        window: 240,
        pin: { x: bear.x, z: bear.z },
        choices: [
          {
            key: 'ENGAGE', label: 'TAKE THE SHOT',
            hint: 'You lose the shadower and your EMCON in the same minute.',
            reply: 'Illuminating. Birds away.',
            apply(world, sig) {
              const shooter = blueCombatants(world)
                .filter(u => u.ammo('SM2') > 0)
                .sort((a, b) => Math.hypot(a.x - sig.unit.x, a.z - sig.unit.z)
                  - Math.hypot(b.x - sig.unit.x, b.z - sig.unit.z))[0];
              if (!shooter) return;
              shooter.ordered.emcon = EMCON.FULL;
              shooter.ordered.roe = ROE.FREE;
            },
          },
          {
            key: 'DECEIVE', label: 'ALTER COURSE UNDER HIS NOSE',
            hint: 'Silent. He keeps a stale picture, and the SAG shoots at where you were.',
            reply: 'Coming ninety degrees to port, no emissions.',
            credit: 1,
            apply(world, sig) {
              const g2 = world.blueGuide;
              const h = g2.heading + Math.PI / 2;
              for (const u of world.units) {
                if (u.side !== SIDE.BLUE || !u.alive || u.isAir || u.isSub) continue;
                u.ordered.heading = h;
                u.ordered.emcon = EMCON.SILENT;
              }
            },
          },
          {
            key: 'IGNORE', label: 'LET HIM WATCH',
            hint: 'He reports your course, speed and composition every four minutes.',
            onExpire: 'Shadower still with us. He has our base course by now.',
            demerit: 1,
          },
        ],
      });
    },
  },

  // ── friendly convoy in the box ───────────────────────────────────────────
  {
    kind: 'CONVOY', cooldown: 45 * MIN,
    check(sys, w, now) {
      if (now - w.startedAt < 20 * MIN) return null;
      if (!sys.once('CONVOY')) return null;
      const g = w.blueGuide;
      const px = g.x + 70000, pz = g.z + 120000;
      return new Signal({
        kind: 'CONVOY', from: 'CTF-40', priority: 'PRIORITY', opened: now,
        subject: 'FRAGO 02 — COVER FOR CONVOY KESTREL SIERRA',
        text: 'Convoy KESTREL SIERRA — three hulls, no escort — is transiting your box northbound for the next half hour. You are the only cover they have.',
        detail: 'Nothing about your primary mission changes. This is one more thing to hold in your head, which is the job.',
        window: 240,
        pin: { x: px, z: pz },
        choices: [
          {
            key: 'WILCO', label: 'WILCO — ASSIGN A PICKET',
            hint: 'One escort covers their track for 30 minutes.',
            reply: 'Wilco. Detaching a picket to cover the convoy track.',
            credit: 2,
            apply(world, sig, sys2) {
              sys2.standing.coverConvoy = { until: world.time + 30 * MIN, point: sig.pin };
              const esc = blueCombatants(world).slice(-1)[0];
              if (esc) { esc.station = null; esc.setBarrier?.(sig.pin.x - 30000, sig.pin.z, sig.pin.x + 30000, sig.pin.z, 9); }
            },
          },
          {
            key: 'UNABLE', label: 'UNABLE — MISSION PRIORITY',
            hint: 'Honest, and defensible. It will be in the record.',
            reply: 'Unable. We are committed to the landing force.',
            onExpire: 'No reply passed. Convoy transiting unescorted.',
          },
        ],
      });
    },
  },

  // ── an aircraft at bingo ─────────────────────────────────────────────────
  {
    kind: 'BINGO', cooldown: 8 * MIN,
    check(sys, w, now) {
      const a = w.units.find(u => u.alive && u.isAir && u.side === SIDE.BLUE
        && u.maxFuel > 0 && u.fuel / u.maxFuel < 0.22 && !u._bingoAsked);
      if (!a) return null;
      a._bingoAsked = true;
      return new Signal({
        kind: 'BINGO', from: a.name, unit: a, priority: 'PRIORITY', opened: now,
        subject: 'BINGO FUEL',
        text: `${a.name} is at bingo. Request to detach for home plate — or say the word and I will stretch it.`,
        detail: 'A relief airframe is roughly forty minutes out from the moment you release this one. Stretching it buys you fifteen more minutes of coverage and risks losing the aircraft.',
        window: 200,
        choices: [
          {
            key: 'RTB', label: 'CLEARED TO RETURN',
            hint: 'A relief launches. You have a gap in your search.',
            reply: 'Cleared. Coming off task, heading for home plate.',
            apply(world, sig) { world.relieveOnStation?.(sig.unit); },
          },
          {
            key: 'STRETCH', label: 'STRETCH IT — STAY ON TASK',
            hint: '15 more minutes of coverage. She may not make it back.',
            reply: 'Understood. Staying on task, minimum fuel.',
            apply(world, sig) {
              const u = sig.unit; if (!u) return;
              u.fuel += 15 * MIN;
              u._stretched = true;
            },
          },
        ],
      });
    },
  },

  // ── battle damage report ─────────────────────────────────────────────────
  {
    kind: 'BDA', cooldown: 6 * MIN,
    check(sys, w, now) {
      const u = w.units.find(x => x.alive && x.side === SIDE.BLUE && !x.isAir
        && x.damage.sensors > 0.4 && !x._bdaAsked);
      if (!u) return null;
      u._bdaAsked = true;
      return new Signal({
        kind: 'BDA', from: u.name, unit: u, priority: 'FLASH', opened: now,
        subject: 'SENSOR CASUALTY',
        text: `${u.name} has lost most of her radar picture to blast damage. I can still shoot on remote, but I am not seeing anything for myself.`,
        detail: 'A blind ship in the anti-air picket is a hole in the picket that the picket does not know about.',
        window: 200,
        choices: [
          {
            key: 'REPOSITION', label: 'FALL BACK — SHIELD HER',
            hint: 'She takes an inner station. The outer screen thins.',
            reply: 'Falling back to an inner station.',
            credit: 1,
            apply(world, sig) {
              const u2 = sig.unit, g = world.blueGuide;
              if (!u2 || !g) return;
              u2.station = { guide: g, relBearing: Math.PI, range: 5000 };
            },
          },
          {
            key: 'HOLD', label: 'HOLD STATION — SHOOT ON REMOTE',
            hint: 'Keeps the screen wide. Her cells still work.',
            reply: 'Holding station. Give me the picture and I will shoot it.',
            onExpire: 'Holding station on remote data.',
          },
        ],
      });
    },
  },

  // ── fishing fleet across the base course ─────────────────────────────────
  {
    kind: 'FISHING', cooldown: 26 * MIN,
    check(sys, w, now) {
      const g = w.blueGuide;
      if (!g) return null;
      const ahead = w.units.filter((u) => {
        if (!u.alive || u.side !== SIDE.NEUTRAL) return false;
        const dx = u.x - g.x, dz = u.z - g.z;
        const along = dx * Math.sin(g.heading) + dz * Math.cos(g.heading);
        const across = Math.abs(dx * Math.cos(g.heading) - dz * Math.sin(g.heading));
        return along > 8000 && along < 55000 && across < 9000;
      });
      if (ahead.length < 2) return null;
      return new Signal({
        kind: 'FISHING', from: 'OOD', priority: 'PRIORITY', opened: now,
        subject: 'FISHING FLEET ON THE BASE COURSE',
        text: `${ahead.length} small contacts working across our track, dead ahead. Nets out, by the look of them.`,
        detail: 'Steaming through a fleet with gear in the water at twenty knots is how you cut somebody in half and end up in an inquiry.',
        window: 200,
        pin: { x: ahead[0].x, z: ahead[0].z },
        choices: [
          {
            key: 'ALTER', label: 'ALTER TO CLEAR',
            hint: 'Costs you time and ground toward POINT OSCAR.',
            reply: 'Coming twenty degrees to starboard to clear the fleet.',
            credit: 1,
            apply(world) {
              for (const u of world.units) {
                if (u.side !== SIDE.BLUE || !u.alive || u.isAir || u.isSub) continue;
                u.ordered.heading = u.ordered.heading + 0.35;
              }
            },
          },
          {
            key: 'THROUGH', label: 'MAINTAIN COURSE AND SPEED',
            hint: 'Saves the time. There is a small boat somewhere in that clutter.',
            reply: 'Maintaining course. Posting extra lookouts.',
            demerit: 1,
            onExpire: 'No orders. Maintaining course through the fleet.',
          },
        ],
      });
    },
  },

  // ── weapons release authority ────────────────────────────────────────────
  {
    kind: 'WEAPONS_FREE', cooldown: 30 * MIN,
    check(sys, w, now) {
      const table = w.picture(SIDE.BLUE);
      const hostile = table.list.some(t => !t.faded && t.identity === 'HOSTILE'
        && t.domain === DOMAIN.SURFACE && t.tq >= 3);
      if (!hostile) return null;
      if (!sys.once('WEAPONS_FREE')) return null;
      return new Signal({
        kind: 'WEAPONS_FREE', from: 'CTF-40', priority: 'FLASH', opened: now,
        subject: 'RELEASE AUTHORITY',
        text: 'You hold a hostile surface group. Weapons release authority for anti-surface engagement is delegated to you as of now. Nobody above you is going to make this call.',
        detail: 'It also means the neutral shipping in your box is your problem. A mis-identified merchant is on your record, not theirs.',
        window: 999,
        choices: [
          {
            key: 'ACK', label: 'ACKNOWLEDGE',
            hint: 'Weapons free for surface engagement.',
            reply: 'Acknowledged. Weapons free for surface action.',
          },
        ],
      });
    },
  },
];
