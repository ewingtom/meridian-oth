import * as THREE from 'three';

/**
 * Pooled, GPU-driven VFX primitives shared by every weapon effect in the game.
 *
 * Two pools, each a SINGLE draw call with a fixed-capacity ring buffer:
 *
 *   ParticlePool — THREE.Points. Each particle's whole life (motion under
 *     exponential drag + gravity, growth, fade, sprite rotation) is evaluated in the
 *     vertex/fragment shader from its spawn attributes, so the CPU only touches a
 *     particle once, when it is spawned. Nothing is allocated per frame and dead
 *     particles cost a clipped vertex.
 *
 *   StreakPool — instanced camera-facing quads stretched along a velocity vector,
 *     used for CIWS tracer rounds. Also fully GPU-integrated: spawn writes the ray,
 *     the shader advances the head and billboards the body every frame.
 *
 * Both are created once per scene (see getWeaponFx) and reused for the whole session.
 */

// ---------------------------------------------------------------------------
// Procedural textures (no image assets; cached module-level)
// ---------------------------------------------------------------------------

let _smokeTex = null;
export function getSmokeTexture() {
  if (_smokeTex) return _smokeTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  // value-noise fbm for a lumpy, non-circular puff
  const grid = 8;
  const rnd = new Float32Array((grid + 1) * (grid + 1));
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.random();
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (x, y, freq) => {
    const gx = (x * freq) % grid;
    const gy = (y * freq) % grid;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = smooth(gx - x0), fy = smooth(gy - y0);
    const idx = (px, py) => rnd[(py % grid) * (grid + 1) + (px % grid)];
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(idx(x0, y0), idx(x0 + 1, y0), fx),
      THREE.MathUtils.lerp(idx(x0, y0 + 1), idx(x0 + 1, y0 + 1), fx),
      fy
    );
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const dx = u - 0.5, dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      let n = sample(u, v, 1) * 0.6 + sample(u, v, 2.3) * 0.28 + sample(u, v, 4.7) * 0.12;
      n = 0.55 + n * 0.75;
      let a = Math.max(0, 1 - r / n);
      a = Math.pow(a, 1.7);
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(THREE.MathUtils.clamp(a, 0, 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  _smokeTex = new THREE.CanvasTexture(c);
  _smokeTex.colorSpace = THREE.SRGBColorSpace;
  return _smokeTex;
}

let _sparkTex = null;
export function getSparkTexture() {
  if (_sparkTex) return _sparkTex;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.92)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.34)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _sparkTex = new THREE.CanvasTexture(c);
  _sparkTex.colorSpace = THREE.SRGBColorSpace;
  return _sparkTex;
}

// ---------------------------------------------------------------------------
// ParticlePool
// ---------------------------------------------------------------------------

const PARTICLE_VERT = `
attribute vec3 aVel;
attribute float aBirth;
attribute float aLife;
attribute vec2 aSize;     // start size, end size (world units)
attribute vec3 aColor;    // colour at birth
attribute vec3 aColor2;   // colour at death (smoke cools and dilutes as it ages)
attribute vec4 aParam;    // x = opacity, y = drag, z = gravity, w = turbulence
attribute float aSeed;
uniform float uTime;
uniform float uPix;
varying float vAlpha;
varying vec3 vColor;
varying float vSpin;
void main() {
  float t = uTime - aBirth;
  float n = t / max(0.0001, aLife);
  if (t < 0.0 || n >= 1.0) {
    gl_Position = vec4(0.0, 0.0, -3.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0; vColor = vec3(0.0); vSpin = 0.0;
    return;
  }
  float drag = max(0.0001, aParam.y);
  vec3 pos = position + aVel * ((1.0 - exp(-drag * t)) / drag);
  pos.y -= 0.5 * aParam.z * t * t;
  // Turbulent wander. Without it a spawn stream reads as a string of beads
  // marching along one line; with it the same particles read as a plume.
  float turb = aParam.w;
  if (turb > 0.0) {
    float ph = aSeed * 31.4159;
    float g = n * turb;
    pos.x += sin(t * 0.83 + ph) * g;
    pos.z += cos(t * 0.71 + ph * 1.7) * g;
    pos.y += sin(t * 1.29 + ph * 0.5) * g * 0.35;
  }
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float grow = 1.0 - pow(1.0 - n, 2.0);
  float size = mix(aSize.x, aSize.y, grow);
  gl_PointSize = clamp(size * uPix * 300.0 / max(1.0, -mv.z), 1.0, 1400.0);
  gl_Position = projectionMatrix * mv;
  float fadeIn = smoothstep(0.0, 0.09, n);
  float fadeOut = 1.0 - smoothstep(0.45, 1.0, n);
  vAlpha = aParam.x * fadeIn * fadeOut;
  vColor = mix(aColor, aColor2, smoothstep(0.0, 0.85, n));
  vSpin = aSeed * 6.28318 + t * (aSeed - 0.5) * 0.75;
}
`;

const PARTICLE_FRAG = `
uniform sampler2D map;
varying float vAlpha;
varying vec3 vColor;
varying float vSpin;
void main() {
  float c = cos(vSpin), s = sin(vSpin);
  vec2 uv = gl_PointCoord - 0.5;
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
  vec4 tex = texture2D(map, uv);
  float al = tex.a * vAlpha;
  if (al < 0.004) discard;
  gl_FragColor = vec4(vColor, al);
}
`;

export class ParticlePool {
  constructor(scene, { capacity = 1200, map, additive = false, renderOrder = 2 } = {}) {
    this.scene = scene;
    this.capacity = capacity;
    this._cursor = 0;
    this._dirty = false;
    this.now = 0;

    const geo = new THREE.BufferGeometry();
    const mk = (n, item) => new THREE.BufferAttribute(new Float32Array(capacity * item), item).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk('position', 3);
    this.aVel = mk('aVel', 3);
    this.aBirth = mk('aBirth', 1);
    this.aLife = mk('aLife', 1);
    this.aSize = mk('aSize', 2);
    this.aColor = mk('aColor', 3);
    this.aColor2 = mk('aColor2', 3);
    this.aParam = mk('aParam', 4);
    this.aSeed = mk('aSeed', 1);
    // Park everything far in the past so nothing renders before first spawn.
    this.aLife.array.fill(0.0001);
    this.aBirth.array.fill(-1000);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aBirth', this.aBirth);
    geo.setAttribute('aLife', this.aLife);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aColor2', this.aColor2);
    geo.setAttribute('aParam', this.aParam);
    geo.setAttribute('aSeed', this.aSeed);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map || getSmokeTexture() },
        uTime: { value: 0 },
        uPix: { value: Math.min(2, window.devicePixelRatio || 1) },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    scene.add(this.points);

    this._c = new THREE.Color();
  }

  /** Spawn one particle. All motion is baked into the attributes — never touched again. */
  spawn(pos, vel, {
    life = 1.5, size0 = 1, size1 = 4, color = 0xffffff, color1 = null, opacity = 0.6,
    drag = 0.8, gravity = 0, delay = 0, turb = 0,
  } = {}) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    const p = this.aPos.array, v = this.aVel.array, s = this.aSize.array;
    const c = this.aColor.array, c2 = this.aColor2.array, pr = this.aParam.array;
    p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
    v[i * 3] = vel.x; v[i * 3 + 1] = vel.y; v[i * 3 + 2] = vel.z;
    this.aBirth.array[i] = this.now + delay;
    this.aLife.array[i] = life;
    s[i * 2] = size0; s[i * 2 + 1] = size1;
    const col = color.isColor ? color : this._c.set(color);
    c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
    if (color1 === null || color1 === undefined) {
      c2[i * 3] = col.r; c2[i * 3 + 1] = col.g; c2[i * 3 + 2] = col.b;
    } else {
      const cb = color1.isColor ? color1 : this._c.set(color1);
      c2[i * 3] = cb.r; c2[i * 3 + 1] = cb.g; c2[i * 3 + 2] = cb.b;
    }
    pr[i * 4] = opacity; pr[i * 4 + 1] = drag; pr[i * 4 + 2] = gravity; pr[i * 4 + 3] = turb;
    this.aSeed.array[i] = Math.random();
    this._dirty = true;
  }

  /** Shift every live particle when the floating origin moves under them. */
  rebase(dx, dz) {
    const p = this.aPos.array;
    for (let i = 0; i < this.capacity; i++) { p[i * 3] -= dx; p[i * 3 + 2] -= dz; }
    this._dirty = true;
  }

  update(now) {
    this.now = now;
    this.material.uniforms.uTime.value = now;
    if (!this._dirty) return;
    this._dirty = false;
    this.aPos.needsUpdate = true;
    this.aVel.needsUpdate = true;
    this.aBirth.needsUpdate = true;
    this.aLife.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aColor2.needsUpdate = true;
    this.aParam.needsUpdate = true;
    this.aSeed.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// StreakPool — instanced tracer rounds
// ---------------------------------------------------------------------------

const STREAK_VERT = `
attribute vec3 iStart;
attribute vec3 iDir;
attribute float iSpeed;
attribute float iBirth;
attribute float iLife;
attribute vec2 iSize;   // x = length, y = half-width
attribute vec3 iColor;
uniform float uTime;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float t = uTime - iBirth;
  if (t < 0.0 || t >= iLife) {
    gl_Position = vec4(0.0, 0.0, -3.0, 1.0);
    vUv = vec2(0.0); vAlpha = 0.0; vColor = vec3(0.0);
    return;
  }
  vec3 head = iStart + iDir * (iSpeed * t);
  vec3 toCam = normalize(cameraPosition - head);
  vec3 right = cross(iDir, toCam);
  float rl = length(right);
  right = rl > 0.0001 ? right / rl : vec3(1.0, 0.0, 0.0);
  // Stub the tail out of the muzzle instead of popping full-length instantly.
  float len = iSize.x * min(1.0, t * 14.0);
  vec3 wp = head - iDir * (len * (1.0 - position.y)) + right * (position.x * iSize.y);
  vUv = vec2(position.x + 0.5, position.y);
  vAlpha = 1.0 - smoothstep(0.55, 1.0, t / iLife);
  vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const STREAK_FRAG = `
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float body = smoothstep(0.0, 0.75, edge);
  float along = mix(0.05, 1.0, pow(vUv.y, 2.0));
  float a = body * along * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * (0.6 + 0.8 * along), a);
}
`;

export class StreakPool {
  constructor(scene, { capacity = 320, renderOrder = 4 } = {}) {
    this.scene = scene;
    this.capacity = capacity;
    this._cursor = 0;
    this._dirty = false;
    this.now = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0,
    ]), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    const mk = (item) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * item), item).setUsage(THREE.DynamicDrawUsage);
    this.iStart = mk(3);
    this.iDir = mk(3);
    this.iSpeed = mk(1);
    this.iBirth = mk(1);
    this.iLife = mk(1);
    this.iSize = mk(2);
    this.iColor = mk(3);
    this.iLife.array.fill(0.0001);
    this.iBirth.array.fill(-1000);
    this.iDir.array.fill(0);
    for (let i = 0; i < capacity; i++) this.iDir.array[i * 3 + 1] = 1;
    geo.setAttribute('iStart', this.iStart);
    geo.setAttribute('iDir', this.iDir);
    geo.setAttribute('iSpeed', this.iSpeed);
    geo.setAttribute('iBirth', this.iBirth);
    geo.setAttribute('iLife', this.iLife);
    geo.setAttribute('iSize', this.iSize);
    geo.setAttribute('iColor', this.iColor);
    geo.instanceCount = capacity;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);
    this._c = new THREE.Color();
  }

  spawn(from, dir, { speed = 1100, length = 18, width = 0.45, life = 0.5, color = 0xfff0b0, delay = 0 } = {}) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    const st = this.iStart.array, d = this.iDir.array, sz = this.iSize.array, c = this.iColor.array;
    st[i * 3] = from.x; st[i * 3 + 1] = from.y; st[i * 3 + 2] = from.z;
    d[i * 3] = dir.x; d[i * 3 + 1] = dir.y; d[i * 3 + 2] = dir.z;
    this.iSpeed.array[i] = speed;
    this.iBirth.array[i] = this.now + delay;
    this.iLife.array[i] = life;
    sz[i * 2] = length; sz[i * 2 + 1] = width;
    const col = color.isColor ? color : this._c.set(color);
    c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
    this._dirty = true;
  }

  /** Shift live tracers when the floating origin moves under them. */
  rebase(dx, dz) {
    const a = this.iStart.array;
    for (let i = 0; i < this.capacity; i++) { a[i * 3] -= dx; a[i * 3 + 2] -= dz; }
    this.iStart.needsUpdate = true;
  }

  update(now) {
    this.now = now;
    this.material.uniforms.uTime.value = now;
    if (!this._dirty) return;
    this._dirty = false;
    this.iStart.needsUpdate = true;
    this.iDir.needsUpdate = true;
    this.iSpeed.needsUpdate = true;
    this.iBirth.needsUpdate = true;
    this.iLife.needsUpdate = true;
    this.iSize.needsUpdate = true;
    this.iColor.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shared per-scene instance
// ---------------------------------------------------------------------------

const _bySceneFx = new WeakMap();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * All weapon VFX pools for a scene: `smoke` (soft, alpha-blended puffs),
 * `fire` (additive hot puffs / sparks) and `streaks` (tracer rounds), plus
 * high-level helpers for the composite effects the weapons use.
 */
class WeaponFx {
  constructor(scene) {
    this.scene = scene;
    this.smoke = new ParticlePool(scene, { capacity: 1800, map: getSmokeTexture(), additive: false, renderOrder: 2 });
    this.fire = new ParticlePool(scene, { capacity: 900, map: getSparkTexture(), additive: true, renderOrder: 3 });
    this.streaks = new StreakPool(scene, { capacity: 400 });
    // Ambient wind, refreshed from the sim each frame; smoke rides it.
    this.wind = new THREE.Vector3(0, 0, 0);
    this.now = 0;
  }

  update(now) {
    this.now = now;
    this.smoke.update(now);
    this.fire.update(now);
    this.streaks.update(now);
  }

  /** Rolling motor exhaust: a hot additive core puff plus a cooler smoke puff. */
  motorPuff(pos, backDir, { hot = 1, size = 1, tint = 0xb8bcc0, underwater = false } = {}) {
    _v.copy(backDir).multiplyScalar(9 + 14 * hot)
      .add(_v2.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5));
    this.smoke.spawn(pos, _v, {
      life: underwater ? 1.4 : (1.6 + Math.random() * 1.6 + hot * 1.2),
      size0: 1.6 * size,
      size1: (underwater ? 7 : 13 + 10 * hot) * size,
      color: underwater ? 0xdaf6ff : tint,
      opacity: underwater ? 0.4 : (0.26 + 0.3 * hot),
      drag: 1.5,
      gravity: underwater ? -1.2 : -0.6,
    });
    if (hot > 0.25 && !underwater) {
      _v.copy(backDir).multiplyScalar(16 * hot)
        .add(_v2.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3));
      this.fire.spawn(pos, _v, {
        life: 0.13 + 0.14 * Math.random(),
        size0: 3.2 * size * hot,
        size1: 0.6 * size,
        color: Math.random() < 0.5 ? 0xffd089 : 0xff9c46,
        opacity: 0.85 * hot,
        drag: 3.5,
      });
    }
  }

  /** The big deflected exhaust cloud a canister/VLS launch dumps on the deck. */
  launchCloud(pos, dir, { scale = 1, color = 0xa8aab0, hot = 0xffc070 } = {}) {
    const n = Math.round(22 * scale);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.35 + Math.random();
      _v.set(Math.cos(a) * r * 16 * scale, (Math.random() * 0.75 - 0.1) * 12 * scale, Math.sin(a) * r * 16 * scale)
        .addScaledVector(dir, -10 * scale * Math.random());
      this.smoke.spawn(pos, _v, {
        life: 2.6 + Math.random() * 2.8,
        size0: 3 * scale,
        size1: (26 + Math.random() * 22) * scale,
        color,
        opacity: 0.34 + Math.random() * 0.2,
        drag: 1.15,
        gravity: -1.1,
        delay: Math.random() * 0.16,
      });
    }
    // Hot flare core right at the tube.
    for (let i = 0; i < Math.round(12 * scale); i++) {
      _v.copy(dir).multiplyScalar(-(10 + Math.random() * 34) * scale)
        .add(_v2.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 20).multiplyScalar(scale));
      this.fire.spawn(pos, _v, {
        life: 0.22 + Math.random() * 0.28,
        size0: 7 * scale,
        size1: 1.5 * scale,
        color: Math.random() < 0.4 ? 0xfff4d0 : hot,
        opacity: 0.95,
        drag: 3.2,
      });
    }
  }

  /** Booster burnout / separation: a short hot flare and a puff of unburnt smoke. */
  boosterSeparation(pos, backDir, { scale = 1 } = {}) {
    for (let i = 0; i < 10; i++) {
      _v.copy(backDir).multiplyScalar(18 + Math.random() * 30)
        .add(_v2.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16));
      this.fire.spawn(pos, _v, {
        life: 0.3 + Math.random() * 0.35,
        size0: 4.5 * scale, size1: 1 * scale,
        color: 0xffc477, opacity: 0.8, drag: 2.4,
      });
    }
    for (let i = 0; i < 8; i++) {
      _v.copy(backDir).multiplyScalar(10 + Math.random() * 18)
        .add(_v2.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 14));
      this.smoke.spawn(pos, _v, {
        life: 2.4 + Math.random() * 2,
        size0: 3 * scale, size1: 22 * scale,
        color: 0x9fa3a8, opacity: 0.34, drag: 1.2, gravity: -0.7,
      });
    }
  }

  /** Sea-skim rooster tail: spray torn off the wave tops under a low missile. */
  seaSpray(pos, forwardDir, { scale = 1 } = {}) {
    for (let i = 0; i < 2; i++) {
      _v.copy(forwardDir).multiplyScalar(-(4 + Math.random() * 10))
        .add(_v2.set((Math.random() - 0.5) * 7, 3 + Math.random() * 7, (Math.random() - 0.5) * 7));
      this.smoke.spawn(pos, _v, {
        life: 0.9 + Math.random() * 0.7,
        size0: 1.6 * scale, size1: (9 + Math.random() * 6) * scale,
        color: 0xe8f6ff, opacity: 0.42, drag: 2.0, gravity: 7,
      });
    }
  }

  /**
   * Persistent topside fire and smoke for a hull that is burning.
   *
   * Four layers, because a real ship fire is four things at once and any one of
   * them alone reads as a video-game particle emitter:
   *
   *   flame    a short, bright, additive body seated on the deck
   *   embers   fast sparks thrown clear of it
   *   hot      dense near-black smoke boiling straight off the flame
   *   plume    that smoke cooling, diluting to grey and leaning downwind
   *
   * The wind is what sells it. A vertical column looks like a chimney; a column
   * that bends over and streams to leeward looks like a ship in trouble, and it
   * is the thing the player picks up from the next horizon.
   */
  hullFire(pos, intensity = 0.5) {
    const I = Math.max(0, Math.min(1, intensity));
    const w = this.wind || { x: 0, z: 0 };
    const r = () => Math.random() - 0.5;
    const spread = 5 + I * 5;

    // ── flame body ──────────────────────────────────────────────────────────
    const flames = 2 + Math.round(I * 3);
    for (let i = 0; i < flames; i++) {
      _v2.set(pos.x + r() * spread, pos.y + Math.random() * 2.5, pos.z + r() * spread * 1.6);
      _v.set(w.x * 0.18 + r() * 3, 8 + Math.random() * (8 + I * 12), w.z * 0.18 + r() * 3);
      this.fire.spawn(_v2, _v, {
        life: 0.4 + Math.random() * 0.45,
        size0: 3.5 + I * 4.5,
        size1: 10 + I * 12,
        color: 0xffeec2, color1: 0xd63a06,
        opacity: 0.85, drag: 1.7, gravity: -3.2, turb: 2.5,
      });
    }

    // ── embers ──────────────────────────────────────────────────────────────
    if (Math.random() < 0.4 + I * 0.5) {
      for (let i = 0; i < 3; i++) {
        _v2.set(pos.x + r() * spread, pos.y + 1 + Math.random() * 3, pos.z + r() * spread);
        _v.set(w.x * 0.5 + r() * 14, 12 + Math.random() * 22, w.z * 0.5 + r() * 14);
        this.fire.spawn(_v2, _v, {
          life: 1.0 + Math.random() * 1.4,
          size0: 0.7 + Math.random() * 0.8, size1: 0.25,
          color: 0xffd489, color1: 0xc42d05,
          opacity: 0.95, drag: 0.5, gravity: 5.5, turb: 1.2,
        });
      }
    }

    // ── hot smoke: the black boil directly above the seat of the fire ───────
    const hot = 1 + Math.round(I * 2);
    for (let i = 0; i < hot; i++) {
      _v2.set(pos.x + r() * spread, pos.y + 3 + Math.random() * 5, pos.z + r() * spread * 1.3);
      _v.set(w.x * 0.3 + r() * 4, 13 + Math.random() * 12 * (0.5 + I), w.z * 0.3 + r() * 4);
      this.smoke.spawn(_v2, _v, {
        life: 1.7 + Math.random() * 1.1,
        size0: 3 + I * 3, size1: 15 + I * 12,
        color: 0x191512, color1: 0x342d26,
        opacity: 0.55 + I * 0.35, drag: 1.1, gravity: -3.4, turb: 4,
      });
    }

    // ── plume: cooling, diluting, streaming to leeward ──────────────────────
    const cool = 1 + Math.round(I * 2);
    for (let i = 0; i < cool; i++) {
      _v2.set(pos.x + r() * spread * 1.4, pos.y + 6 + Math.random() * 8, pos.z + r() * spread * 1.4);
      _v.set(
        w.x * (0.85 + Math.random() * 0.4) + r() * 3,
        10 + Math.random() * 9,
        w.z * (0.85 + Math.random() * 0.4) + r() * 3,
      );
      this.smoke.spawn(_v2, _v, {
        life: 7 + Math.random() * 9,
        size0: 8 + I * 6, size1: 60 + I * 55,
        color: 0x3b3630, color1: 0x929599,
        opacity: 0.3 + I * 0.18, drag: 0.24, gravity: -0.7, turb: 17,
      });
    }
  }

  /**
   * Bow spray. A hull driving into a sea throws water off the stem in sheets
   * that break into droplets and blow aft along the side — it is the loudest
   * visual signal that a ship is actually moving, and its absence is why a CG
   * warship so often looks like it is parked.
   */
  bowSpray(pos, fwd, speedFrac, beam) {
    const I = Math.max(0, Math.min(1.4, speedFrac));
    if (I < 0.12) return;
    const w = this.wind || { x: 0, z: 0 };
    const r = () => Math.random() - 0.5;
    const side = { x: -fwd.z, z: fwd.x };
    const n = 3 + Math.round(I * 6);
    for (let i = 0; i < n; i++) {
      const sgn = Math.random() < 0.5 ? -1 : 1;
      const out = beam * (0.35 + Math.random() * 0.5) * sgn;
      _v2.set(
        pos.x + side.x * out + r() * 3,
        1.0 + Math.random() * 2.2,
        pos.z + side.z * out + r() * 3,
      );
      // Thrown out and up off the stem, then carried aft by the ship's own wind.
      _v.set(
        side.x * sgn * (3 + Math.random() * 6) * I - fwd.x * (5 + I * 12) + w.x * 0.25,
        4 + Math.random() * 9 * I,
        side.z * sgn * (3 + Math.random() * 6) * I - fwd.z * (5 + I * 12) + w.z * 0.25,
      );
      this.smoke.spawn(_v2, _v, {
        life: 0.55 + Math.random() * 0.75,
        size0: 0.45 + I * 0.7,
        size1: 2.6 + I * 3.4,
        color: 0xf4f9fc, color1: 0xd6e5ee,
        opacity: 0.22 + I * 0.26,
        drag: 2.8, gravity: 7.5, turb: 1.6,
      });
    }
  }

  /** CIWS burst: a dense fan of tracers plus muzzle flash at the mount. */
  ciwsBurst(from, dir, distance, { rounds = 7, color = 0xfff0a0, spread = 0.02 } = {}) {
    const speed = 1120;
    const life = Math.min(1.6, Math.max(0.12, distance / speed) + 0.05);
    for (let i = 0; i < rounds; i++) {
      _v.copy(dir);
      _v.x += (Math.random() - 0.5) * spread;
      _v.y += (Math.random() - 0.5) * spread;
      _v.z += (Math.random() - 0.5) * spread;
      _v.normalize();
      this.streaks.spawn(from, _v, {
        speed: speed * (0.94 + Math.random() * 0.12),
        length: 28 + Math.random() * 18,
        width: 0.55 + Math.random() * 0.35,
        life,
        color,
        delay: i * 0.010,
      });
    }
    // muzzle flash
    for (let i = 0; i < 5; i++) {
      _v.copy(dir).multiplyScalar(18 + Math.random() * 20)
        .add(_v2.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8));
      this.fire.spawn(from, _v, {
        life: 0.07 + Math.random() * 0.06,
        size0: 5.2, size1: 1.1,
        color: i === 0 ? 0xfffbe6 : 0xffcf6a,
        opacity: 0.95, drag: 6,
      });
    }
    // wisp of gun smoke drifting off the mount
    if (Math.random() < 0.5) {
      _v.copy(dir).multiplyScalar(6).add(_v2.set((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4));
      this.smoke.spawn(from, _v, {
        life: 1.4 + Math.random(), size0: 1.4, size1: 9,
        color: 0xb9b6ad, opacity: 0.24, drag: 1.4, gravity: -1.4,
      });
    }
  }

  /** Fragmentation airburst — the visual signature of a successful CIWS kill.
   * Deliberately unlike a ship-impact fireball: a white flash, a fast radial
   * shrapnel star, and a small dirty grey-black frag puff. No lingering fire. */
  airburst(pos, { scale = 1 } = {}) {
    for (let i = 0; i < 34; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = (26 + Math.random() * 62) * scale;
      _v.set(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)).multiplyScalar(sp);
      this.fire.spawn(pos, _v, {
        life: 0.26 + Math.random() * 0.4,
        size0: 2.4 * scale, size1: 0.5 * scale,
        color: Math.random() < 0.35 ? 0xffffff : (Math.random() < 0.5 ? 0xffe6a8 : 0xff8a3c),
        opacity: 1, drag: 2.2, gravity: 9,
      });
    }
    for (let i = 0; i < 5; i++) {
      _v.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 10);
      this.fire.spawn(pos, _v, {
        life: 0.12 + Math.random() * 0.08,
        size0: 11 * scale, size1: 3 * scale,
        color: 0xfff6dc, opacity: 1, drag: 4,
      });
    }
    for (let i = 0; i < 10; i++) {
      _v.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 16 + 2, (Math.random() - 0.5) * 22);
      this.smoke.spawn(pos, _v, {
        life: 1.1 + Math.random() * 1.2,
        size0: 2.2 * scale, size1: (11 + Math.random() * 8) * scale,
        color: 0x4a4844, opacity: 0.5, drag: 2.4, gravity: 1.5,
      });
    }
  }

  dispose() {
    this.smoke.dispose();
    this.fire.dispose();
    this.streaks.dispose();
  }
}

/** Per-scene singleton — every projectile / launcher shares these three draw calls. */
export function getWeaponFx(scene) {
  let fx = _bySceneFx.get(scene);
  if (!fx) {
    fx = new WeaponFx(scene);
    _bySceneFx.set(scene, fx);
  }
  return fx;
}
