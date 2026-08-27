import { SIDE, EMCON, ROE, IDENT, DOMAIN, NM, KNOT, AO_HALF, Rng, D2R, WEAPONS_QUALITY_TQ } from './constants.js';
import { World } from './World.js';

/*
 * OPERATION NORTH ANCHOR — the Kestrel Sea, 0410 local.
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
const MERCHANT_NAMES = [
  'MV NORDIC AURORA', 'MV KESTREL TRADER', 'MV BALTIC PIONEER', 'MV STAR OF LEITH',
  'MV ORION CREST', 'MV SEVEN SISTERS', 'MV ANDALUSIA', 'MV CAPE FINISTERRE',
  'MV THORVALD BANKE',
];
const TRAWLER_NAMES = [
  'FV HAVFRUEN', 'FV NORDSTJERNEN', 'FV SILDEBERG', 'FV MAAGEN', 'FV BRISLING',
];

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
export function buildScenario(seed = (Math.random() * 0x7fffffff) | 0) {
  const rng = new Rng(seed);

  /*
   * Where the enemy actually is, hidden from the player.
   *
   * This used to be a rectangle spanning x -150..130 km at z 165..265 km — which
   * is always NORTH, so however the seed fell the answer to "which way do I
   * send the Poseidon" was the same. Placing the group in POLAR coordinates
   * about the objective instead puts it anywhere on a 150-degree arc, so the
   * bearing is a real unknown and the search has to start from the intelligence
   * rather than from memory.
   *
   * The arc is centred north because that is where their airfield is — Volsk
   * NAS lies northeast, and a surface action group that appeared to the
   * southwest would have had to steam past the whole task force to get there.
   * Within that constraint it is wide open.
   */
  const OBJ = { x: 30000, z: 20000 };
  const approachBrg = (-75 + rng.range(0, 150)) * D2R;      // 285 through 000 to 075
  const approachRng = rng.range(185000, 295000);
  const redX = OBJ.x + Math.sin(approachBrg) * approachRng;
  const redZ = OBJ.z + Math.cos(approachBrg) * approachRng;
  // They are closing the objective, with a few degrees of wander so the course
  // is not a giveaway either.
  const redCourse = Math.atan2(OBJ.x - redX, OBJ.z - redZ) + rng.range(-0.22, 0.22);

  const scenario = {
    seed,
    id: 'NORTH_ANCHOR',
    name: 'OPERATION NORTH ANCHOR',
    // Chart datum for the origin. The graticule used to print nautical miles
    // from the origin with hemisphere letters on them, which reads as a latitude
    // and produced references like 150S — a latitude that cannot exist. With a
    // datum the same grid prints real positions you could pass over the net.
    datum: { lat: 62.0, lon: 8.0 },
    subtitle: 'Kestrel Sea · 0410 local · Task Force 44',
    seaState: 3,
    windDir: 210 * D2R,
    startTime: 4 * 3600 + 10 * 60,
    timeLimit: 7.5 * 3600,
    redTruth: { x: redX, z: redZ, course: redCourse },
    // What INTELLIGENCE thinks, which is not the same thing.
    // Where the Volsk commander thinks the task force might be. Deliberately a
    // vast box that does NOT start centred on the truth: he has the same problem
    // the player does, and the time it takes him to solve it is the time the
    // player has to solve theirs first.
    // Where the Volsk commander looks. He does NOT know where the task force is
    // either, and his box covers the northern half of the operating area — the
    // approaches to his own position and to POINT OSCAR. The consequence is that
    // contact happens when the PLAYER decides to push north, not on a timer,
    // which is what makes the transit a decision instead of a countdown.
    redSearchBox: { x: rng.range(-90000, 90000), z: 70000, w: 600000, h: 280000, axis: 0 },
    intelBox: {
      x: redX + rng.range(-70000, 70000),
      z: redZ + rng.range(-55000, 55000),
      w: 300000, h: 210000,
      confidence: 'MODERATE',
      age: 5.5 * 3600,
    },
    // Where the SAG waits. A surface action group with no contact does not
    // charge blindly at the enemy's assumed position — it holds a barrier across
    // the approaches it is there to deny, which is also what makes the player's
    // search a solvable problem instead of a chase after a target that has
    // already left the box intelligence gave them.
    redAdvanceTo: { x: redX * 0.6, z: redZ - 40000 },
    redPatrol: {
      ax: redX - 140000, az: redZ - 25000,
      bx: redX + 140000, bz: redZ + 25000,
    },
    redAirbase: { x: 210000, z: 415000, name: 'VOLSK NAVAL AIR STATION' },
    blueAirbase: { x: -330000, z: -430000, name: 'NAS KESTREL POINT', alive: true },
    redSubBarrier: { ax: -120000, az: 60000, bx: 120000, bz: 20000 },
    // Reachable, and only just. GRANITE BAY makes 22 knots; POINT OSCAR is 120
    // nautical miles up-threat, which is five and a half hours at her best speed
    // against a seven and a half hour window. That leaves enough slack to turn
    // away from one raid and not enough to wander — which is the whole point of
    // escorting a high value unit.
    objectivePoint: { x: 30000, z: 20000, name: 'POINT OSCAR', radius: 30000 },
    // The landing has to happen somewhere. KESTREL ISLAND and its outliers give
    // POINT OSCAR a coast, the plot some terrain, and the task force somewhere
    // it can put a headland between itself and a hostile radar.
    islands: [
      { id: 'KESTREL', name: 'KESTREL I.', x: 34000, z: 6000, radius: 5200, height: 620, seed: 17 },
      { id: 'SKUA', name: 'SKUA ROCK', x: 12000, z: 26000, radius: 1500, height: 120, seed: 44 },
      { id: 'BRANT', name: 'BRANT I.', x: 58000, z: 30000, radius: 3100, height: 430, seed: 91 },
      { id: 'GANNET', name: 'GANNET SKERRIES', x: -8000, z: 44000, radius: 900, height: 46, seed: 63 },
    ],
    briefing: [
      'Two hours ago a Volsk surface action group sortied from the northern basin and went dark. Fleet intelligence puts them somewhere in the shaded box — a hundred and sixty thousand square miles of empty grey water, five and a half hours stale.',
      'Task Force 44 is escorting GRANITE BAY and CAPE HATTERAS north to POINT OSCAR. The landing force embarked in GRANITE BAY has to be there. That is the mission; everything else is in support of it.',
      'The SAG is built around a Volna-class cruiser with sixteen supersonic anti-ship missiles that outrange everything you own by two hundred miles. If he finds you first, you will not get to choose the terms of the engagement.',
      'Find him. Get a weapons-quality track. Hold it long enough for your missiles to arrive. And keep your emissions off the air until the moment shooting is better than hiding.',
    ],
  };

  const world = new World(scenario);
  world.time = scenario.startTime;
  world.startedAt = scenario.startTime;

  // ── BLUE: Task Force 44 ────────────────────────────────────────────────────
  const tfX = -20000, tfZ = -200000;
  const guide = world.spawn({
    className: 'DDG_FLIGHT_IIA', side: SIDE.BLUE, id: 'DDG-121',
    name: 'USS MERIDIAN', hullNo: 'DDG-121',
    x: tfX, z: tfZ, heading: 8 * D2R, speed: 16 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  guide.flagship = true;

  const hvu1 = world.spawn({
    className: 'LPD', side: SIDE.BLUE, id: 'LPD-31',
    name: 'USS GRANITE BAY', hullNo: 'LPD-31',
    x: tfX + 2600, z: tfZ - 5200, heading: 8 * D2R, speed: 16 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  const hvu2 = world.spawn({
    className: 'AOE', side: SIDE.BLUE, id: 'T-AKE-9',
    name: 'USNS CAPE HATTERAS', hullNo: 'T-AKE-9',
    x: tfX - 2900, z: tfZ - 6400, heading: 8 * D2R, speed: 16 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });

  const ffg1 = world.spawn({
    className: 'FFG_CONSTELLATION', side: SIDE.BLUE, id: 'FFG-64',
    name: 'USS SENTINEL', hullNo: 'FFG-64',
    x: tfX - 14000, z: tfZ + 9000, heading: 8 * D2R, speed: 16 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  const ffg2 = world.spawn({
    className: 'FFG_CONSTELLATION', side: SIDE.BLUE, id: 'FFG-67',
    name: 'USS VANGUARD', hullNo: 'FFG-67',
    x: tfX + 15000, z: tfZ + 8000, heading: 8 * D2R, speed: 16 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  const ddg2 = world.spawn({
    className: 'DDG_FLIGHT_IIA', side: SIDE.BLUE, id: 'DDG-118',
    name: 'USS CUTLASS', hullNo: 'DDG-118',
    x: tfX + 1000, z: tfZ - 14000, heading: 8 * D2R, speed: 16 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  ddg2.mags.LRASM = 16;
  ddg2.magsMax.LRASM = 16;

  // Screen stations relative to the guide. A real screen is assigned by threat
  // axis; here the ASW-capable frigates lead and the AAW destroyers cover the HVUs.
  ffg1.station = { guide, relBearing: -35 * D2R, range: 22000 };
  ffg2.station = { guide, relBearing: 35 * D2R, range: 22000 };
  ddg2.station = { guide, relBearing: 180 * D2R, range: 12000 };
  // The high value units sit well behind the screen, on the disengaged quarter.
  hvu1.station = { guide, relBearing: 160 * D2R, range: 15000 };
  hvu2.station = { guide, relBearing: -160 * D2R, range: 16000 };

  const ssn = world.spawn({
    className: 'SSN_VIRGINIA', side: SIDE.BLUE, id: 'SSN-796',
    name: 'USS RAVENNA', hullNo: 'SSN-796',
    x: tfX + 6000, z: tfZ + 78000, heading: 8 * D2R, speed: 6 * KNOT,
    alt: -120, emcon: EMCON.SILENT, roe: ROE.TIGHT,
  });
  ssn.depthOrdered = -120;

  // One Poseidon already on station — a hint, in the shape of an asset, that the
  // answer to "I cannot see" is altitude.
  const mpa = world.spawn({
    className: 'MPA_P8', side: SIDE.BLUE, id: 'VP-71',
    name: 'POSEIDON 71',
    x: tfX - 30000, z: tfZ + 40000, heading: 15 * D2R,
    alt: 8000, emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  mpa.fuel = mpa.maxFuel * 0.86;
  mpa.setOrbit(tfX, tfZ + 60000, 26000);
  // On station with the task force, not up-threat. Getting her north is the
  // player's first decision and the first place the horizon lesson bites.
  mpa.x = tfX - 25000; mpa.z = tfZ + 55000;

  // A second Poseidon, held back. Losing the first one to a SAM envelope is a
  // very common and very instructive mistake, and a scenario where that mistake
  // is unrecoverable teaches nothing except to reload.
  const mpa2 = world.spawn({
    className: 'MPA_P8', side: SIDE.BLUE, id: 'VP-72',
    name: 'POSEIDON 72',
    x: tfX + 40000, z: tfZ - 60000, heading: 10 * D2R,
    alt: 8000, emcon: EMCON.PASSIVE, roe: ROE.TIGHT,
  });
  mpa2.setOrbit(tfX + 30000, tfZ - 40000, 24000);

  // Airborne early warning.
  //
  // This aircraft is the answer to the central problem of task-force air
  // defence: a ship's radar horizon against a sea-skimmer is about thirty
  // kilometres, which is ninety seconds, and the only way to buy more is to lift
  // the radar off the sea. It also means the force can shoot on the Hawkeye's
  // picture while remaining in EMCON BRAVO itself — an escort that has never
  // radiated firing on a track somebody else is holding is the kill web doing
  // exactly what it exists to do.
  const aew = world.spawn({
    className: 'AEW_E2D', side: SIDE.BLUE, id: 'VAW-121',
    name: 'HAWKEYE 601',
    x: tfX - 8000, z: tfZ + 22000, heading: 8 * D2R,
    alt: 9000, emcon: EMCON.FULL, roe: ROE.TIGHT,
  });
  aew.setOrbit(tfX, tfZ + 30000, 22000);

  // ── RED: Volsk Northern Fleet SAG OTVAZHNY ────────────────────────────────
  const cg = world.spawn({
    className: 'CG_SLAVA', side: SIDE.RED, id: 'RED-CG',
    name: 'VOLNA', x: redX, z: redZ, heading: redCourse, speed: 15 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.FREE,
  });
  const rd1 = world.spawn({
    className: 'DDG_UDALOY', side: SIDE.RED, id: 'RED-DD1',
    name: 'GROMKIY', x: redX - 11000, z: redZ + 6000, heading: redCourse, speed: 15 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.FREE,
  });
  const rd2 = world.spawn({
    className: 'DDG_UDALOY', side: SIDE.RED, id: 'RED-DD2',
    name: 'BESSTRASHNY', x: redX + 12500, z: redZ + 5000, heading: redCourse, speed: 15 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.FREE,
  });
  const rf1 = world.spawn({
    className: 'FFG_STEREGUSHCHY', side: SIDE.RED, id: 'RED-FF1',
    name: 'SMETLIVY', x: redX - 4000, z: redZ - 12000, heading: redCourse, speed: 15 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.FREE,
  });
  const rf2 = world.spawn({
    className: 'FFG_STEREGUSHCHY', side: SIDE.RED, id: 'RED-FF2',
    name: 'ZORKIY', x: redX + 6000, z: redZ - 13500, heading: redCourse, speed: 15 * KNOT,
    emcon: EMCON.PASSIVE, roe: ROE.FREE,
  });

  const rsub = world.spawn({
    className: 'SSGN_AKULA', side: SIDE.RED, id: 'RED-SS',
    // Its own bearing, independent of the surface group — a submarine that always
    // sat in the same box was the one contact the player never had to search for.
    name: 'B-471 KRASNODAR',
    x: OBJ.x + Math.sin(rng.range(-2.4, 2.4)) * rng.range(40000, 130000),
    z: OBJ.z + Math.cos(rng.range(-2.4, 2.4)) * rng.range(30000, 110000),
    heading: Math.PI, speed: 5 * KNOT, alt: -150, emcon: EMCON.SILENT, roe: ROE.FREE,
  });
  rsub.depthOrdered = -150;

  const rmpa = world.spawn({
    className: 'MPA_BEAR', side: SIDE.RED, id: 'RED-MPA',
    name: 'MEDVED 04',
    x: redX + rng.range(-120000, 120000), z: redZ + rng.range(50000, 130000),
    heading: Math.PI, alt: 7000, emcon: EMCON.FULL, roe: ROE.TIGHT,
  });

  for (let i = 0; i < 4; i++) {
    const b = world.spawn({
      className: 'BOMBER_BACKFIRE', side: SIDE.RED, id: `RED-BMR${i}`,
      name: `RAIDER ${i + 1}`,
      x: scenario.redAirbase.x + i * 3000, z: scenario.redAirbase.z,
      heading: Math.PI, alt: 10500, emcon: EMCON.SILENT, roe: ROE.TIGHT,
      speed: 260,
    });
    b.fuel = b.maxFuel;
  }

  // ── NEUTRAL shipping ───────────────────────────────────────────────────────
  // The identification problem, in physical form. Three of these will sit inside
  // your best ESM cut on the SAG at some point in the next two hours.
  // Real lanes, not scatter. Merchant traffic in any sea follows a handful of
  // great-circle routes between ports, so the neutrals here run on three of
  // them — and one of those lanes passes straight through the intel box, which
  // is precisely why the identification problem is a problem.
  /*
   * Lanes have to cross the track the task group is actually going to steam.
   *
   * These were laid out against the corners of the area of operations, and the
   * transit runs from (-20000, -200000) to POINT OSCAR at (30000, 20000): about
   * 225 km on a course of 013. Measured against that corridor, the nearest
   * neutral in the whole scenario passed 71 km abeam and most were 160 to 326 km
   * off. In four hours of steaming the player met no shipping at all.
   *
   * Everything downstream depended on it. The signal that fires when a merchant
   * closes inside the screen needs one within 26 km of a high-value unit; the
   * fishing-fleet signal needs two contacts in a cone ahead. Neither condition
   * was ever satisfiable, so five of the twelve generators never fired once in a
   * four-hour sortie and the sea was empty.
   *
   * A task group does not get a private ocean. It transits the lanes that are
   * there, and having to sort a freighter from a warship at forty miles is the
   * problem this game is about — so one lane now crosses the corridor early,
   * another crosses it late, and the third stays out wide as background traffic.
   */
  const LANES = [
    // Crosses the base course at about (2000, -120000), a third of the way up.
    { name: 'KESTREL PASSAGE', a: { x: -AO_HALF * 0.62, z: -AO_HALF * 0.52 }, b: { x: AO_HALF * 0.70, z: -AO_HALF * 0.16 } },
    // Crosses again on the approach to POINT OSCAR, around (22000, -20000).
    { name: 'NORTHERN APPROACH', a: { x: -AO_HALF * 0.80, z: AO_HALF * 0.02 }, b: { x: AO_HALF * 0.86, z: -AO_HALF * 0.24 } },
    // Background traffic, well clear to the east.
    { name: 'COASTAL', a: { x: AO_HALF * 0.42, z: AO_HALF * 0.55 }, b: { x: AO_HALF * 0.95, z: -AO_HALF * 0.30 } },
  ];
  world.lanes = LANES;
  for (let i = 0; i < 12; i++) {
    const isTrawler = i >= 9;
    let x, z, hdg;
    if (isTrawler) {
      // Fishing works grounds, not routes: a loose cluster over a bank.
      //
      // The bank was at (6000, 52000) — past POINT OSCAR, and 250 km up the
      // track from where the task group starts. Nobody ever saw it. A bank sits
      // where the bottom brings the fish up, and this one is on the shelf edge
      // the group crosses about an hour out, which is exactly the kind of place a
      // warship at twenty knots has to think about gear in the water.
      const bx = -9000, bz = -152000;
      x = bx + rng.range(-15000, 15000);
      z = bz + rng.range(-11000, 11000);
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
      className: isTrawler ? 'TRAWLER' : 'MERCHANT', side: SIDE.NEUTRAL,
      id: `NEU-${i}`,
      name: isTrawler
        ? TRAWLER_NAMES[(i - 9) % TRAWLER_NAMES.length]
        : MERCHANT_NAMES[i % MERCHANT_NAMES.length],
      x, z, heading: hdg, speed: (isTrawler ? 5 : 15) * KNOT,
      emcon: EMCON.RESTRICTED, roe: ROE.HOLD,
    });
    m.orderCourse(hdg, m.cls.maxSpeed * (isTrawler ? 0.35 : 0.8));
    m.lane = isTrawler ? 'FISHING' : LANES[i % LANES.length].name;
  }

  world.blueGuide = guide;
  world.blueHvu = [hvu1, hvu2];
  world.blueUnitsOrder = [guide, ddg2, ffg1, ffg2, hvu1, hvu2, ssn, mpa, mpa2, aew];
  world.redSag = [cg, rd1, rd2, rf1, rf2];

  return world;
}

/**
 * Mission state machine and scoring. Phases are not gates the player has to
 * unlock — they are a readout of what the situation currently demands, so the
 * objective panel always says something true and useful.
 */
export class Mission {
  constructor(world) {
    this.world = world;
    this.phase = 'SEARCH';
    this.status = 'ACTIVE';
    this.startedAt = world.time;
    this.objectives = [
      { id: 'FIND', text: 'Locate the Volsk surface action group', detail: 'Gain a track of any quality on a hostile surface combatant', done: false, key: true },
      { id: 'TQ', text: 'Develop a weapons-quality track (TQ4+)', detail: 'A firing solution needs an error ellipse smaller than a missile seeker basket', done: false, key: true },
      { id: 'CG', text: 'Neutralise the Volna-class cruiser', detail: 'She carries sixteen P-1000 with a 300 nm reach — she is the threat', done: false, key: true },
      { id: 'ESCORTS', text: 'Destroy at least three hostile escorts', done: false, key: false },
      { id: 'OSCAR', text: 'Escort GRANITE BAY to POINT OSCAR', detail: 'The landing force has to arrive. That is the mission.', done: false, key: true },
      { id: 'HVU', text: 'Both high value units survive', done: false, key: false, negative: true },
    ];
    this.failReason = null;
    this.hints = [];
    this._hintsShown = new Set();
    this.grade = null;
    this.oscarProgress = 0;
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
    const table = w.picture('BLUE');
    const now = w.time;

    const redSurface = w.units.filter(u => u.side === 'RED' && u.domain === 'SURFACE');
    const redAlive = redSurface.filter(u => u.alive);
    const cg = w.units.find(u => u.id === 'RED-CG');
    const hvus = w.units.filter(u => u.side === 'BLUE' && u.hvu);
    const granite = w.units.find(u => u.id === 'LPD-31');

    const sagTracks = table.list.filter(t =>
      !t.faded && t.identity === 'HOSTILE' && t.domain === 'SURFACE' &&
      redSurface.some(r => r.id === t.truthId));
    const bestTq = sagTracks.reduce((m, t) => Math.max(m, t.tq), 0);

    this.objectives[0].done ||= sagTracks.length > 0;
    if (bestTq >= WEAPONS_QUALITY_TQ && !this.objectives[1].done) {
      this.objectives[1].done = true;
      if (w.stats.timeToFirstWeaponsQuality === null) w.stats.timeToFirstWeaponsQuality = now - this.startedAt;
    }
    this.objectives[2].done = !!cg && !cg.alive;
    this.objectives[3].done = redSurface.filter(u => !u.alive && u !== cg).length >= 3;
    this.objectives[5].done = hvus.every(u => u.alive);

    if (granite && granite.alive) {
      const d = Math.hypot(granite.x - w.scenario.objectivePoint.x, granite.z - w.scenario.objectivePoint.z);
      this.oscarProgress = Math.max(this.oscarProgress, 1 - Math.min(1, d / 430000));
      if (d < w.scenario.objectivePoint.radius) this.objectives[4].done = true;
    }

    // Phase readout
    if (!this.objectives[0].done) this.phase = 'SEARCH';
    else if (!this.objectives[1].done) this.phase = 'DEVELOP';
    else if (!this.objectives[2].done) this.phase = 'STRIKE';
    else if (!this.objectives[4].done) this.phase = 'TRANSIT';
    else this.phase = 'COMPLETE';

    const inbound = w.weapons.filter(o => o.alive && o.side === 'RED' && o.category === 'ASM').length;
    if (inbound > 0) this.phase = 'DEFEND';

    this._hints(now, table, bestTq, sagTracks, inbound);

    // ── win / loss ──────────────────────────────────────────────────────────
    if (this.status !== 'ACTIVE') return;
    // Only the landing force is mission-critical. Losing the oiler is a serious
    // blow and a heavy scoring penalty, but a task force that has lost its
    // replenishment ship can still put the Marines ashore — ending the whole
    // operation on it made a single unlucky leaker into an instant loss.
    if (granite && !granite.alive) {
      this._end('FAILURE', 'GRANITE BAY is lost with the landing force embarked. The operation is over.');
      return;
    }
    if (this.objectives[4].done && this.objectives[2].done) {
      this._end('SUCCESS', 'GRANITE BAY is at POINT OSCAR and the hostile surface action group has been broken.');
      return;
    }
    if (this.objectives[4].done && redAlive.length === 0) {
      this._end('SUCCESS', 'Objective secured. The Kestrel Sea belongs to Task Force 44.');
      return;
    }
    if (now - this.startedAt > w.scenario.timeLimit) {
      this._end('FAILURE', 'The landing window has closed. GRANITE BAY did not reach POINT OSCAR in time.');
    }
  }

  /**
   * Contextual guidance. Deliberately delivered as watch-officer radio traffic in
   * the comms log rather than as modal tutorial boxes — the player is being
   * advised by their staff, which is both less annoying and closer to the truth.
   */
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
    add('High value units intact', w.units.filter(u => u.hvu && u.alive).length * 250,
      `${w.units.filter(u => u.hvu && u.alive).length} of 2 HVUs afloat`);
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
    if (this.objectives[4].done) add('POINT OSCAR reached', 300, 'Landing force delivered');

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
    const rank = total > 1400 ? 'DISTINGUISHED'
      : total > 850 ? 'EFFECTIVE'
        : total > 300 ? 'MARGINAL' : 'UNSATISFACTORY';
    return { total, pts, rank };
  }
}
