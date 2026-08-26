import * as THREE from 'three';

const _tmpDir = new THREE.Vector3();
const _tmpRight = new THREE.Vector3();
const _tmpView = new THREE.Vector3();
const _tmpPos = new THREE.Vector3();

/**
 * Generic GPU-cheap trailing ribbon: a ring-buffer of world-space samples rendered as a
 * triangle-strip quad-per-segment, alpha-blended with a procedural texture (see
 * ProceduralTextures.js — no image assets involved). Two use cases in this codebase:
 *   - ship-wake foam trail: flat, lies on the water plane ('horizontal' orientation)
 *   - projectile smoke/tracer trails: always faces the camera ('billboard' orientation,
 *     which needs the active camera passed into update())
 * The vertex/uv/alpha buffers are fixed-capacity typed arrays that get overwritten (not
 * reallocated) every rebuild, so this stays cheap even with several trails alive at once
 * (a handful of ships + in-flight ordnance during combat).
 */
export class TrailRibbon {
  constructor(scene, {
    capacity = 64,
    life = 2,
    color = 0xffffff,
    map,
    additive = false,
    orientation = 'billboard', // 'billboard' | 'horizontal'
    maxGap = 900,              // metres between samples before the ribbon restarts
    widthFn = () => 1,
    alphaFn = (age, life) => Math.max(0, 1 - age / life),
    uvRepeat = 1,
    renderOrder = 1,
    opacity = 1,
  } = {}) {
    this.scene = scene;
    this.capacity = capacity;
    this.life = life;
    this.orientation = orientation;
    this.widthFn = widthFn;
    this.alphaFn = alphaFn;
    this.uvRepeat = uvRepeat;
    this.maxGap = maxGap;
    this.samples = [];

    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(capacity * 2 * 3);
    const uvs = new Float32Array(capacity * 2 * 2);
    const alphas = new Float32Array(capacity * 2);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
    const indices = [];
    for (let i = 0; i < capacity - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
    geo.setIndex(indices);
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map },
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: opacity },
      },
      vertexShader: `
        attribute float alpha;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vUv = uv;
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          float a = texture2D(map, vUv).a * vAlpha * uOpacity;
          if (a < 0.008) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Record a new trailing point. `elapsed` must be the same clock update() is driven
   * with, passed explicitly (rather than read from internal state) so the freshest
   * sample never lags a frame behind the emitter. `data` is opaque per-sample payload
   * (e.g. ship speed) handed back to widthFn/alphaFn. */
  addSample(pos, elapsed, data = null) {
    const last = this.samples[this.samples.length - 1];
    // A floating-origin rebase, a camera teleport, or a view that was streamed
    // out and back leaves one stale sample kilometres away from its neighbour.
    // The quad spanning that gap has one end behind the camera, and what the
    // rasterizer does with it is a thin smear of dashes across the sky. Start a
    // fresh ribbon rather than try to draw the impossible one.
    if (last && (Math.abs(pos.x - last.x) > this.maxGap || Math.abs(pos.z - last.z) > this.maxGap)) {
      this.samples.length = 0;
    }
    this.samples.push({ x: pos.x, y: pos.y, z: pos.z, t: elapsed, data });
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  clear() {
    this.samples.length = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  update(elapsed, camera) {
    while (this.samples.length && elapsed - this.samples[0].t > this.life) this.samples.shift();
    this._rebuild(elapsed, camera);
  }

  _rebuild(elapsed, camera) {
    const n = this.samples.length;
    if (n < 2) { this.geometry.setDrawRange(0, 0); this.mesh.visible = false; return; }
    this.mesh.visible = true;

    const posArr = this.geometry.attributes.position.array;
    const uvArr = this.geometry.attributes.uv.array;
    const alphaArr = this.geometry.attributes.alpha.array;

    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const age = elapsed - s.t;
      const next = this.samples[i + 1] || this.samples[i - 1] || s;
      const prev = this.samples[i - 1] || next;
      _tmpDir.set(next.x - prev.x, next.y - prev.y, next.z - prev.z);
      if (_tmpDir.lengthSq() < 1e-8) _tmpDir.set(0, 0, 1);
      _tmpDir.normalize();

      if (this.orientation === 'horizontal') {
        _tmpRight.set(-_tmpDir.z, 0, _tmpDir.x);
        if (_tmpRight.lengthSq() < 1e-8) _tmpRight.set(1, 0, 0);
        _tmpRight.normalize();
      } else {
        _tmpPos.set(s.x, s.y, s.z);
        _tmpView.copy(camera.position).sub(_tmpPos).normalize();
        _tmpRight.crossVectors(_tmpDir, _tmpView);
        if (_tmpRight.lengthSq() < 1e-8) _tmpRight.set(1, 0, 0);
        _tmpRight.normalize();
      }

      const u = i / Math.max(1, n - 1);
      const width = this.widthFn(age, this.life, u, s.data) * 0.5;
      const alpha = this.alphaFn(age, this.life, u, s.data);

      const i2 = i * 2;
      posArr[i2 * 3 + 0] = s.x + _tmpRight.x * width;
      posArr[i2 * 3 + 1] = s.y + _tmpRight.y * width;
      posArr[i2 * 3 + 2] = s.z + _tmpRight.z * width;
      posArr[(i2 + 1) * 3 + 0] = s.x - _tmpRight.x * width;
      posArr[(i2 + 1) * 3 + 1] = s.y - _tmpRight.y * width;
      posArr[(i2 + 1) * 3 + 2] = s.z - _tmpRight.z * width;

      const uu = u * this.uvRepeat;
      uvArr[i2 * 2 + 0] = uu; uvArr[i2 * 2 + 1] = 0;
      uvArr[(i2 + 1) * 2 + 0] = uu; uvArr[(i2 + 1) * 2 + 1] = 1;

      alphaArr[i2] = alpha;
      alphaArr[i2 + 1] = alpha;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
