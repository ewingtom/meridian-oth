import { SIDE, EMCON, ROE, IDENT, DOMAIN, NM, KNOT, AO_HALF, Rng, D2R, WEAPONS_QUALITY_TQ } from './constants.js';
import { World } from './World.js';
import { weapon } from './weapons.db.js';
import {
  HULL_NAMES, MERCHANT_NAMES, TRAWLER_NAMES,
  BLUE_CATALOGUE, RED_CATALOGUE, posture, layoutBlue, layoutRed,
} from './forces.db.js';
import { SCENARIOS, scenarioById, missionContext, KESTREL } from './scenarios.db.js';

/*
 * OPERATION NORTH ANCHOR — the Kestrel Sea, 0515 local.
 *
 * The scenario is built so that every phase forces one specific lesson, and the
 * player discovers each lesson by running into the physics rather than by reading
 * a tutorial box:
 *
 *   You cannot see. Your masts are 30 m tall and the enemy is 400 km away.
 *      -> the only fix is to put a sensor in the air. (radar horizon)
 *   The moment you radiate, he knows where you are and you still do not know
 *      where he is.                                    -> (EMCON asymmetry)
 *   You have a contact but you cannot shoot it, because "somewhere in this
 *      twenty-mile ellipse" is not a firing solution.  -> (track quality)
 *   You shot, and the missiles found nothing, because the ellipse was stale by
 *      the time they arrived.                          -> (custody / kill web)
 *   He shoots back with forty rounds arriving together. -> (saturation, layers)
 */

const RED_SHIP_NAMES = ['VOLNA', 'GROMKIY', 'BESSTRASHNY', 'SMETLIVY', 'ZORKIY'];
// Two pools, because a fishing vessel is an FV and a freighter is an MV.
//
// There was one list of ten for twelve hulls, and the last two wrapped — so the
// two trawlers on the bank were called MV NORDIC AURORA and MV KESTREL TRADER,
// which were also the names of two merchants out on the northern lane. Duplicate
// contacts on the same plot, with the wrong prefix, in an identification scenario
// where telling one neutral from another is the whole problem.

/*
 * A DIFFERENT SEA EVERY TIME.
 *
 * The seed defaulted to a constant, so every sortie was byte-identical: the same
 * surface group in the same water on the same bearing, the same submarine, the
 * same trawlers on the same bank. A player who had run it once already knew
 * where to look, and scouting — which is the entire first act — became a
 * formality they could skip.
 *
 * Pass a seed to reproduce a specific sortie (the briefing prints it, so a good
 * one can be replayed or handed to someone else). Pass nothing and you get a new
 * one.
 */
/**
 * The default order of battle — what Engage Now sails with, and what the editor
 * opens pre-filled so the player is editing a real task force rather than
 * assembling one from nothing.
 */
/**
 * The order of battle a scenario sails with — what Engage Now uses, and what
 * the editor opens pre-filled.
 *
 * Each scenario owns its own generator, because "where does the enemy start"
 * is the question that makes one mission different from another. The seed
 * feeds a private stream so the same seed replays the same sortie.
 */
export function defaultSpec(seed = (Math.random() * 0x7fffffff) | 0, scenarioId = 'NORTH_ANCHOR') {
  const rng = new Rng(seed);
  const def = scenarioById(scenarioId);
  const spec = def.spec(seed, rng);
  spec.seed = seed;
  spec.scenario = def.id;
  return spec;
}

/**
 * Build the world from a FORCE SPEC — or from a seed, which makes one.
 *
 * The split is what lets a pre-mission editor exist at all. Everything about
 * which hulls are present and where they start now lives in a plain object that
 * either the generator or the player can produce, and this function does not
 * care which one handed it over.
 */
export function buildScenario(specOrSeed, scenarioId) {
  const spec = (specOrSeed && typeof specOrSeed === 'object')
    ? specOrSeed
    : defaultSpec(specOrSeed === undefined ? undefined : specOrSeed, scenarioId);
  const seed = spec.seed ?? 1;
  const rng = new Rng(seed);
  const def = scenarioById(spec.scenario || scenarioId);
  const OBJ = def.objectivePoint;
  const redX = spec.red.sag.x, redZ = spec.red.sag.z, redCourse = spec.red.sag.course;

  // The world's own record of the mission it is. Everything scenario-specific
  // comes from the definition; everything about the sea is shared, because it
  // is the same sea.
  const scenario = {
    seed,
    id: def.id,
    name: def.name,
    subtitle: `${def.subtitle} · ${def.name.replace(/^OPERATION /, '')}`,
    briefing: def.briefing,
    startTime: def.startTime,
    timeLimit: def.timeLimit,
    objectivePoint: def.objectivePoint,
    posture: spec.posture,
    seaState: 3,
    windDir: 210 * D2R,
    datum: KESTREL.datum,
    islands: KESTREL.islands,
    redAirbase: KESTREL.redAirbase,
    blueAirbase: KESTREL.blueAirbase,
    redTruth: { x: redX, z: redZ, course: redCourse },
    // What INTELLIGENCE thinks, which is not the same thing. Deliberately a
    // vast box that does not start centred on the truth: the enemy commander
    // has the same problem the player does, and the time it takes him to solve
    // it is the time the player has to solve theirs first.
    redSearchBox: { x: rng.range(-90000, 90000), z: 70000, w: 600000, h: 280000, axis: 0 },
    intelBox: {
      x: redX + rng.range(-70000, 70000),
      z: redZ + rng.range(-55000, 55000),
      w: 300000, h: 210000,
      confidence: 'MODERATE',
      age: 5.5 * 3600,
    },
    // Where the SAG waits. A surface action group with no contact holds a
    // barrier across the approaches it is there to deny rather than charging at
    // an assumed position — which is also what makes the player's search a
    // solvable problem instead of a chase after a target that has left the box.
    redAdvanceTo: { x: redX * 0.6, z: redZ - 40000 },
    redPatrol: {
      ax: redX - 140000, az: redZ - 25000,
      bx: redX + 140000, bz: redZ + 25000,
    },
    redSubBarrier: { ax: -120000, az: 60000, bx: 120000, bz: 20000 },
  };

  const world = new World(scenario);
  world.time = scenario.startTime;
  world.startedAt = scenario.startTime;

  // ── force generation ───────────────────────────────────────────────────────
  spawnBlue(world, spec, scenario);
  spawnRed(world, spec, scenario, rng);
  spawnNeutrals(world, spec, scenario, rng);
  applyPosture(world, spec, scenario);

  return world;
}

/*
 * WHERE EACH HULL STANDS.
 *
 * A screen is not a shape, it is a set of assignments — so the layout is a
 * table of stations by role and the Nth ship of a role takes the Nth station.
 * With the default order of battle this reproduces the hand-placed formation
 * exactly: frigates on the bows at 22 km, the second destroyer astern at 12,
 * the high-value units on the disengaged quarter, the carrier tucked inside the
 * screen rather than behind it because she has to be able to turn into the wind
 * and everybody else conforms to her. Add a sixth escort and it keeps working,
 * which is the entire reason this is a table and not five literals.
 */
const STATIONS = {
  ESCORT: [
    { brg: -35, r: 22000 }, { brg: 35, r: 22000 }, { brg: 180, r: 12000 },
    { brg: -105, r: 20000 }, { brg: 105, r: 20000 }, { brg: 0, r: 26000 },
    { brg: -150, r: 17000 }, { brg: 150, r: 17000 },
  ],
  INNER: [{ brg: 175, r: 9000 }, { brg: 195, r: 11000 }],
  HVU: [
    { brg: 160, r: 15000 }, { brg: -160, r: 16000 },
    { brg: 148, r: 19000 }, { brg: -148, r: 20000 },
  ],
};

/** Flatten a composition list into one entry per hull, in catalogue order. */
function roster(list, catalogue) {
  const out = [];
  for (const entry of list || []) {
    const meta = catalogue.find(c => c.cls === entry.cls);
    if (!meta) continue;
    for (let i = 0; i < (entry.n || 0); i++) out.push({ cls: entry.cls, role: meta.role, i });
  }
  return out;
}

/** Pull the next unused name for a class. */
function nameFor(cls, used) {
  const pool = HULL_NAMES[cls] || [['UNNAMED', null]];
  const n = (used[cls] = (used[cls] || 0) + 1) - 1;
  const [name, hull] = pool[n % pool.length];
  return { name: n < pool.length ? name : `${name} (${n + 1})`, hullNo: hull };
}

function spawnBlue(world, spec, scenario) {
  const b = spec.blue;
  const course = b.course;
  const used = {};
  const created = [], hvus = [];
  let guide = null;

  /*
   * Every hull is placed individually, and STATION KEEPING IS DERIVED FROM
   * WHERE IT IS.
   *
   * A ship that is where the formation expects it gets a station — a bearing
   * and range off the guide — and holds it. A ship the player has picked up and
   * put somewhere else is marked detached and gets none, so it starts where it
   * was put and steams on the base course until ordered otherwise. Without that
   * distinction, dragging the carrier two hundred kilometres away would have
   * been undone in the first few minutes by the station keeper quietly steering
   * her back into the screen, which is not what anybody dragging a carrier two
   * hundred kilometres away is asking for.
   */
  for (const h of b.units || []) {
    const meta = BLUE_CATALOGUE.find(c => c.cls === h.cls);
    if (!meta) continue;
    const nm = nameFor(h.cls, used);
    const isSub = meta.role === 'SUB';
    const u = world.spawn({
      className: h.cls, side: SIDE.BLUE, id: nm.hullNo || `BLUE-${created.length}`,
      name: nm.name, hullNo: nm.hullNo,
      x: h.x, z: h.z, heading: course, speed: (isSub ? 6 : 16) * KNOT,
      alt: isSub ? -120 : 0,
      emcon: isSub ? EMCON.SILENT : EMCON.PASSIVE, roe: ROE.TIGHT,
    });
    if (isSub) u.depthOrdered = -120;
    if (!guide) { guide = u; u.flagship = true; }
    else if (!h.detached && !isSub) {
      const dx = h.x - b.x, dz = h.z - b.z;
      u.station = {
        guide,
        relBearing: Math.atan2(dx, dz) - course,
        range: Math.hypot(dx, dz),
      };
    }
    if (meta.role === 'HVU') hvus.push(u);
    // Anti-ship rounds ride in the destroyers' cells as well as the flagship's.
    if (h.cls === 'DDG_FLIGHT_IIA' && created.length) { u.mags.LRASM = 16; u.magsMax.LRASM = 16; }
    if (h.cls === 'CVN_FORD') {
      // Aviation ordnance. The air wing draws from the ship's magazine, so this
      // is the real limit on how many anti-ship sorties she can fly.
      const load = { LRASM: 24, HARPOON: 16, AMRAAM: 96, SIDEWINDER: 48, MK54: 18, SONOBUOY: 400 };
      for (const [k, v] of Object.entries(load)) { u.mags[k] = v; u.magsMax[k] = v; }
    }
    created.push(u);
  }
  if (!guide) return;

  // Alert aircraft. A carrier does not start a watch with a cold deck, and an
  // escort keeps a Seahawk armed on the pad — which is what keeps LAUNCH HELO
  // doing what it has always done the first time it is pressed, now that every
  // hangar goes through the deck scheduler.
  const alert = (ship, type, ld, n) => {
    if (!ship.deck) return;
    ship.deck.prep(type, ld, n);
    for (const f of ship.deck.frames) if (f.state === 'PREPPING') { f.state = 'READY'; f.timer = 0; }
    ship.deck.log.length = 0;
  };
  for (const u of created) {
    if (!u.deck) continue;
    if (u.deck.catapults > 0) alert(u, 'FA18E', 'CAP', 2);
    else alert(u, 'MH60R', 'ASW', 1);
  }

  // Shore-based aviation. Two Poseidons — one on station as a hint in the shape
  // of an asset that the answer to "I cannot see" is altitude, and one held back
  // because losing the first to a SAM envelope is a common and instructive
  // mistake, and a scenario where it is unrecoverable teaches only to reload.
  const air = [];
  const mpa = world.spawn({
    className: 'MPA_P8', side: SIDE.BLUE, id: 'VP-71', name: 'POSEIDON 71',
    x: b.x - 25000, z: b.z + 55000, heading: course, alt: 8000,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  mpa.fuel = mpa.maxFuel * 0.86;
  mpa.setOrbit(b.x, b.z + 60000, 26000);
  air.push(mpa);
  const mpa2 = world.spawn({
    className: 'MPA_P8', side: SIDE.BLUE, id: 'VP-72', name: 'POSEIDON 72',
    x: b.x + 40000, z: b.z - 60000, heading: course, alt: 8000,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  mpa2.setOrbit(b.x + 30000, b.z - 40000, 24000);
  air.push(mpa2);

  // Airborne early warning: the answer to the central problem of task-force air
  // defence. A ship's radar horizon against a sea-skimmer is about thirty
  // kilometres, which is ninety seconds; the only way to buy more is to lift the
  // radar off the sea. It also lets the force shoot on the Hawkeye's picture
  // while staying silent itself.
  const aew = world.spawn({
    className: 'AEW_E2D', side: SIDE.BLUE, id: 'VAW-121', name: 'HAWKEYE 601',
    x: b.x - 8000, z: b.z + 22000, heading: course, alt: 9000,
    emcon: EMCON.FULL, roe: ROE.TIGHT,
  });
  aew.setOrbit(b.x, b.z + 30000, 22000);
  air.push(aew);

  world.blueGuide = guide;
  world.blueHvu = hvus;
  world.blueUnitsOrder = [...created, ...air];
}

function spawnRed(world, spec, scenario, rng) {
  const r = spec.red;
  const used = {};
  const sag = [];
  (r.sag.units || []).forEach((h, i) => {
    const nm = nameFor(h.cls, used);
    sag.push(world.spawn({
      className: h.cls, side: SIDE.RED, id: `RED-S${i}`, name: nm.name,
      x: h.x, z: h.z, heading: r.sag.course, speed: 15 * KNOT,
      emcon: EMCON.PASSIVE, roe: ROE.FREE,
    }));
  });

  for (let i = 0; i < (r.subs || 0); i++) {
    // Its own bearing, independent of the surface group — a submarine that
    // always sat in the same box was the one contact nobody had to search for.
    const sub = world.spawn({
      className: 'SSGN_AKULA', side: SIDE.RED, id: `RED-SS${i}`,
      name: nameFor('SSGN_AKULA', used).name,
      // A scenario may say where the boat is hunting; otherwise it takes its own
      // bearing about the objective, independent of the surface group — a
      // submarine that always sat in the same box was the one contact nobody
      // had to search for.
      x: (r.subAnchor ? r.subAnchor.x : scenario.objectivePoint.x)
        + Math.sin(rng.range(-2.4, 2.4)) * rng.range(r.subAnchor ? 12000 : 40000, r.subAnchor ? 45000 : 130000),
      z: (r.subAnchor ? r.subAnchor.z : scenario.objectivePoint.z)
        + Math.cos(rng.range(-2.4, 2.4)) * rng.range(r.subAnchor ? 10000 : 30000, r.subAnchor ? 40000 : 110000),
      heading: Math.PI, speed: 5 * KNOT, alt: -150, emcon: EMCON.SILENT, roe: ROE.FREE,
    });
    sub.depthOrdered = -150;
  }

  for (let i = 0; i < (r.mpa || 0); i++) {
    world.spawn({
      className: 'MPA_BEAR', side: SIDE.RED, id: `RED-MPA${i}`,
      name: nameFor('MPA_BEAR', used).name,
      x: r.sag.x + rng.range(-120000, 120000), z: r.sag.z + rng.range(50000, 130000),
      heading: Math.PI, alt: 7000, emcon: EMCON.FULL, roe: ROE.TIGHT,
    });
  }

  for (let i = 0; i < (r.bombers || 0); i++) {
    const b = world.spawn({
      className: 'BOMBER_BACKFIRE', side: SIDE.RED, id: `RED-BMR${i}`,
      name: nameFor('BOMBER_BACKFIRE', used).name,
      x: scenario.redAirbase.x + i * 3000, z: scenario.redAirbase.z,
      heading: Math.PI, alt: 10500, emcon: EMCON.SILENT, roe: ROE.TIGHT, speed: 260,
    });
    b.fuel = b.maxFuel;
  }

  world.redSag = sag;
}

function spawnNeutrals(world, spec, scenario, rng) {
  /*
   * Lanes have to cross the track the task group is actually going to steam.
   *
   * These were once laid out against the corners of the area of operations, and
   * measured against the real transit corridor the nearest neutral in the whole
   * scenario passed 71 km abeam. Everything downstream depended on it: the
   * signal that fires when a merchant closes inside the screen needs one within
   * 26 km of a high-value unit, and neither that nor the fishing-fleet condition
   * was ever satisfiable, so the sea was empty and five generators never fired.
   *
   * A task group does not get a private ocean. One lane crosses the corridor
   * early, another late, and the third stays out wide as background traffic.
   */
  const LANES = [
    { name: 'KESTREL PASSAGE', a: { x: -AO_HALF * 0.62, z: -AO_HALF * 0.52 }, b: { x: AO_HALF * 0.70, z: -AO_HALF * 0.16 } },
    { name: 'NORTHERN APPROACH', a: { x: -AO_HALF * 0.80, z: AO_HALF * 0.02 }, b: { x: AO_HALF * 0.86, z: -AO_HALF * 0.24 } },
    { name: 'COASTAL', a: { x: AO_HALF * 0.42, z: AO_HALF * 0.55 }, b: { x: AO_HALF * 0.95, z: -AO_HALF * 0.30 } },
  ];
  world.lanes = LANES;

  const nMerch = spec.neutral.merchants, nTrawl = spec.neutral.trawlers;
  // The fishing bank sits on the shelf edge the group crosses about an hour
  // out, which is exactly the kind of place a warship at twenty knots has to
  // think about gear in the water.
  const bank = { x: spec.blue.x + 11000, z: spec.blue.z + 48000 };

  for (let i = 0; i < nMerch + nTrawl; i++) {
    const isTrawler = i >= nMerch;
    let x, z, hdg;
    if (isTrawler) {
      x = bank.x + rng.range(-15000, 15000);
      z = bank.z + rng.range(-11000, 11000);
      hdg = rng.range(0, 360) * D2R;
    } else {
      const lane = LANES[i % LANES.length];
      const t = rng.next();
      const along = { x: lane.b.x - lane.a.x, z: lane.b.z - lane.a.z };
      const len = Math.hypot(along.x, along.z) || 1;
      const nx = -along.z / len, nz = along.x / len;
      // Traffic separation: a couple of miles of scatter either side of the
      // track, and half the hulls running the reciprocal.
      const off = rng.range(-5000, 5000);
      x = lane.a.x + along.x * t + nx * off;
      z = lane.a.z + along.z * t + nz * off;
      const rev = i % 2 === 1;
      hdg = Math.atan2(rev ? -along.x : along.x, rev ? -along.z : along.z);
    }
    const m = world.spawn({
      className: isTrawler ? 'TRAWLER' : 'MERCHANT', side: SIDE.NEUTRAL, id: `NEU-${i}`,
      name: isTrawler
        ? TRAWLER_NAMES[(i - nMerch) % TRAWLER_NAMES.length]
        : MERCHANT_NAMES[i % MERCHANT_NAMES.length],
      x, z, heading: hdg, speed: (isTrawler ? 5 : 15) * KNOT,
      emcon: EMCON.RESTRICTED, roe: ROE.HOLD,
    });
    m.orderCourse(hdg, m.cls.maxSpeed * (isTrawler ? 0.35 : 0.8));
    m.lane = isTrawler ? 'FISHING' : LANES[i % LANES.length].name;
  }
}

/**
 * How hot it starts.
 *
 * COLD is the game as designed: a search problem where the first decision is
 * whether to radiate. WARM has already been found — a Bear is overhead and the
 * intelligence is ninety minutes old rather than five and a half hours. HOT
 * skips the search entirely and asks a different question, because the salvo
 * is already in the air and the only thing that matters is the next four
 * minutes.
 */
function applyPosture(world, spec, scenario) {
  const p = posture(spec.posture);
  for (const u of world.units) {
    if (u.side === SIDE.BLUE && !u.isAir) {
      u.ordered.roe = p.blueRoe === 'ROE_FREE' ? ROE.FREE : ROE.TIGHT;
      if (p.blueEmcon === 'FULL') u.setEmcon(EMCON.FULL);
    } else if (u.side === SIDE.RED && !u.isAir && !u.isSub) {
      if (p.redEmcon === 'FULL') u.setEmcon(EMCON.FULL);
      else if (p.redEmcon === 'RESTRICTED') u.setEmcon(EMCON.RESTRICTED);
    }
  }
  scenario.intelBox.age = p.intelAgeH * 3600;
  scenario.posture = p.id;

  if (!p.redKnowsYou) return;
  // He has a solution on the task force. Hand the red commander the truth
  // rather than making him search for it.
  world.redKnowsBlue = { x: world.blueGuide.x, z: world.blueGuide.z, t: world.time };

  if (p.opening === 'INBOUND') {
    /*
     * The salvo the posture promises.
     *
     * HOT says "the first salvo is already in the air", and for a while it said
     * only that — it set weapons free, lit everybody up and then handed the
     * player a perfectly quiet ocean. A posture that describes a raid has to
     * produce a raid.
     *
     * The shot is taken at the guide's actual position rather than through the
     * track system, because the fiction is that he solved the targeting problem
     * ten minutes ago and this is the consequence. Half the launchers, not all
     * of them: the point is to open the game inside a defended-zone problem,
     * not to decide it before the player has touched anything.
     */
    const target = world.blueGuide;
    let fired = 0;
    for (const u of world.redSag) {
      const asm = (u.cls.weapons || [])
        .map(w => w.id)
        .find(id => (u.mags[id] || 0) > 0 && weapon(id)?.category === 'ASM');
      if (!asm) continue;
      const n = Math.max(1, Math.floor((u.mags[asm] || 0) / 2));
      for (let i = 0; i < n; i++) {
        const o = world.ordnance.fire(u, asm, null, { aim: { x: target.x, z: target.z } });
        if (!o) break;
        fired++;
      }
      u.setEmcon(EMCON.FULL);
    }
    if (fired) {
      world.comms.push({
        t: world.time, from: 'TF-44 TAO', priority: 'FLASH',
        text: `VAMPIRE VAMPIRE VAMPIRE — ${fired} inbound. He shot first.`,
      });
    }
  }

  if (p.opening === 'SHADOWED') {
    // Put the Bear where a shadower would be: overhead, and already radiating.
    const bear = world.units.find(u => u.alive && u.className === 'MPA_BEAR');
    if (bear) {
      bear.x = world.blueGuide.x + 60000;
      bear.z = world.blueGuide.z + 40000;
      bear.setOrbit(world.blueGuide.x, world.blueGuide.z, 55000);
    }
  }
}

/**
 * Mission state machine and scoring. Phases are not gates the player has to
 * unlock — they are a readout of what the situation currently demands, so the
 * objective panel always says something true and useful.
 */
export class Mission {
  constructor(world) {
    this.world = world;
    this.def = scenarioById(world.scenario.id);
    this.phase = 'SEARCH';
    this.status = 'ACTIVE';
    this.startedAt = world.time;
    // Objectives come from the scenario and carry their own tests. They used to
    // be six literals indexed by number in step(), which is why there was only
    // ever one mission.
    this.objectives = this.def.objectives.map(o => ({ ...o, done: false }));
    this.failReason = null;
    this.hints = [];
    this._hintsShown = new Set();
    this.grade = null;
    this.oscarProgress = 0;
    this._reached = new Set();
  }

  /** Has the objective with this id been met? Used by phase and outcome tests. */
  done(id) {
    const o = this.objectives.find(x => x.id === id);
    return !!o && o.done;
  }

  /**
   * Has any live blue unit of this class reached the objective point?
   * Also drives the progress readout, so a long transit shows movement rather
   * than a boolean that flips at the end.
   */
  reached(clsFragment) {
    if (this._reached.has(clsFragment)) return true;
    const w = this.world, pt = w.scenario.objectivePoint;
    if (!pt) return false;
    for (const u of w.units) {
      if (!u.alive || u.side !== SIDE.BLUE || !u.className.includes(clsFragment)) continue;
      const d = Math.hypot(u.x - pt.x, u.z - pt.z);
      this.oscarProgress = Math.max(this.oscarProgress, 1 - Math.min(1, d / 430000));
      if (d < pt.radius) { this._reached.add(clsFragment); return true; }
    }
    return false;
  }

  hint(id, text, opts = {}) {
    if (this._hintsShown.has(id)) return;
    this._hintsShown.add(id);
    this.hints.push({ id, text, t: this.world.time, ...opts });
    this.world.comms.push({
      t: this.world.time, from: opts.from || 'TF-44 TAO', priority: opts.priority || 'ROUTINE', text, hint: true,
    });
  }

  step() {
    const w = this.world;
    const now = w.time;
    const c = missionContext(w, this);

    // Objectives latch, except the ones phrased as a standing condition — "both
    // high value units survive" has to be able to become false again.
    for (const o of this.objectives) {
      const v = !!o.check(w, this, c);
      o.done = o.negative ? v : (o.done || v);
    }

    this.phase = this.def.phase(w, this, c) || this.phase;

    if (this.def.hints) this._hints(now, c.table, c.bestTq, c.sagTracks, c.inbound);

    if (this.status !== 'ACTIVE') return;
    const out = this.def.outcome(w, this, c);
    if (out) this._end(out.status, out.reason);
  }

  _hints(now, table, bestTq, sagTracks, inbound) {
    const w = this.world;
    const elapsed = now - this.startedAt;
    const guide = w.blueGuide;
    const mpa = w.units.find(u => u.alive && u.type === 'MPA' && u.side === 'BLUE');

    if (elapsed > 25) {
      this.hint('INTRO',
        'Sir, our masthead horizon is twenty-one miles. The SAG could be four hundred miles out and we would never know. Recommend we work POSEIDON 71 north and put her radar where it can do some good.',
        { priority: 'PRIORITY' });
    }
    // Formation recognition.
    const pend = table.list.filter(t => !t.own && !t.faded && t.domain === 'SURFACE'
      && (t.identity === 'PENDING' || t.identity === 'UNKNOWN') && t.tq >= 2 && t.speedEst > 6.5);
    for (const t of pend) {
      const company = pend.filter(o => o !== t && Math.hypot(o.x - t.x, o.z - t.z) < 45000).length;
      if (company >= 2) {
        this.hint('FORMATION',
          `${company + 1} large contacts in company, holding station on each other at better than fifteen knots. Merchants do not steam like that. Designate the group hostile and we can start building a firing solution.`,
          { priority: 'PRIORITY' });
        break;
      }
    }

    if (elapsed > 100 && mpa && mpa.emcon === 'PASSIVE' && !this._hintsShown.has('MPA_RADAR')) {
      this.hint('MPA_RADAR',
        'POSEIDON 71 is passive. Her ESM will hear anything that radiates, but the SAG is running quiet — if we want to find them we have to light her radar and accept that they will hear it.',
        { priority: 'ROUTINE' });
    }
    if (sagTracks.some(t => t.tq <= 2 && t.bearingCuts.length) && !this._hintsShown.has('CUT')) {
      this.hint('CUT',
        'That is a bearing, not a position — the ellipse runs three hundred miles down the line of sight. Get a second cut from a unit well off that bearing and we can cross-fix it.',
        { priority: 'PRIORITY' });
    }
    if (this.objectives[0].done && bestTq < WEAPONS_QUALITY_TQ && elapsed > 400) {
      this.hint('NEED_TQ',
        'We hold the SAG, but not well enough to shoot. TQ four is the line — below that the seeker basket lands in empty water and we have thrown away the salvo.',
        { priority: 'PRIORITY' });
    }
    if (bestTq >= WEAPONS_QUALITY_TQ) {
      this.hint('CAN_SHOOT',
        'Weapons quality on the SAG. LRASM will take eleven minutes to get there — whatever is holding that track has to keep holding it the whole way, or the missiles arrive at a memory.',
        { priority: 'FLASH' });
    }
    if (w.stats.asmFired >= 4 && w.stats.asmHit === 0 && now - this._firstStrikeAt > 900 && this._firstStrikeAt) {
      this.hint('SATURATE',
        'That salvo achieved nothing. Their cruiser can service about twenty rounds inside the two minutes we are visible to her — anything smaller she kills one at a time. Close to Naval Strike Missile range and commit EVERYTHING on one time-on-top, or do not shoot at all.',
        { priority: 'FLASH', from: 'TF-44 CO' });
    }
    if (w.stats.asmFired > 0 && !this._firstStrikeAt) this._firstStrikeAt = now;
    if (w.stats.asmFired > 0 && !this._hintsShown.has('CUSTODY')) {
      this.hint('CUSTODY',
        'Birds are away. Keep custody. If the track goes stale before they get there, they will search the ocean where the SAG used to be.',
        { priority: 'FLASH' });
    }
    if (inbound > 0) {
      this.hint('INBOUND',
        'VAMPIRE. Multiple inbound. Get the HVUs turned away, weapons free on the escorts, and stand by for hard kill at the outer edge.',
        { priority: 'FLASH', from: 'TF-44 AAW' });
    }
    if (inbound >= 8) {
      this.hint('SATURATION',
        'This is a saturation raid — they are all arriving together on purpose. We have six fire control channels across the force. Prioritise the leakers on GRANITE BAY.',
        { priority: 'FLASH', from: 'TF-44 AAW' });
    }
    // The shadower, and the decision it forces.
    const shadow = table.list.find(t => !t.faded && t.identity === 'HOSTILE' && t.domain === 'AIR'
      && Math.hypot(t.x - guide.x, t.z - guide.z) < 160000);
    if (shadow) {
      this.hint('KILL_THE_SCOUT',
        'That patrol aircraft is inside Standard range. He is holding us on radar and every round the SAG fires is aimed by him — kill him and their picture goes with him. But we cannot put a missile on him without a fire-control solution, and that means going active. Radiate, or accept being targeted.',
        { priority: 'FLASH', from: 'TF-44 TAO' });
    }

    const redMpa = table.list.find(t => !t.faded && t.identity === 'HOSTILE' && t.domain === 'AIR');
    if (redMpa) {
      this.hint('RED_MPA',
        'Airborne emitter to the north — that is a Volsk maritime patrol aircraft and he is looking for us. His radar reaches a hundred and fifty miles. We hear him long before he sees us, but we cannot shoot him without going active ourselves.',
        { priority: 'PRIORITY' });
    }

    // Scouts wandering into the SAM umbrella.
    for (const a of w.units) {
      if (!a.alive || a.side !== 'BLUE' || !a.isAir) continue;
      for (const t of table.list) {
        if (t.own || t.faded || t.domain !== 'SURFACE') continue;
        if (t.identity === 'FRIEND' || t.identity === 'NEUTRAL') continue;
        if (t.speedEst < 6) continue;                     // a formation, not a merchant
        if (Math.hypot(t.x - a.x, t.z - a.z) > 105000) continue;
        this.hint('SAM_ENVELOPE',
          `${a.name} is inside the SAG's surface-to-air envelope — their long-range battery reaches nearly fifty miles past where she is now. Pull her back and hold custody from outside it, or we lose our eyes.`,
          { priority: 'FLASH', from: 'TF-44 TAO' });
        break;
      }
    }

    // The single most important warning in the game.
    const passive = w.units.filter(u => u.alive && u.side === 'BLUE' && u.isSurface
      && (u.emcon === 'SILENT' || u.emcon === 'PASSIVE'));
    if (inbound > 0 && passive.length >= 3) {
      this.hint('GO_ACTIVE',
        'Sir — we are in EMCON BRAVO with vampires inbound. We cannot engage what we cannot see, and their seekers will not come up until they are ninety seconds out. SPY has to come up NOW, weapons free, or this raid arrives unopposed.',
        { priority: 'FLASH', from: 'TF-44 AAW' });
    }
    const redFound = table.list.some(t => !t.faded && t.identity === 'HOSTILE'
      && t.domain === 'SURFACE' && t.fingerprint);
    if (redFound) {
      this.hint('THEY_ARE_LOUD',
        'The SAG has gone active — every one of their air-search sets is radiating. They would not do that unless they thought they had us. Assume we are being targeted.',
        { priority: 'PRIORITY' });
    }
    if (guide && guide.emcon === 'FULL' && !this._hintsShown.has('EMCON_WARN')) {
      this.hint('EMCON_WARN',
        'We are radiating. SPY is a hundred-kilowatt beacon — their ESM will hold us at better than twice the range we can see them. Recommend we get the picture we need and go quiet again.',
        { priority: 'PRIORITY' });
    }
    if (w.stats.neutralLosses.length > 0) {
      this.hint('NEUTRAL',
        'We killed a neutral. The seeker took the biggest return in the basket, and that is exactly what it is designed to do. Positive identification before launch, every time.',
        { priority: 'FLASH', from: 'TF-44 CO' });
    }
  }

  _end(status, reason) {
    // Status first: score() reads it to cap the rank on a failure.
    this.status = status;
    this.failReason = reason;
    this.endedAt = this.world.time;
    this.grade = this.score();
    this.world.emit({ type: 'MISSION_END', status, reason, grade: this.grade });
  }

  score() {
    const w = this.world;
    const s = w.stats;
    const pts = [];
    let total = 0;
    const add = (label, value, detail) => { pts.push({ label, value, detail }); total += value; };

    const redKills = s.redLosses.filter(l => !l.id.includes('BMR')).length;
    add('Hostile combatants destroyed', redKills * 120,
      `${redKills} hostile ${redKills === 1 ? 'unit' : 'units'} destroyed`);
    const hvuAll = w.units.filter(u => u.hvu).length;
    const hvuUp = w.units.filter(u => u.hvu && u.alive).length;
    if (hvuAll) add('High value units intact', hvuUp * 250, `${hvuUp} of ${hvuAll} HVUs afloat`);
    add('Own losses', -s.blueLosses.length * 200,
      `${s.blueLosses.length} friendly ${s.blueLosses.length === 1 ? 'unit' : 'units'} lost`);
    const ourNeutrals = s.neutralLosses.filter(l => l.by === 'BLUE');
    add('Neutral vessels destroyed by TF-44', -ourNeutrals.length * 400,
      ourNeutrals.length ? 'Rules of engagement violation' : 'None — clean engagement');
    // A 0-for-0 rendered as "0 %" reads as a failure when in fact nothing was
    // fired; say so instead.
    const eff = s.asmFired ? s.asmHit / s.asmFired : 0;
    add('Strike efficiency', Math.round(eff * 300), s.asmFired
      ? `${s.asmHit} ${s.asmHit === 1 ? 'hit' : 'hits'} from ${s.asmFired} anti-ship ${s.asmFired === 1 ? 'missile' : 'missiles'} (${Math.round(eff * 100)}%)`
      : 'No anti-ship missiles were fired');
    if (s.timeToFirstWeaponsQuality !== null) {
      const mins = s.timeToFirstWeaponsQuality / 60;
      add('Time to weapons-quality track', Math.round(Math.max(0, 260 - mins * 3)),
        `${Math.round(mins)} minutes from mission start`);
    }
    /*
     * Objectives, scored from the scenario's own list.
     *
     * This used to be `this.objectives[4].done` — the fifth objective, by
     * index, which happened to be POINT OSCAR in the one mission that existed.
     * Every scenario with fewer than five objectives threw on the debrief
     * screen, which is a spectacular way to lose a player's session at the
     * exact moment they wanted to see how they did.
     */
    const key = this.objectives.filter(o => o.key);
    const keyDone = key.filter(o => o.done);
    if (key.length) {
      add('Mission objectives', keyDone.length * Math.round(900 / key.length),
        `${keyDone.length} of ${key.length} key objectives met`);
    }
    const bonus = this.objectives.filter(o => !o.key && o.done);
    if (bonus.length) add('Secondary objectives', bonus.length * 90,
      bonus.map(o => o.text).join('; '));

    // Command judgement: the signals you answered well, and the ones you let run
    // out. A task force commander is graded on more than missiles.
    const sig = w.signals;
    if (sig && (sig.credit || sig.demerit)) {
      add('Command decisions', sig.credit * 60 - sig.demerit * 40,
        `${sig.credit} signal${sig.credit === 1 ? '' : 's'} handled well, ${sig.demerit} ignored or mishandled`);
    }

    // Calibrated against the points actually reachable. Simply bringing the task
    // force home intact is +500 before anything else happens, so thresholds that
    // started at 500 graded a clean run — two HVUs afloat, no losses, no neutrals
    // killed — as UNSATISFACTORY. UNSATISFACTORY should mean you lost something.
    /*
     * A failed mission cannot be graded DISTINGUISHED.
     *
     * The rank was a pure function of points, and points come mostly from
     * things that are true whether or not you succeeded — hulls afloat, no
     * neutrals killed, objectives partially met. A barrier patrol that let the
     * submarine through and lost nothing scored 1650 and was told it had done
     * distinguished work. Failing the mission is the mission's verdict on you,
     * and the rank has to say so.
     */
    let rank = total > 1400 ? 'DISTINGUISHED'
      : total > 850 ? 'EFFECTIVE'
        : total > 300 ? 'MARGINAL' : 'UNSATISFACTORY';
    if (this.status === 'FAILURE') {
      const ORDER = ['UNSATISFACTORY', 'MARGINAL', 'EFFECTIVE', 'DISTINGUISHED'];
      rank = ORDER[Math.min(ORDER.indexOf(rank), ORDER.indexOf('MARGINAL'))];
    }
    return { total, pts, rank, status: this.status };
  }
}
