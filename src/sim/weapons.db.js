/**
 * Weapon database.
 *
 * The numbers here are deliberately in the public-knowledge ballpark of the real
 * systems they evoke, because the whole point of the game is that the geometry of
 * modern naval combat is a consequence of those numbers: a 550 km missile fired by
 * a ship whose own radar horizon is 40 km is, by definition, shooting on somebody
 * else's picture. Blue systems use their real designations; the opposing Volsk
 * Federation is fictional, with systems modelled on the well-known Soviet/Russian
 * families they are drawn from.
 *
 * Key fields:
 *   range        max kinematic range, metres
 *   speed        cruise speed, m/s
 *   terminalSpeed  speed once it goes terminal (supersonic sprinters differ)
 *   seekerRange  how far ahead the seeker sees once it activates
 *   seekerWidth  half-width of the seeker's search fan (metres at seekerRange)
 *   rcs          missile's own radar cross-section, m² — what the defender sees
 *   cruiseAlt    metres; sea-skimmers hide below the defender's radar horizon
 *   pkTerminal   base probability the warhead achieves a kill given it acquires
 */

export const WEAPONS = {
  // ───────────────────────── BLUE ─────────────────────────
  LRASM: {
    id: 'LRASM', name: 'AGM-158C LRASM', category: 'ASM', side: 'BLUE',
    range: 560000, speed: 240, terminalSpeed: 240, seekerRange: 55000, seekerWidth: 22000,
    rcs: 0.05, cruiseAlt: 60, terminalAlt: 6, pkTerminal: 0.82, warhead: 450,
    stealth: 0.25, datalink: true, discriminates: true, cyclesToFire: 3,
    blurb: 'Stealthy, autonomous, very long legs, and it flies low. Low observability plus a sea-skimming profile means the defender is fighting both the radar equation and the horizon at once.',
  },
  NSM: {
    id: 'NSM', name: 'RGM-184 Naval Strike Missile', category: 'ASM', side: 'BLUE',
    range: 185000, speed: 265, terminalSpeed: 265, seekerRange: 30000, seekerWidth: 11000,
    rcs: 0.08, cruiseAlt: 12, terminalAlt: 4, pkTerminal: 0.74, warhead: 125,
    stealth: 0.3, datalink: false, discriminates: true, cyclesToFire: 2,
    blurb: 'Passive imaging-infrared seeker — it never radiates, so the target gets no warning from ESM. Sea-skimming the whole way.',
  },
  HARPOON: {
    id: 'HARPOON', name: 'RGM-84D Harpoon Block II', category: 'ASM', side: 'BLUE',
    range: 130000, speed: 240, terminalSpeed: 240, seekerRange: 24000, seekerWidth: 9000,
    rcs: 0.35, cruiseAlt: 15, terminalAlt: 5, pkTerminal: 0.66, warhead: 221,
    stealth: 0.85, datalink: false, cyclesToFire: 2,
    blurb: 'The workhorse. Active radar seeker turns on at a set range from the aim point — early turn-on finds a stale track, but announces the shot.',
  },
  SM2: {
    id: 'SM2', name: 'RIM-174 SM-2 Block IIIC', category: 'SAM', side: 'BLUE',
    range: 170000, speed: 1100, seekerRange: 30000, rcs: 0.1, pkSingle: 0.72,
    minAlt: 3, maxAlt: 24000, needsIllum: false, cyclesToFire: 1,
    blurb: 'Area air defence. Reaches far — but only as far as the ship can see, and a sea-skimmer stays under the horizon until 30 km.',
  },
  ESSM: {
    id: 'ESSM', name: 'RIM-162 ESSM Block 2', category: 'SAM', side: 'BLUE',
    range: 50000, speed: 1300, seekerRange: 20000, rcs: 0.05, pkSingle: 0.80,
    minAlt: 2, maxAlt: 15000, quadPacked: true, cyclesToFire: 1, fireAndForget: true,
    blurb: 'Quad-packed point defence. Four to a VLS cell, which is how a destroyer survives a saturation raid instead of running dry.',
  },
  RAM: {
    id: 'RAM', name: 'RIM-116 Rolling Airframe Missile', category: 'SAM', side: 'BLUE',
    range: 9000, speed: 680, seekerRange: 9000, rcs: 0.02, pkSingle: 0.78,
    minAlt: 2, maxAlt: 6000, cyclesToFire: 0.5, fireAndForget: true,
    blurb: 'Last-ditch, fire-and-forget. Passive RF/IR homing — no illuminator needed, so it works when the fire-control channels are saturated.',
  },
  CIWS: {
    id: 'CIWS', name: 'Mk 15 Phalanx Block 1B', category: 'CIWS', side: 'BLUE',
    range: 1800, rate: 75, pkSingle: 0.55, cyclesToFire: 0.2,
    blurb: 'Twenty millimetres of last resort, closed-loop spotting. If it is shooting, everything upstream has already failed.',
  },
  GUN127: {
    id: 'GUN127', name: 'Mk 45 Mod 4 5"/62', category: 'GUN', side: 'BLUE',
    range: 24000, rate: 0.33, pkSingle: 0.2, shellSpeed: 800,
    blurb: 'Naval gunfire — still the cheapest way to kill a small boat or a merchant hull.',
  },
  MK54: {
    id: 'MK54', name: 'Mk 54 Lightweight Torpedo', category: 'TORPEDO', side: 'BLUE',
    range: 11000, speed: 20, seekerRange: 2200, pkTerminal: 0.62, warhead: 44,
    airDropped: true, cyclesToFire: 1,
    blurb: 'Dropped by helo or MPA onto a datum. Runs a search pattern; a stale datum means it searches empty water.',
  },
  MK48: {
    id: 'MK48', name: 'Mk 48 Mod 7 ADCAP', category: 'TORPEDO', side: 'BLUE',
    range: 50000, speed: 28, seekerRange: 4000, pkTerminal: 0.88, warhead: 295,
    wireGuided: true, cyclesToFire: 2,
    blurb: 'Heavyweight, wire-guided. The submarine keeps steering it from the firing point, which is why a submarine must stay quiet and stay close.',
  },
  VLA: {
    id: 'VLA', name: 'RUM-139C VL-ASROC', category: 'TORPEDO', side: 'BLUE',
    range: 22000, speed: 300, seekerRange: 2200, pkTerminal: 0.55, warhead: 44,
    rocketThrown: true, cyclesToFire: 1,
    blurb: 'A Mk 54 flown to the datum on a rocket. Puts a torpedo in the water 12 miles away sixty seconds after the sonar contact.',
  },
  NULKA: {
    id: 'NULKA', name: 'Mk 53 Nulka / SRBOC', category: 'DECOY', side: 'BLUE',
    range: 4000, seduceChance: 0.42, cyclesToFire: 0.2,
    blurb: 'Soft kill. A hovering rocket radiating a false ship-sized return, plus chaff. Cheaper than a SAM and it does not need a fire-control channel.',
  },
  SONOBUOY: {
    id: 'SONOBUOY', name: 'SSQ-53/62 Sonobuoy', category: 'SONOBUOY', side: 'BLUE',
    passiveRange: 14000, activeRange: 9000, life: 2400,
    blurb: 'A disposable hydrophone on a parachute. Lay a barrier across the threat axis and wait.',
  },

  // ───────────────────────── RED (Volsk Federation) ─────────────────────────
  VULKAN: {
    id: 'VULKAN', name: 'P-1000 VULKAN', category: 'ASM', side: 'RED',
    range: 550000, speed: 780, terminalSpeed: 830, seekerRange: 75000, seekerWidth: 30000,
    rcs: 1.6, cruiseAlt: 12000, terminalAlt: 60, pkTerminal: 0.86, warhead: 950,
    stealth: 1.6, datalink: true, discriminates: true, cyclesToFire: 4,
    blurb: 'A three-tonne supersonic high-diver. It cruises at 12 km where your radar sees it early — and then there is nothing you can do about the closing rate.',
  },
  KALIBR: {
    id: 'KALIBR', name: '3M-54 KALIBR-NK', category: 'ASM', side: 'RED',
    range: 420000, speed: 240, terminalSpeed: 950, seekerRange: 45000, seekerWidth: 16000,
    rcs: 0.25, cruiseAlt: 40, terminalAlt: 10, pkTerminal: 0.78, warhead: 400,
    stealth: 0.6, datalink: true, cyclesToFire: 3,
    blurb: 'Subsonic all the way in, then a supersonic terminal sprint inside the last 20 km — designed specifically to beat the reaction time of a point-defence system.',
  },
  URAN: {
    id: 'URAN', name: 'Kh-35U URAN', category: 'ASM', side: 'RED',
    range: 260000, speed: 260, terminalSpeed: 260, seekerRange: 22000, seekerWidth: 8000,
    rcs: 0.3, cruiseAlt: 12, terminalAlt: 4, pkTerminal: 0.62, warhead: 145,
    // A modern seeker rejects a return an order of magnitude off what it was
    // told to expect. Without this the Kh-35 happily flew into whichever hull in
    // the basket was biggest, which in a shipping lane is always a container
    // ship — the opposing commander was sinking most of the neutral traffic in
    // the box every run and burning his magazines doing it.
    stealth: 0.8, datalink: false, discriminates: true, cyclesToFire: 2,
    blurb: 'Small, cheap, sea-skimming. Individually survivable; forty of them is a different problem.',
  },
  KH32: {
    id: 'KH32', name: 'Kh-32 (air-launched)', category: 'ASM', side: 'RED',
    range: 600000, speed: 1300, terminalSpeed: 1300, seekerRange: 60000, seekerWidth: 24000,
    rcs: 0.9, cruiseAlt: 22000, terminalAlt: 400, pkTerminal: 0.8, warhead: 500,
    stealth: 1.2, datalink: false, cyclesToFire: 3,
    blurb: 'Launched from a bomber at the edge of the ocean and dropped on you from the stratosphere at Mach 4. The reason a task force cares very much where the enemy MPA is.',
  },
  FORT: {
    id: 'FORT', name: 'S-300F FORT', category: 'SAM', side: 'RED',
    range: 90000, speed: 1500, seekerRange: 25000, rcs: 0.15, pkSingle: 0.66,
    minAlt: 25, maxAlt: 25000, needsIllum: true, cyclesToFire: 1,
    blurb: 'Long-reach area SAM, but semi-active — it needs a continuous illuminator, and there are only so many channels.',
  },
  KINZHAL_SAM: {
    id: 'KINZHAL_SAM', name: '3K95 KINZHAL', category: 'SAM', side: 'RED',
    range: 12000, speed: 850, seekerRange: 12000, pkSingle: 0.6, rcs: 0.05,
    minAlt: 5, maxAlt: 6000, cyclesToFire: 0.5,
    blurb: 'Short-range point defence. Radar-directed, so it competes for the same fire-control channels as the long-range battery.',
  },
  KASHTAN: {
    id: 'KASHTAN', name: 'CIWS gun/missile mount', category: 'CIWS', side: 'RED',
    range: 2000, rate: 70, pkSingle: 0.5, cyclesToFire: 0.2,
    blurb: 'Combined gun and missile close-in mount.',
  },
  TORP65: {
    id: 'TORP65', name: '65-76 wake-homing torpedo', category: 'TORPEDO', side: 'RED',
    range: 50000, speed: 26, seekerRange: 5000, pkTerminal: 0.85, warhead: 450,
    wakeHoming: true, cyclesToFire: 2,
    blurb: 'Follows the wake instead of the hull. Decoys that fool an acoustic homer do nothing to it — you have to turn.',
  },
  GUN130: {
    id: 'GUN130', name: 'AK-130 130 mm', category: 'GUN', side: 'RED',
    range: 23000, rate: 0.5, pkSingle: 0.22, shellSpeed: 850,
    blurb: 'Twin 130 mm mount.',
  },
};

export function weapon(id) {
  const w = WEAPONS[id];
  if (!w) throw new Error(`unknown weapon ${id}`);
  return w;
}
