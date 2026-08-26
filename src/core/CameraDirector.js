import * as THREE from 'three';
import { clamp, angDiff, wrapAngle, NM, D2R } from '../sim/constants.js';
import { curvatureDrop } from './ocean.js';

/**
 * Camera director.
 *
 * Sea Power's central conceit is that the player is nowhere in particular: a
 * god's-eye over the plot, able to drop into any unit at any moment. So this
 * owns four cameras that are really one camera being persuaded:
 *
 *   TACTICAL  free orbit over the ocean, 200 m to 260 km up. At altitude it is a
 *             chart; at sea level it is a seascape, and the transition is
 *             continuous because it is literally the same camera moving.
 *   FOLLOW    chase a unit, cinematic.
 *   BRIDGE    first person on the bridge wing, conning the ship yourself.
 *   MISSILE   ride a weapon to its end.
 *
 * The world is 680 km across, far past float32's comfortable range for shader
 * maths, so everything renders in a FLOATING ORIGIN frame that gets rebased
 * whenever the camera wanders more than 12 km from it.
 */

const _v3a = new THREE.Vector3();

export const CAM = {
  TACTICAL: 'TACTICAL',
  FOLLOW: 'FOLLOW',
  BRIDGE: 'BRIDGE',
  MISSILE: 'MISSILE',
};

const REBASE_DIST = 12000;

export class CameraDirector {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;

    this.mode = CAM.TACTICAL;
    this.origin = new THREE.Vector2(0, 0);   // sim-space origin of the render frame

    // Tactical orbit state (sim coordinates for the focus point)
    this.focus = new THREE.Vector2(0, -250000);
    this.focusTarget = this.focus.clone();
    // Height of the orbit centre. Zero over the sea; the unit's altitude when
    // following something that flies, or a chase camera pinned to sea level ends
    // up looking up at an aircraft from underneath the waves.
    this.focusY = 0;
    this.focusYTarget = 0;
    this.dist = 42000;
    this.distTarget = 42000;
    this.yaw = 0;
    this.yawTarget = 0;
    this.pitch = 1.05;
    this.pitchTarget = 1.05;

    this.followUnit = null;
    this.bridgeUnit = null;
    this.missile = null;
    this._missileHold = 0;
    this._missilePos = new THREE.Vector3();
    this._returnFrom = null;
    this._returnT = 1;

    // Bridge look
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.bridgeStation = 'BRIDGE';
    this.fovTarget = 55;

    this._shake = 0;
    this._shakeV = new THREE.Vector3();

    this.onRebase = null;
  }

  // ── frame conversion ──────────────────────────────────────────────────────
  rx(x) { return x - this.origin.x; }
  rz(z) { return z - this.origin.y; }
  toRender(x, z, out = new THREE.Vector3()) { return out.set(x - this.origin.x, 0, z - this.origin.y); }

  /**
   * How far the sea surface (and anything floating on it) has dropped below the
   * flat y = 0 plane at this render-space point, because of the earth's
   * curvature. Every hull, symbol and wake applies the same offset as the far
   * sea shader, which is what puts distant ships properly hull-down.
   */
  drop(rx, rz) {
    const cx = this.camera.position.x, cz = this.camera.position.z;
    return curvatureDrop(Math.hypot(rx - cx, rz - cz));
  }
  toSim(vx, vz) { return { x: vx + this.origin.x, z: vz + this.origin.y }; }

  _maybeRebase() {
    const fx = this.focus.x, fz = this.focus.y;
    if (Math.abs(fx - this.origin.x) > REBASE_DIST || Math.abs(fz - this.origin.y) > REBASE_DIST) {
      const prev = this.origin.clone();
      this.origin.set(Math.round(fx / 1000) * 1000, Math.round(fz / 1000) * 1000);
      const dx = this.origin.x - prev.x, dz = this.origin.y - prev.y;
      this.camera.position.x -= dx;
      this.camera.position.z -= dz;
      this._missilePos.x -= dx; this._missilePos.z -= dz;
      if (this._returnFrom) { this._returnFrom.pos.x -= dx; this._returnFrom.pos.z -= dz; }
      this.onRebase?.(dx, dz);
    }
  }

  // ── mode switching ────────────────────────────────────────────────────────
  setTactical(focusSim) {
    if (this.mode !== CAM.TACTICAL) this._beginBlend(0.7);
    if (focusSim) { this.focusTarget.set(focusSim.x, focusSim.z); }
    this.mode = CAM.TACTICAL;
    this.followUnit = null;
    this.bridgeUnit = null;
    this.fovTarget = 55;
  }

  follow(unit) {
    if (this.mode !== CAM.FOLLOW || this.followUnit !== unit) this._beginBlend(0.7);
    if (!unit) return;
    this.followUnit = unit;
    this.mode = CAM.FOLLOW;
    this.focusTarget.set(unit.x, unit.z);
    this.distTarget = clamp(this.distTarget, 200, 3000);
    if (this.distTarget > 2800) this.distTarget = 900;
    this.pitchTarget = 0.28;
    this.fovTarget = 48;
  }

  /**
   * Capture the current pose so the next frame can ease out of it instead of
   * cutting. Any mode change routes through this: the machinery already existed
   * for coming home from a missile ride and simply was not applied anywhere
   * else, so switching to the bridge teleported the eyepoint nine hundred metres
   * in a single frame.
   */
  _beginBlend(seconds = 0.8) {
    this._returnFrom = {
      pos: this.camera.position.clone(),
      quat: this.camera.quaternion.clone(),
      fov: this.camera.fov,
    };
    this._returnT = 0;
    this._returnDur = seconds;
  }

  board(unit) {
    if (!unit || unit.isSub || unit.isAir === undefined) return;
    this._beginBlend(0.85);
    this.bridgeUnit = unit;
    this.mode = CAM.BRIDGE;
    this.lookYaw = 0;
    this.lookPitch = -0.02;
    this.fovTarget = 62;
  }

  rideMissile(ord) {
    if (!ord || !ord.alive) return false;
    this.missile = ord;
    this._prevMode = this.mode;
    this._prevState = { follow: this.followUnit, bridge: this.bridgeUnit };
    this.mode = CAM.MISSILE;
    this._missileHold = 0;
    this._missilePos.set(0, 0, 0);
    this._missileOff = null;
    this._prevFocus = this.focus.clone();
    this.fovTarget = 50;
    return true;
  }

  exitMissile() {
    if (this.mode !== CAM.MISSILE) return;
    this._returnFrom = {
      pos: this.camera.position.clone(),
      quat: this.camera.quaternion.clone(),
      fov: this.camera.fov,
    };
    this._returnT = 0;
    this.missile = null;
    // Never restore MISSILE as the "previous" mode: riding a second round would
    // then store MISSILE as the thing to go back to, and the ride would end with
    // the director in MISSILE mode holding no missile — an orbit camera parked
    // three hundred kilometres from anything, staring at empty water.
    this.mode = (this._prevMode && this._prevMode !== CAM.MISSILE) ? this._prevMode : CAM.TACTICAL;
    this.followUnit = this._prevState?.follow || null;
    this.bridgeUnit = this._prevState?.bridge || null;
    // The ride dragged the focus downrange with the round; put it back where the
    // player left the plot, or on the unit they were following.
    const home = this.followUnit || this.bridgeUnit;
    if (home) this.focusTarget.set(home.x, home.z);
    else if (this._prevFocus) this.focusTarget.copy(this._prevFocus);
    this.focus.copy(this.focusTarget);
    this.fovTarget = this.mode === CAM.BRIDGE ? 62 : this.mode === CAM.FOLLOW ? 48 : 55;
  }

  shake(amount) { this._shake = Math.min(1.6, this._shake + amount); }

  // ── input ─────────────────────────────────────────────────────────────────
  zoom(delta) {
    if (this.mode === CAM.BRIDGE) {
      this.fovTarget = clamp(this.fovTarget * (1 + delta * 0.0016), 6, 70);
      return;
    }
    const f = Math.exp(delta * 0.0013);
    const min = this.mode === CAM.FOLLOW ? 90 : 260;
    this.distTarget = clamp(this.distTarget * f, min, 300000);
    if (this.mode === CAM.FOLLOW && this.distTarget > 12000) { this.mode = CAM.TACTICAL; this.followUnit = null; }
  }

  orbit(dx, dy) {
    if (this.mode === CAM.BRIDGE) {
      const s = (this.camera.fov / 55) * 0.0022;
      this.lookYaw = wrapAngle(this.lookYaw - dx * s);
      this.lookPitch = clamp(this.lookPitch - dy * s, -0.55, 0.5);
      return;
    }
    this.yawTarget -= dx * 0.0032;
    this.pitchTarget = clamp(this.pitchTarget + dy * 0.0026, 0.06, 1.5);
  }

  pan(dx, dy) {
    if (this.mode === CAM.BRIDGE) return;
    if (this.mode === CAM.FOLLOW) { this.mode = CAM.TACTICAL; this.followUnit = null; }
    const scale = this.dist * 0.0016;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const ex = -dx * scale, ez = dy * scale;
    this.focusTarget.x += ex * c - ez * s;
    this.focusTarget.y += ex * s + ez * c;
  }

  panBy(vx, vz) {
    if (this.mode === CAM.FOLLOW) { this.mode = CAM.TACTICAL; this.followUnit = null; }
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    this.focusTarget.x += vx * c - vz * s;
    this.focusTarget.y += vx * s + vz * c;
  }

  jumpTo(x, z, dist) {
    this.focusTarget.set(x, z);
    if (dist) this.distTarget = dist;
    if (this.mode === CAM.FOLLOW || this.mode === CAM.BRIDGE) { this.mode = CAM.TACTICAL; this.followUnit = null; this.bridgeUnit = null; }
  }

  /** Altitude-driven "map-ness": 0 = seascape, 1 = chart. */
  get chartness() {
    return clamp((this.dist - 5000) / 32000, 0, 1);
  }

  get altitude() { return this.camera.position.y; }

  // ── per-frame ─────────────────────────────────────────────────────────────
  update(dt, ocean, elapsed) {
    const k = 1 - Math.exp(-dt * 7);
    if (this.mode === CAM.MISSILE && !this.missile) this.mode = CAM.TACTICAL;

    if (this.mode === CAM.MISSILE && this.missile) {
      this._updateMissile(dt, k);
    } else if (this.mode === CAM.BRIDGE && this.bridgeUnit?.alive) {
      this._updateBridge(dt, k, ocean, elapsed);
    } else {
      if (this.mode === CAM.FOLLOW) {
        if (!this.followUnit?.alive) { this.mode = CAM.TACTICAL; this.followUnit = null; this.focusYTarget = 0; }
        else {
          this.focusTarget.set(this.followUnit.x, this.followUnit.z);
          const u = this.followUnit;
          this.focusYTarget = u.isAir ? Math.max(4, u.alt)
            : u.isSub ? Math.min(-2, u.alt * 0.35) : 6;
        }
      } else {
        this.focusYTarget = 0;
      }
      if (this.mode === CAM.BRIDGE) this.mode = CAM.TACTICAL;
      this._updateOrbit(dt, k, ocean, elapsed);
    }

    // Ease home from a missile ride onto the live station pose.
    if (this._returnT < 1 && this._returnFrom) {
      this._returnT = Math.min(1, this._returnT + dt / (this._returnDur || 0.9));
      const e = this._returnT * this._returnT * (3 - 2 * this._returnT);
      this.camera.position.lerpVectors(this._returnFrom.pos, this._stationPos, e);
      this.camera.quaternion.slerpQuaternions(this._returnFrom.quat, this._stationQuat, e);
      if (this._returnT >= 1) this._returnFrom = null;
    }

    // Camera shake from nearby detonations
    if (this._shake > 0.001) {
      this._shake *= Math.exp(-dt * 3.2);
      const a = this._shake * (this.mode === CAM.BRIDGE ? 0.9 : 2.2);
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a;
    }

    if (Math.abs(this.camera.fov - this.fovTarget) > 0.02) {
      this.camera.fov += (this.fovTarget - this.camera.fov) * clamp(dt * 8, 0, 1);
      this._updateProjection();
    }
    this._maybeRebase();
  }

  _updateProjection() {
    const alt = Math.max(2, this.camera.position.y);
    // Dynamic near/far keeps a 24-bit depth buffer honest across five orders of
    // magnitude of scale without needing a logarithmic depth buffer (which would
    // mean patching every custom shader in the game).
    //
    // The near plane must follow the distance to what the camera is LOOKING AT,
    // not its altitude. Deriving it from altitude alone put the near plane at
    // 180 m whenever the camera was up at an aircraft's cruising level — which
    // meant that flying the chase camera up to a Hawkeye at nine thousand metres
    // clipped the Hawkeye itself out of the frame, and every aircraft in the game
    // appeared never to be rendered at all.
    const subject = this.mode === CAM.MISSILE ? 24
      : (this.mode === CAM.FOLLOW || this.mode === CAM.TACTICAL) ? Math.max(6, this.dist)
        : alt;
    const near = this.mode === CAM.BRIDGE ? 0.25
      : clamp(Math.min(alt, subject) * 0.02, 0.25, 900);
    const far = clamp(alt * 90 + 90000, 90000, 1400000);
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  _updateOrbit(dt, k, ocean, elapsed) {
    this.focus.lerp(this.focusTarget, this.mode === CAM.FOLLOW ? clamp(dt * 5, 0, 1) : k);
    this.dist += (this.distTarget - this.dist) * clamp(dt * 6, 0, 1);
    this.yaw += angDiff(this.yaw, this.yawTarget) * k;

    // Automatic pitch: looking down from orbit, looking across from sea level.
    const t = clamp((this.dist - 900) / 26000, 0, 1);
    const autoPitch = 0.16 + t * 1.16;
    const blend = clamp((this.dist - 2500) / 12000, 0, 1);
    const desiredPitch = this.pitchTarget * (1 - blend) + autoPitch * blend;
    this.pitch += (desiredPitch - this.pitch) * clamp(dt * 4, 0, 1);

    this.focusY += (this.focusYTarget - this.focusY) * clamp(dt * 5, 0, 1);
    const cx = this.rx(this.focus.x);
    const cz = this.rz(this.focus.y);
    const cy = this.focusY;
    const h = Math.sin(this.pitch) * this.dist;
    const r = Math.cos(this.pitch) * this.dist;
    this.camera.position.set(
      cx - Math.sin(this.yaw) * r,
      Math.max(3.5, cy + h),
      cz - Math.cos(this.yaw) * r,
    );
    this.camera.lookAt(cx, cy, cz);
    this._stationPos = this.camera.position.clone();
    this._stationQuat = this.camera.quaternion.clone();
    this._updateProjection();
  }

  _updateBridge(dt, k, ocean, elapsed) {
    const u = this.bridgeUnit;
    this.focus.set(u.x, u.z);
    this.focusTarget.copy(this.focus);
    const cx = this.rx(u.x), cz = this.rz(u.z);

    // Eye position on the STARBOARD BRIDGE WING, riding the sea with the hull.
    //
    // It used to sit on the centreline at 62 % of masthead height, which on
    // every hull in the game is inside the deckhouse — the first-person view was
    // a full screen of interior bulkhead. A bridge wing is the right answer for
    // both reasons: it is outboard of the superstructure so nothing can be in
    // front of it, and it is where you would actually be standing.
    // Measured off the ship's own model where we have it (UnitView publishes a
    // bridgeEye once the hull streams in), class numbers only as a fallback.
    const eye = this.bridgeEyeFor?.(u);
    const eyeH = eye?.h ?? u.cls.bridgeEyeH ?? (u.cls.mastHeight || 28) * 0.46;
    // Far enough forward to be at the FRONT of the bridge rather than halfway
    // down the deckhouse, so the view is mostly sea and bow rather than mostly
    // the side of a building.
    const fwdOff = eye?.fwd ?? (u.cls.length || 150) * 0.21;
    // ON the bridge wing: beam is the ship's WIDTH, so the wing tip is at half a
    // beam from the centreline. Outboard of that the eye hangs over open water;
    // inboard it ends up inside the deckhouse.
    const sideOff = eye?.side ?? (u.cls.beam || 18) * 0.48;
    const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
    // Starboard. Forward is (sin h, cos h) in x/z; in three.js's right-handed
    // frame the vector ninety degrees to the right of that is (-cos h, sin h).
    // The sign was inverted, which put the "starboard bridge wing" on the PORT
    // side — so the deckhouse sat in the right of frame instead of the left.
    const rx2 = -ch, rz2 = sh;
    let ex = cx + sh * fwdOff + rx2 * sideOff;
    let ez = cz + ch * fwdOff + rz2 * sideOff;

    let waveY = 0, roll = 0, pitch = 0;
    if (ocean) {
      const t = elapsed;
      waveY = ocean.getHeightAt(ex, ez, t);
      const dl = 30;
      const fwdY = ocean.getHeightAt(ex + sh * dl, ez + ch * dl, t);
      const sideY = ocean.getHeightAt(ex - ch * dl, ez + sh * dl, t);
      pitch = Math.atan2(fwdY - waveY, dl) * 0.55;
      roll = Math.atan2(sideY - waveY, dl) * 0.75;
    }

    this.camera.position.set(ex, eyeH + waveY * 0.8, ez);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(
      this.lookPitch + pitch,
      u.heading + this.lookYaw + Math.PI,
      roll * 0.8,
      'YXZ',
    );
    // The GLB hulls are bow = +Z, and a camera looks down -Z, so a bridge camera
    // facing forward is the hull's yaw plus a half turn.
    q.setFromEuler(e);
    this.camera.quaternion.copy(q);
    this._stationPos = this.camera.position.clone();
    this._stationQuat = this.camera.quaternion.clone();
    this._updateProjection();
  }

  _updateMissile(dt, k) {
    const m = this.missile;
    // The plot focus follows the round. Everything downstream keys off it — the
    // floating origin, the curvature drop, and the detail bubble that decides
    // which meshes exist at all — so leaving the focus back with the task force
    // meant that once a missile was a hundred kilometres downrange the weapon
    // camera was pointing at an empty sea with the round culled out of it.
    if (m.alive) { this.focus.set(m.x, m.z); this.focusTarget.copy(this.focus); }
    const px = this.rx(m.x), pz = this.rz(m.z), py = Math.max(2, m.alt);
    const fwd = new THREE.Vector3(Math.sin(m.heading), 0, Math.cos(m.heading)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(fwd, up).normalize();

    if (!m.alive) {
      this._missileHold += dt;
      this.camera.position.copy(this._missilePos);
      this.camera.lookAt(px, py, pz);
      if (this._missileHold > 1.6) this.exitMissile();
      this._updateProjection();
      return;
    }

    // Chase pose. Close enough that the round fills a real part of the frame —
    // this shot is the game's signature and a missile that reads as a speck in
    // the middle distance wastes it — and offset to one side so it is a 3/4 view
    // against the sea rather than a dead-astern silhouette.
    // Smooth the OFFSET from the round, not the camera's absolute position.
    // Lerping the absolute position against a target moving at 240 m/s leaves a
    // steady-state lag of v/k — about forty metres at any usable smoothing rate —
    // so the signature shot of the game framed the missile as a speck in the
    // middle distance no matter what chase offset was asked for. Smoothing the
    // offset instead keeps the round pinned exactly where it was framed while
    // still easing through the round's own manoeuvres.
    const desiredOff = _v3a.set(0, 0, 0)
      .addScaledVector(fwd, -19)
      .addScaledVector(up, 5.5)
      .addScaledVector(side, 4.2);
    if (!this._missileOff) this._missileOff = desiredOff.clone();
    this._missileOff.lerp(desiredOff, 1 - Math.exp(-dt * 5));
    this._missilePos.set(px, py, pz).add(this._missileOff);
    this._missilePos.y = Math.max(this._missilePos.y, 3.5);
    this.camera.position.copy(this._missilePos);
    const look = new THREE.Vector3(px, py, pz).addScaledVector(fwd, 11);
    this.camera.lookAt(look);
    this._updateProjection();
  }

  /** Screen ray -> sea-surface point in SIM coordinates. */
  screenToSea(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const d = ray.ray.direction;
    if (Math.abs(d.y) < 1e-6) return null;
    const t = -ray.ray.origin.y / d.y;
    if (t < 0) return null;
    const p = ray.ray.origin.clone().addScaledVector(d, t);
    return { x: p.x + this.origin.x, z: p.z + this.origin.y };
  }
}
