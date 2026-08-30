import { buildScenario, Mission } from './Scenario.js';
import { Track } from './Tracks.js';
import { GENERATORS } from './Signals.js';

/**
 * Saving and loading a watch.
 *
 * The obstacle is not volume, it is REFERENCES. A running world is a graph:
 * a screen station points at the guide, a track points at the truth it is
 * shadowing and at every unit contributing to it, a missile points at its
 * shooter and its target, a deck frame points at the aircraft that came off it.
 * None of that survives JSON, and rebuilding it wrongly is worse than not
 * saving at all — a save that silently drops the tactical picture hands the
 * player back a game where they have lost custody of everything they worked
 * for.
 *
 * So the shape here is: SERIALISE STATE, REBUILD STRUCTURE. The save carries
 * the force spec, and loading rebuilds the world from it — which recreates
 * every unit with the right class, the right sensors and the right magazines,
 * already wired to each other. Then the saved state is written over the top by
 * id, and the references are re-pointed by looking each id up in the world that
 * now exists.
 *
 * Two things are deliberately not preserved:
 *
 *   Unanswered decisions. A Signal's choices carry apply() closures, which
 *   cannot be serialised. Rather than drop them, the load re-runs the
 *   generator that produced each pending signal — if the world still justifies
 *   the question, it is asked again with the remaining time on it. If the
 *   situation has resolved itself, it quietly does not come back, which is the
 *   honest outcome.
 *
 *   Aircraft trails and particle effects. Cosmetic, and they rebuild in seconds.
 */

const VERSION = 3;
const KEY = 'oth.saves';
const MAX_SLOTS = 6;

// ── unit ────────────────────────────────────────────────────────────────────

function saveUnit(u) {
  return {
    id: u.id, cls: u.className, name: u.name, hullNo: u.hullNo, side: u.side,
    x: u.x, z: u.z, alt: u.alt, heading: u.heading, speed: u.speed,
    hp: u.hp, alive: u.alive, despawned: !!u.despawned,
    damage: { ...u.damage },
    mags: { ...u.mags },
    ordered: { ...u.ordered },
    waypoints: (u.waypoints || []).map(w => ({ ...w })),
    patrol: u.patrol ? { ...u.patrol } : null,
    station: u.station ? { guide: u.station.guide.id, relBearing: u.station.relBearing, range: u.station.range } : null,
    fuel: u.fuel, depthOrdered: u.depthOrdered,
    homeBase: u.homeBase ? u.homeBase.id : null,
    airRole: u.airRole, loadoutId: u.loadoutId,
    rtb: !!u.rtb, flagship: !!u.flagship, hvu: !!u.hvu, neutral: !!u.neutral,
    lane: u.lane, radiating: !!u.radiating,
    strikeTrack: u.strikeTrack ? u.strikeTrack.id : null,
    // Class weapons are rewritten at launch from an aircraft's loadout, so the
    // list has to travel with the unit or a saved strike fighter reloads unarmed.
    clsWeapons: u.airRole ? (u.cls.weapons || []).map(w => ({ ...w })) : null,
    deck: u.deck ? {
      launchTimer: u.deck._launchTimer,
      frames: u.deck.frames.map(f => ({
        id: f.id, type: f.type, loadout: f.loadout, state: f.state,
        timer: f.timer, unit: f.unit ? f.unit.id : null,
      })),
      log: u.deck.log.slice(-12),
    } : null,
  };
}

function applyUnit(u, s, byId, trackById) {
  u.x = s.x; u.z = s.z; u.alt = s.alt; u.heading = s.heading; u.speed = s.speed;
  u.hp = s.hp; u.alive = s.alive; u.despawned = s.despawned;
  u.damage = { ...s.damage };
  u.mags = { ...s.mags };
  u.ordered = { ...u.ordered, ...s.ordered };
  u.waypoints.length = 0;
  for (const w of s.waypoints) u.waypoints.push({ ...w });
  u.patrol = s.patrol ? { ...s.patrol } : null;
  u.station = null;
  if (s.station) {
    const g = byId.get(s.station.guide);
    if (g) u.station = { guide: g, relBearing: s.station.relBearing, range: s.station.range };
  }
  u.fuel = s.fuel; u.depthOrdered = s.depthOrdered;
  u.homeBase = s.homeBase ? byId.get(s.homeBase) || null : null;
  u.airRole = s.airRole; u.loadoutId = s.loadoutId;
  u.rtb = s.rtb; u.flagship = s.flagship; u.lane = s.lane;
  u.strikeTrack = s.strikeTrack ? trackById.get(s.strikeTrack) || null : null;
  if (s.clsWeapons) u.cls = { ...u.cls, weapons: s.clsWeapons };
  if (s.deck && u.deck) {
    u.deck._launchTimer = s.deck.launchTimer;
    u.deck.frames = s.deck.frames.map(f => ({
      id: f.id, type: f.type, loadout: f.loadout, state: f.state,
      timer: f.timer, unit: f.unit ? byId.get(f.unit) || null : null,
    }));
    for (const f of u.deck.frames) if (f.unit) f.unit.deckFrame = f;
    u.deck.log = (s.deck.log || []).slice();
  }
}

// ── track ───────────────────────────────────────────────────────────────────

const TRACK_SCALARS = [
  'id', 'side', 'truthId', 'domain', 'created', 'lastUpdate', 'lastGoodUpdate',
  'x', 'z', 'vx', 'vz', 'alt', 'tq', 'sigma', 'classification', 'identity',
  'identityLocked', 'fingerprint', 'linked', 'linkAge', 'threat', 'lostAt',
  'faded', 'strength', 'newFlag', 'speedEst', 'courseEst', 'everWeaponsQuality',
  'assigned', 'silentSince',
  // Without this a restored track has measured === undefined, _refresh()
  // forces tq to 0, and any round in flight on a coasting track silently
  // loses its midcourse updates at the TQ3 gate in Ordnance.js.
  'measured',
];

function saveTrack(t) {
  const o = {};
  for (const k of TRACK_SCALARS) o[k] = t[k];
  o.P = Array.from(t.P);
  o.label = t.label;
  o.emitters = [...t.emitters];
  o.engagedBy = [...t.engagedBy];
  o.contributors = [...t.contributors.entries()].map(([id, v]) => [id, { t: v.t, kind: v.kind }]);
  o.bearingCuts = t.bearingCuts.map(c => ({ ...c }));
  return o;
}

// ── the whole thing ─────────────────────────────────────────────────────────

export function serialise(game) {
  const w = game.world;
  return {
    v: VERSION,
    at: Date.now(),
    label: `${w.scenario.name.replace(/^OPERATION /, '')} · ${fmtClock(w.time)}`,
    scenario: w.scenario.id,
    spec: w.spec,
    time: w.time,
    startedAt: w.startedAt,
    timeScale: game.timeScale,
    units: w.units.map(saveUnit),
    weapons: w.weapons.filter(o => o.alive).map(o => ({
      id: o.id, weaponId: o.weaponId, side: o.side, x: o.x, z: o.z, alt: o.alt,
      heading: o.heading, speed: o.speed, phase: o.phase, age: o.age,
      distance: o.distance, alive: o.alive, salvoId: o.salvoId,
      seekerActive: !!o.seekerActive, acquired: !!o.acquired,
      lofted: !!o.lofted, cruiseAlt: o.cruiseAlt, aim: o.aim ? { ...o.aim } : null,
      shooter: o.shooter ? o.shooter.id : null,
      truth: o.truth ? o.truth.id : null,
      track: o.track ? o.track.id : null,
      vlt: o.vlt, vSpd: o.vSpd, vPitch: o.vPitch,
    })),
    /*
     * Tracks, minus the ghosts.
     *
     * A track outlives the thing it was following. A missile that flew and died
     * three minutes ago is reaped from the world, but its contact lingers on
     * the plot until the sensor model gets round to fading it — measured on a
     * saturation raid, sixty-one tracks included sixteen whose truth had been
     * gone for two to three minutes and which were not yet marked faded. They
     * are dead history and cannot be rehydrated, so they are dropped here
     * rather than silently failing to load: the same outcome, reached honestly
     * and with a smaller file.
     */
    tracks: Object.fromEntries(['BLUE', 'RED'].map(side => {
      const tab = w.picture(side);
      if (!tab) return [side, []];
      // Must match exactly what the save carries. Rounds live for eight
      // seconds after they die before being reaped, and counting those as
      // "live" here while the weapons list filters them out saved sixteen
      // tracks that could never be rehydrated.
      const live = new Set([
        ...w.units.map(u => u.id),
        ...w.weapons.filter(o => o.alive).map(o => o.id),
      ]);
      return [side, tab.list.filter(t => live.has(t.truthId)).map(saveTrack)];
    })),
    buoys: (w.buoys || []).map(b => ({ ...b })),
    weather: { ...w.weather },
    stats: JSON.parse(JSON.stringify(w.stats)),
    comms: w.comms.slice(-60),
    signals: {
      credit: w.signals.credit,
      demerit: w.signals.demerit,
      fired: [...w.signals.fired],
      cooldown: [...w.signals.cooldown.entries()],
      lastFired: [...w.signals.lastFired.entries()],
      recentUnit: [...w.signals.recentUnit.entries()],
      beats: w.signals.beats.map(b => ({ ...b })),
      standing: JSON.parse(JSON.stringify(w.signals.standing)),
      // Pending questions travel as a kind and a deadline; the generator is
      // asked to pose them again on load. See the note at the top.
      active: w.signals.active.filter(s => !s.resolved && s.choices)
        .map(s => ({ kind: s.kind, deadline: s.deadline })),
    },
    mission: {
      status: game.mission.status, phase: game.mission.phase,
      failReason: game.mission.failReason, oscarProgress: game.mission.oscarProgress,
      startedAt: game.mission.startedAt,
      done: game.mission.objectives.filter(o => o.done).map(o => o.id),
      reached: [...game.mission._reached],
      hintsShown: [...game.mission._hintsShown],
      hints: game.mission.hints.slice(-20),
    },
  };
}

/**
 * Rebuild a world from a save. Returns { world, mission } for the caller to
 * wire, because everything else in the game is constructed around a world and
 * has to be rebuilt with it.
 */
export function deserialise(save) {
  if (!save || save.v !== VERSION) {
    throw new Error(`save format ${save && save.v} is not version ${VERSION}`);
  }
  const w = buildScenario(save.spec, save.scenario);
  w.time = save.time;
  w.startedAt = save.startedAt;
  w.weather = { ...w.weather, ...save.weather };
  w.stats = JSON.parse(JSON.stringify(save.stats));
  w.comms = save.comms.slice();
  w.buoys = (save.buoys || []).map(b => ({ ...b }));

  // Units the save has that the fresh world does not — aircraft launched from a
  // deck, relief airframes flown in from shore.
  const byId = new Map(w.units.map(u => [u.id, u]));
  for (const s of save.units) {
    if (byId.has(s.id)) continue;
    const u = w.spawn({
      className: s.cls, side: s.side, id: s.id, name: s.name, hullNo: s.hullNo,
      x: s.x, z: s.z, heading: s.heading, emcon: s.ordered.emcon, roe: s.ordered.roe,
    });
    byId.set(s.id, u);
  }
  // And units the fresh world has that the save does not — nothing should hit
  // this, but a spec change between versions would, and a ghost ship on the
  // plot is a worse failure than a missing one.
  const savedIds = new Set(save.units.map(s => s.id));
  w.units = w.units.filter(u => savedIds.has(u.id));

  /*
   * Weapons before tracks, because a track can be following a MISSILE — and a
   * raid in the air is exactly the moment a player reaches for the save. The
   * ordnance keeps its original id so the track can find it again.
   */
  w.weapons.length = 0;
  for (const s of save.weapons) {
    const shooter = s.shooter ? byId.get(s.shooter) : null;
    if (!shooter) continue;                     // its launcher is gone; so is it
    const o = w.ordnance.fire(shooter, s.weaponId, null, { aim: s.aim || undefined, salvoId: s.salvoId });
    if (!o) continue;
    // fire() spends a round from the magazine; the saved magazine already
    // reflects that expenditure, so hand it back.
    shooter.mags[s.weaponId] = (shooter.mags[s.weaponId] || 0) + 1;
    Object.assign(o, {
      id: s.id,
      x: s.x, z: s.z, alt: s.alt, heading: s.heading, speed: s.speed,
      phase: s.phase, age: s.age, distance: s.distance, alive: s.alive,
      seekerActive: s.seekerActive, acquired: s.acquired, lofted: s.lofted,
      cruiseAlt: s.cruiseAlt, vlt: s.vlt, vSpd: s.vSpd, vPitch: s.vPitch,
      truth: s.truth ? byId.get(s.truth) || null : null,
    });
    byId.set(o.id, o);
    o._savedTrack = s.track;
  }

  const trackById = new Map();
  for (const side of ['BLUE', 'RED']) {
    const tab = w.picture(side);
    if (!tab) continue;
    // `list` is a getter over the truthId map, so the maps are what get cleared.
    tab.tracks.clear();
    tab.byId.clear();
    for (const s of (save.tracks[side] || [])) {
      const truth = byId.get(s.truthId);
      if (!truth) continue;
      const t = Object.create(Track.prototype);
      for (const k of TRACK_SCALARS) t[k] = s[k];
      t.truthRef = truth;
      t.P = Float64Array.from(s.P);
      t.label = s.label;
      t.emitters = new Set(s.emitters);
      t.engagedBy = new Set(s.engagedBy);
      t.contributors = new Map(s.contributors.map(([id, v]) => [id, { ...v, unit: byId.get(id) || null }]));
      t.bearingCuts = s.bearingCuts.map(c => ({ ...c }));
      tab.tracks.set(t.truthId, t);
      tab.byId.set(t.id, t);
      trackById.set(t.id, t);
    }
  }

  for (const s of save.units) {
    const u = byId.get(s.id);
    if (u) applyUnit(u, s, byId, trackById);
  }

  // Now the tracks exist, point every round back at the one it is flying at.
  for (const o of w.weapons) {
    o.track = o._savedTrack ? trackById.get(o._savedTrack) || null : null;
    delete o._savedTrack;
  }

  // Signals: everything except the closures.
  const sg = w.signals, ss = save.signals;
  sg.credit = ss.credit; sg.demerit = ss.demerit;
  sg.fired = new Set(ss.fired);
  sg.cooldown = new Map(ss.cooldown);
  sg.lastFired = new Map(ss.lastFired);
  sg.recentUnit = new Map(ss.recentUnit);
  sg.beats = ss.beats.map(b => ({ ...b }));
  sg.standing = JSON.parse(JSON.stringify(ss.standing));
  sg.active = [];
  for (const a of ss.active) {
    const gen = GENERATORS.find(g => g.kind === a.kind);
    if (!gen) continue;
    // Ask the generator to pose the question again. If the world no longer
    // justifies it, it simply is not asked, which is the honest outcome.
    let sig = null;
    try { sig = gen.check(sg, w, w.time); } catch (e) { sig = null; }
    if (!sig) continue;
    sig.deadline = a.deadline;
    sig.opened = w.time;
    sg.log.push(sig);
    sg.active.push(sig);
  }

  const mission = new Mission(w);
  const ms = save.mission;
  mission.status = ms.status; mission.phase = ms.phase;
  mission.failReason = ms.failReason; mission.oscarProgress = ms.oscarProgress;
  mission.startedAt = ms.startedAt;
  mission._reached = new Set(ms.reached);
  mission._hintsShown = new Set(ms.hintsShown);
  mission.hints = (ms.hints || []).slice();
  const doneIds = new Set(ms.done);
  for (const o of mission.objectives) o.done = doneIds.has(o.id);
  w.mission = mission;

  return { world: w, mission };
}

// ── slots ───────────────────────────────────────────────────────────────────

function fmtClock(t) {
  const m = Math.floor((t / 60) % 60), h = Math.floor(t / 3600) % 24;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}Z`;
}

export function listSaves() {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : [];
    return Array.isArray(all) ? all : [];
  } catch (e) { return []; }
}

export function writeSave(game) {
  const rec = serialise(game);
  const all = listSaves();
  all.unshift({ at: rec.at, label: rec.label, scenario: rec.scenario, data: rec });
  // Newest six. A save list that grows without bound eventually fails to write
  // and the failure looks like "saving is broken".
  const keep = all.slice(0, MAX_SLOTS);
  try {
    localStorage.setItem(KEY, JSON.stringify(keep));
    return { ok: true, count: keep.length };
  } catch (e) {
    // Quota. Drop the oldest and try once more before admitting defeat.
    try {
      localStorage.setItem(KEY, JSON.stringify(keep.slice(0, 2)));
      return { ok: true, count: Math.min(2, keep.length), trimmed: true };
    } catch (e2) {
      return { ok: false, error: 'Storage full — could not write the save.' };
    }
  }
}

export function deleteSave(at) {
  const keep = listSaves().filter(s => s.at !== at);
  try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch (e) { /* nothing to do */ }
  return keep;
}
