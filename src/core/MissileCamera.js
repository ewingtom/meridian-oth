import * as THREE from 'three';

/**
 * MissileCamera — Sea Power's signature "ride the missile" view. When the player
 * lets a weapon fly, the camera can snap to it and chase it out over the horizon
 * to impact, banking with the missile, then ease smoothly back to whatever station
 * view the player was in. No hard cut in either direction.
 *
 * It runs as a post-pass: the normal per-station camera (PlayerController +
 * CameraRig) sets the camera each frame as usual, and this OVERRIDES the final
 * transform only while active. That keeps the rig's own pose live and continuous
 * underneath, so releasing control at the end is seamless — the camera is already
 * sitting on the station pose when we hand back.
 *
 * Beyond the spectacle, this is a teaching instrument: riding a shot to its end
 * shows the trainee exactly why it hit or died — a chaff decoy pulling the seeker
 * off, a CIWS burst killing it short, a hard terminal jink, or a clean strike —
 * turning an abstract "track destroyed" plot event into a legible, visceral lesson.
 */
export class MissileCamera {
  constructor(camera) {
    this.camera = camera;
    this.target = null;        // the Projectile being ridden
    this.phase = 'off';        // off | follow | return
    this.autoSnap = true;      // snap to newly-fired offensive missiles
    this._returnT = 0;
    this._returnFrom = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 50 };
    this._desired = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._side = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._holdT = 0;           // brief dwell on impact before returning
    // Own persistent camera position. Critical: the CameraRig resets camera.position
    // to the station pose every frame before this override runs, so we must carry our
    // own position forward and lerp IT toward the chase point — lerping the (reset)
    // camera.position would restart from the ship each frame and never catch up.
    this._camPos = new THREE.Vector3();
  }

  get active() {
    return this.phase !== 'off';
  }

  /** Begin riding a projectile. Ignores duds (no position). */
  follow(projectile) {
    if (!projectile || !projectile.position) return false;
    this.target = projectile;
    this.phase = 'follow';
    this._holdT = 0;
    this._seedPose();
    return true;
  }

  /** Seat the camera behind the missile immediately so frame one isn't a jump. */
  _seedPose() {
    const p = this.target.position;
    this._fwd.copy(this.target.velocity);
    if (this._fwd.lengthSq() < 1e-4) this._fwd.set(0, 0, 1);
    this._fwd.normalize();
    this._camPos.copy(p).addScaledVector(this._fwd, -30).addScaledVector(this._up, 10);
    this.camera.position.copy(this._camPos);
  }

  /** Trigger an ease-back-to-station from a live follow (player pressed exit). */
  cancel(stationPose) {
    if (this.phase === 'follow') this._beginReturn(stationPose);
  }

  _beginReturn(stationPose) {
    this.phase = 'return';
    this._returnT = 0;
    this._returnFrom.pos.copy(this.camera.position);
    this._returnFrom.quat.copy(this.camera.quaternion);
    this._returnFrom.fov = this.camera.fov;
  }

  /**
   * Called every frame AFTER CameraRig.update, only meaningful while active.
   * `stationPose` is the live per-station camera pose (the transform the rig just
   * set), captured before this override runs — we ease back onto it on exit so the
   * handoff is seamless even as the ship keeps moving.
   * @returns {boolean} true if it drove the camera this frame.
   */
  update(dt, stationPose) {
    if (this.phase === 'off') return false;

    if (this.phase === 'follow') {
      const t = this.target;
      // Missile gone (hit / intercepted / expired): dwell a beat on the last
      // position so the outcome registers, then ease home.
      if (!t || t.dead) {
        // Hold the last chase framing (our own persistent position, not the rig's
        // reset station pose) for a beat so the outcome registers, then ease home.
        this.camera.position.copy(this._camPos);
        if (t && t.position) { this._look.copy(t.position); this.camera.lookAt(this._look); }
        this._holdT += dt;
        if (this._holdT > 0.7) this._beginReturn(stationPose);
        return true;
      }
      const p = t.position;
      this._fwd.copy(t.velocity);
      if (this._fwd.lengthSq() < 1e-4) this._fwd.set(0, 0, 1);
      this._fwd.normalize();
      // Chase pose: behind, above, and offset to one side for a dynamic 3/4 read
      // of the missile against the sea — reads far better than a dead-astern view.
      this._side.crossVectors(this._fwd, this._up).normalize();
      this._desired.copy(p)
        .addScaledVector(this._fwd, -30)
        .addScaledVector(this._up, 11)
        .addScaledVector(this._side, 7);
      this._desired.y = Math.max(this._desired.y, 6); // never dunk under the waves
      // Critically-damped-ish follow on our OWN persistent position (see _camPos).
      const k = 1 - Math.exp(-dt * 6.5);
      this._camPos.lerp(this._desired, k);
      this.camera.position.copy(this._camPos);
      this._look.copy(p).addScaledVector(this._fwd, 45);
      this.camera.lookAt(this._look);
      return true;
    }

    if (this.phase === 'return') {
      // Ease from where the ride ended back onto the LIVE station pose (so it lands
      // exactly where the rig is, even though the ship moved during the flight).
      this._returnT += dt / 0.85;
      const tt = Math.min(1, this._returnT);
      const e = tt * tt * (3 - 2 * tt); // smoothstep
      this.camera.position.lerpVectors(this._returnFrom.pos, stationPose.pos, e);
      this.camera.quaternion.slerpQuaternions(this._returnFrom.quat, stationPose.quat, e);
      const fov = THREE.MathUtils.lerp(this._returnFrom.fov, stationPose.fov, e);
      if (Math.abs(this.camera.fov - fov) > 0.01) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      if (tt >= 1) { this.phase = 'off'; this.target = null; return false; }
      return true;
    }
    return false;
  }
}
