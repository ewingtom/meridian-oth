/**
 * What a player is allowed to put in the water, and what to call it.
 *
 * This exists so that the scenario generator and the pre-mission editor argue
 * from the same list. Before it, "what is in this engagement" was four hundred
 * lines of hand-written spawn calls inside buildScenario — which meant the only
 * way to change the order of battle was to edit the source, and the only order
 * of battle anyone ever fought was the one that was written down.
 *
 * A FORCE SPEC is the separation that makes an editor possible: a plain object
 * saying which groups exist, what is in them, and where they are. Two things
 * produce one — `randomSpec()` for Engage Now, and the editor for everything
 * else — and `buildScenario()` consumes it without caring which. That is the
 * whole architecture; the rest of this file is the vocabulary.
 *
 * Names come from pools rather than being generated, because "USS MERIDIAN"
 * reads as a ship and "BLUE DDG 3" reads as a spreadsheet, and the fleet net is
 * most of this game's texture.
 */

export const HULL_NAMES = {
  DDG_FLIGHT_IIA: [
    ['USS MERIDIAN', 'DDG-121'], ['USS CUTLASS', 'DDG-118'], ['USS RESOLUTE', 'DDG-124'],
    ['USS BLACKWOOD', 'DDG-127'], ['USS ANNAPOLIS', 'DDG-130'],
  ],
  FFG_CONSTELLATION: [
    ['USS SENTINEL', 'FFG-64'], ['USS VANGUARD', 'FFG-67'], ['USS INTREPID', 'FFG-70'],
    ['USS BRISTOL', 'FFG-72'],
  ],
  CVN_FORD: [
    ['USS KEARSARGE BAY', 'CVN-79'], ['USS ENTERPRISE', 'CVN-80'],
  ],
  LPD: [
    ['USS GRANITE BAY', 'LPD-31'], ['USS HARPERS FERRY', 'LPD-33'],
  ],
  AOE: [
    ['USNS CAPE HATTERAS', 'T-AKE-9'], ['USNS POINT LOMA', 'T-AKE-12'],
  ],
  SSN_VIRGINIA: [
    ['USS RAVENNA', 'SSN-796'], ['USS MONTPELIER', 'SSN-802'],
  ],
  CG_SLAVA: [['VOLNA', null], ['GROZNY', null]],
  DDG_UDALOY: [['GROMKIY', null], ['BESSTRASHNY', null], ['ADMIRAL LEVCHENKO', null]],
  FFG_STEREGUSHCHY: [['SMETLIVY', null], ['ZORKIY', null], ['DERZKIY', null], ['STOIKIY', null]],
  SSGN_AKULA: [['B-471 KRASNODAR', null], ['B-448 TAMBOV', null]],
  MPA_BEAR: [['MEDVED 04', null], ['MEDVED 07', null]],
  BOMBER_BACKFIRE: [['RAIDER 1', null], ['RAIDER 2', null], ['RAIDER 3', null], ['RAIDER 4', null],
    ['RAIDER 5', null], ['RAIDER 6', null], ['RAIDER 7', null], ['RAIDER 8', null]],
};

export const MERCHANT_NAMES = [
  'MV NORDIC AURORA', 'MV KESTREL TRADER', 'MV BALTIC PIONEER', 'MV STAR OF LEITH',
  'MV ORION CREST', 'MV SEVEN SISTERS', 'MV ANDALUSIA', 'MV CAPE FINISTERRE',
  'MV THORVALD BANKE', 'MV ARKLOW DAWN', 'MV SUNDA STRAIT', 'MV PELAGIC VENTURE',
];
export const TRAWLER_NAMES = [
  'FV HAVFRUEN', 'FV NORDSTJERNEN', 'FV SILDEBERG', 'FV MAAGEN', 'FV BRISLING',
  'FV HAVGUL', 'FV SOLVEIG',
];

/**
 * The pick-list the editor draws, in the order it draws it.
 *
 * `role` decides where a hull is stationed; `max` is the point past which a
 * group stops being a task force and starts being a parade. `screen` orders the
 * escort stations — 0 takes the forward bows, 1 the flanks and the rear —
 * because a real screen is assigned by what each hull is good at: the frigates
 * carry the towed arrays, so they lead and listen, and the destroyers sit where
 * they can cover the high-value units with SM-2.
 */
export const BLUE_CATALOGUE = [
  { cls: 'DDG_FLIGHT_IIA', label: 'Arleigh Burke DDG', role: 'ESCORT', screen: 1, max: 5, hint: 'Air-defence spine. The first one is your flagship.' },
  { cls: 'FFG_CONSTELLATION', label: 'Constellation FFG', role: 'ESCORT', screen: 0, max: 4, hint: 'Best ear in the force — a towed array that hears further than anything else you own.' },
  { cls: 'CVN_FORD', label: 'Ford-class carrier', role: 'INNER', max: 2, hint: 'Reach. An air wing puts weapons where no launcher here can, if you build the deck in time.' },
  { cls: 'LPD', label: 'San Antonio LPD', role: 'HVU', max: 2, hint: 'The landing force. Cannot defend herself, cannot outrun anything.' },
  { cls: 'AOE', label: 'Lewis and Clark T-AKE', role: 'HVU', max: 2, hint: 'Replenishment. Without her you have four days of missiles and a parade.' },
  { cls: 'SSN_VIRGINIA', label: 'Virginia SSN', role: 'SUB', max: 2, hint: 'The unit they cannot find — and cannot be reached quickly either.' },
];

export const RED_CATALOGUE = [
  { cls: 'CG_SLAVA', label: 'Slava-class CG', role: 'LEAD', max: 3, hint: 'Sixteen supersonic anti-ship missiles that outrange everything you own.' },
  { cls: 'DDG_UDALOY', label: 'Udaloy DDG', role: 'ESCORT', max: 4, hint: 'ASW destroyer with a useful surface fit.' },
  { cls: 'FFG_STEREGUSHCHY', label: 'Steregushchy FFG', role: 'ESCORT', max: 4, hint: 'Small, quiet, and carries Kh-35.' },
];

export const RED_OTHER = [
  { key: 'subs', cls: 'SSGN_AKULA', label: 'Akula SSGN', max: 3, hint: 'Somewhere. That is the whole problem.' },
  { key: 'mpa', cls: 'MPA_BEAR', label: 'Tu-142 Bear-F', max: 3, hint: 'Finds you, then tells everybody.' },
  { key: 'bombers', cls: 'BOMBER_BACKFIRE', label: 'Tu-22M Backfire', max: 8, hint: 'The raid. Held at Volsk NAS until they have a targeting solution.' },
];

/**
 * How hot the engagement starts.
 *
 * This is the setting that changes what the mission IS. Cold is the game as
 * designed — a search problem, where the first decision is whether to radiate.
 * Hot skips the search and asks a different question: your emissions are
 * already up, so is everybody else's, and the missiles are coming.
 */
export const POSTURES = [
  {
    id: 'COLD', label: 'Cold — nobody has fired',
    blurb: 'Weapons tight, emissions down, no contact. You have to find him before this becomes a fight, and he has the same problem.',
    blueRoe: 'ROE_TIGHT', blueEmcon: 'PASSIVE',
    redRoe: 'ROE_FREE', redEmcon: 'PASSIVE',
    intelAgeH: 5.5, redKnowsYou: false, opening: null,
  },
  {
    id: 'WARM', label: 'Warm — contact, no shooting',
    blurb: 'A Bear has already found you and is shadowing. He knows roughly where you are; you know roughly where he came from. Nobody has released weapons yet.',
    blueRoe: 'ROE_TIGHT', blueEmcon: 'PASSIVE',
    redRoe: 'ROE_FREE', redEmcon: 'RESTRICTED',
    intelAgeH: 1.5, redKnowsYou: true, opening: 'SHADOWED',
  },
  {
    id: 'HOT', label: 'Hot — engagement in progress',
    blurb: 'Everyone is radiating, he has a firing solution, and the first salvo is already in the air. There is no search phase. Fight the raid.',
    blueRoe: 'ROE_FREE', blueEmcon: 'FULL',
    redRoe: 'ROE_FREE', redEmcon: 'FULL',
    intelAgeH: 0.1, redKnowsYou: true, opening: 'INBOUND',
  },
];

export function posture(id) {
  return POSTURES.find(p => p.id === id) || POSTURES[0];
}

/** Total hulls in a composition list, for the editor's counters. */
export function hullCount(list) {
  return (list || []).reduce((a, e) => a + (e.n || 0), 0);
}

/*
 * WHERE EACH HULL STANDS.
 *
 * A screen is not a shape, it is a set of assignments — so the layout is a
 * table of stations by role and the Nth ship of a role takes the Nth station.
 * With the default order of battle this reproduces the original hand-placed
 * formation exactly: frigates on the bows at 22 km, the second destroyer astern
 * at 12, the high-value units on the disengaged quarter, the carrier tucked
 * inside the screen rather than behind it because she has to turn into the wind
 * and everybody else conforms to her.
 *
 * This lives here rather than in the scenario builder because the SETUP SCREEN
 * needs it too — it is what decides where a newly added hull appears, and what
 * "re-form" means.
 */
export const STATIONS = {
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
  SUB: [{ brg: 8, r: 78000 }, { brg: -14, r: 86000 }],
};

/** A loose box for the surface action group, lead ship at the centre. */
export const RED_OFFSETS = [
  [0, 0], [-11000, 6000], [12500, 5000], [-4000, -12000], [6000, -13500],
  [15000, -4000], [-15000, -6000], [3000, 14000], [-8000, 15000],
];

const D2R_ = Math.PI / 180;

/**
 * Lay a blue composition out into individual hulls with absolute positions.
 *
 * `counts` is [{cls, n}]. Returns one entry per hull. The first escort is the
 * guide and sits at the anchor; everybody else takes a station by role, and
 * station assignment is by what a hull is GOOD at rather than by spawn order —
 * the frigates carry the towed arrays so they lead and listen, the destroyers
 * sit where they can cover the high-value units.
 */
export function layoutBlue(counts, anchor) {
  const flat = [];
  for (const e of counts || []) {
    const meta = BLUE_CATALOGUE.find(c => c.cls === e.cls);
    if (!meta) continue;
    for (let i = 0; i < (e.n || 0); i++) flat.push({ cls: e.cls, role: meta.role, screen: meta.screen ?? 1 });
  }
  const gi = flat.findIndex(f => f.role === 'ESCORT');
  const guide = gi >= 0 ? flat[gi] : flat[0];
  const rest = flat.filter(f => f !== guide);

  // Escorts get their stations in `screen` order, not arrival order.
  const escortOrder = rest
    .map((f, i) => ({ f, i }))
    .filter(o => o.f.role === 'ESCORT')
    .sort((a, b) => a.f.screen - b.f.screen || a.i - b.i)
    .map(o => o.f);

  const taken = {};
  const out = [];
  if (guide) out.push({ cls: guide.cls, x: anchor.x, z: anchor.z, detached: false, guide: true });
  for (const f of rest) {
    const table = STATIONS[f.role] || STATIONS.ESCORT;
    const idx = f.role === 'ESCORT' ? escortOrder.indexOf(f) : (taken[f.role] = (taken[f.role] || 0) + 1) - 1;
    const st = table[idx % table.length];
    const brg = anchor.course + st.brg * D2R_;
    out.push({
      cls: f.cls,
      x: anchor.x + Math.sin(brg) * st.r,
      z: anchor.z + Math.cos(brg) * st.r,
      detached: false, guide: false,
    });
  }
  return out;
}

/** The same, for the surface action group. */
export function layoutRed(counts, anchor) {
  const flat = [];
  for (const e of counts || []) {
    if (!RED_CATALOGUE.find(c => c.cls === e.cls)) continue;
    for (let i = 0; i < (e.n || 0); i++) flat.push(e.cls);
  }
  return flat.map((cls, i) => {
    const [ox, oz] = RED_OFFSETS[i % RED_OFFSETS.length];
    return { cls, x: anchor.x + ox, z: anchor.z + oz, detached: false, guide: i === 0 };
  });
}

/** Counts by class, which is what the editor's steppers show. */
export function countsOf(units) {
  const m = new Map();
  for (const u of units || []) m.set(u.cls, (m.get(u.cls) || 0) + 1);
  return m;
}
