/**
 * The air wing: what each airframe can be sent up carrying, and what that costs
 * in time on the deck.
 *
 * This is the whole point of a carrier as a game object. A destroyer's magazine
 * is a fixed list — it has sixteen anti-ship missiles and that is the end of the
 * conversation. A carrier has twenty-four airframes and no fixed answer: the
 * same Super Hornet is an interceptor, a scout or an anti-ship strike depending
 * on what the deck crew bolts to it, and the difference between those is
 * MEASURED IN HALF HOURS. That is the decision the player is actually making.
 *
 * PREP TIME is the delay before an aircraft can be launched; COOLDOWN is
 * refuelling and servicing after it comes back. Both scale with how complicated
 * the loadout is, and the numbers here are Sea Power's own, from its mission-
 * maker documentation: an E-2C at 157 seconds, a heavy air-to-air Tomcat fit at
 * 300, an S-3 anti-ship scout at 900, and a full A-6/A-7 strike package at 1800.
 * Thirty minutes is a long time when a Backfire raid is inbound, and it is
 * supposed to be — the answer to "why didn't I have a strike ready" is that you
 * had to decide half an hour ago.
 *
 * A loadout also names the WEAPONS the airframe carries. Nothing in the class
 * database arms a Super Hornet; the loadout does, at launch. Which means the
 * carrier's magazine is finite in a way that matters: fly six anti-ship sorties
 * and the ship is out of LRASM whatever the airframes are doing.
 */

/** Mission a loadout is flown for. Drives the tasking the player is offered. */
export const AIR_ROLE = {
  CAP: 'CAP',           // combat air patrol — hold a station, kill what comes
  STRIKE: 'STRIKE',     // anti-surface, against a designated track
  RECON: 'RECON',       // armed reconnaissance — find them, shoot if worthwhile
  AEW: 'AEW',           // airborne early warning
  ASW: 'ASW',           // anti-submarine
  SSC: 'SSC',           // surface search and control
};

export const LOADOUTS = {
  FA18E: {
    CAP: {
      id: 'CAP', name: 'Air-to-Air', role: AIR_ROLE.CAP,
      prep: 300, cooldown: 420,
      weapons: [
        { id: 'AMRAAM', count: 6, launcher: 'wing pylon' },
        { id: 'SIDEWINDER', count: 2, launcher: 'wingtip rail' },
      ],
      blurb: 'Six AMRAAM and a pair of Sidewinders. Kills the archer instead of the arrow — one fighter on station is worth a great deal more than another cell of SM-2.',
    },
    STRIKE: {
      id: 'STRIKE', name: 'Anti-Ship Heavy', role: AIR_ROLE.STRIKE,
      prep: 1800, cooldown: 900,
      weapons: [
        { id: 'LRASM', count: 2, launcher: 'wing pylon' },
        { id: 'SIDEWINDER', count: 2, launcher: 'wingtip rail' },
      ],
      blurb: 'Two LRASM and enough fuel to get there. Thirty minutes on the deck to build — the reason a strike is something you decide to have, not something you reach for.',
    },
    RECON: {
      id: 'RECON', name: 'Armed Recon', role: AIR_ROLE.RECON,
      prep: 900, cooldown: 600,
      weapons: [
        { id: 'HARPOON', count: 2, launcher: 'wing pylon' },
        { id: 'SIDEWINDER', count: 2, launcher: 'wingtip rail' },
      ],
      blurb: 'Tanks, a radar and two Harpoon. Goes and looks, and can act on what it finds without flying home first.',
    },
  },

  AEW_E2D: {
    AEW: {
      id: 'AEW', name: 'Early Warning', role: AIR_ROLE.AEW,
      prep: 157, cooldown: 600,
      weapons: [],
      blurb: 'Nothing to bolt on but fuel, which is why she is quick to turn round. Lifts the air picture off the sea and buys the task force the ninety seconds a sea-skimmer would otherwise not give it.',
    },
  },

  MH60R: {
    ASW: {
      id: 'ASW', name: 'Anti-Submarine', role: AIR_ROLE.ASW,
      prep: 600, cooldown: 480,
      weapons: [
        { id: 'SONOBUOY', count: 25, launcher: 'sonobuoy chute' },
        { id: 'MK54', count: 2, launcher: 'pylon' },
      ],
      blurb: 'Buoys and two torpedoes. The only thing in the task force that can put a sonar exactly where the towed array heard something.',
    },
    SSC: {
      id: 'SSC', name: 'Surface Search', role: AIR_ROLE.SSC,
      prep: 300, cooldown: 300,
      weapons: [{ id: 'SONOBUOY', count: 10, launcher: 'sonobuoy chute' }],
      blurb: 'Radar and a camera. Goes out to put eyes on a contact the ship can only see as a bearing.',
    },
  },
};

/** Every loadout defined for a type, as an array. */
export function loadoutsFor(type) {
  return Object.values(LOADOUTS[type] || {});
}

export function loadout(type, id) {
  return (LOADOUTS[type] || {})[id] || null;
}

/** The loadout a type is flown with when nobody has said otherwise. */
export function defaultLoadout(type) {
  const all = loadoutsFor(type);
  return all.length ? all[0] : null;
}
