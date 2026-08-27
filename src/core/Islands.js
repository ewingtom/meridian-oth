import * as THREE from 'three';

/*
 * Littoral terrain.
 *
 * An ocean with nothing in it is a very large empty room. Land changes that in
 * three ways at once: it gives the eye a horizon feature and a sense of scale,
 * it gives the mission somewhere to BE — POINT OSCAR is a beach, and a landing
 * force has to arrive somewhere — and it gives the tactical picture terrain.
 * A headland between you and a hostile radar is the oldest cover there is.
 *
 * The islands are heightfields, generated from a seeded ridged-multifractal so
 * they read as rock rather than as smooth blobs, with a beach shelf that meets
 * the sea at zero and a cliff face where the slope runs away. Surfacing is by
 * height and slope: wet rock and sand at the bottom, bare rock on the steep
 * faces, tundra and snow on the tops — the same colour logic a real sub-arctic
 * island obeys.
 */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value-noise field with a seeded permutation, sampled bilinearly. */
function makeNoise(seed) {
  const N = 256;
  const rnd = mulberry(seed);
  const g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const at = (x, y) => g[((y & (N - 1)) * N) + (x & (N - 1))];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  };
}

/**
 * Build one island.
 *
 * @param {object} o
 * @param {number} o.radius   plan radius of the land mass, metres
 * @param {number} o.height   peak elevation, metres
 * @param {number} o.seed
 * @param {number} o.res      grid resolution per side
 */
export function buildIsland({ radius = 2600, height = 260, seed = 1, res = 128 } = {}) {
  const noise = makeNoise(seed);
  const rnd = mulberry(seed * 7919);
  // Two independent warps stop the plan shape being a circle with bumps.
  const warpA = makeNoise(seed + 101);
  const warpB = makeNoise(seed + 202);
  const lobeAng = rnd() * Math.PI * 2;
  const lobeAmp = 0.22 + rnd() * 0.3;

  const span = radius * 2.5;
  const half = span * 0.5;
  const pos = new Float32Array((res + 1) * (res + 1) * 3);
  const nrm = new Float32Array((res + 1) * (res + 1) * 3);
  const idx = [];

  const heightAt = (x, z) => {
    const d = Math.hypot(x, z);
    const ang = Math.atan2(z, x);
    // Plan-form: a radial falloff pushed around by low-frequency noise and one
    // deliberate lobe, so the island has a headland and a bay rather than being
    // rotationally symmetric.
    const wob = (warpA(x * 0.00042 + 13, z * 0.00042 + 7) - 0.5) * 0.55
      + Math.cos(ang - lobeAng) * lobeAmp;
    const rEff = radius * (1 + wob);
    let t = 1 - d / Math.max(120, rEff);
    if (t <= 0) return -18;                          // sea floor, well under water
    t = Math.pow(Math.max(0, t), 1.35);

    // Ridged multifractal: |1 - 2n| stacked over octaves is what turns smooth
    // noise into something with crests and gullies instead of dunes.
    let amp = 1, freq = 0.00085, r = 0, norm = 0;
    for (let o2 = 0; o2 < 5; o2++) {
      const n = noise(x * freq + seed * 3.1, z * freq + seed * 5.7);
      r += amp * (1 - Math.abs(1 - 2 * n));
      norm += amp;
      amp *= 0.52; freq *= 2.07;
    }
    r /= norm;
    // Sharpen the ridges. A plain sum of octaves gives a dome with texture on it;
    // pushing the ridged term through a power and letting it dominate the radial
    // falloff is what produces actual crests, corries and gullies.
    r = Math.pow(r, 1.9);
    const detail = (warpB(x * 0.0055, z * 0.0055) - 0.5) * 0.10;
    // Beach shelf: flatten the last stretch before the water so the land meets
    // the sea on a slope you could put a landing craft on, not a wall.
    const shelf = Math.min(1, t / 0.16);
    return (t * (0.12 + 1.30 * r) * height + detail * height * t) * shelf - (1 - shelf) * 3.0;
  };

  let p = 0;
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const x = -half + (i / res) * span;
      const z = -half + (j / res) * span;
      pos[p] = x; pos[p + 1] = heightAt(x, z); pos[p + 2] = z;
      p += 3;
    }
  }
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * (res + 1) + i, b = a + 1, c = a + res + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  return { geometry: geo, radius, height, span };
}

const ISLAND_VERT = /* glsl */`
uniform float uEarthR;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vHeight;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float radial = length(wp.xz - cameraPosition.xz);
  wp.y -= (radial * radial) / (2.0 * uEarthR);
  vWorld = wp.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vHeight = position.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const ISLAND_FRAG = /* glsl */`
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uHorizonColor;
uniform vec3 uSkyColor;
uniform float uVisibility;
uniform float uTime;
uniform float uSnowLine;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vHeight;

float ihash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float inoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ihash(i), ihash(i + vec2(1.0, 0.0)), f.x),
             mix(ihash(i + vec2(0.0, 1.0)), ihash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float ifbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * inoise(p); p *= 2.11; a *= 0.5; }
  return v;
}

/*
 * Exact inverse of the ACES fit the grade pass applies.
 *
 * This shader's palette is authored by eye, in display space. The grade pass
 * applies ACES and the sRGB transfer to the whole frame, so this surface has to
 * hand it something that comes back out looking as authored.
 *
 * The first attempt used pow(colour, 2.2), assuming linearise -> ACES -> sRGB
 * round-trips. It does not: ACES sits in the middle and compresses midtones, so
 * these surfaces were darkened TWICE and the darkest channel crushed hardest.
 * Measured on near water at a low eyepoint, red came out at exactly 0 — the
 * "foreground red channel hard-clipped to zero" an art review reported, and why
 * a low camera saw a near-black sea that looked correct from higher up.
 *
 * ACES is y = x(ax+b) / (x(cx+d)+e), so inverting is a quadratic:
 *   (yc - a)x^2 + (yd - b)x + ye = 0.  One sqrt, and the round trip is identity.
 */
uniform float uGradeExposure;
vec3 acesInverse(vec3 y) {
  const float ia = 2.51, ib = 0.03, ic = 2.43, id = 0.59, ie = 0.14;
  y = clamp(y, 0.0, 0.9999);
  vec3 A = y * ic - ia;
  vec3 B = y * id - ib;
  vec3 C = y * ie;
  vec3 disc = max(B * B - 4.0 * A * C, vec3(0.0));
  return max((-B - sqrt(disc)) / (2.0 * A), vec3(0.0));
}

void main() {
  vec3 N = normalize(vNrm);
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  float h = vHeight;

  // Surfacing by height and slope, which is how real coastal ground sorts
  // itself: sand where it is low and flat, bare rock where it is steep, tundra
  // on the shoulders, snow on the tops and in the lee.
  vec3 sand = vec3(0.52, 0.47, 0.40) * (0.85 + 0.3 * ifbm(vWorld.xz * 0.06));
  vec3 rock = mix(vec3(0.27, 0.26, 0.25), vec3(0.38, 0.36, 0.33),
                  ifbm(vWorld.xz * 0.021 + 4.0));
  rock *= 0.8 + 0.45 * ifbm(vWorld.xz * 0.14);
  vec3 tundra = mix(vec3(0.21, 0.24, 0.16), vec3(0.30, 0.31, 0.20),
                    ifbm(vWorld.xz * 0.035 + 11.0));
  vec3 snow = vec3(0.80, 0.83, 0.87);

  float sandM = (1.0 - smoothstep(1.0, 9.0, h)) * (1.0 - smoothstep(0.25, 0.55, slope));
  float snowM = smoothstep(uSnowLine, uSnowLine + 70.0, h) * (1.0 - smoothstep(0.45, 0.75, slope));
  float grassM = (1.0 - smoothstep(0.30, 0.62, slope)) * smoothstep(4.0, 22.0, h) * (1.0 - snowM);

  vec3 albedo = rock;
  albedo = mix(albedo, tundra, grassM);
  albedo = mix(albedo, sand, sandM);
  albedo = mix(albedo, snow, snowM);

  // Wet rock in the splash zone.
  float wet = 1.0 - smoothstep(-0.5, 3.2, h);
  albedo *= mix(1.0, 0.55, wet);

  float ndl = clamp(dot(N, uSunDirection), 0.0, 1.0);
  // Wrapped diffuse: bare rock under a big sky is not lambertian, and a hard
  // terminator on a headland looks like a lighting bug.
  float wrap = clamp((dot(N, uSunDirection) + 0.35) / 1.35, 0.0, 1.0);
  vec3 lit = albedo * (uSunColor * wrap * 1.25 + uSkyColor * (0.42 + 0.28 * N.y));
  // A little specular where it is wet.
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 H = normalize(V + uSunDirection);
  lit += uSunColor * pow(max(dot(N, H), 0.0), 40.0) * wet * 0.35;

  float dist = length(cameraPosition - vWorld);
  float air = 1.0 - exp(-dist * (3.912 / max(2000.0, uVisibility)) * 0.62);
  vec3 color = mix(lit, uHorizonColor * 0.97, clamp(air, 0.0, 0.96));
  color += (ihash(gl_FragCoord.xy * 0.21 + uTime) - 0.5) * (2.0 / 255.0);
  // Hand the grade pass LINEAR radiance — it now applies ACES and the sRGB
  // transfer to the whole frame. See the note in VIGNETTE_GRADE_SHADER.
  gl_FragColor = vec4(acesInverse(color) / uGradeExposure, 1.0);
}
`;

export function makeIslandMaterial(shared) {
  return new THREE.ShaderMaterial({
    vertexShader: ISLAND_VERT,
    fragmentShader: ISLAND_FRAG,
    uniforms: {
      uSunDirection: shared.uSunDirection,
      uSunColor: shared.uSunColor,
      uHorizonColor: shared.uHorizonColor,
      uSkyColor: { value: new THREE.Color(0x9fbdd6) },
      uVisibility: shared.uVisibility,
      uTime: shared.uTime,
      uEarthR: shared.uEarthR,
      uSnowLine: { value: 430 },
      uGradeExposure: { value: 1.3 },
    },
  });
}
