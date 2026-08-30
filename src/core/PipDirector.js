import * as THREE from 'three';
import { SIDE } from '../sim/constants.js';

/*
 * What the second window looks at.
 *
 * The interesting thing about a missile duel is that almost none of it happens
 * where the player is looking. A round leaves a ship two hundred kilometres
 * away, flies for six minutes, and either goes in or doesn't. On the plot that
 * is an arrowhead crossing a chart. So this picks the moments worth cutting to
 * and frames them, and the ranking below is a claim about which of those
 * moments actually matter:
 *
 *   SUNK       9  — a ship is gone. Nothing outranks it.
 *   HIT        7  — the warhead went off.
 *   TERMINAL   5  — a round is inside its last seconds against a ship. THIS is
 *                   the shot: you see it come in, you see the CIWS open up, and
 *                   you find out whether the defence worked. Nothing else in
 *                   the game has that much suspense per second.
 *   INTERCEPT  4  — something got killed in the air.
 *   LAUNCH     3  — a round leaving the rails. Common, so it yields to anything.
 *   CATSHOT    2  — an aircraft off the bow. The lowest priority in the list
 *                   because a deck cycle is thirty seconds long and there may
 *                   be eight of them, but it is the shot that sells a carrier.
 *
 * A cut may only be replaced by something that outranks it, and never in its
 * first second. Otherwise a busy engagement — twelve rounds inbound, CIWS
 * firing, decoys away — turns the inset into a strobe.
 *
 * TERMINAL is not an event. Nothing in the sim announces "a missile is about to
 * hit you" because nothing in the sim knows. So the director looks for it: each
 * frame it scans the in-flight rounds for one that has acquired a ship and is
 * inside its last few seconds, and cuts before the interesting part instead of
 * after it.
 */

const PRI = { CATSHOT: 2, LAUNCH: 3, INTERCEPT: 4, CIWS: 4, TERMINAL: 5, HIT: 7, SUNK: 9 };
const DUR = { CATSHOT: 5.5, LAUNCH: 6.5, INTERCEPT: 2.4, CIWS: 2.4, TERMINAL: 6.0, HIT: 3.6, SUNK: 6.5 };

/** A cut may not be pre-empted inside this window, whatever turns up. */
const MIN_HOLD = 0.9;

/**
 * How long simultaneous launches are collected before one is chosen. Long
 * enough to catch a coordinated salvo, short enough that the cut still lands
 * while the round is leaving the rails.
 */
const LAUNCH_GATHER = 0.28;

/** How long a cut may wait for its meshes before it is shown regardless. */
const WARMUP_CAP = 0.75;

/** Only look ahead this far for a terminal run. */
const TERMINAL_TTG = 7.0;

export class PipDirector {
  constructor(pip, cam, world) {
    this.pip = pip;
    this.cam = cam;
    this.world = world;
    this.enabled = true;

    this.shot = null;
    this.t = 0;
    this._eye = new THREE.Vector3();
    this._at = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._seenTerminal = new Set();
    this._scanAcc = 0;
    /*
     * What the inset needs meshes for.
     *
     * SceneView streams hulls in and out of a "detail bubble" sized from the
     * MAIN camera — and that bubble is zero once the player zooms past 120 km,
     * which is where a tactical plot is normally read. So the inset was cutting
     * to a launch two hundred kilometres away and filming empty ocean: no hull,
     * and no missile either, because ordnance views are gated by the same
     * bubble. That is the "pops up and doesn't load" — nothing was ever going
     * to load, because nothing had been asked for.
     *
     * SceneView reads this set every frame and streams whatever is in it
     * regardless of where the main camera is looking.
     */
    this.pinned = new Set();
    /** True once the subject actually has a mesh, so the cut can be shown. */
    this.ready = false;
    this._warm = 0;
  }

  /*
   * Launches arrive in clusters — a coordinated salvo means three ships firing
   * inside the same second, and whichever one the event loop happened to reach
   * first used to win the window. So launches are not cut immediately: they are
   * collected for a beat and the best of them is chosen.
   *
   * The pause is doing a second job. It is also warm-up time for the streamer,
   * so by the time the cut opens the hull and the round are built.
   */
  offerLaunch(cand) {
    if (!this.enabled) return;
    if (this.shot && PRI[this.shot.kind] > PRI.LAUNCH) return;
    this._launchQ = this._launchQ || [];
    this._launchQ.push(cand);
    if (this._launchT === undefined || this._launchT === null) this._launchT = 0;
  }

  _flushLaunches() {
    const q = this._launchQ;
    if (!q || !q.length) return;
    /*
     * Pick the one worth watching. A big salvo beats a single round, our own
     * ships beat theirs — the player has more invested in what they ordered —
     * and a round already being fired at is more interesting than one that is
     * not. Ties go to the round nearest what the player has selected.
     */
    let best = null, bestScore = -1e9;
    for (const c of q) {
      let sc = (c.salvoSize || 1) * 2;
      if (c.own) sc += 6;
      if (c.category === 'ASM') sc += 5;
      else if (c.category === 'TORPEDO') sc += 4;
      else if (c.category === 'SAM') sc += 2;
      if (c.nearSelection) sc += 3;
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    this._launchQ = null;
    this._launchT = null;
    if (best) this.offer('LAUNCH', best);
  }

  /** An event worth filming. Returns true if it took the window. */
  offer(kind, { ord = null, unit = null, x = 0, z = 0, alt = 0, from = null, orbit0 = 0 } = {}) {
    if (!this.enabled) return false;
    const pri = PRI[kind];
    if (pri === undefined) return false;
    if (this.shot && this.t < MIN_HOLD) return false;
    if (this.shot && PRI[this.shot.kind] > pri) return false;

    this.shot = { kind, ord, unit, x, z, alt, from, orbit0, dur: DUR[kind] };
    this.t = 0;
    this._eyeInit = false;
    this._fovS = 0;
    /*
     * Ask for the meshes NOW, and do not put the inset on screen until they
     * exist. A cut that opens on an empty sea and fills in half a second later
     * is worse than no cut: the player looks at the moment the thing they were
     * meant to see has already happened.
     */
    this.pinned.clear();
    if (unit) this.pinned.add(unit);
    if (from) this.pinned.add(from);
    if (ord) this.pinned.add(ord);
    if (ord?.truth) this.pinned.add(ord.truth);
    this.ready = false;
    this._warm = 0;
    return true;
  }

  /** Has the scene actually built what this shot is pointed at? */
  _subjectReady(view) {
    if (!view) return true;                    // no view layer to wait on
    const s = this.shot;
    if (!s) return false;
    const need = s.unit || s.from;
    if (need && need.alive !== false) {
      const v = view.views?.get(need);
      // A view exists as a grey placeholder box the moment it is created; what
      // we are waiting for is the real hull.
      if (!v || !v.ready || v.placeholder) return false;
    }
    if (s.ord && s.ord.alive && !view.ordViews?.has(s.ord)) return false;
    return true;
  }

  /**
   * Watch the in-flight rounds for one about to arrive. Cheap — it runs at 5 Hz
   * over a list that is single digits most of the time and rarely past thirty.
   */
  _scanTerminal(dt) {
    this._scanAcc += dt;
    if (this._scanAcc < 0.2) return;
    this._scanAcc = 0;
    if (this.shot && PRI[this.shot.kind] >= PRI.TERMINAL) return;

    let best = null, bestTtg = 1e9;
    for (const o of this.world.weapons) {
      if (!o.alive || !o.acquired) continue;
      const t = o.truth;
      if (!t || !t.alive || t.isAir) continue;
      if (this._seenTerminal.has(o.id ?? o)) continue;
      const r = Math.hypot(t.x - o.x, t.z - o.z);
      const ttg = r / Math.max(60, o.speed);
      if (ttg > TERMINAL_TTG || ttg < 0.8) continue;
      // Prefer a round about to arrive against the player's own ships — being
      // shot at is more interesting than shooting.
      const bias = t.side === SIDE.BLUE ? 0.5 : 1.0;
      if (ttg * bias < bestTtg) { bestTtg = ttg * bias; best = o; }
    }
    if (best) {
      this._seenTerminal.add(best.id ?? best);
      this.offer('TERMINAL', { ord: best, unit: best.truth });
    }
    if (this._seenTerminal.size > 400) this._seenTerminal.clear();
  }

  update(dt, view = null) {
    if (!this.enabled) { this.pip.active = false; this.pinned.clear(); return; }
    if (this._launchT !== null && this._launchT !== undefined) {
      this._launchT += dt;
      if (this._launchT >= LAUNCH_GATHER) this._flushLaunches();
    }
    this._scanTerminal(dt);

    const s = this.shot;
    if (!s) { this.pip.active = false; this.pinned.clear(); return; }

    /*
     * Warm-up. The shot is framed and the meshes are requested, but the inset
     * stays off screen until they are actually there — or until the warm-up
     * cap runs out, because a cut that never opens is also a failure. The
     * clock on the shot itself does not start until it is visible, so the
     * player always gets the full duration of whatever they are shown.
     */
    if (!this.ready) {
      this._warm += dt;
      this._frame(s, dt);                      // frame it anyway, so it is composed
      if (this._subjectReady(view) || this._warm > WARMUP_CAP) this.ready = true;
      else { this.pip.active = false; return; }
    }

    this.t += dt;
    if (this.t > s.dur) { this.shot = null; this.pip.active = false; this.pinned.clear(); return; }

    this.pip.active = true;
    this._frame(s, dt);
  }

  // ── framing ───────────────────────────────────────────────────────────────

  /**
   * Every shot is built in TRUE altitude — y is height above the sea, not the
   * render-space y the scene is drawn at. PipView lifts the whole scene by the
   * curvature drop at the anchor so the two agree; without that, a subject two
   * hundred kilometres from the main camera is drawn a kilometre underground
   * and the inset films empty ocean.
   */
  _frame(s, dt) {
    const cam = this.cam;
    let ax, az;      // anchor, sim space
    const eye = this._eye, at = this._at;
    let fov = 34;

    switch (s.kind) {
      case 'LAUNCH': {
        const o = s.ord;
        const live = o && o.alive;
        ax = live ? o.x : s.x; az = live ? o.z : s.z;
        at.set(cam.rx(ax), Math.max(3, live ? o.alt : s.alt), cam.rz(az));

        // A tracking shot, not a cut. The eye starts on the launching ship's
        // beam and chases: it is critically damped toward the ideal chase
        // position with a lag that decays, so it swings after the round and
        // settles behind it the way a crane operator would.
        //
        // The chase distance is set by how big the round has to look, not by
        // what feels safe. A cruise missile is about five metres long: at the
        // 120 m the first version settled on, with a 40° field, it was seventeen
        // pixels in a 288-pixel frame — a moving dot. At 50 m with a 30° field
        // it is nearer sixty, which is a missile.
        const hdg = live ? o.heading : (s.from?.heading ?? 0);
        const fx = Math.sin(hdg), fz = Math.cos(hdg);
        const ideal = this._tmp.set(
          cam.rx(ax) - fx * 44 - fz * 21,
          Math.max(12, (live ? o.alt : s.alt) + 9),
          cam.rz(az) - fz * 44 + fx * 21,
        );
        if (!this._eyeInit) {
          const u = s.from;
          eye.set(
            cam.rx(u ? u.x : ax) + fz * 58,
            30,
            cam.rz(u ? u.z : az) - fx * 58,
          );
          this._eyeInit = true;
        }
        // Locked off for the first beat. A deck camera does not move, and the
        // round crossing a superstructure that is holding still is what sells
        // the speed — a chase that starts immediately throws the ship away in
        // under a second and leaves a dot on an empty sky.
        if (this.t > 1.1) {
          const tau = THREE.MathUtils.lerp(0.9, 0.22, Math.min(1, (this.t - 1.1) / 1.8));
          eye.lerp(ideal, 1 - Math.exp(-dt / tau));
        }
        fov = 30;
        break;
      }

      case 'TERMINAL': {
        // Look PAST the ship, back down the bearing the round is coming from.
        //
        // The first version stood off the target's beam, which cannot work: a
        // round still 1.5 km out and a ship 300 m away are a hundred and twenty
        // degrees apart from that position, so every frame before impact was
        // empty sea. Behind the ship on the threat axis they are nearly
        // collinear — the ship is in the foreground and the thing coming for it
        // is beyond, closing down the middle of the frame.
        const u = s.unit, o = s.ord;
        ax = u.x; az = u.z;
        const live = o && o.alive;
        const bx = live ? o.x : u.x, bz = live ? o.z : u.z;
        const brg = Math.atan2(bx - u.x, bz - u.z);
        const sx = Math.sin(brg), sz = Math.cos(brg);
        eye.set(
          cam.rx(u.x) - sx * 335 + sz * 100,
          52,
          cam.rz(u.z) - sz * 335 - sx * 100,
        );

        // Frame on the bisector and open the field just wide enough to hold
        // both, the way an operator would ride the zoom — so the round is in
        // shot from a mile out and the frame tightens as it arrives.
        const vShip = this._tmp.set(cam.rx(u.x) - eye.x, 20 - eye.y, cam.rz(u.z) - eye.z);
        const dShip = vShip.length();
        vShip.multiplyScalar(1 / dShip);
        if (live) {
          const vM = this._tmp2.set(cam.rx(bx) - eye.x, Math.max(4, o.alt) - eye.y, cam.rz(bz) - eye.z)
            .normalize();
          const ang = Math.acos(THREE.MathUtils.clamp(vShip.dot(vM), -1, 1)) * (180 / Math.PI);
          fov = THREE.MathUtils.clamp(ang * 1.35 + 12, 26, 58);
          vShip.add(vM).normalize();
        } else {
          fov = 30;
        }
        this._fovS = this._fovS ? THREE.MathUtils.lerp(this._fovS, fov, 0.12) : fov;
        fov = this._fovS;
        at.copy(vShip).multiplyScalar(dShip).add(eye);
        break;
      }

      case 'TERMINAL': {
        // Stand off the target's beam on the side the round is coming from and
        // look BACK down the threat bearing, so the missile grows in frame and
        // the ship is the thing it is growing toward.
        const u = s.unit, o = s.ord;
        ax = u.x; az = u.z;
        const live = o && o.alive;
        const bx = live ? o.x : u.x, bz = live ? o.z : u.z;
        const brg = Math.atan2(bx - u.x, bz - u.z);
        const sx = Math.sin(brg), sz = Math.cos(brg);
        // Out along the threat bearing, and off to one side so the ship is not
        // hidden behind the incoming round.
        eye.set(
          cam.rx(u.x) + sx * 330 + sz * 150,
          64,
          cam.rz(u.z) + sz * 330 - sx * 150,
        );
        // Frame between the ship and the round: early on that is mostly the
        // round, at impact it is the ship.
        const w = Math.min(1, this.t / 2.4);
        at.set(
          cam.rx(THREE.MathUtils.lerp(bx, u.x, w)),
          THREE.MathUtils.lerp(live ? o.alt : 20, 22, w),
          cam.rz(THREE.MathUtils.lerp(bz, u.z, w)),
        );
        fov = 30;
        break;
      }

      case 'CATSHOT': {
        // From the bow, low, looking back down the angle of the deck — the
        // aircraft comes off the cat straight at the camera and passes over it.
        const u = s.unit, o = s.ord;
        const live = o && o.alive;
        ax = live ? o.x : s.x; az = live ? o.z : s.z;
        const hdg = u ? u.heading : (live ? o.heading : 0);
        const fx = Math.sin(hdg), fz = Math.cos(hdg);
        eye.set(
          cam.rx(u ? u.x : ax) + fx * 300 - fz * 60,
          34,
          cam.rz(u ? u.z : az) + fz * 300 + fx * 60,
        );
        at.set(cam.rx(ax), Math.max(12, live ? o.alt : 20), cam.rz(az));
        fov = 34;
        break;
      }

      case 'HIT':
      case 'SUNK': {
        const u = s.unit;
        ax = u ? u.x : s.x; az = u ? u.z : s.z;
        // Slow orbit, close in. A static shot of a burning ship reads as a
        // freeze; a drifting one reads as a camera.
        const a = s.orbit0 + this.t * 0.11;
        const r = s.kind === 'SUNK' ? 420 : 300;
        eye.set(
          cam.rx(ax) + Math.sin(a) * r,
          s.kind === 'SUNK' ? 120 : 72,
          cam.rz(az) + Math.cos(a) * r,
        );
        at.set(cam.rx(ax), 16, cam.rz(az));
        fov = 32;
        break;
      }

      case 'INTERCEPT':
      case 'CIWS':
      default: {
        ax = s.x; az = s.z;
        const u = s.unit;
        const brg = u ? Math.atan2(s.x - u.x, s.z - u.z) : 0;
        const sx = Math.sin(brg), sz = Math.cos(brg);
        eye.set(
          cam.rx(ax) - sx * 260 + sz * 180,
          Math.max(50, s.alt * 0.6 + 40),
          cam.rz(az) - sz * 260 - sx * 180,
        );
        at.set(cam.rx(ax), Math.max(6, s.alt), cam.rz(az));
        fov = 28;
        break;
      }
    }

    this.pip.anchor(cam.rx(ax), cam.rz(az));
    this.pip.look(eye, at, fov);
  }

  /** Human-readable slug for the inset's corner label. */
  get label() {
    const s = this.shot;
    if (!s) return '';
    switch (s.kind) {
      case 'CATSHOT': return `${s.unit?.name || 'FLIGHT DECK'} — LAUNCHING`;
      case 'LAUNCH': return `${s.from?.name || 'LAUNCH'} — WEAPON AWAY`;
      case 'TERMINAL': return `${s.unit?.name || 'CONTACT'} — INBOUND`;
      case 'HIT': return `${s.unit?.name || 'CONTACT'} — IMPACT`;
      case 'SUNK': return `${s.unit?.name || 'CONTACT'} — SINKING`;
      case 'CIWS': return `${s.unit?.name || ''} — CIWS ENGAGING`;
      default: return 'INTERCEPT';
    }
  }
}
