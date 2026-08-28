import { loadout, defaultLoadout, loadoutsFor, AIR_ROLE } from './airwing.db.js';

/**
 * A flight deck.
 *
 * The interesting thing about carrier aviation, as a game system, is that it is
 * almost entirely about TIME rather than about quantity. The carrier is not
 * short of airframes — she has twenty-four Super Hornets and the player will
 * rarely fly a third of them. What she is short of is deck: one aircraft leaves
 * every thirty seconds, one lands every forty-five, an anti-ship fit takes half
 * an hour to build, and the landing area is fouled while anybody is in the
 * groove. Every one of those is a queue, and the player's real decision is what
 * to put in the queue and when — half an hour before they know they need it.
 *
 * So the deck is a small scheduler, and each airframe walks one path:
 *
 *   STOWED ──prep──> PREPPING ──timer──> READY ──launch──> LAUNCHING
 *                                                              │ catapult
 *                                                              ▼
 *                            COOLDOWN <──timer── RECOVERING <── (airborne unit)
 *                                │
 *                                └──> STOWED
 *
 * Two rules make it a deck rather than a list. SPOTS caps how many aircraft can
 * be ready or launching at once, because a deck park is finite and the ones you
 * armed an hour ago are in the way of the ones you want now. And RECOVERY HAS
 * PRIORITY: while an aircraft is in the groove nothing is catapulted, because
 * the landing area runs the length of the deck. That is what makes a CAP coming
 * home low on fuel genuinely inconvenient when a strike is waiting to go, which
 * is exactly the texture cyclic operations have in life.
 *
 * Ships that are not carriers get a deck too — an escort's hangar is a deck with
 * no catapults and one spot — so the same code runs a destroyer's single
 * Seahawk and a supercarrier's air wing.
 */

export const FRAME = {
  STOWED: 'STOWED',
  PREPPING: 'PREPPING',
  READY: 'READY',
  LAUNCHING: 'LAUNCHING',
  AIRBORNE: 'AIRBORNE',
  RECOVERING: 'RECOVERING',
  COOLDOWN: 'COOLDOWN',
};

/** A hangar with no catapults: what every escort has. */
const HELO_PAD = { catapults: 0, spots: 1, cycleTime: 45, recoverTime: 75 };

export class FlightDeck {
  constructor(unit) {
    this.unit = unit;
    const spec = unit.cls.flightDeck || HELO_PAD;
    this.catapults = spec.catapults;
    this.spots = spec.spots;
    this.cycleTime = spec.cycleTime;
    this.recoverTime = spec.recoverTime;

    this.frames = [];
    let n = 0;
    for (const slot of unit.cls.aircraft || []) {
      for (let i = 0; i < slot.count; i++) {
        this.frames.push({
          id: `${unit.id}-A${++n}`,
          type: slot.type,
          loadout: null,
          state: FRAME.STOWED,
          timer: 0,
          unit: null,
        });
      }
    }

    this._launchTimer = 0;
    this._recoverTimer = 0;
    /** Rolling log the interface shows as a flight-operations box. */
    this.log = [];
  }

  // ── queries ───────────────────────────────────────────────────────────────

  /** Frames grouped by type and loadout, which is how the deck reads to a human. */
  groups() {
    const out = new Map();
    for (const f of this.frames) {
      const key = `${f.type}|${f.loadout || '-'}`;
      let g = out.get(key);
      if (!g) {
        g = { type: f.type, loadout: f.loadout, states: {}, total: 0, minTimer: Infinity };
        out.set(key, g);
      }
      g.states[f.state] = (g.states[f.state] || 0) + 1;
      g.total++;
      if (f.state === FRAME.PREPPING || f.state === FRAME.COOLDOWN) {
        g.minTimer = Math.min(g.minTimer, f.timer);
      }
    }
    return [...out.values()];
  }

  count(state, type = null, loadoutId = null) {
    return this.frames.filter(f => f.state === state
      && (!type || f.type === type)
      && (loadoutId === null || f.loadout === loadoutId)).length;
  }

  /**
   * How much of the deck park is spoken for. An aircraft being ARMED is sitting
   * on the deck with a tractor and an ordnance team round it, so it counts —
   * the header has to report the same number the arming limit enforces, or the
   * player is told there is room and then refused.
   */
  get spotsUsed() {
    return this.count(FRAME.READY) + this.count(FRAME.LAUNCHING) + this.count(FRAME.PREPPING);
  }

  get spotsFree() { return Math.max(0, this.spots - this.spotsUsed); }

  /** True while somebody is in the groove and the catapults are cold. */
  get recovering() { return this.count(FRAME.RECOVERING) > 0; }

  types() {
    return [...new Set(this.frames.map(f => f.type))];
  }

  // ── orders ────────────────────────────────────────────────────────────────

  /**
   * Start arming `n` airframes. Returns how many actually went on the clock —
   * fewer than asked if the airframes are not there or the deck park is full.
   */
  prep(type, loadoutId, n = 1) {
    const ld = loadout(type, loadoutId);
    if (!ld) return 0;
    let done = 0;
    for (const f of this.frames) {
      if (done >= n) break;
      if (f.state !== FRAME.STOWED || f.type !== type) continue;
      // An aircraft being armed is already occupying deck, so it counts against
      // the park the moment work starts — otherwise the player can queue twenty
      // and discover the problem half an hour later.
      if (this.spotsUsed >= this.spots) break;
      if (!this._drawWeapons(ld)) {
        this._note(`${ld.name} — magazine short, cannot arm`);
        break;
      }
      f.loadout = loadoutId;
      f.state = FRAME.PREPPING;
      f.timer = ld.prep;
      done++;
    }
    if (done) this._note(`${done} × ${this._typeName(type)} arming — ${ld.name}, ${Math.round(ld.prep / 60)} min`);
    return done;
  }

  /** Stand an armed or arming airframe back down, returning its weapons. */
  standDown(type, loadoutId, n = 1) {
    let done = 0;
    for (const f of this.frames) {
      if (done >= n) break;
      if (f.type !== type || f.loadout !== loadoutId) continue;
      if (f.state !== FRAME.PREPPING && f.state !== FRAME.READY) continue;
      const ld = loadout(f.type, f.loadout);
      if (ld) this._returnWeapons(ld);
      f.state = FRAME.STOWED; f.loadout = null; f.timer = 0;
      done++;
    }
    if (done) this._note(`${done} × ${this._typeName(type)} struck below`);
    return done;
  }

  /** Put `n` ready airframes in the catapult queue. */
  launch(type, loadoutId, n = 1) {
    let done = 0;
    for (const f of this.frames) {
      if (done >= n) break;
      if (f.state !== FRAME.READY || f.type !== type || f.loadout !== loadoutId) continue;
      f.state = FRAME.LAUNCHING;
      done++;
    }
    return done;
  }

  /** An airborne aircraft is back overhead and wants the deck. */
  recover(u) {
    const f = this.frames.find(x => x.unit === u);
    if (!f) return false;
    f.state = FRAME.RECOVERING;
    f.timer = this.recoverTime;
    f.unit = null;
    return true;
  }

  /** An airborne aircraft is not coming back. */
  lost(u) {
    const f = this.frames.find(x => x.unit === u);
    if (!f) return false;
    // The airframe is gone; the frame goes with it rather than returning to the
    // hangar. A carrier that flies badly runs out of aeroplanes.
    const i = this.frames.indexOf(f);
    this.frames.splice(i, 1);
    return true;
  }

  // ── the clock ─────────────────────────────────────────────────────────────

  step(dt, now, world) {
    // Recovery first: it owns the deck.
    let landed = null;
    for (const f of this.frames) {
      if (f.state !== FRAME.RECOVERING) continue;
      f.timer -= dt;
      if (f.timer <= 0 && !landed) {
        const ld = loadout(f.type, f.loadout);
        f.state = FRAME.COOLDOWN;
        f.timer = ld ? ld.cooldown : 300;
        f.loadout = null;
        landed = f;
      }
    }

    for (const f of this.frames) {
      if (f.state === FRAME.PREPPING) {
        f.timer -= dt;
        if (f.timer <= 0) {
          f.state = FRAME.READY; f.timer = 0;
          const ld = loadout(f.type, f.loadout);
          this._note(`${this._typeName(f.type)} ready on deck — ${ld ? ld.name : ''}`);
        }
      } else if (f.state === FRAME.COOLDOWN) {
        f.timer -= dt;
        if (f.timer <= 0) { f.state = FRAME.STOWED; f.timer = 0; }
      }
    }

    // Sweep up airframes that are not coming back. An aircraft can be shot
    // down, run dry or be destroyed on the water, and none of those paths run
    // through recover() — without this the deck's books show four Hornets
    // permanently airborne and the hangar never gets them back.
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.state !== FRAME.AIRBORNE) continue;
      if (f.unit && (!f.unit.alive || f.unit.despawned) && !f.unit.recovered) {
        this.frames.splice(i, 1);
        this._note(`${f.unit.name} is missing`);
      }
    }

    // Catapults. Nothing goes while the landing area is fouled.
    this._launchTimer = Math.max(0, this._launchTimer - dt);
    if (!this.recovering && this._launchTimer <= 0) {
      const f = this.frames.find(x => x.state === FRAME.LAUNCHING);
      if (f) {
        const u = world.launchAircraft(this.unit, f.type, loadout(f.type, f.loadout));
        if (u) {
          f.state = FRAME.AIRBORNE;
          f.unit = u;
          u.deckFrame = f;
          this._launchTimer = this.cycleTime;
        } else {
          // Could not spawn — put it back on the deck rather than losing it.
          f.state = FRAME.READY;
        }
      }
    }
  }

  // ── magazine ──────────────────────────────────────────────────────────────

  /**
   * Aircraft weapons come out of the SHIP's magazine, which is what makes a
   * carrier's reach finite. Twenty-four airframes are no use if the last LRASM
   * flew an hour ago.
   */
  _drawWeapons(ld) {
    const mags = this.unit.mags;
    for (const w of ld.weapons) {
      if ((mags[w.id] || 0) < w.count) return false;
    }
    for (const w of ld.weapons) mags[w.id] -= w.count;
    return true;
  }

  _returnWeapons(ld) {
    for (const w of ld.weapons) {
      this.unit.mags[w.id] = (this.unit.mags[w.id] || 0) + w.count;
    }
  }

  _typeName(type) {
    return ({ FA18E: 'Hornet', AEW_E2D: 'Hawkeye', MH60R: 'Seahawk' })[type] || type;
  }

  _note(text) {
    this.log.push({ t: this.unit.world ? this.unit.world.time : 0, text });
    if (this.log.length > 24) this.log.shift();
  }
}

export { AIR_ROLE, loadoutsFor, loadout, defaultLoadout };
