/**
 * Platform (unit class) database.
 *
 * `refRange` on a sensor is its detection range against a reference target —
 * 10,000 m² RCS for surface search, 5 m² for air search, acoustic index 1.0 for
 * sonar. Actual range scales as the fourth root of RCS (the radar range equation)
 * and is then hard-clipped by the 4/3-earth horizon, which is usually the binding
 * constraint at sea and the single most important thing this game teaches.
 *
 * `emitPower` is the relative effective radiated power an ESM receiver sees. A
 * hostile ESM set detects the emitter at roughly 1.6x the range at which the
 * emitter detects a large ship, because ESM is a one-way path and radar is a
 * two-way path. That asymmetry — you are seen before you see — is EMCON.
 */

import { DOMAIN } from './constants.js';

const S = DOMAIN.SURFACE, U = DOMAIN.SUBSURFACE, A = DOMAIN.AIR, M = DOMAIN.MISSILE;

// ── sensor factory helpers ────────────────────────────────────────────────
const radar = (o) => ({ mode: 'ACTIVE', type: 'RADAR', emits: true, scan: 4, ...o });
const esm = (o) => ({ mode: 'PASSIVE', type: 'ESM', emits: false, scan: 1, ...o });
const sonar = (o) => ({ type: 'SONAR', scan: 6, ...o });
const eo = (o) => ({ mode: 'PASSIVE', type: 'VISUAL', emits: false, scan: 2, ...o });

export const PLATFORMS = {
  // ══════════════════════════ BLUE — Task Force 44 ══════════════════════════
  DDG_FLIGHT_IIA: {
    id: 'DDG_FLIGHT_IIA', type: 'DDG', domain: S,
    display: 'Arleigh Burke Flight IIA',
    role: 'Guided missile destroyer — the fleet\'s air defence spine and its longest reach.',
    length: 155, beam: 20, mastHeight: 34, draft: 9.4, displacement: 9200,
    rcs: 4200, acoustic: 1.25, model: 'player_ship',
    maxSpeed: 15.9, accelTime: 90, turnRate: 0.055, // m/s (31 kt), rad/s
    hp: 100, crew: 330,
    sensors: [
      radar({ id: 'SPY1D', name: 'AN/SPY-1D(V)', height: 30, refRange: 320000, refAir: 300000, emitPower: 1.0, domains: [S, A, M], airRef: 5 }),
      radar({ id: 'SPS67', name: 'AN/SPS-67(V)3 surface search', height: 24, refRange: 70000, emitPower: 0.35, domains: [S, M], navRadar: true }),
      esm({ id: 'SLQ32', name: 'AN/SLQ-32(V)6 SEWIP', height: 28, sensitivity: 1.15, domains: [S, A, M] }),
      sonar({ id: 'SQS53C', name: 'AN/SQS-53C hull array', mode: 'DUAL', passiveRange: 22000, activeRange: 34000, emitPower: 1.4, domains: [U] }),
      eo({ id: 'MK20', name: 'Mk 20 EOSS / lookouts', height: 26, refRange: 26000, domains: [S, A, M] }),
    ],
    weapons: [
      { id: 'SM2', count: 40, launcher: 'Mk 41 VLS' },
      { id: 'ESSM', count: 32, launcher: 'Mk 41 VLS' },
      { id: 'LRASM', count: 16, launcher: 'Mk 41 VLS' },
      { id: 'VLA', count: 8, launcher: 'Mk 41 VLS' },
      { id: 'HARPOON', count: 8, launcher: 'Mk 141' },
      { id: 'CIWS', count: 2, launcher: 'Mk 15 mount' },
      { id: 'GUN127', count: 1, launcher: 'Mk 45' },
      { id: 'NULKA', count: 12, launcher: 'Mk 53' },
      // Aviation stores. The embarked Seahawk arms from the ship, so without
      // these the hangar has an aircraft in it and nothing to hang on it.
      { id: 'MK54', count: 6, launcher: 'Mk 32 tubes / aircraft' },
      { id: 'SONOBUOY', count: 60, launcher: 'aviation stores' },
    ],
    // Two, which is what a Flight IIA hangar holds — and what gives the deck
    // somewhere to go once the alert aircraft is airborne.
    aircraft: [{ type: 'MH60R', count: 2 }],
    fireControlChannels: 6,
  },

  FFG_CONSTELLATION: {
    id: 'FFG_CONSTELLATION', type: 'FFG', domain: S,
    display: 'Constellation-class frigate',
    role: 'Multi-mission escort. Its variable-depth towed array is the task force\'s best ear.',
    length: 151, beam: 20, mastHeight: 31, draft: 7, displacement: 7300,
    rcs: 2100, acoustic: 0.85, model: 'escort_hull',
    maxSpeed: 13.9, accelTime: 85, turnRate: 0.06,
    hp: 72, crew: 200,
    sensors: [
      radar({ id: 'EASR', name: 'AN/SPY-6(V)3 EASR', height: 28, refRange: 250000, refAir: 240000, emitPower: 0.85, domains: [S, A, M] }),
      esm({ id: 'SLQ32F', name: 'SEWIP Lite', height: 25, sensitivity: 1.0, domains: [S, A, M] }),
      sonar({ id: 'VDS', name: 'CAPTAS-4 VDS + towed array', mode: 'DUAL', passiveRange: 46000, activeRange: 42000, emitPower: 1.6, domains: [U], towed: true }),
      eo({ id: 'EOSS', name: 'Electro-optical sight', height: 24, refRange: 22000, domains: [S, A, M] }),
    ],
    weapons: [
      { id: 'ESSM', count: 32, launcher: 'Mk 41 VLS' },
      { id: 'SM2', count: 8, launcher: 'Mk 41 VLS' },
      { id: 'NSM', count: 16, launcher: 'deck canister' },
      { id: 'VLA', count: 4, launcher: 'Mk 41 VLS' },
      { id: 'RAM', count: 21, launcher: 'SeaRAM' },
      { id: 'GUN127', count: 1, launcher: 'Mk 110' },
      { id: 'NULKA', count: 10, launcher: 'Mk 53' },
      { id: 'MK54', count: 6, launcher: 'Mk 32 tubes / aircraft' },
      { id: 'SONOBUOY', count: 60, launcher: 'aviation stores' },
    ],
    aircraft: [{ type: 'MH60R', count: 1 }],
    fireControlChannels: 4,
  },

  LPD: {
    id: 'LPD', type: 'LPD', domain: S,
    display: 'San Antonio-class amphibious transport dock',
    role: 'HIGH VALUE UNIT. Carries the landing force. She cannot defend herself and she cannot outrun anything.',
    length: 208, beam: 32, mastHeight: 40, draft: 7, displacement: 25000,
    rcs: 12000, acoustic: 1.8, model: 'lpd',
    maxSpeed: 11.3, accelTime: 160, turnRate: 0.03,
    hp: 210, crew: 360, hvu: true,
    sensors: [
      radar({ id: 'SPS48', name: 'AN/SPS-48E air search', height: 34, refRange: 200000, refAir: 220000, emitPower: 0.8, domains: [S, A] }),
      esm({ id: 'SLQ32L', name: 'SLQ-32(V)2', height: 30, sensitivity: 0.85, domains: [S, A, M] }),
      eo({ id: 'LOOKOUT', name: 'Bridge lookouts', height: 28, refRange: 20000, domains: [S, A, M] }),
    ],
    weapons: [
      { id: 'RAM', count: 21, launcher: 'Mk 49 GMLS' },
      { id: 'CIWS', count: 2, launcher: 'Mk 15 mount' },
      { id: 'NULKA', count: 8, launcher: 'Mk 53' },
    ],
    fireControlChannels: 1,
  },

  AOE: {
    id: 'AOE', type: 'T-AKE', domain: S,
    display: 'Lewis and Clark-class dry cargo ship',
    role: 'Fleet replenishment. Without her the task force has four days of missiles and then it is a very expensive parade.',
    length: 210, beam: 32, mastHeight: 36, draft: 9, displacement: 41000,
    rcs: 18000, acoustic: 2.0, model: 'take',
    maxSpeed: 10.3, accelTime: 200, turnRate: 0.025,
    hp: 150, crew: 130, hvu: true, softHvu: true,
    sensors: [
      radar({ id: 'NAV', name: 'Commercial navigation radar', height: 30, refRange: 40000, emitPower: 0.15, domains: [S], navRadar: true }),
      eo({ id: 'LOOKOUT', name: 'Bridge lookouts', height: 26, refRange: 18000, domains: [S, A, M] }),
    ],
    weapons: [{ id: 'NULKA', count: 4, launcher: 'Mk 53' }],
    fireControlChannels: 0,
  },

  CVN_FORD: {
    id: 'CVN_FORD', type: 'CVN', domain: S,
    display: 'Gerald R. Ford-class carrier',
    role: 'The task force\'s reach. Everything else here shoots as far as it can see; she puts armed aircraft six hundred kilometres away and brings them back for another one.',
    length: 333, beam: 78, mastHeight: 65, draft: 12, displacement: 100000,
    rcs: 60000, acoustic: 2.4, model: 'carrier_cvn',
    // Declared, not guessed. The axis solve in normalizeHull calls the
    // second-longest bounding-box dimension "up", and on a carrier that is an
    // argument between a 78 m flight deck and the masthead — which the art then
    // has to win rather than be shaped correctly. Stating it here means the
    // island can be built the height an island actually is.
    modelAxes: { len: 'z', up: 'y', beam: 'x', upSign: 1, lenSign: 1 },
    maxSpeed: 15.4, accelTime: 150, turnRate: 0.028,
    hp: 420, crew: 4550, hvu: true,
    sensors: [
      radar({ id: 'EASR_CVN', name: 'AN/SPY-6(V)2 EASR', height: 60, refRange: 260000, refAir: 250000, emitPower: 0.9, domains: [S, A, M] }),
      radar({ id: 'SPN46', name: 'AN/SPN-46 approach control', height: 55, refRange: 60000, refAir: 90000, emitPower: 0.3, domains: [A], navRadar: true }),
      esm({ id: 'SLQ32C', name: 'AN/SLQ-32(V)6 SEWIP', height: 58, sensitivity: 1.15, domains: [S, A, M] }),
      eo({ id: 'CVNEO', name: 'Flight deck and bridge lookouts', height: 55, refRange: 24000, domains: [S, A, M] }),
    ],
    weapons: [
      { id: 'ESSM', count: 32, launcher: 'Mk 29 GMLS' },
      { id: 'RAM', count: 42, launcher: 'Mk 49 GMLS' },
      { id: 'CIWS', count: 3, launcher: 'Mk 15 mount' },
      { id: 'NULKA', count: 16, launcher: 'Mk 53' },
    ],
    // The air wing. `count` is airframes carried; the flight deck decides what
    // state each one is in — see FlightDeck.js.
    aircraft: [
      { type: 'FA18E', count: 24 },
      { type: 'AEW_E2D', count: 4 },
      { type: 'MH60R', count: 6 },
    ],
    // Four catapults, three arresting-gear engines, and enough deck to spot a
    // dozen aircraft without fouling the landing area.
    flightDeck: { catapults: 4, spots: 12, cycleTime: 32, recoverTime: 46 },
    fireControlChannels: 3,
  },

  FA18E: {
    id: 'FA18E', type: 'VFA', domain: A,
    display: 'F/A-18E Super Hornet',
    role: 'Strike fighter. What it is carrying decides what it is — the airframe is the same one whether it is holding a CAP station or putting two anti-ship missiles into a cruiser.',
    length: 18.3, beam: 13.6, mastHeight: 0, draft: 0,
    rcs: 3, acoustic: 0, model: 'aircraft_fa18', air: true,
    maxSpeed: 480, cruiseSpeed: 235, cruiseAlt: 9500, maxAlt: 15000,
    accelTime: 14, turnRate: 0.22,
    hp: 10, crew: 1, endurance: 2.6 * 3600,
    sensors: [
      radar({ id: 'APG79', name: 'AN/APG-79 AESA', height: 0, refRange: 150000, refAir: 140000, emitPower: 0.55, domains: [S, A, M], isar: true }),
      esm({ id: 'ALR67', name: 'AN/ALR-67(V)3 RWR', height: 0, sensitivity: 1.0, domains: [S, A, M] }),
      eo({ id: 'ATFLIR', name: 'AN/ASQ-228 ATFLIR', height: 0, refRange: 32000, domains: [S], identifies: true }),
    ],
    // Filled in from the loadout at launch — see airwing.db.js. The airframe
    // carries nothing on its own.
    weapons: [],
    fireControlChannels: 2,
  },

  SSN_VIRGINIA: {
    id: 'SSN_VIRGINIA', type: 'SSN', domain: U,
    display: 'Virginia-class attack submarine',
    role: 'The one unit the enemy cannot find. Slow, silent, and lethal — but she is only in your kill web when she comes shallow.',
    length: 115, beam: 10, mastHeight: 0, draft: 10, displacement: 7800,
    rcs: 90, acoustic: 0.11, model: 'enemy_submarine',
    maxSpeed: 12.8, accelTime: 120, turnRate: 0.035,
    hp: 55, crew: 135, sub: true,
    maxDepth: 400, periscopeDepth: 18,
    sensors: [
      sonar({ id: 'TB29', name: 'TB-29A thin-line towed array', mode: 'PASSIVE', passiveRange: 95000, domains: [U, S], towed: true }),
      sonar({ id: 'BQQ10', name: 'BQQ-10 spherical array', mode: 'DUAL', passiveRange: 52000, activeRange: 30000, emitPower: 1.3, domains: [U, S] }),
      esm({ id: 'BLQ10', name: 'BLQ-10 mast ESM', height: 6, sensitivity: 1.0, domains: [S, A], needsShallow: true }),
      eo({ id: 'PHOTONICS', name: 'Photonics mast', height: 6, refRange: 14000, domains: [S], needsShallow: true }),
    ],
    weapons: [
      { id: 'MK48', count: 22, launcher: '533 mm tube' },
      { id: 'HARPOON', count: 4, launcher: '533 mm tube' },
    ],
    fireControlChannels: 4,
  },

  MPA_P8: {
    id: 'MPA_P8', type: 'MPA', domain: A,
    display: 'P-8A Poseidon',
    role: 'Maritime patrol. Puts a radar horizon 240 nautical miles wide over the ocean — the difference between a task force that can see and one that cannot.',
    length: 40, beam: 37, mastHeight: 0, draft: 0,
    rcs: 55, acoustic: 0, model: 'aircraft_p8', air: true,
    maxSpeed: 240, cruiseSpeed: 190, cruiseAlt: 8000, maxAlt: 12500,
    accelTime: 40, turnRate: 0.05,
    hp: 22, crew: 9, endurance: 8 * 3600,
    sensors: [
      radar({ id: 'APY10', name: 'AN/APY-10 surface search', height: 0, refRange: 300000, refAir: 120000, emitPower: 0.7, domains: [S, M], isar: true }),
      esm({ id: 'ALQ240', name: 'ALQ-240 ESM', height: 0, sensitivity: 1.3, domains: [S, A, M] }),
      eo({ id: 'MX20', name: 'MX-20HD electro-optical turret', height: 0, refRange: 40000, domains: [S], identifies: true }),
      { type: 'MAD', id: 'MAD', mode: 'PASSIVE', emits: false, scan: 1, refRange: 1200, domains: [U] },
    ],
    weapons: [
      { id: 'SONOBUOY', count: 120, launcher: 'rotary launcher' },
      { id: 'MK54', count: 5, launcher: 'weapons bay' },
      { id: 'LRASM', count: 4, launcher: 'wing pylon' },
      { id: 'HARPOON', count: 2, launcher: 'wing pylon' },
    ],
    fireControlChannels: 2,
  },

  AEW_E2D: {
    id: 'AEW_E2D', type: 'AEW', domain: A,
    display: 'E-2D Advanced Hawkeye',
    role: 'Airborne early warning. Lifts the air picture off the sea surface — the only way to see a sea-skimmer before it is ninety seconds out.',
    length: 18, beam: 25, mastHeight: 0, draft: 0,
    rcs: 40, acoustic: 0, model: 'aircraft_e2d', air: true,
    maxSpeed: 180, cruiseSpeed: 145, cruiseAlt: 9000, maxAlt: 10500,
    accelTime: 45, turnRate: 0.06,
    hp: 18, crew: 5, endurance: 5 * 3600,
    sensors: [
      radar({ id: 'APY9', name: 'AN/APY-9 UHF rotodome', height: 0, refRange: 300000, refAir: 460000, emitPower: 0.95, domains: [S, A, M], airPriority: true, isar: true }),
      esm({ id: 'ALQ217', name: 'ALQ-217 ESM', height: 0, sensitivity: 1.2, domains: [S, A, M] }),
    ],
    weapons: [],
    fireControlChannels: 0,
    relay: true,
  },

  MH60R: {
    id: 'MH60R', type: 'HELO', domain: A,
    display: 'MH-60R Seahawk',
    role: 'Embarked ASW and surface-search helicopter. Short legs, but she can put a dipping sonar exactly where the towed array heard something.',
    length: 20, beam: 16, mastHeight: 0, draft: 0,
    rcs: 12, acoustic: 0, model: 'aircraft_mh60', air: true, helo: true,
    maxSpeed: 72, cruiseSpeed: 55, cruiseAlt: 900, maxAlt: 3500,
    accelTime: 20, turnRate: 0.28,
    hp: 8, crew: 4, endurance: 3.2 * 3600,
    sensors: [
      radar({ id: 'APS153', name: 'AN/APS-153 MMR', height: 0, refRange: 90000, emitPower: 0.3, domains: [S, M], isar: true }),
      esm({ id: 'ALQ210', name: 'ALQ-210 ESM', height: 0, sensitivity: 0.9, domains: [S, A] }),
      sonar({ id: 'ALFS', name: 'AN/AQS-22 dipping sonar', mode: 'DUAL', passiveRange: 12000, activeRange: 16000, emitPower: 1.0, domains: [U], dipping: true }),
      eo({ id: 'FLIR', name: 'AN/AAS-44 FLIR', height: 0, refRange: 22000, domains: [S], identifies: true }),
    ],
    weapons: [
      { id: 'SONOBUOY', count: 25, launcher: 'sonobuoy rack' },
      { id: 'MK54', count: 2, launcher: 'pylon' },
    ],
    fireControlChannels: 1,
  },

  // ═══════════════════ RED — Volsk Federation Northern Fleet ═══════════════════
  CG_SLAVA: {
    id: 'CG_SLAVA', type: 'CG', domain: S,
    display: 'Volna-class guided missile cruiser',
    role: 'The centrepiece of the hostile surface action group. Sixteen supersonic heavy anti-ship missiles with a reach of three hundred miles.',
    length: 186, beam: 21, mastHeight: 42, draft: 8.4, displacement: 11500,
    rcs: 15000, acoustic: 1.9, model: 'enemy_destroyer',
    maxSpeed: 16.5, accelTime: 120, turnRate: 0.04,
    hp: 130, crew: 480,
    sensors: [
      radar({ id: 'FREGAT', name: 'MR-800 FREGAT-MA 3D', height: 38, refRange: 300000, refAir: 260000, emitPower: 1.2, domains: [S, A, M], fingerprint: 'MR-800 FREGAT-MA' }),
      radar({ id: 'TOPPAIR', name: 'MR-600 long-range air search', height: 36, refRange: 340000, refAir: 380000, emitPower: 1.35, domains: [A, S], fingerprint: 'MR-600 TOP PAIR' }),
      radar({ id: 'FRONTDOME', name: '3R41 fire control illuminator', height: 30, refRange: 100000, emitPower: 0.9, domains: [A, M], fireControl: true, fingerprint: '3R41 FRONT DOME' }),
      esm({ id: 'RUM', name: 'MP-401 ESM suite', height: 34, sensitivity: 1.0, domains: [S, A, M] }),
      sonar({ id: 'PLATINA', name: 'MGK-335 hull sonar', mode: 'DUAL', passiveRange: 18000, activeRange: 26000, emitPower: 1.3, domains: [U] }),
      eo({ id: 'LOOKOUT', name: 'Optical directors', height: 30, refRange: 24000, domains: [S, A, M] }),
    ],
    weapons: [
      { id: 'VULKAN', count: 16, launcher: 'SM-248 deck launcher' },
      { id: 'FORT', count: 64, launcher: 'B-204 revolver VLS' },
      { id: 'KASHTAN', count: 6, launcher: 'CIWS mount' },
      { id: 'GUN130', count: 1, launcher: 'AK-130' },
    ],
    fireControlChannels: 6,
  },

  DDG_UDALOY: {
    id: 'DDG_UDALOY', type: 'DDG', domain: S,
    display: 'Gromkiy-class destroyer',
    role: 'Escort and anti-submarine picket for the hostile SAG.',
    length: 163, beam: 19, mastHeight: 36, draft: 6.2, displacement: 7900,
    rcs: 6800, acoustic: 1.5, model: 'enemy_destroyer',
    maxSpeed: 15.4, accelTime: 100, turnRate: 0.05,
    hp: 85, crew: 300,
    sensors: [
      radar({ id: 'FREGAT2', name: 'MR-760 FREGAT-MA 3D', height: 33, refRange: 260000, refAir: 230000, emitPower: 1.0, domains: [S, A, M], fingerprint: 'MR-760 FREGAT' }),
      esm({ id: 'RUM2', name: 'MP-401S ESM', height: 30, sensitivity: 0.95, domains: [S, A, M] }),
      sonar({ id: 'POLINOM', name: 'MGK-355 POLINOM', mode: 'DUAL', passiveRange: 34000, activeRange: 40000, emitPower: 1.7, domains: [U] }),
      eo({ id: 'LOOKOUT', name: 'Optical directors', height: 28, refRange: 22000, domains: [S, A, M] }),
    ],
    weapons: [
      { id: 'URAN', count: 8, launcher: 'KT-184 canister' },
      { id: 'KINZHAL_SAM', count: 48, launcher: '3S95 VLS' },
      { id: 'KASHTAN', count: 4, launcher: 'CIWS mount' },
      { id: 'GUN130', count: 1, launcher: 'AK-100' },
      { id: 'TORP65', count: 8, launcher: '533 mm tube' },
    ],
    fireControlChannels: 4,
  },

  FFG_STEREGUSHCHY: {
    id: 'FFG_STEREGUSHCHY', type: 'FFG', domain: S,
    display: 'Smetlivy-class corvette',
    role: 'Light escort. Cheap, numerous, and carrying eight anti-ship missiles that will ruin an unescorted auxiliary.',
    length: 105, beam: 13, mastHeight: 27, draft: 3.7, displacement: 2200,
    rcs: 900, acoustic: 0.95, model: 'escort_hull',
    maxSpeed: 14.4, accelTime: 70, turnRate: 0.075,
    hp: 40, crew: 100,
    sensors: [
      radar({ id: 'FURKE', name: 'MR-352 FURKE-2', height: 24, refRange: 150000, refAir: 120000, emitPower: 0.6, domains: [S, A, M], fingerprint: 'MR-352 FURKE' }),
      esm({ id: 'RUM3', name: 'ESM suite', height: 22, sensitivity: 0.85, domains: [S, A, M] }),
      sonar({ id: 'ZARYA', name: 'Zarya-M hull sonar', mode: 'DUAL', passiveRange: 16000, activeRange: 20000, emitPower: 1.0, domains: [U] }),
      eo({ id: 'LOOKOUT', name: 'Optical director', height: 21, refRange: 18000, domains: [S, A, M] }),
    ],
    weapons: [
      { id: 'URAN', count: 8, launcher: 'KT-184 canister' },
      { id: 'KINZHAL_SAM', count: 12, launcher: 'VLS' },
      { id: 'KASHTAN', count: 2, launcher: 'CIWS mount' },
    ],
    fireControlChannels: 2,
  },

  SSGN_AKULA: {
    id: 'SSGN_AKULA', type: 'SSGN', domain: U,
    display: 'Bars-class nuclear attack submarine',
    role: 'Hostile submarine. Quiet enough that you will hear her when she shoots, and not before, unless you work for it.',
    length: 110, beam: 14, mastHeight: 0, draft: 10, displacement: 12800,
    rcs: 100, acoustic: 0.24, model: 'enemy_submarine',
    maxSpeed: 16.5, accelTime: 140, turnRate: 0.03,
    hp: 60, crew: 73, sub: true,
    maxDepth: 500, periscopeDepth: 18,
    sensors: [
      sonar({ id: 'SKAT', name: 'MGK-540 SKAT-3 array', mode: 'PASSIVE', passiveRange: 62000, domains: [U, S], towed: true }),
      sonar({ id: 'SKATA', name: 'MGK-540 active', mode: 'ACTIVE', activeRange: 24000, emitPower: 1.2, domains: [U, S] }),
      esm({ id: 'RIM', name: 'Mast ESM', height: 6, sensitivity: 0.95, domains: [S, A], needsShallow: true }),
    ],
    weapons: [
      { id: 'TORP65', count: 18, launcher: '650 mm tube' },
      { id: 'KALIBR', count: 8, launcher: '533 mm tube' },
    ],
    fireControlChannels: 4,
  },

  MPA_BEAR: {
    id: 'MPA_BEAR', type: 'MPA', domain: A,
    display: 'Tu-142 MEDVED maritime patrol aircraft',
    role: 'Hostile scout. If this aircraft finds your task force, a regiment of bombers gets your position an hour later.',
    length: 53, beam: 50, mastHeight: 0, draft: 0,
    rcs: 90, acoustic: 0, model: 'aircraft_bear', air: true,
    maxSpeed: 240, cruiseSpeed: 175, cruiseAlt: 7000, maxAlt: 11000,
    accelTime: 60, turnRate: 0.035,
    hp: 30, crew: 11, endurance: 12 * 3600,
    sensors: [
      radar({ id: 'KORNM', name: 'Korshun-N search radar', height: 0, refRange: 340000, refAir: 90000, emitPower: 1.1, domains: [S, M], fingerprint: 'KORSHUN-N', isar: true }),
      esm({ id: 'BEARESM', name: 'ESM/ELINT suite', height: 0, sensitivity: 1.25, domains: [S, A, M] }),
      eo({ id: 'BEAREO', name: 'Observation blisters', height: 0, refRange: 30000, domains: [S], identifies: true }),
    ],
    weapons: [{ id: 'SONOBUOY', count: 60, launcher: 'bay' }],
    fireControlChannels: 0,
    relay: true,
  },

  BOMBER_BACKFIRE: {
    id: 'BOMBER_BACKFIRE', type: 'BOMBER', domain: A,
    display: 'Tu-22M RAIDER missile bomber',
    role: 'Land-based anti-ship strike. Two Kh-32 apiece, launched from four hundred miles out. The regiment is the threat, not the aircraft.',
    length: 42, beam: 34, mastHeight: 0, draft: 0,
    rcs: 100, acoustic: 0, model: 'aircraft_backfire', air: true,
    maxSpeed: 480, cruiseSpeed: 260, cruiseAlt: 11000, maxAlt: 13500,
    accelTime: 50, turnRate: 0.04,
    hp: 26, crew: 4, endurance: 5 * 3600,
    sensors: [
      radar({ id: 'PNA', name: 'PNA-D attack radar', height: 0, refRange: 260000, emitPower: 1.0, domains: [S], fingerprint: 'PNA-D DOWN BEAT' }),
      esm({ id: 'BOMBESM', name: 'ESM warning receiver', height: 0, sensitivity: 0.8, domains: [S, A] }),
    ],
    weapons: [{ id: 'KH32', count: 2, launcher: 'fuselage/wing' }],
    fireControlChannels: 1,
  },

  // ══════════════════════════ NEUTRAL ══════════════════════════
  MERCHANT: {
    id: 'MERCHANT', type: 'MERCHANT', domain: S,
    display: 'Merchant vessel',
    role: 'Neutral shipping. Nine of them will look exactly like a warship on a bearing-only ESM cut.',
    length: 190, beam: 30, mastHeight: 34, draft: 11, displacement: 45000,
    rcs: 22000, acoustic: 2.2, model: 'merchant_ship',
    maxSpeed: 8.7, accelTime: 240, turnRate: 0.018,
    hp: 60, crew: 22, neutral: true,
    sensors: [
      radar({ id: 'NAV', name: 'Furuno navigation radar', height: 28, refRange: 36000, emitPower: 0.12, domains: [S], navRadar: true, fingerprint: 'CIVIL NAV RADAR' }),
      eo({ id: 'LOOKOUT', name: 'Bridge watch', height: 26, refRange: 16000, domains: [S] }),
    ],
    weapons: [],
    fireControlChannels: 0,
    alwaysRadiates: true,
  },

  TRAWLER: {
    id: 'TRAWLER', type: 'TRAWLER', domain: S,
    display: 'Fishing trawler',
    role: 'Fishing fleet. Acoustic clutter, radar clutter, and occasionally an intelligence collector with a very good ESM mast.',
    length: 48, beam: 10, mastHeight: 14, draft: 4, displacement: 900,
    rcs: 420, acoustic: 1.4, model: 'trawler',
    maxSpeed: 6.2, accelTime: 120, turnRate: 0.05,
    hp: 12, crew: 14, neutral: true,
    sensors: [
      radar({ id: 'NAV', name: 'Navigation radar', height: 12, refRange: 22000, emitPower: 0.08, domains: [S], navRadar: true, fingerprint: 'CIVIL NAV RADAR' }),
    ],
    weapons: [],
    fireControlChannels: 0,
    alwaysRadiates: true,
  },
};

export function platform(id) {
  const p = PLATFORMS[id];
  if (!p) throw new Error(`unknown platform ${id}`);
  return p;
}
