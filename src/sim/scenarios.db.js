import { SIDE, DOMAIN, IDENT, D2R, KNOT, WEAPONS_QUALITY_TQ } from './constants.js';
import { layoutBlue, layoutRed } from './forces.db.js';

/**
 * The missions.
 *
 * Until this file existed there was one scenario, and it was not a scenario —
 * it was the scenario builder. Objectives were six literals indexed by number
 * inside Mission.step, the win condition named a specific hull by its pennant,
 * and the phase readout was a chain of ifs about POINT OSCAR. Which meant the
 * second time anybody played, they played the first time again.
 *
 * A scenario is now a definition: who is there, what counts as done, what
 * counts as over, and what the watch is called. Mission consumes it and knows
 * nothing about landing forces or cruisers.
 *
 * Each objective owns its own test. Each scenario owns its phase readout and
 * its outcome. The shared per-step context is computed once and handed to all
 * of them, because otherwise every check re-scans the picture.
 */

const MIN = 60, H = 3600;

/** Everything a check might want, worked out once per step. */
export function missionContext(w, m) {
  const table = w.picture(SIDE.BLUE) || { list: [] };
  const redSurface = w.units.filter(u => u.side === SIDE.RED && u.domain === DOMAIN.SURFACE);
  const redSubs = w.units.filter(u => u.side === SIDE.RED && u.isSub);
  const blueShips = w.units.filter(u => u.side === SIDE.BLUE && !u.isAir && !u.isSub);
  const sagTracks = table.list.filter(t => !t.faded && t.identity === IDENT.HOSTILE
    && t.domain === DOMAIN.SURFACE && redSurface.some(r => r.id === t.truthId));
  const subTracks = table.list.filter(t => !t.faded && t.domain === DOMAIN.SUBSURFACE
    && redSubs.some(r => r.id === t.truthId));
  return {
    table, redSurface, redSubs, blueShips, sagTracks, subTracks,
    redAlive: redSurface.filter(u => u.alive),
    hvus: w.units.filter(u => u.side === SIDE.BLUE && u.hvu),
    bestTq: sagTracks.reduce((a, t) => Math.max(a, t.tq), 0),
    subTq: subTracks.reduce((a, t) => Math.max(a, t.tq), 0),
    inbound: w.weapons.filter(o => o.alive && o.side === SIDE.RED && o.category === 'ASM').length,
    elapsed: w.time - m.startedAt,
  };
}

/** Shared sea. Every scenario is fought in the Kestrel Sea. */
const KESTREL = {
  datum: { lat: 62.0, lon: 8.0 },
  islands: [
    { id: 'KESTREL', name: 'KESTREL I.', x: 34000, z: 6000, radius: 5200, height: 620, seed: 17 },
    { id: 'SKUA', name: 'SKUA ROCK', x: 12000, z: 26000, radius: 1500, height: 120, seed: 44 },
    { id: 'BRANT', name: 'BRANT I.', x: 58000, z: 30000, radius: 3100, height: 430, seed: 91 },
    { id: 'GANNET', name: 'GANNET SKERRIES', x: -8000, z: 44000, radius: 900, height: 46, seed: 63 },
  ],
  redAirbase: { x: 210000, z: 415000, name: 'VOLSK NAVAL AIR STATION' },
  blueAirbase: { x: -330000, z: -430000, name: 'NAS KESTREL POINT', alive: true },
};

/** A blue force at an anchor, laid out in formation. */
function blue(x, z, courseDeg, ships) {
  const a = { x, z, course: courseDeg * D2R };
  return { ...a, units: layoutBlue(ships, a) };
}
function redSag(x, z, courseDeg, ships) {
  const a = { x, z, course: courseDeg * D2R };
  return { ...a, units: layoutRed(ships, a) };
}

export const SCENARIOS = [
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'NORTH_ANCHOR',
    name: 'OPERATION NORTH ANCHOR',
    tag: 'Escort · search · strike',
    blurb: 'Get the landing force to POINT OSCAR. A hostile surface action group is somewhere in four hundred miles of empty water and outranges everything you own.',
    subtitle: 'Kestrel Sea · Task Force 44',
    startTime: 5 * H + 15 * MIN,
    timeLimit: 7.5 * H,
    difficulty: 'The full problem',
    briefing: [
      'Two hours ago a Volsk surface action group sortied from the northern basin and went dark. Fleet intelligence puts them somewhere in the shaded box — a hundred and sixty thousand square miles of empty grey water, five and a half hours stale.',
      'Task Force 44 is escorting GRANITE BAY and CAPE HATTERAS north to POINT OSCAR. The landing force embarked in GRANITE BAY has to be there. That is the mission; everything else is in support of it.',
      'The SAG is built around a Volna-class cruiser with sixteen supersonic anti-ship missiles that outrange everything you own by two hundred miles. If he finds you first, you will not get to choose the terms of the engagement.',
      'Find him. Get a weapons-quality track. Hold it long enough for your missiles to arrive. And keep your emissions off the air until the moment shooting is better than hiding.',
    ],
    objectivePoint: { x: 30000, z: 20000, name: 'POINT OSCAR', radius: 30000 },
    intent: [
      'Find the surface action group before it finds you. Build a firing solution out of whatever sensors you can put over the horizon, keep custody of it while your missiles are in the air, and get GRANITE BAY to POINT OSCAR.',
      'KEARSARGE BAY is your reach. Her wing can put weapons where no launcher in this force can, but a deck is a queue — an anti-ship fit is thirty minutes of ordnance work per aircraft, and nothing is catapulted while somebody is landing. Decide what you are building before you know you need it.',
    ],
    caution: 'Positive identification before launch. There is neutral traffic all over this water, and a seeker cannot tell a frigate from a container ship.',
    hints: true,
    objectives: [
      { id: 'FIND', text: 'Locate the Volsk surface action group', detail: 'Gain a track of any quality on a hostile surface combatant', key: true,
        check: (w, m, c) => c.sagTracks.length > 0 },
      { id: 'TQ', text: 'Develop a weapons-quality track (TQ4+)', detail: 'A firing solution needs an error ellipse smaller than a missile seeker basket', key: true,
        check: (w, m, c) => c.bestTq >= WEAPONS_QUALITY_TQ },
      { id: 'CG', text: 'Neutralise the Volna-class cruiser', detail: 'She carries sixteen P-1000 with a 300 nm reach — she is the threat', key: true,
        check: (w) => { const cg = w.units.find(u => u.className === 'CG_SLAVA'); return !!cg && !cg.alive; } },
      { id: 'ESCORTS', text: 'Destroy at least three hostile escorts',
        check: (w, m, c) => c.redSurface.filter(u => !u.alive && u.className !== 'CG_SLAVA').length >= 3 },
      { id: 'OSCAR', text: 'Escort GRANITE BAY to POINT OSCAR', detail: 'The landing force has to arrive. That is the mission.', key: true,
        check: (w, m) => m.reached('LPD') },
      { id: 'HVU', text: 'Both high value units survive', negative: true,
        check: (w, m, c) => c.hvus.every(u => u.alive) },
    ],
    phase: (w, m, c) => {
      if (c.inbound > 0) return 'DEFEND';
      if (!m.done('FIND')) return 'SEARCH';
      if (!m.done('TQ')) return 'DEVELOP';
      if (!m.done('CG')) return 'STRIKE';
      if (!m.done('OSCAR')) return 'TRANSIT';
      return 'COMPLETE';
    },
    outcome: (w, m, c) => {
      const lpd = w.units.find(u => u.className === 'LPD');
      if (lpd && !lpd.alive) return { status: 'FAILURE', reason: 'GRANITE BAY is lost with the landing force embarked. The operation is over.' };
      if (m.done('OSCAR') && m.done('CG')) return { status: 'SUCCESS', reason: 'GRANITE BAY is at POINT OSCAR and the hostile surface action group has been broken.' };
      if (m.done('OSCAR') && c.redAlive.length === 0) return { status: 'SUCCESS', reason: 'Objective secured. The Kestrel Sea belongs to Task Force 44.' };
      if (c.elapsed > w.scenario.timeLimit) return { status: 'FAILURE', reason: 'The landing window has closed. GRANITE BAY did not reach POINT OSCAR in time.' };
      return null;
    },
    spec: (seed, rng) => {
      // The enemy in polar coordinates about the objective, so the bearing is a
      // real unknown rather than a memorised one.
      const OBJ = { x: 30000, z: 20000 };
      const brg = (-75 + rng.range(0, 150)) * D2R;
      const rge = rng.range(185000, 295000);
      const rx = OBJ.x + Math.sin(brg) * rge, rz = OBJ.z + Math.cos(brg) * rge;
      return {
        posture: 'COLD',
        blue: blue(-20000, -200000, 8, [
          { cls: 'DDG_FLIGHT_IIA', n: 2 }, { cls: 'FFG_CONSTELLATION', n: 2 },
          { cls: 'CVN_FORD', n: 1 }, { cls: 'LPD', n: 1 },
          { cls: 'AOE', n: 1 }, { cls: 'SSN_VIRGINIA', n: 1 },
        ]),
        red: {
          sag: redSag(rx, rz, (Math.atan2(OBJ.x - rx, OBJ.z - rz) + rng.range(-0.22, 0.22)) / D2R, [
            { cls: 'CG_SLAVA', n: 1 }, { cls: 'DDG_UDALOY', n: 2 }, { cls: 'FFG_STEREGUSHCHY', n: 2 },
          ]),
          subs: 1, mpa: 1, bombers: 4,
        },
        neutral: { merchants: 9, trawlers: 3 },
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'BARRIER',
    name: 'OPERATION COLD IRON',
    tag: 'Anti-submarine · search',
    blurb: 'A Volsk SSGN is somewhere ahead of the convoy lane. Find it with sonobuoys, dipping sonar and a towed array before it finds the ships behind you.',
    subtitle: 'Kestrel Sea · barrier patrol',
    startTime: 4 * H + 40 * MIN,
    timeLimit: 5 * H,
    difficulty: 'One problem, done properly',
    briefing: [
      'A Volsk Akula sailed from the northern basin nine hours ago and has not been seen since. Sound surveillance holds a probable transit into the Kestrel Sea, and the convoy lane runs straight through it.',
      'You are the barrier. Four hulls, two Poseidons and whatever you can put in the water. He is quiet, he is deep, and he is between you and the ships you are covering.',
      'A towed array only hears at slow speed. A sonobuoy hears for an hour after you have gone home. A dipping sonar hears exactly where you put it and nowhere else. Use all three, and remember that going active tells him precisely where you are.',
      'Kill him before he reaches the lane. If you cannot kill him, at least hold contact — a submarine being tracked is a submarine that cannot set up.',
    ],
    objectivePoint: { x: -20000, z: -30000, name: 'BARRIER CENTRE', radius: 40000 },
    intent: [
      'Hold the barrier. Something is trying to get through it submerged, and the only thing that finds a quiet boat is patience and a sensor in the right water — a towed array below the layer, or buoys laid where he has to cross.',
      'Your helicopters are the reach here, not your missiles. A dipping sonar puts an ear anywhere you like for twenty minutes at a time, and a barrier laid an hour ago has run out of battery. Relay them so the line never has a hole in it.',
    ],
    caution: 'Active sonar finds him faster and tells him exactly where you are. Choose deliberately which of those two you would rather have.',
    objectives: [
      { id: 'DETECT', text: 'Gain contact on the submarine', detail: 'Any track, any quality, on the subsurface contact', key: true,
        check: (w, m, c) => c.subTracks.length > 0 },
      { id: 'HOLD', text: 'Develop the contact to TQ3 or better', detail: 'A torpedo needs somewhere to be dropped', key: true,
        check: (w, m, c) => c.subTq >= 3 },
      { id: 'KILL', text: 'Sink the submarine', key: true,
        check: (w, m, c) => c.redSubs.length > 0 && c.redSubs.every(u => !u.alive) },
      { id: 'INTACT', text: 'No friendly losses', negative: true,
        check: (w, m, c) => c.blueShips.every(u => u.alive) },
    ],
    phase: (w, m, c) => {
      if (c.inbound > 0 || w.weapons.some(o => o.alive && o.category === 'TORPEDO' && o.side === SIDE.RED)) return 'DEFEND';
      if (m.done('KILL')) return 'COMPLETE';
      if (!m.done('DETECT')) return 'SEARCH';
      if (!m.done('HOLD')) return 'DEVELOP';
      return 'PROSECUTE';
    },
    outcome: (w, m, c) => {
      if (m.done('KILL')) return { status: 'SUCCESS', reason: 'The submarine is on the bottom. The lane is open.' };
      const lost = c.blueShips.filter(u => !u.alive).length;
      if (lost >= 2) return { status: 'FAILURE', reason: 'Two hulls lost to a submarine you never held. The barrier has failed.' };
      if (c.elapsed > w.scenario.timeLimit) {
        return { status: 'FAILURE', reason: 'The convoy is entering the lane and the submarine is still out there somewhere.' };
      }
      return null;
    },
    spec: (seed, rng) => {
      const brg = rng.range(-2.2, 2.2), rge = rng.range(55000, 130000);
      return {
        posture: 'COLD',
        blue: blue(-20000, -120000, 12, [
          { cls: 'DDG_FLIGHT_IIA', n: 1 }, { cls: 'FFG_CONSTELLATION', n: 3 },
          { cls: 'SSN_VIRGINIA', n: 1 },
        ]),
        red: {
          sag: redSag(240000, 250000, 200, []),
          subs: 1, mpa: 0, bombers: 0,
          subAnchor: { x: -20000 + Math.sin(brg) * rge, z: -30000 + Math.cos(brg) * rge },
        },
        neutral: { merchants: 6, trawlers: 4 },
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'ALPHA',
    name: 'OPERATION HAMMERFALL',
    tag: 'Carrier strike · deck management',
    blurb: 'The SAG is located and you have a carrier. Build the strike, launch it, and put the cruiser on the bottom before the window closes.',
    subtitle: 'Kestrel Sea · Carrier Strike Group',
    startTime: 6 * H + 30 * MIN,
    timeLimit: 3.5 * H,
    difficulty: 'A clock, not a search',
    briefing: [
      'Intelligence has them. A Volsk surface action group, two hundred and sixty miles north-east, holding a barrier across the approaches. The track is fresh and somebody is keeping it that way.',
      'This is not a search problem. You know where he is. What you do not have is time: the window closes in three and a half hours, and an anti-ship fit is thirty minutes of ordnance work per aircraft before anything leaves the deck.',
      'Twelve spots. Nothing catapults while an aircraft is landing. Decide what you are building before you know you need it, because you will not get to change your mind quickly.',
      'And keep custody. The missiles fly at the track, not at the ship — if the fix goes stale while they are in the air, they will search the water where he used to be.',
    ],
    objectivePoint: { x: 30000, z: 20000, name: 'POINT OSCAR', radius: 30000 },
    intent: [
      'This is a deck problem wearing a strike problem\'s clothes. The air wing can reach further than anything else in the force, but an anti-ship fit is thirty minutes of ordnance work per aircraft, nothing launches while somebody is recovering, and the window does not wait for you.',
      'Decide the package before you have the track. If you start building the strike when the solution firms up, the solution will be stale by the time the aircraft are ready.',
    ],
    caution: 'A strike launched at a track you have stopped watching is a strike at where he used to be.',
    objectives: [
      { id: 'ARMED', text: 'Build a strike package', detail: 'Four or more aircraft armed with an anti-ship fit', key: true,
        check: (w) => w.units.some(u => u.alive && u.deck
          && (u.deck.count('READY', 'FA18E', 'STRIKE') + u.deck.count('AIRBORNE', 'FA18E', 'STRIKE')) >= 4) },
      { id: 'AIRBORNE', text: 'Get the package airborne', key: true,
        check: (w) => w.units.filter(u => u.alive && u.airRole === 'STRIKE').length >= 2 },
      { id: 'CG', text: 'Sink the Volna-class cruiser', key: true,
        check: (w) => { const cg = w.units.find(u => u.className === 'CG_SLAVA'); return !!cg && !cg.alive; } },
      { id: 'ESCORTS', text: 'Break the escort — three or more hostile hulls',
        check: (w, m, c) => c.redSurface.filter(u => !u.alive).length >= 3 },
      { id: 'CVN', text: 'The carrier survives', negative: true,
        check: (w) => { const cv = w.units.find(u => u.className === 'CVN_FORD'); return !cv || cv.alive; } },
    ],
    phase: (w, m, c) => {
      if (c.inbound > 0) return 'DEFEND';
      if (m.done('CG')) return 'COMPLETE';
      if (!m.done('ARMED')) return 'ARMING';
      if (!m.done('AIRBORNE')) return 'LAUNCH';
      return 'STRIKE';
    },
    outcome: (w, m, c) => {
      const cv = w.units.find(u => u.className === 'CVN_FORD');
      if (cv && !cv.alive) return { status: 'FAILURE', reason: 'The carrier is lost. Without her there is no strike and no air cover.' };
      if (m.done('CG')) return { status: 'SUCCESS', reason: 'The cruiser is gone and the wing came home. That is what a carrier is for.' };
      if (c.elapsed > w.scenario.timeLimit) return { status: 'FAILURE', reason: 'The window has closed with the cruiser still afloat.' };
      return null;
    },
    spec: (seed, rng) => {
      const brg = rng.range(-0.9, 0.9) + 0.6, rge = rng.range(230000, 300000);
      const rx = 30000 + Math.sin(brg) * rge, rz = 20000 + Math.cos(brg) * rge;
      return {
        posture: 'WARM',
        blue: blue(-10000, -150000, 20, [
          { cls: 'DDG_FLIGHT_IIA', n: 2 }, { cls: 'FFG_CONSTELLATION', n: 1 },
          { cls: 'CVN_FORD', n: 1 }, { cls: 'AOE', n: 1 },
        ]),
        red: {
          sag: redSag(rx, rz, (Math.atan2(-rx, -rz) + rng.range(-0.3, 0.3)) / D2R, [
            { cls: 'CG_SLAVA', n: 1 }, { cls: 'DDG_UDALOY', n: 2 }, { cls: 'FFG_STEREGUSHCHY', n: 2 },
          ]),
          subs: 0, mpa: 1, bombers: 4,
        },
        neutral: { merchants: 7, trawlers: 2 },
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'GAUNTLET',
    name: 'OPERATION CLEAN HANDS',
    tag: 'Identification · rules of engagement',
    blurb: 'Heavy neutral traffic, a hostile hiding inside it, and weapons free. Get through without killing anybody who did not deserve it.',
    subtitle: 'Kestrel Sea · congested waters',
    startTime: 11 * H + 10 * MIN,
    timeLimit: 4 * H,
    difficulty: 'The hardest thing this game asks',
    briefing: [
      'The northern shipping lanes are packed. Fourteen merchant hulls and a fishing fleet working the shelf edge, and somewhere in the middle of it a Volsk task group that has been told to look exactly like everybody else.',
      'A seeker cannot tell a frigate from a container ship. You can — but only if you go and look, and looking takes a sensor that is then not looking anywhere else.',
      'Weapons are free. That is not permission, it is exposure. Every hull you put on the bottom that turns out to be carrying grain is an international incident and it will be in your record.',
      'Positive identification before launch. Take the time. The one thing worse than a hostile getting through is a neutral that did not.',
    ],
    objectivePoint: { x: 40000, z: 60000, name: 'WAYPOINT ROMEO', radius: 34000 },
    intent: [
      'This water is full of people who are not shooting at you. Get the task force through it without killing any of them, and without letting the one that is hostile get inside your screen because you were being careful.',
      'Identification is the whole mission. An emitter fingerprint, a visual pass by a helicopter, a course that makes no commercial sense — build the picture before the rules of engagement force your hand rather than after.',
    ],
    caution: 'Every round you fire here is one you will have to justify. So is every one you did not.',
    objectives: [
      { id: 'ID', text: 'Positively identify six surface contacts', detail: 'Visual or electro-optical identification — not a radar return', key: true,
        check: (w, m, c) => c.table.list.filter(t => t.identityLocked && t.domain === DOMAIN.SURFACE).length >= 6 },
      { id: 'HOSTILE', text: 'Find the hostile group inside the traffic', key: true,
        check: (w, m, c) => c.sagTracks.length > 0 },
      { id: 'KILL', text: 'Destroy at least two hostile combatants', key: true,
        check: (w, m, c) => c.redSurface.filter(u => !u.alive).length >= 2 },
      { id: 'CLEAN', text: 'No neutral vessel destroyed by TF-44', negative: true, key: true,
        check: (w) => !w.stats.neutralLosses.some(l => l.by === SIDE.BLUE) },
    ],
    phase: (w, m, c) => {
      if (c.inbound > 0) return 'DEFEND';
      if (m.done('KILL')) return 'COMPLETE';
      if (!m.done('HOSTILE')) return 'SORT';
      return 'ENGAGE';
    },
    outcome: (w, m, c) => {
      const killed = w.stats.neutralLosses.filter(l => l.by === SIDE.BLUE).length;
      if (killed >= 2) return { status: 'FAILURE', reason: `${killed} neutral vessels destroyed by this task force. The operation is finished and so are you.` };
      if (m.done('KILL') && m.done('CLEAN')) return { status: 'SUCCESS', reason: 'The hostile group is broken and not one neutral hull was touched. That is the job.' };
      if (c.elapsed > w.scenario.timeLimit) {
        return killed === 0
          ? { status: 'SUCCESS', reason: 'Transit complete with clean hands, though the hostile group slipped away.' }
          : { status: 'FAILURE', reason: 'Time expired, and there is a neutral hull on the bottom with your name on it.' };
      }
      return null;
    },
    spec: (seed, rng) => {
      const brg = rng.range(-1.3, 1.3), rge = rng.range(90000, 150000);
      const rx = 40000 + Math.sin(brg) * rge, rz = 60000 + Math.cos(brg) * rge;
      return {
        posture: 'WARM',
        blue: blue(-10000, -90000, 18, [
          { cls: 'DDG_FLIGHT_IIA', n: 2 }, { cls: 'FFG_CONSTELLATION', n: 2 },
          { cls: 'LPD', n: 1 },
        ]),
        red: {
          sag: redSag(rx, rz, (Math.atan2(-rx, -rz) + rng.range(-0.5, 0.5)) / D2R, [
            { cls: 'DDG_UDALOY', n: 1 }, { cls: 'FFG_STEREGUSHCHY', n: 2 },
          ]),
          subs: 0, mpa: 1, bombers: 0,
        },
        neutral: { merchants: 14, trawlers: 7 },
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'VAMPIRE',
    name: 'OPERATION IRON RAIN',
    tag: 'Air defence · survival',
    blurb: 'You are the target. The salvo is already in the air and more is coming. Fight the raid, keep the high value units afloat, and last the hour.',
    subtitle: 'Kestrel Sea · under attack',
    startTime: 17 * H + 5 * MIN,
    timeLimit: 1.5 * H,
    difficulty: 'No search, no choices, just the next four minutes',
    briefing: [
      'It has already started. A Volsk surface action group inside two hundred miles emptied half its launchers at us four minutes ago, and a Backfire regiment is staging out of Volsk behind them.',
      'There is no search phase and no clever answer. Everything is radiating, everyone knows where everyone is, and the only question is whether the screen holds.',
      'Layer the defence. SM-2 reaches furthest and needs a channel; ESSM is quad-packed and quick; RAM and the Phalanx are what is left when the rest has failed. Soft kill costs nothing and works more often than anybody admits.',
      'Keep GRANITE BAY and CAPE HATTERAS afloat for ninety minutes. That is the whole mission.',
    ],
    objectivePoint: { x: -20000, z: -140000, name: 'STATION KILO', radius: 50000 },
    intent: [
      'The salvo is already in the air. Layer the defence: SM-2 reaches furthest and needs a fire-control channel, ESSM is quad-packed and quick, RAM and the Phalanx are what is left when everything upstream has failed.',
      'Soft kill costs nothing and works more often than anyone admits. Spend decoys early — a seeker that takes the Nulka is a round you never had to shoot at.',
    ],
    caution: 'Keep GRANITE BAY and CAPE HATTERAS afloat. Nothing else on this sheet matters if they are not.',
    objectives: [
      { id: 'SURVIVE', text: 'Both high value units survive the raid', key: true, negative: true,
        check: (w, m, c) => c.hvus.length > 0 && c.hvus.every(u => u.alive) },
      { id: 'LEAKERS', text: 'Stop the first salvo — no leakers reach the HVUs', negative: true,
        check: (w, m, c) => c.hvus.every(u => u.hp >= u.maxHp * 0.999) },
      { id: 'COUNTER', text: 'Hit back — destroy two hostile combatants',
        check: (w, m, c) => c.redSurface.filter(u => !u.alive).length >= 2 },
      { id: 'SCREEN', text: 'Lose no more than one escort', negative: true,
        check: (w, m, c) => c.blueShips.filter(u => !u.alive && !u.hvu).length <= 1 },
    ],
    phase: (w, m, c) => {
      if (c.inbound > 0) return 'DEFEND';
      if (c.elapsed > w.scenario.timeLimit) return 'COMPLETE';
      return 'REARM';
    },
    outcome: (w, m, c) => {
      if (c.hvus.length && c.hvus.some(u => !u.alive)) {
        return { status: 'FAILURE', reason: 'A high value unit is gone. The screen did not hold.' };
      }
      if (c.elapsed > w.scenario.timeLimit) {
        return { status: 'SUCCESS', reason: 'Ninety minutes, and both of them are still afloat. The screen held.' };
      }
      return null;
    },
    spec: (seed, rng) => {
      const brg = rng.range(-1.1, 1.1), rge = rng.range(150000, 220000);
      const bx = -20000, bz = -140000;
      const rx = bx + Math.sin(brg) * rge, rz = bz + Math.cos(brg) * rge;
      return {
        posture: 'HOT',
        blue: blue(bx, bz, 8, [
          { cls: 'DDG_FLIGHT_IIA', n: 2 }, { cls: 'FFG_CONSTELLATION', n: 2 },
          { cls: 'LPD', n: 1 }, { cls: 'AOE', n: 1 },
        ]),
        red: {
          sag: redSag(rx, rz, (Math.atan2(bx - rx, bz - rz)) / D2R, [
            { cls: 'CG_SLAVA', n: 1 }, { cls: 'DDG_UDALOY', n: 2 }, { cls: 'FFG_STEREGUSHCHY', n: 1 },
          ]),
          subs: 0, mpa: 1, bombers: 6,
        },
        neutral: { merchants: 5, trawlers: 2 },
      };
    },
  },
];

export function scenarioById(id) {
  return SCENARIOS.find(s => s.id === id) || SCENARIOS[0];
}

export { KESTREL };
