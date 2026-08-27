import * as THREE from 'three';
import { CLOUD_FIELD_GLSL } from './skyShader.js';

/**
 * Ocean surface.
 *
 * Descended from the MERIDIAN ocean (Gerstner vertex displacement + a rich
 * fragment pass doing capillary/chop/glitter, fresnel, foam and a physical
 * Kelvin wake), with two changes made for a fleet-scale game:
 *
 *  1. MULTIPLE WAKE SOURCES. The original coupled the water to a single hero
 *     hull. A task force is six ships in visual range of each other, so the
 *     bow mound, Kelvin arms and stern lane are now evaluated for the N nearest
 *     moving hulls each frame.
 *  2. A CAMERA-RELATIVE FRAME. The world is 680 km across; at those magnitudes
 *     float32 in the shader's noise hashes falls apart. The renderer keeps a
 *     floating origin and everything here works in metres from that origin.
 */

// Gerstner wave parameters: [dirX, dirZ, steepness, wavelength, speed, phase]
//
// Two properties matter more than the individual numbers. First, the wavelengths
// are mutual irrationals so the sum never repeats into a waffle lattice. Second —
// and this is what the original set was missing — every component carries its own
// PHASE offset. Without that, all ten waves crest together at the world origin and
// the sea reads as a stamped sheet of corrugated iron rather than a confused swell.
//
// The directional spread is deliberately wide (roughly ±70° about the wind axis)
// with the long swell trains clustered and the short chop scattered, which is
// what a real developing sea does.
const WAVE_SET = [
  [0.97, 0.24, 0.30, 137.0, 0.88, 0.00],
  [0.88, -0.47, 0.26, 89.0, 1.02, 2.31],
  [1.00, 0.05, 0.22, 61.0, 1.20, 4.77],
  [0.64, 0.77, 0.17, 43.0, 1.44, 1.13],
  [-0.31, 0.95, 0.14, 29.5, 1.79, 5.62],
  [0.79, -0.62, 0.115, 19.7, 2.16, 3.05],
  [-0.86, -0.51, 0.088, 13.1, 2.63, 0.47],
  [0.24, -0.97, 0.066, 8.9, 3.21, 2.88],
  [-0.99, 0.16, 0.048, 5.9, 3.94, 5.11],
  [0.55, 0.84, 0.034, 3.7, 4.86, 1.72],
  [-0.47, 0.88, 0.026, 2.4, 6.05, 3.61],
  [0.93, 0.37, 0.020, 1.6, 7.40, 0.92],
];

/**
 * The axis the dominant swell train runs along, i.e. the direction the wind is
 * blowing towards. Smoke, spray and any other wind-driven effect reads from here
 * so the whole scene agrees with itself: a plume leaning across the swell rather
 * than with it is the kind of thing nobody can name but everybody notices.
 */
export const WIND_DIR = (() => {
  const d = WAVE_SET[0];
  const l = Math.hypot(d[0], d[1]) || 1;
  return { x: d[0] / l, z: d[1] / l };
})();

// Eight, not five. A task force is eight hulls and a convoy adds more; with a
// budget of five, three ships in any wide shot simply slid across the water
// leaving nothing behind them, which is the single most obvious way for a sea
// to look fake. The loop is bounded and the extra three iterations early-out on
// the range test, so the cost lands well inside the frame.
export const NUM_WAKES = 8;

/** Outer radius of the detailed Gerstner field, metres. */
export const WAVE_FIELD_R = 14000;

/**
 * Camera-centred radial grid for the wave field.
 *
 * A square plane spends most of its vertices where they are least useful — the
 * far corners — and it ends in a straight edge that has to be hidden. A radial
 * grid whose ring spacing grows as a power of the radius puts roughly constant
 * SCREEN-space density on the water: about a metre between vertices at the
 * camera, forty at a kilometre, sixty at three. Same triangle budget, six times
 * the reach, and its boundary is a circle that meets the far-sea disc cleanly.
 */
function buildWaveGrid(rings = 140, segs = 256, r1 = WAVE_FIELD_R) {
  const r0 = 1.2;
  const pos = new Float32Array((rings + 1) * (segs + 1) * 3);
  const idx = [];
  let p = 0;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const rad = r0 + (r1 - r0) * Math.pow(t, 2.2);
    for (let sgm = 0; sgm <= segs; sgm++) {
      // The closing column must be BIT-IDENTICAL to the opening one. Computing
      // it as cos(2*pi)/sin(2*pi) instead leaves sin at -2.4e-16 rather than
      // zero, and that microscopic mismatch opens a one-pixel crack along a
      // single ray from the camera — a thin dark hairline running across the sea
      // that follows the camera around and reads as a rendering fault, because
      // it is one.
      const a = (sgm === segs ? 0 : sgm / segs) * Math.PI * 2;
      pos[p++] = Math.cos(a) * rad;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * rad;
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let sgm = 0; sgm < segs; sgm++) {
      const a = r * (segs + 1) + sgm;
      idx.push(a, a + (segs + 1), a + 1, a + 1, a + (segs + 1), a + segs + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = r1 * 1.4;
  return geo;
}

function buildWaveGLSL() {
  let decl = `#define NUM_WAVES ${WAVE_SET.length}\n`;
  decl += `#define NUM_WAKES ${NUM_WAKES}\n`;
  decl += `uniform vec4 uWaveA[NUM_WAVES];\nuniform vec2 uWaveB[NUM_WAVES];\n`;
  // uWaveAmp must be declared HERE, alongside the other wave uniforms, rather than
  // with the per-shader uniform block below: this string is inlined at the very top
  // of OCEAN_VERTEX, ahead of that block, and the Gerstner function it precedes
  // reads uWaveAmp. Declaring it later made the vertex shader fail to compile
  // outright ("'uWaveAmp' : undeclared identifier"), which silently took the whole
  // ocean surface out of the render.
  decl += `uniform float uWaveAmp;\n`;
  // Wake sources, packed: xy = position (camera-relative metres), zw = forward unit
  decl += `uniform vec4 uWakePos[NUM_WAKES];\n`;
  // x = normalised speed, y = half length, z = beam, w = active flag
  decl += `uniform vec4 uWakeDim[NUM_WAKES];\n`;
  return decl;
}

const GERSTNER_FUNC = `
vec3 gerstner(vec3 p, float t, vec3 camPos, out vec3 tangent, out vec3 binormal) {
  vec3 offset = vec3(0.0);
  tangent = vec3(1.0, 0.0, 0.0);
  binormal = vec3(0.0, 0.0, 1.0);
  // The ocean grid has fixed world-space vertex spacing. The shortest wave
  // components sit at or below that grid's Nyquist limit, which reads as moire in a
  // specific mid-distance band where perspective packs many cells into few pixels.
  // Fade each wave out with distance, scaled to its own wavelength, so short
  // components taper off before they can alias.
  float distToCam = length(p.xz - camPos.xz);
  for (int i = 0; i < NUM_WAVES; i++) {
    vec2 dir = uWaveA[i].xy;
    float steepness = uWaveA[i].z;
    float wavelength = uWaveA[i].w;
    float speed = uWaveB[i].x;
    float k = 6.28318530718 / wavelength;
    float c = sqrt(9.8 / k) * speed * 0.35 + speed * 0.15;
    float f = k * (dot(dir, p.xz) - c * t * 3.0) + uWaveB[i].y;
    float distFade = 1.0 - smoothstep(wavelength * 10.0, wavelength * 26.0, distToCam);
    float a = steepness / k / float(NUM_WAVES) * 3.35 * uWaveAmp
      * mix(1.0, distFade, step(wavelength, 38.0));
    offset.x += dir.x * a * cos(f);
    offset.z += dir.y * a * cos(f);
    offset.y += a * sin(f) * 0.92;

    float wa = k * a;
    tangent += vec3(
      -dir.x * dir.x * wa * sin(f),
      dir.x * wa * cos(f),
      -dir.x * dir.y * wa * sin(f)
    );
    binormal += vec3(
      -dir.x * dir.y * wa * sin(f),
      dir.y * wa * cos(f),
      -dir.y * dir.y * wa * sin(f)
    );
  }
  return offset;
}
`;

export const OCEAN_VERTEX = `
#include <common>
#include <shadowmap_pars_vertex>
${buildWaveGLSL()}
uniform float uTime;
uniform vec3 uCamPos;
uniform float uEarthR;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoamFactor;
varying float vFresnelBoost;
varying float vHullWake;
varying float vEdge;

${GERSTNER_FUNC}

void main() {
  vec3 pos = position;
  vec3 worldXZ = pos + vec3(modelMatrix[3].x, 0.0, modelMatrix[3].z);

  vec3 tangent, binormal;
  vec3 disp = gerstner(worldXZ, uTime, uCamPos, tangent, binormal);

  // ── hull-coupled surface displacement, summed over every nearby moving hull ──
  float wakeH = 0.0;
  float tangentLift = 0.0;
  float binormalLift = 0.0;
  float wakeAccum = 0.0;
  for (int i = 0; i < NUM_WAKES; i++) {
    if (uWakeDim[i].w < 0.5) continue;
    vec2 sp = uWakePos[i].xy;
    vec2 fwd = uWakePos[i].zw;
    float spd = uWakeDim[i].x;
    vec2 toShip = worldXZ.xz - sp;
    // Cheap reject: nothing beyond half a kilometre contributes.
    if (dot(toShip, toShip) > 640000.0) continue;
    float along = dot(toShip, fwd);
    float side = abs(dot(toShip, vec2(-fwd.y, fwd.x)));
    float bowMound = smoothstep(70.0, 0.0, along) * smoothstep(-10.0, 28.0, along)
      * smoothstep(28.0, 0.8, side) * spd;
    float sternLift = smoothstep(8.0, -14.0, along) * smoothstep(-120.0, -18.0, along)
      * smoothstep(22.0, 1.5, side) * spd * 0.55;

    // ── the Kelvin wake, as an actual wave system ─────────────────────────
    //
    // A displacement hull leaves a pattern that is the same shape for every ship
    // at every speed: a wedge of half-angle 19.47 degrees, filled with a
    // TRANSVERSE train running square across the track and a DIVERGENT train
    // running out along the cusp lines, both at the wavelength set by the ship's
    // own speed, lambda = 2*pi*V^2/g. Two constant-width airbrush smears — which
    // is what this used to be — get none of that: no wavelength, no cusps, no
    // decay, and no interaction with the sea they are drawn on.
    float V = max(1.5, spd * 11.3);              // metres per second
    float lam = clamp(6.28318 * V * V / 9.81, 10.0, 260.0);
    float kw = 6.28318 / lam;
    float aft = max(0.0, -along);
    float envelope = aft * 0.35355;              // tan(19.47 degrees)
    float inWedge = 1.0 - smoothstep(0.80, 1.06, side / max(2.0, envelope));
    float decay = exp(-aft / (140.0 + lam * 4.0));
    // Transverse crests: square across the track, spaced one wavelength apart.
    float trans = sin(kw * aft) * inWedge * decay;
    // Divergent crests: they lie along the arms, so their phase advances with a
    // mix of distance astern and distance out.
    float dph = kw * (aft * 0.88 + side * 0.52);
    float armBandV = smoothstep(0.26, 0.0, abs(side / max(2.0, envelope) - 0.86));
    float divg = sin(dph) * armBandV * decay;
    // Gated astern, for the same reason as in the fragment stage: ahead of the
    // stem the wedge envelope is zero, the arm band test degenerates, and the
    // vertex stage lifts a pair of ridges out of the water in FRONT of the ship.
    float asternV = smoothstep(0.0, max(uWakeDim[i].y, 40.0) * 0.30, aft);
    float kelvin = (trans * 0.55 + divg * 0.75) * spd * asternV;
    float kelvinAmp = clamp(0.30 + V * 0.075, 0.3, 1.5);

    // NEVER depress water beside a hull — that exposes the underwater hull band.
    // Astern of it the wake is a real wave train and may go both ways.
    wakeH += bowMound * 5.5 + sternLift * 2.2 + kelvin * kelvinAmp;
    tangentLift += bowMound * 0.55 + kelvin * 0.30;
    binormalLift += bowMound * 0.25 + kelvin * 0.16;
    wakeAccum += bowMound + sternLift + abs(kelvin) * 0.7;
  }
  disp.y += wakeH;
  tangent.y += tangentLift;
  binormal.y += binormalLift;
  vHullWake = clamp(wakeAccum, 0.0, 1.6);

  pos += disp;

  vec3 n = normalize(cross(binormal, tangent));
  vNormal = n;

  vec4 worldPos = modelMatrix * vec4(pos, 1.0);
  // Same earth-curvature drop the far sea uses, so the two surfaces are one
  // continuous sphere rather than a plane meeting a bowl.
  float radial = length(position.xz);
  worldPos.y -= (radial * radial) / (2.0 * uEarthR);
  vWorldPos = worldPos.xyz;
  vEdge = radial;

  // Crest steepness, as the tangent frame's deviation from flat.
  //
  // The 0.55 subtracted here was a dead constant: a Gerstner surface at any
  // amplitude this game produces has a steepness well under it, so the term
  // clamped to zero on every vertex, at every sea state, always. Whitecaps have
  // therefore never rendered once in this project — which is exactly what an
  // art review found when it forced a gale and got a sea with no breaking
  // crests anywhere on it.
  //
  // No bias, and a gain that puts the result in the range the break threshold
  // downstream actually tests against.
  float steep = length(tangent - vec3(1.0,0.0,0.0)) + length(binormal - vec3(0.0,0.0,1.0));
  vFoamFactor = clamp(steep * 1.7 + vHullWake * 0.8, 0.0, 1.8);

  float distToCam = length(uCamPos - worldPos.xyz);
  vFresnelBoost = smoothstep(800.0, 40.0, distToCam);

  // ── shadow reception ──────────────────────────────────────────────────────
  // The single biggest "this is pasted on top of the ocean" tell is a hull that
  // throws no shadow onto the water under it. three.js's shadow chunks want two
  // specific names in scope: a vec4 worldPosition and a view-space
  // transformedNormal. Provide them and let the standard code do the rest.
  vec4 worldPosition = worldPos;
  vec3 transformedNormal = normalMatrix * n;
  #include <shadowmap_vertex>

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export const OCEAN_FRAGMENT = `

#include <common>
#include <packing>
// WebGLRenderer sets this per-object automatically, but only declares it for its
// own material types — a ShaderMaterial has to declare it or getShadowMask()
// fails to compile and takes the whole ocean with it.
uniform bool receiveShadow;
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
#define NUM_WAKES ${NUM_WAKES}
uniform float uTime;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uLightScale;
uniform vec3 uCamPos;
uniform samplerCube uEnvMap;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uVisibility;
uniform vec3 uHorizonColor;
uniform float uDetailLevel;
// uWaveAmp is declared for the VERTEX stage by buildWaveGLSL(); the fragment
// stage is a separate compilation unit and needs its own declaration. Omitting
// it does not fail loudly — the fragment shader simply refuses to compile, the
// program never links, and the entire ocean silently disappears from the frame
// while everything else keeps rendering. (See validateShaders() in renderer.js,
// which now turns exactly this failure into a console error at startup.)
uniform float uWaveAmp;
uniform vec4 uIsland[4];   // xz centre (render space), z plan radius, w peak height
uniform float uFieldR;
uniform vec4 uWakePos[NUM_WAKES];
uniform vec4 uWakeDim[NUM_WAKES];
uniform vec4 uWakeCol[NUM_WAKES];   // rgb topside colour, a = half-length
uniform float uRain;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoamFactor;
varying float vFresnelBoost;
varying float vHullWake;
varying float vEdge;

${CLOUD_FIELD_GLSL}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
/*
 * Rotate each octave, do not merely scale it.
 *
 * noise() interpolates a hash on an axis-aligned integer lattice, so its
 * structure is axis-aligned too. Scaling by 2.02 between octaves keeps every
 * one of them on the SAME axes, and their features stack up into visible
 * rectangular cells — which is exactly what the whitecap foam looked like once
 * the tone mapping was fixed and the sea was finally bright enough to show it:
 * hard blocky patches rather than breaking crests.
 *
 * A rotation by a non-special angle between octaves decorrelates them, and the
 * lattice stops being able to reinforce itself. It costs two multiplies.
 */
const mat2 FBM_ROT = mat2(0.8253356, -0.5646425, 0.5646425, 0.8253356);  // ~34.4 deg
float fbm(vec2 p) {
  float v = 0.0, amp = 0.5;
  for (int i = 0; i < 3; i++) { v += amp * noise(p); p = FBM_ROT * p * 2.02; amp *= 0.5; }
  return v;
}

/*
 * Value noise that also returns its own gradient — vec3(value, d/dx, d/dy).
 *
 * The surface-detail block needs GRADIENTS, not values: it perturbs the normal,
 * so what it actually wants is the slope of each noise octave. It was getting
 * them by finite difference — sampling the field three times per octave and
 * subtracting — which is three times the work for an approximation.
 *
 * The interpolant here is the same smoothstep the value path uses, so this is
 * the exact analytic derivative of noise() above and the surface is
 * bit-comparable. Measured at 1280x720 the detail-normal block was 7.7 ms of a
 * 44.4 ms frame, and it is the single most expensive thing in the water.
 */
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);              // d/df of the interpolant
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(
    a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    du.x * (k1 + k3 * u.y),
    du.y * (k2 + k3 * u.x)
  );
}

/** Three-octave fbm carrying its gradient. Matches fbm() term for term. */
vec3 fbmd(vec2 p) {
  vec3 acc = vec3(0.0);
  float amp = 0.5;
  vec2 q = p;
  mat2 rot = mat2(1.0, 0.0, 0.0, 1.0);
  for (int i = 0; i < 3; i++) {
    vec3 n = noised(q);
    acc.x += amp * n.x;
    // Chain-rule the accumulated rotation and scale back onto the gradient.
    acc.yz += amp * (n.y * vec2(rot[0][0], rot[1][0]) + n.z * vec2(rot[0][1], rot[1][1]));
    q = FBM_ROT * q * 2.02;
    rot = FBM_ROT * rot * 2.02;
    amp *= 0.5;
  }
  return acc;
}

/*
 * Aerial perspective, integrated through a two-component atmosphere.
 *
 * Treating the air as uniform is fine at sea level and completely wrong from
 * altitude: a camera 45 km up looking down at the fleet is not looking through
 * 45 km of sea-level air. But using ONE scale height is wrong too, and that is
 * the subtler error. What limits visibility at sea level is aerosol — haze, salt,
 * spray — and aerosol hugs the surface with a scale height near 1.2 km. Molecular
 * (Rayleigh) scattering is far weaker but reaches to 8.4 km and beyond.
 *
 * Integrate them separately and both regimes come out right: 40 km of sea-level
 * air is a wall of haze (which is the definition of the visual range), while the
 * same 40 km looking straight down from the stratosphere is nearly clear — which
 * is why satellite photographs of the ocean are deep blue and not white.
 */
float layerDepth(float dist, float lo, float hi, float H) {
  float dh = hi - lo;
  if (dh < 1.0) return dist * exp(-lo / H);
  return dist * (H / dh) * (exp(-lo / H) - exp(-hi / H));
}
float opticalDepth(float dist, float hA, float hB, float k) {
  float lo = max(0.0, min(hA, hB));
  float hi = max(0.0, max(hA, hB));
  float aerosol = k * layerDepth(dist, lo, hi, 1250.0);
  float rayleigh = 1.15e-5 * layerDepth(dist, lo, hi, 8400.0);
  return aerosol + rayleigh;
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
 * Measured on near water at a low eyepoint, red came out at exactly 0 — which is
 * the "foreground red channel hard-clipped to zero" an art review reported, and
 * why a low camera saw a near-black sea that looked correct from higher up.
 *
 * ACES is y = x(ax+b) / (x(cx+d)+e), so inverting is a quadratic:
 *   (yc - a)x^2 + (yd - b)x + ye = 0.  One sqrt, round trip is identity.
 */
uniform float uGradeExposure;
vec3 acesInverse(vec3 y) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  // Overexposure has to run to white, not through the nearest primary.
  //
  // The clamp below is per channel, so a colour whose red passes one first is
  // held there while green and blue keep climbing. The sun's glow is a single
  // warm hue scaled over four orders of magnitude, and that clamp turned it into
  // a ringed target: a pink halo where only red had clipped, a yellow ring where
  // red and green had, a white core where all three had. Nothing in the scene is
  // pink. Pull the channel ratios together as the peak goes past one so they
  // arrive at the ceiling together, which is also what film does.
  float peak = max(max(y.r, y.g), y.b);
  if (peak > 1.0) {
    float s = 1.0 / (1.0 + (peak - 1.0) * 1.2);
    y = mix(vec3(1.0), y / peak, s) * peak;
  }
  y = clamp(y, 0.0, 0.9999);
  vec3 A = y * c - a;
  vec3 B = y * d - b;
  vec3 C = y * e;
  vec3 disc = max(B * B - 4.0 * A * C, vec3(0.0));
  return max((-B - sqrt(disc)) / (2.0 * A), vec3(0.0));
}

void main() {
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  float dist = length(uCamPos - vWorldPos);

  // ── surface detail, as a proper LOD chain ────────────────────────────────
  // The original faded ALL micro-detail out past 420 m, which left everything
  // beyond that a smooth foil catching the sky in long unbroken ribbons — the
  // single biggest reason the water read as painted metal instead of sea. Each
  // octave now fades at its own distance: the swell texture survives to six
  // kilometres, wind chop to about one, capillary ripples only in the near field.
  // Fading them independently keeps detail everywhere the eye can resolve it
  // without letting any octave alias once it drops below a pixel.
  float dSwell = smoothstep(4200.0, 900.0, dist) * uDetailLevel;
  // The swell normal is built from TWO octaves, and each one costs three field
  // lookups to finite-difference a gradient out of. The second is four times the
  // frequency of the first, so it drops below a pixel four times sooner — but it
  // was fading on the same seven-kilometre curve as the first and being sampled
  // across most of the screen for nothing. Measured at 1280x720, the whole
  // detail-normal block was 7.9 ms of a 49.6 ms frame.
  float dSwell2 = smoothstep(1500.0, 400.0, dist) * uDetailLevel;
  float dChop  = smoothstep(1600.0, 220.0, dist) * uDetailLevel;
  float dCap   = smoothstep(340.0, 45.0, dist) * uDetailLevel;
  float nearDetail = max(dSwell, max(dChop, dCap));

  vec3 N = normalize(vNormal);
  if (nearDetail > 0.01) {
    vec2 grad = vec2(0.0);
    // Analytic gradients. Each of these used to sample its octave THREE times and
    // subtract to approximate a slope; noised()/fbmd() return the exact slope in
    // one. The negative-epsilon factors reproduce the old finite-difference
    // scaling term for term, so the surface is unchanged — the same water,
    // computed properly instead of by difference.
    if (dSwell > 0.01) {
      vec2 rp = vWorldPos.xz * 0.055 + uTime * 0.030;
      grad += fbmd(rp).yz * (-0.55) * dSwell;
    }
    if (dSwell2 > 0.01) {
      vec2 rp2 = vWorldPos.xz * 0.155 - uTime * 0.055;
      grad += fbmd(rp2).yz * (-0.3) * 0.7 * dSwell2;
    }
    if (dChop > 0.01) {
      vec2 rpChop = vWorldPos.xz * 0.62 + uTime * 0.13;
      grad += fbmd(rpChop).yz * (-0.16) * 0.6 * dChop;
    }
    if (dCap > 0.01) {
      vec2 rpCap = vWorldPos.xz * 2.9 + uTime * 0.42;
      grad += noised(rpCap).yz * (-0.04) * 0.42 * dCap;
    }
    // Rain stipple — thousands of tiny impact rings when the weather closes in.
    if (uRain > 0.01 && dCap > 0.01) {
      vec2 rr = vWorldPos.xz * 6.0 + floor(uTime * 12.0);
      grad += noised(rr).yz * (-0.02) * uRain * 1.6 * dCap;
    }
    // Detail-normal strength stays modest: at high gain the tight specular lobe
    // draws continuous bright filaments instead of sparkle.
    vec3 detailNormal = normalize(vec3(grad.x * 1.15, 1.0, grad.y * 1.15));
    N = normalize(mix(vNormal, normalize(vNormal + detailNormal * 0.7), 0.92));
  }

  float NdotV = clamp(dot(N, viewDir), 0.0, 1.0);
  float fresnel = pow(1.0 - NdotV, 4.2);
  fresnel = mix(0.04, 1.0, fresnel);

  vec3 reflectDir = reflect(-viewDir, N);
  vec3 reflColor = textureCube(uEnvMap, reflectDir).rgb;
  // Water reflects less than a mirror and the sea's own roughness blurs and dims
  // what comes back. Reflecting the sky at full brightness is what produced the
  // hard pale ribbons on every wave face.
  // Dimmed, but not extinguished.
  //
  // At a grazing angle Fresnel is near one, so distant water is almost entirely
  // reflection — that is why the sea lightens toward the horizon and takes the
  // sky's colour. Sampled down the centre of a frame, the sky read (68,110,152)
  // and the water below it (0,18,50): the reflection was being scaled so far
  // down that the sea never approached the sky at any distance. An art review
  // called the result flat and red-starved, and the red channel was in fact
  // clipping to exactly zero across the whole ocean.
  reflColor = mix(reflColor * 0.94, uHorizonColor * 0.86, 0.24);

  float depthMix = clamp(dot(N, vec3(0.0,1.0,0.0)), 0.0, 1.0);
  vec3 waterColor = mix(uDeepColor, uShallowColor, pow(depthMix, 2.4) * 0.55);

  // Subsurface scattering. Sunlight that enters the back of a wave and comes out
  // of the front is what gives a swell its green-blue translucent glow, and its
  // absence is why untreated CG water looks like tinted glass. Strongest looking
  // toward the sun, and only where the surface is actually piled up into a crest.
  float towardSun = clamp(dot(-viewDir, uSunDirection) * 0.5 + 0.5, 0.0, 1.0);
  // Crest steepness WITHOUT the hull-wake term. vFoamFactor folds the wake mound
  // into itself so that foam appears around a moving hull; feeding that same
  // number into subsurface scattering painted a brilliant turquoise slab across
  // the bow wave, because the wake pegs the term at maximum.
  float naturalCrest = clamp(vFoamFactor - vHullWake * 0.8, 0.0, 1.2);
  float sss = pow(towardSun, 3.5) * clamp(naturalCrest * 0.7, 0.0, 1.0);
  waterColor += vec3(0.010, 0.048, 0.043) * sss * 1.5 * uSunColor;
  // Upwelling radiance. Deep water is not black: sunlight that penetrates the
  // surface is scattered back out by the water column itself, which is why the
  // sea right under your feet from a bridge wing is a deep blue rather than a
  // hole. Without it the near field reads as a void around every hull.
  waterColor += vec3(0.008, 0.030, 0.052) * clamp(uSunDirection.y, 0.0, 1.0) * (0.55 + 0.45 * N.y);

  vec3 halfDir = normalize(uSunDirection + viewDir);
  float NdotH = clamp(dot(N, halfDir), 0.0, 1.0);
  // Broad sun sheen, deliberately weak, plus a sparse high-frequency glitter
  // mask so the sun road is made of individual points of light.
  float spec = min(pow(NdotH, 900.0) * 0.20, 0.22);
  float sparkle = nearDetail > 0.15
    ? smoothstep(0.86, 1.0, noise(vWorldPos.xz * 9.0 + uTime * 1.9))
      * smoothstep(0.55, 0.95, noise(vWorldPos.xz * 1.7 - uTime * 0.4))
    : 0.0;
  float glitter = pow(NdotH, 130.0) * sparkle * 0.9;
  // Cloud shadows. A broken deck lays great slow-moving patches of shade across
  // the sea, and their absence is one of the reasons an otherwise good CG ocean
  // still reads as a shader rather than as water.
  float sun = cloudSunlight(vWorldPos.xz - uCamPos.xz, uSunDirection, uTime);
  vec3 sunSpec = uSunColor * (spec + glitter) * (0.35 + 0.55 * vFresnelBoost) * sun;

  // ── wake foam / wet darkening, summed over every nearby hull ───────────────
  float hullFoam = 0.0;
  float hullShade = 1.0;
  float bowFoam = 0.0;
  float besideHullMax = 0.0;
  float waterlineMax = 0.0;
  float wetBand = 0.0;
  float collarFoam = 0.0;

  // ── noise fields, evaluated ONCE ─────────────────────────────────────────
  //
  // Everything below used to be evaluated INSIDE the per-hull loop. fbm is five
  // octaves of value noise, the loop runs once per nearby ship, and the ocean
  // covers most of the screen — so a task force of eight was paying forty fbm
  // evaluations on every water pixel in the frame to compute five fields that do
  // not depend on which ship is being considered at all. That is what made the
  // game lag. They are functions of world position and time; hoist them.
  // ...but only where a hull can actually use them.
  //
  // All four of these feed wake foam, the churn collar and a ship's reflection.
  // They were hoisted out of the per-hull loop so they are evaluated once rather
  // than once per ship — correct — but they were still evaluated on EVERY water
  // pixel in the frame, and in any wide shot almost none of the sea is within a
  // kilometre of a ship. Four field lookups on most of the screen, discarded.
  //
  // A handful of squared-distance tests against the wake slots costs a fraction
  // of one lookup and skips all four.
  bool nearAnyHull = false;
  for (int i = 0; i < NUM_WAKES; i++) {
    if (uWakeDim[i].w < 0.5) continue;
    vec2 dHull = vWorldPos.xz - uWakePos[i].xy;
    if (dot(dHull, dHull) < 1000000.0) nearAnyHull = true;
  }
  float nLace = 0.0, nStreak = 0.0, nChurn = 0.0, nRefl = 0.0;
  if (nearAnyHull) {
    nLace   = smoothstep(0.3, 0.88, fbm(vWorldPos.xz * 0.55 + uTime * 0.4));
    nStreak = smoothstep(0.5, 0.95, fbm(vWorldPos.xz * 1.4 - uTime * 0.2));
    nChurn  = fbm(vWorldPos.xz * 1.15 + uTime * 0.9);
    nRefl   = fbm(vWorldPos.xz * 0.09 + uTime * 0.13);
  }
  float wakeTrough = 0.0;
  float nearShipMax = 0.0;
  vec3 hullRefl = vec3(0.0);
  float hullReflW = 0.0;
  for (int i = 0; i < NUM_WAKES; i++) {
    if (uWakeDim[i].w < 0.5) continue;
    vec2 sp = uWakePos[i].xy;
    vec2 fwd = uWakePos[i].zw;
    float spd = uWakeDim[i].x;
    float halfLen = max(uWakeDim[i].y, 40.0);
    float beam = max(uWakeDim[i].z, 12.0);
    vec2 toShip = vWorldPos.xz - sp;
    if (dot(toShip, toShip) > 1000000.0) continue;
    float shipDist = length(toShip);
    float along = dot(toShip, fwd);
    float side = abs(dot(toShip, vec2(-fwd.y, fwd.x)));

    // ── the hull's own shadow on the sea ────────────────────────────────────
    // A ship that throws no shadow reads as a decal pasted on the water, and it
    // is the first thing anyone notices. A shadow map would only cover whatever
    // box the sun's shadow camera happens to be looking at; this is analytic, so
    // every hull in the wake set casts, at any range, for free.
    //
    // The test is the real one: walk up the column of air above this patch of
    // water and ask whether the ship's solid volume is in the way of the sun. At
    // height y the sightline has drifted by sunHoriz * (y / sunUp), so a few
    // samples up the column trace out the correct sheared silhouette — long and
    // raking with the sun low, tight under the keel with it overhead.
    float shipH = uWakeDim[i].w;

    // ── the hull's REFLECTION in the sea ────────────────────────────────────
    //
    // A ship with a shadow but no reflection still reads as a cut-out. Every
    // naval game worth comparing this one to lays the hull back down the water
    // toward the viewer, and on a real sea it is not a mirror image — it is a
    // broken vertical smear of the ship's own tone, torn apart by every wave
    // between you and it.
    //
    // Geometry, not a render pass. A point h metres above the water on an object
    // D metres away reflects at D * hc / (hc + h) from the eye along the same
    // bearing, where hc is the eye height. So the whole reflection occupies the
    // band between D * hc / (hc + shipH) and D, on the ship's bearing, and its
    // width is the ship's own beam-on width at that range. That is a handful of
    // dot products per hull.
    {
      vec2 camToShip = sp - uCamPos.xz;
      float dShip = length(camToShip);
      if (dShip > 30.0 && uCamPos.y > 0.5 && uCamPos.y < 900.0) {
        vec2 bearing = camToShip / dShip;
        vec2 camToFrag = vWorldPos.xz - uCamPos.xz;
        float alongB = dot(camToFrag, bearing);
        float lateralB = abs(dot(camToFrag, vec2(-bearing.y, bearing.x)));

        float hc = uCamPos.y;
        float dTop = dShip * hc / (hc + shipH);      // where the masthead lands
        float span = max(1.0, dShip - dTop);

        // How wide does this hull look from here? Broadside it is its length;
        // bow-on it is its beam.
        float cosAsp = abs(dot(bearing, fwd));
        float halfW = mix(halfLen, beam * 0.55, cosAsp);

        float inBand = smoothstep(dTop - span * 0.10, dTop + span * 0.10, alongB)
                     * smoothstep(dShip + halfW * 0.35, dShip - halfW * 0.1, alongB)
                     * smoothstep(halfW * 1.35, halfW * 0.55, lateralB);

        // Break it up. A reflection only survives where the surface happens to
        // be facing you; every wave slope tears a piece out of it, which is what
        // turns a mirror into the ragged column of light a real ship lays down.
        float chopBreak = smoothstep(0.78, 0.985, N.y)
          * (0.35 + 0.75 * nRefl);
        // It fades with depth into the reflection, as the mast end gets more
        // grazing and more broken.
        float depthFade = mix(0.35, 1.0, smoothstep(dTop, dShip, alongB));

        float w = inBand * chopBreak * depthFade;
        hullRefl += uWakeCol[i].rgb * w;
        hullReflW += w;
      }
    }

    if (uSunDirection.y > 0.03) {
      float occ = 0.0;
      for (int k = 0; k < 4; k++) {
        float hy = (float(k) + 0.35) / 4.0 * shipH;
        vec2 q = vWorldPos.xz + uSunDirection.xz * (hy / uSunDirection.y) - sp;
        float qa = dot(q, fwd);
        float qs = abs(dot(q, vec2(-fwd.y, fwd.x)));
        // Hull below the deck edge, superstructure above it — two boxes, which
        // is enough to give the shadow a recognisable warship shape.
        float t = hy / max(1.0, shipH);
        float la = mix(halfLen, halfLen * 0.42, smoothstep(0.22, 0.75, t));
        float lb = mix(beam * 0.52, beam * 0.30, smoothstep(0.22, 0.75, t));
        float inBox = smoothstep(la + 5.0, la - 5.0, abs(qa))
          * smoothstep(lb + 4.0, lb - 4.0, qs);
        occ = max(occ, inBox);
      }
      hullShade = min(hullShade, 1.0 - occ * 0.86);
    }

    // Contact occlusion, and NOTHING WIDER.
    //
    // This used to reach 2.6 beams out from the hull and darken that whole
    // region by nearly half. A soft-edged rounded rectangle of dark water,
    // aligned to the hull and completely indifferent to where the sun is, is not
    // a shadow — it is a decal, and an art review saw it for exactly that: "a
    // hard-edged grey shadow polygon floats beside every ship."
    //
    // The real hull shadow is hullShade above, which walks the air column toward
    // the sun and falls where a shadow actually falls. This term's only job is
    // the darkening in the few metres right against the plating where the sky is
    // genuinely occluded, so it is now tight enough to read as contact.
    float besideHull = smoothstep(halfLen * 1.02, halfLen * 0.80, abs(along))
      * smoothstep(beam * 1.05, beam * 0.46, side);
    float waterlineRing = smoothstep(beam * 1.85, beam * 0.22, side)
      * smoothstep(halfLen + 18.0, halfLen * 0.92, abs(along));
    besideHullMax = max(besideHullMax, besideHull);
    waterlineMax = max(waterlineMax, waterlineRing);
    nearShipMax = max(nearShipMax, smoothstep(beam * 3.2, beam * 0.9, shipDist));

    // ── the foam collar at the waterline ────────────────────────────────────
    //
    // An art review put it exactly right: the water plane cut the anti-fouling
    // with a clean geometric curve and a nine-thousand-tonne destroyer at
    // sixteen knots disturbed the sea less than a moored buoy. Everything the
    // shader knew about a hull was subtractive — masks that kept foam OUT of
    // the footprint — and nothing put any in at the join.
    //
    // The join needs its own term, and it needs the hull's real plan shape: a
    // waterplane is fine forward and full amidships, so a constant half-beam
    // draws the collar standing off the bow by half the ship's width. A
    // superellipse taper costs one pow and follows the entry.
    {
      float u = clamp(abs(along) / halfLen, 0.0, 1.4);
      float halfB = (beam * 0.5) * pow(max(0.0, 1.0 - pow(u, 2.6)), 0.42);
      float outside = side - halfB;               // metres outboard of the plating

      // Wider at speed, and wider again in a seaway: the collar IS the sea
      // running up and down the ship's side.
      float collarW = 1.4 + beam * 0.10 + spd * beam * 0.30 + uWaveAmp * 1.8;
      float band = smoothstep(collarW, -0.6, outside) * smoothstep(-collarW * 0.55, -0.1, outside);
      band *= smoothstep(halfLen * 1.10, halfLen * 0.99, abs(along));

      // Break it up, and let it SURGE: the local wave height relative to the
      // hull is what makes the collar boil rather than sit there.
      // Two scales of breakup, because one gives a painted stripe. The coarse
      // band makes the collar thin and thicken along the ship's length the way
      // real white water pulses aft; the fine one is the churn inside it.
      float churnFine = 0.30 + 0.70 * nChurn;
      // Along-the-hull variation, from a cheap wave rather than a second fbm:
      // it only has to make the collar thin and thicken, and nobody can tell the
      // difference between an octave stack and two sines doing that job.
      float churnCoarse = 0.42 + 0.30 * sin(along * 0.055 - uTime * 0.9)
                               + 0.28 * sin(along * 0.131 + uTime * 0.6 + float(i));
      float churn = churnFine * churnCoarse * 1.35;
      float surge = 0.55 + 0.45 * sin(along * 0.22 - uTime * 2.3 + vWorldPos.y * 1.4);
      // Even stopped, a hull in a seaway works foam along its side; underway it
      // is continuous white water.
      float amount = (0.28 + 1.25 * spd) * (0.45 + 0.55 * uWaveAmp);

      collarFoam = max(collarFoam, band * churn * surge * amount);
    }

    if (spd > 0.04) {
      float lace = nLace;
      float streak = nStreak;

      // ── Kelvin geometry, matching the vertex stage exactly ───────────────
      // Foam belongs on the CRESTS of the wake's own wave train, not spread
      // evenly over a painted band. Recomputing the same quantities here is what
      // makes the white water sit where the water is actually breaking.
      float V = max(1.5, spd * 11.3);
      float lam = clamp(6.28318 * V * V / 9.81, 10.0, 260.0);
      float kw = 6.28318 / lam;
      float aft = max(0.0, -along);
      float envelope = aft * 0.35355;
      float wedgeIn = 1.0 - smoothstep(0.82, 1.08, side / max(2.0, envelope));
      float wDecay = exp(-aft / (150.0 + lam * 4.0));
      // Crest masks: the tops of the transverse and divergent trains.
      float transC = smoothstep(0.25, 0.95, sin(kw * aft) * 0.5 + 0.5);
      float dph = kw * (aft * 0.88 + side * 0.52);
      float armBandF = smoothstep(0.30, 0.0, abs(side / max(2.0, envelope) - 0.86));
      float divgC = smoothstep(0.30, 0.95, sin(dph) * 0.5 + 0.5);

      // The prop-wash lane: a narrow, turbulent, persistent trench of aerated
      // water directly astern, which is the brightest and longest-lived part of
      // any real wake.
      float sternLane = smoothstep(-6.0, -30.0, along)
        * smoothstep(-900.0, -40.0, along)
        * smoothstep(beam * 2.2, beam * 0.25, side);
      sternLane *= exp(-aft * 0.0022);

      // Nothing in a Kelvin system exists FORWARD of the ship. Every term here
      // is written in aft, which clamps to zero ahead of the stem — and at
      // zero the wedge envelope also collapses to zero, so side over envelope
      // blows up near the centreline and the divergent arm band lights up in
      // front of the bow. That is the pair of bright hairlines running away from
      // the stem that an art review kept finding. Gate the whole system astern.
      float astern = smoothstep(0.0, halfLen * 0.30, aft);
      float kelvinArm = (divgC * armBandF * 1.15 + transC * wedgeIn * 0.45) * wDecay * astern;
      float moundFoam = vHullWake * smoothstep(14.0, 50.0, along) * (1.0 - besideHull)
        * (1.0 - waterlineRing) * 0.85;
      float wakeAge = 1.0;   // the Kelvin terms carry their own decay now
      float breakup = lace * streak * (0.45 + 0.55 * sin(along * 0.12 + uTime * 1.1 + side * 0.08));
      float f = (sternLane * 1.9 + kelvinArm * 1.35 + moundFoam) * spd * wakeAge;
      f *= 0.4 + 0.6 * breakup;
      f *= (1.0 - besideHull) * (1.0 - waterlineRing * 0.98);
      hullFoam = max(hullFoam, f);

      // ── near-field white water ─────────────────────────────────────────────
      // The bow wave used to be folded into the same accumulator as the long
      // wake and then multiplied by (1 - waterlineRing). That term exists to keep
      // foam from bleeding under the hull — and it covers the whole forward half
      // of the ship, so it was deleting the bow wave exactly where a bow wave
      // happens. The near-field terms are therefore kept separate and are only
      // masked out of the hull's own footprint.
      //
      // Geometry is the real thing: the crest leaves the stem at about twenty
      // degrees off the centreline and decays over a couple of ship lengths.
      float fromStem = halfLen * 0.98 - along;              // metres aft of the stem
      float vLine = abs(side - max(0.0, fromStem) * 0.36);
      float bowV = smoothstep(beam * 0.75, 0.0, vLine)
        * smoothstep(0.0, beam * 0.8, fromStem)
        * exp(-max(0.0, fromStem) * 0.0055);
      // The mound of white water piled against the stem itself.
      float stemPile = smoothstep(beam * 1.7, beam * 0.1, side)
        * smoothstep(-10.0, 12.0, fromStem) * smoothstep(74.0, 8.0, fromStem);
      // Propeller boil under the counter: narrow, bright, and short.
      float boil = smoothstep(-halfLen * 1.02, -halfLen * 1.5, along)
        * smoothstep(-halfLen * 3.4, -halfLen * 1.5, along)
        * smoothstep(beam * 1.35, beam * 0.1, side);
      // Aerated water dragged along the hull sides.
      float sideChurn = smoothstep(beam * 0.6, beam * 1.15, side)
        * smoothstep(beam * 2.1, beam * 0.95, side)
        * smoothstep(halfLen * 1.1, halfLen * 0.45, abs(along));
      float near = bowV * 1.0 + stemPile * 0.8 + boil * 1.1 + sideChurn * 0.5;
      near *= spd * (0.5 + 0.5 * (lace * 0.55 + streak * 0.55));
      bowFoam = max(bowFoam, near);

      wetBand = max(wetBand, max(besideHull * (0.5 + 0.25 * spd),
        smoothstep(16.0, 3.0, shipDist) * (0.15 + 0.18 * spd)));
      // The trough BETWEEN the transverse crests reads darker, which is what
      // gives the train its corrugated look from above — but only INSIDE the
      // wake. Left unbounded it drew a dark hairline straight down the ship's
      // track for half a kilometre, which is the opposite of a wake.
      float troughMask = min(1.0, sternLane * 1.6 + kelvinArm * 1.2);
      wakeTrough = max(wakeTrough, (1.0 - transC) * wedgeIn * wDecay * astern * spd * 0.45 * troughMask);
    }
  }

  float contactKill = 1.0 - max(besideHullMax, waterlineMax * 0.92);

  // ── surf ─────────────────────────────────────────────────────────────────
  // Where the sea meets the land it shoals, goes turquoise, and breaks. Without
  // this an island is a decal standing in deep water; with it there is a coast.
  float shore = 0.0;
  float shallow = 0.0;
  for (int i = 0; i < 4; i++) {
    if (uIsland[i].z < 1.0) continue;
    vec2 rel = vWorldPos.xz - uIsland[i].xy;
    float d = length(rel);
    // Out of range of this island: nothing below can contribute, and the two
    // octave stacks it would run are not free. Most water in this game is
    // nowhere near land, so this skips almost every pixel almost every frame.
    if (d > uIsland[i].z * 2.2) continue;
    // Break the circle: the shoal has to follow the island's plan shape, and a
    // perfectly round ring of turquoise around a lumpy island is the tell.
    // The lobe has to be a NUDGE, not a search.
    //
    // At 0.55 this wandered the notional coastline by more than half the
    // island's radius — plus or minus 900 m on a 3.4 km island. The surf band is
    // tens of metres wide, so a ring that moves by 900 m almost never coincides
    // with the actual waterline, and an art review's shader probe found no surf
    // anywhere in near-shore water even though shoreR itself was correct. The
    // lobe exists to stop the shoal being a perfect circle; a few per cent does
    // that without throwing the surf line into open water.
    float ang = atan(rel.y, rel.x);
    float lobe = fbm(vec2(cos(ang), sin(ang)) * 1.7 + uIsland[i].w * 0.01) - 0.5;
    float edge = uIsland[i].z * (1.0 + lobe * 0.10);
    // Depth proxy: how far outside the plan radius this water is.
    float outside = d - edge;
    // HUG THE COAST — properly this time.
    //
    // At edge * 0.20 the shelf still reached a kilometre offshore on a 5 km
    // island, and measured 0.97 saturated across the whole near-shore band: a
    // flat turquoise swimming pool around the island rather than water shoaling
    // onto it. Squared falloff over a few hundred metres puts the colour where
    // the bottom actually comes up.
    float shoalT = clamp(max(0.0, outside) / (edge * 0.06), 0.0, 1.0);
    shallow = max(shallow, (1.0 - shoalT) * (1.0 - shoalT));
    // The break itself: a band just outside the land, pulsing with the swell so
    // it reads as sets arriving rather than as a painted ring.
    // SURF IS A NARROW LINE AT THE BEACH, not a wide ring offshore. This was a
    // 390-metre-wide band centred 234 metres out, which is so diffuse it reads
    // as nothing at all — an art review found no shoreline surf. Tens of metres
    // wide, right where the water meets the land.
    float band = 1.0 - smoothstep(0.0, edge * 0.012, abs(outside - edge * 0.008));
    float sets = 0.55 + 0.45 * sin(d * 0.011 - uTime * 1.15
      + fbm(vWorldPos.xz * 0.0022) * 6.0);
    // Surf runs even on a calm — a swell always reaches a beach — so the floor
    // is well above zero rather than scaling from nothing with the sea state.
    shore = max(shore, band * sets * (0.45 + 0.55 * smoothstep(0.0, 1.2, uWaveAmp)));
  }
  // Only break the surf line up where there IS a surf line.
  if (shore > 0.001) shore *= 0.45 + 0.55 * fbm(vWorldPos.xz * 0.35 - uTime * 0.5);

  // ── whitecaps ────────────────────────────────────────────────────────────
  // A wave breaks when its crest steepness passes a limit, and what you get is a
  // small, discrete, near-white PATCH that then drifts downwind and dissolves.
  // Painting a continuous foam ribbon along every crest — which is what a plain
  // steepness-to-alpha ramp does — is what makes CG water read as an oil slick.
  // So: a hard threshold for "is this crest breaking", multiplied by two octaves
  // of noise at very different scales to break the result into patches, plus a
  // dissolving tail so the foam persists on the back of the crest.
  // Where a crest starts to break.
  //
  // This threshold is compared against wave steepness, and it was calibrated
  // against the OLD amplitude scale, which never went below about 0.8. Putting
  // the Douglas scale on a physical footing dropped the whole range — sea state 1
  // is now 0.09 rather than 0.81 — so a threshold that starts at 1.02 is never
  // reached at any sea state the game actually produces, and the sea had no
  // whitecaps in a full gale. An art review reported exactly that.
  //
  // Recalibrated to the amplitude range that now exists: nothing breaks on a
  // calm, and a gale is covered in breaking crests.
  //
  // Second calibration pass, against measured coverage rather than by eye. With
  // the patch term fixed this reached full only at the very top of the scale:
  // sea state 5 measured 0% whitecap coverage and sea state 8 only 2.3%. A real
  // Douglas 5 is visibly flecked and a Douglas 8 is a third foam. Reaching the
  // low limit sooner, and lower, puts breaking crests on a rough sea without
  // painting the calm — sea state 3 still measures clean.
  // Third calibration, and the first one done against a correctly exposed frame.
  //
  // The previous two were tuned against a pipeline with no tone mapping and no
  // sRGB transfer, where everything rendered about six times too dark — so foam
  // that measured "barely visible" was actually near-white once the transfer
  // function was put back, and a gale came out as hard blocky patches of blown
  // highlight. Pulled back, with softer thresholds so the value-noise lattice
  // underneath cannot draw its own grid at high contrast.
  float breakLimit = mix(0.95, 0.32, clamp((uWaveAmp - 0.10) / 0.90, 0.0, 1.0));
  float crest = smoothstep(breakLimit, breakLimit + 0.30, vFoamFactor);

  // DETAIL BY DISTANCE.
  //
  // Everything below is fine structure inside the foam — which patches of sea
  // are breaking, the fizz on a crest, the streaks lying downwind. It is worth
  // a great deal at fifty metres and literally nothing at two kilometres, where
  // one pixel spans more sea than the largest of these features. The shader was
  // paying for all of it on every water pixel in the frame regardless, and the
  // ocean is most of the frame: measured with GPU timer queries it was 27.7 ms
  // of a 50 ms frame, the single most expensive thing in the game.
  //
  // The test is on distance, so it is spatially coherent — a whole band of the
  // screen takes the same side of the branch, which is what makes a branch in a
  // fragment shader cheap rather than catastrophic.
  float capPatch, fizz, streakFoam;
  if (dist < 2600.0) {
    // THRESHOLDS CALIBRATED TO fbm's ACTUAL RANGE.
    //
    // fbm() here is three octaves at 0.5 / 0.25 / 0.125, so it sums to at most
    // 0.875 and averages about 0.44 — it does NOT span zero to one. These three
    // smoothsteps were written as though it did, reaching for 0.75 and 0.80,
    // and they are MULTIPLIED together: each one sat near zero and the product
    // was nothing at all. Measured on a sea state 8 gale, crest was 0.95 and
    // capPatch was 0.002, so the sea correctly decided it was breaking
    // everywhere and then multiplied the foam away. Three art reviews running
    // reported no whitecaps at any sea state, and this is why.
    //
    // Centred on 0.44 now, with a spread that leaves the product low on average
    // and full where all three coincide — which is what breaking looks like:
    // discrete patches, not a continuous ribbon along every crest.
    capPatch = smoothstep(0.38, 0.60, fbm(vWorldPos.xz * 0.055 + uTime * 0.035))
      * smoothstep(0.36, 0.58, fbm(vWorldPos.xz * 0.42 - uTime * 0.13))
      // A third, very large scale: whole areas of sea that are simply breaking
      // more than the areas next to them.
      * (0.30 + 0.70 * smoothstep(0.36, 0.58, fbm(vWorldPos.xz * 0.0022 + 91.0)));
    fizz = 0.45 + 0.55 * smoothstep(0.35, 0.85, noise(vWorldPos.xz * 3.2 - uTime * 0.9));
    // Streaks of dissipated foam lying in the troughs downwind of a break.
    // Same calibration problem: 0.55 to 1.0 is unreachable for a field that tops
    // out at 0.875 and averages 0.44, so the downwind streaks never drew either.
    streakFoam = smoothstep(0.44, 0.62, fbm(vWorldPos.xz * 0.09 + uTime * 0.02))
      * smoothstep(breakLimit * 0.72, breakLimit, vFoamFactor) * 0.22;
  } else {
    // Far field: one cheap octave standing in for the whole stack. Averaged over
    // a pixel that covers hundreds of metres, that is what the detailed version
    // converges to anyway.
    float coarse = smoothstep(0.38, 0.78, noise(vWorldPos.xz * 0.055 + uTime * 0.035));
    capPatch = 0.24 + 0.62 * coarse;
    fizz = 0.85;
    streakFoam = 0.0;
  }
  float whitecap = crest * capPatch * fizz;   // NB: 'patch' is a GLSL reserved word

  // Whitecap foam and hull-wake foam are DIFFERENT MATERIALS and must not share
  // a colour. A breaking crest is a thin, brilliant, short-lived thing; a bow
  // wave and the churn along a hull is a thick aerated slab that is much duller
  // and much greener. Giving the wake the whitecap's near-white value turned the
  // water ahead of every ship into a flat cream-coloured wedge that reads as a
  // sandbar. They are also broken up differently: crests are speckled, a wake is
  // streaked along the direction of travel.
  float capMask = clamp(max(whitecap, streakFoam), 0.0, 1.0) * mix(0.05, 1.0, contactKill);
  // Two scales of breakup: a coarse one that dissolves the wake's outline so it
  // never reads as a hard-edged slab, and a fine one for the churn inside it.
  // Four more octave stacks that only mean anything where there IS foam from a
  // hull. Away from a ship they are multiplied by zero, so computing them is
  // pure waste — and away from a ship is almost the whole ocean.
  float wakeBreak = 1.0, bowBreak = 1.0;
  if (hullFoam + bowFoam + collarFoam > 0.001) {
    wakeBreak = (0.35 + 0.65 * fbm(vWorldPos.xz * 0.055 + uTime * 0.07))
      * (0.55 + 0.45 * fbm(vWorldPos.xz * 0.9 + uTime * 0.4));
    bowBreak = 0.55 + 0.45 * fbm(vWorldPos.xz * 0.6 + uTime * 0.55);
  }
  float wakeMask = clamp(hullFoam * wakeBreak, 0.0, 1.0);
  // The collar is freshly entrained air right against the plating, so it is the
  // brightest white in the frame and it does NOT get the bow wave's breakup —
  // it is continuous by nature.
  float bowMask = clamp(bowFoam * bowBreak + collarFoam * 1.35, 0.0, 1.0);

  vec3 foamCrest = vec3(0.90, 0.94, 0.96);
  vec3 wakeTint = vec3(0.62, 0.70, 0.73);
  // Freshly entrained air is much brighter and much whiter than the dissipated
  // wake a kilometre astern; giving both the same colour is what makes a CG
  // wake read as a painted stripe.
  vec3 bowTint = vec3(0.87, 0.91, 0.93);

  float absorb = 1.0 - exp(-dist * 0.00032);
  waterColor = mix(waterColor, uDeepColor * 0.68, absorb * 0.7);

  float edgeFade = smoothstep(uFieldR * 0.94, uFieldR * 0.999, vEdge);

  float broadSpec = pow(NdotH, 48.0) * 0.075;
  sunSpec += uSunColor * broadSpec * (0.25 + 0.5 * nearDetail);

  float horizonBoost = pow(1.0 - clamp(N.y, 0.0, 1.0), 2.2);
  float contactDim = mix(0.62, 1.0, contactKill);
  contactDim *= mix(0.84, 1.0, 1.0 - besideHullMax * 0.92);
  contactDim *= mix(0.45, 1.0, 1.0 - waterlineMax);
  contactDim *= mix(0.75, 1.0, 1.0 - nearShipMax * 0.85);
  /*
   * A reflection REPLACES what the water would otherwise be mirroring.
   *
   * This was additive — base += hullRefl * 1.15 — so a ship could only ever make
   * the water under it brighter. A review measured exactly that: the sea
   * directly beneath the hull read 184 against 151 on the same screen rows off
   * to the side, and concluded there was no reflection at all, because a
   * reflected ship makes water DARKER. Which it does: a haze-grey topside sits
   * around 0.25 albedo and the sky it displaces is far brighter, so where the
   * hull occupies the mirrored direction the water loses light rather than
   * gaining it.
   *
   * So the hull goes into reflColor, weighted by how much of that direction it
   * covers, before the Fresnel mix decides how much of the pixel is mirror at
   * all. That also puts it where it belongs physically: strongest at a grazing
   * angle, which is where a real ship lays its reflection toward you.
   */
  float hullW = clamp(hullReflW, 0.0, 1.0);
  reflColor = mix(reflColor, hullRefl / max(1e-4, hullReflW), hullW);

  float fresnelUse = fresnel * mix(0.55, 0.96, contactKill) * (1.0 - nearShipMax * 0.25);
  vec3 base = mix(waterColor, reflColor, fresnelUse + horizonBoost * 0.28 * contactDim);

  // Subsurface upwelling.
  //
  // Most of what you see looking DOWN at deep water is not reflection — it is
  // light that went into the sea, scattered, and came back out. The Fresnel
  // reflection is at its weakest at exactly that angle, so without an upwelling
  // term the ocean goes black the moment the camera climbs: the tactical view,
  // which is the view this game is mostly played in, was a near-black screen
  // with a few ship dots on it. Weighting it by (1 - fresnel) puts it where it
  // belongs — strong from above, gone at a grazing angle where reflection takes
  // over — so the close-up look is untouched.
  float upwell = (1.0 - fresnel) * (0.30 + 0.70 * sun);
  base += uShallowColor * upwell * 0.34;
  // A hull's shadow on the sea kills the specular first and the body colour
  // second — a shaded patch of water is not merely darker, it stops glittering,
  // which is what makes the shadow read as a shadow rather than as a stain. The
  // shadow map still handles what the analytic test cannot know about — aircraft,
  // ordnance, terrain — and the analytic hull shade handles the ships.
  // The analytic hull shadow alone — NOT gated on getShadowMask().
  //
  // getShadowMask() reads a receiveShadow uniform that three.js sets for its
  // own material types. This is a ShaderMaterial and does not declare it, so the
  // value the shader reads is undefined; in practice it came back false and the
  // mask returned zero for every water pixel in the frame. min(0, hullShade) is
  // zero everywhere, which does not draw a shadow — it flattens the entire sea
  // to the shadowed value uniformly, so nothing has a shadow and the whole ocean
  // is simply darker. That is exactly what an art review saw: no cast shadow at
  // 30 degrees of sun elevation, on water that was too dark everywhere.
  //
  // The analytic term above needs none of that machinery: it walks the air
  // column from this fragment toward the sun and tests it against the hull's own
  // box, using uniforms the ocean already has.
  float hullShadow = hullShade;
  // Amplitude. Measured on frame captures, the shadow under a hull was darkening
  // the water by about eighteen percent — visible if you were told to look for
  // it, invisible otherwise. A real hull shadow on a sunlit sea is the darkest
  // thing in the frame: it kills the specular sun glitter outright (that is most
  // of what makes water bright) and takes the body colour down with it, leaving
  // only sky reflection. So: specular goes to near nothing, and the body drops
  // by nearly half rather than by a fifth.
  float sunLit = sun * mix(0.05, 1.0, hullShadow);
  base += sunSpec * mix(0.04, 1.0, hullShadow) * (1.05 + horizonBoost * 0.5) * contactDim;
  // Two SEPARATE terms, and conflating them was crushing the whole sea to black.
  // The first is the ordinary coupling between the sun's diffuse term and the
  // water's brightness — it applies everywhere and must stay gentle, because
  // sunLit is small over most of the surface. The second is the hull shadow,
  // and only that one is allowed to be dramatic.
  base *= mix(0.82, 1.0, sunLit);
  base *= mix(0.58, 1.0, hullShadow);
  // (The hull's reflection is applied into reflColor above, before the Fresnel
  // mix, rather than added on here.)
  // Shaded water is not merely dimmer: it loses the warm forward-scatter and
  // reads a shade cooler and greener than the lit sea around it.
  // Shadowed water is lit by the sky alone, so it goes markedly cooler as well
  // as darker — the colour shift is half of what sells it as a shadow.
  base = mix(base * vec3(0.58, 0.68, 0.82), base, hullShadow);
  // Anti-bloom: keep the waterline from becoming an emissive white skirt, but at
  // a fraction of the original strength — the old values dug a black moat around
  // every hull that was obvious the moment the camera got down to bridge height.
  float bloomKill = max(waterlineMax, nearShipMax * besideHullMax);
  base = mix(base, waterColor * 0.94, bloomKill * 0.6);
  base *= (1.0 - wetBand * 0.35);
  base = mix(base, uDeepColor * 0.72, clamp(wakeTrough * 0.7 + (1.0 - contactKill) * 0.18, 0.0, 0.5));
  float hullGate = (1.0 - besideHullMax * 0.5) * (1.0 - waterlineMax * 0.45);
  base = mix(base, wakeTint, clamp(wakeMask, 0.0, 1.0) * 0.55 * hullGate);
  // Shoaling water: less of the deep body colour, more scattered green, and it
  // gets brighter because the bottom is close enough to bounce light back.
  base = mix(base, mix(base, vec3(0.17, 0.42, 0.44), 0.66) * 1.14, shallow * 0.70);
  base = mix(base, bowTint, bowMask * 0.8);
  base = mix(base, vec3(0.93, 0.96, 0.97), clamp(shore, 0.0, 1.0) * 0.85);
  base = mix(base, foamCrest, clamp(capMask, 0.0, 1.0) * 0.92 * hullGate);
  // Aerial perspective, identical in form to the far-sea shader so the detailed
  // patch and the disc beyond it converge on the same colour and the seam at the
  // patch edge disappears instead of reading as a bright band on the water.
  // Water takes its colour from the sky. Under a storm the sky goes grey and so
  // must the sea — without this the ocean rendered MORE saturated in a gale than
  // in fair weather, because the body colour is a constant and only the sun term
  // was changing. Drive a desaturation off how grey the horizon has become.
  float skyGrey = 1.0 - clamp((max(uHorizonColor.b - uHorizonColor.r, 0.0)) * 5.5, 0.0, 1.0);
  float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
  base = mix(base, mix(vec3(lum), uHorizonColor * 0.34, 0.45), skyGrey * 0.62);

  // The weather has to change how much light there IS, not only its colour.
  //
  // uSunColor carries the sun's COLOUR; SceneView copies sunLight.color into it
  // and nothing ever handed this shader the sun's INTENSITY. So the sea kept
  // full clear-noon brightness through a gale, and an art review measured the
  // storm sea at mean luminance 109 against a clear sea's 104 — brighter, on six
  // percent of the light. Dim the body before the aerial perspective, since the
  // haze it fades into is the sky's own colour and has already been dimmed.
  // ...but only the part of the pixel that is not a mirror. reflColor is the sky,
  // and the sky has already been dimmed by the same weather. Scaling the blended
  // result dimmed the reflection twice, which is what left a storm sea reading 34
  // against a sky of 131 — near-black water under a pale grey ceiling, when a
  // grazing angle should be throwing that ceiling straight back at the camera.
  base *= mix(uLightScale, 1.0, fresnelUse);

  float airMass = 1.0 - exp(-opticalDepth(dist, uCamPos.y, vWorldPos.y, 3.912 / uVisibility));
  airMass += (hash(gl_FragCoord.xy * 0.2 + uTime * 0.11) - 0.5) * 0.012;
  airMass = clamp(airMass, 0.0, 1.0);
  vec3 color = mix(base, uHorizonColor * 0.94, airMass);
  // The very edge of the Gerstner grid still has to stop somewhere; fade the last
  // few hundred metres into the same air colour so the boundary is invisible.
  color = mix(color, mix(uDeepColor * 0.85, uHorizonColor * 0.94, airMass), edgeFade * 0.7);
  color += (hash(gl_FragCoord.xy * 0.15 + uTime) - 0.5) * (2.4 / 255.0);

  // The grade pass now applies ACES and the sRGB transfer to the whole frame, so
  // everything must hand it LINEAR radiance. This shader's palette is authored by
  // eye in display space, so undo the transfer on the way out; the grade pass
  // puts it back. Net identity for this surface, while the PBR materials finally
  // get the tone mapping they have always been written to expect.
  color = acesInverse(color) / uGradeExposure;
  gl_FragColor = vec4(color, 1.0);
}
`;


// ── far ocean ────────────────────────────────────────────────────────────────

export const EARTH_R = 6371000 * 1.12;   // slightly inflated for optical refraction
export const FAR_SEA_INNER = 220;
const FAR_SEA_OUTER = 900000;

/** Curvature drop of the sea surface at horizontal distance d from the viewer. */
export function curvatureDrop(d) {
  return (d * d) / (2 * EARTH_R);
}

/**
 * A disc with logarithmically spaced rings: dense where the eye is, sparse at
 * nine hundred kilometres. 192 x 56 quads covers the whole visible ocean for
 * about 21k triangles.
 */
function buildFarSeaGeometry() {
  const RINGS = 56, SEGS = 192;
  const pos = new Float32Array((RINGS + 1) * (SEGS + 1) * 3);
  const idx = [];
  let p = 0;
  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    const rad = FAR_SEA_INNER * Math.pow(FAR_SEA_OUTER / FAR_SEA_INNER, t);
    for (let s = 0; s <= SEGS; s++) {
      const a = (s === SEGS ? 0 : s / SEGS) * Math.PI * 2;   // exact wrap, no crack
      pos[p++] = Math.cos(a) * rad;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * rad;
    }
  }
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SEGS; s++) {
      const a = r * (SEGS + 1) + s;
      const b = a + 1;
      const c = a + (SEGS + 1);
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

export const FAR_SEA_VERTEX = `
uniform vec3 uCamPos;
uniform float uEarthR;
varying vec3 vWorldPos;
varying float vDist;
void main() {
  vec3 p = position + vec3(modelMatrix[3].x, 0.0, modelMatrix[3].z);
  float d = length(position.xz);
  vDist = d;
  // The sea falls away from the observer at d^2 / 2R. At a 20 m eye height this
  // hides everything past 16 km; from 9 km up it draws a visibly curved horizon.
  p.y -= (d * d) / (2.0 * uEarthR) + 0.30;
  vWorldPos = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const FAR_SEA_FRAGMENT = `
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uLightScale;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFogColor;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform float uFogDensity;
uniform float uWaveAmp;
uniform float uInner;
uniform float uWaveFieldR;
uniform float uVisibility;
uniform samplerCube uEnvMap;
varying vec3 vWorldPos;
varying float vDist;

${CLOUD_FIELD_GLSL}

uniform sampler2D uSeaField;
#define SEA_TILE 8.0

// Same substitution as the main ocean shader — see the note there. The far sea
// covers the whole screen from any altitude, so it benefits at least as much.
// (Its fbm ran four octaves rather than three; the baked field is three, which
// at far-sea distances is well past the point where the fourth is resolvable.)
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) { return texture2D(uSeaField, p / SEA_TILE).g; }
float fbm(vec2 p) { return texture2D(uSeaField, p / SEA_TILE).r; }

/*
 * Aerial perspective, integrated through a two-component atmosphere.
 *
 * Treating the air as uniform is fine at sea level and completely wrong from
 * altitude: a camera 45 km up looking down at the fleet is not looking through
 * 45 km of sea-level air. But using ONE scale height is wrong too, and that is
 * the subtler error. What limits visibility at sea level is aerosol — haze, salt,
 * spray — and aerosol hugs the surface with a scale height near 1.2 km. Molecular
 * (Rayleigh) scattering is far weaker but reaches to 8.4 km and beyond.
 *
 * Integrate them separately and both regimes come out right: 40 km of sea-level
 * air is a wall of haze (which is the definition of the visual range), while the
 * same 40 km looking straight down from the stratosphere is nearly clear — which
 * is why satellite photographs of the ocean are deep blue and not white.
 */
float layerDepth(float dist, float lo, float hi, float H) {
  float dh = hi - lo;
  if (dh < 1.0) return dist * exp(-lo / H);
  return dist * (H / dh) * (exp(-lo / H) - exp(-hi / H));
}
float opticalDepth(float dist, float hA, float hB, float k) {
  float lo = max(0.0, min(hA, hB));
  float hi = max(0.0, max(hA, hB));
  float aerosol = k * layerDepth(dist, lo, hi, 1250.0);
  float rayleigh = 1.15e-5 * layerDepth(dist, lo, hi, 8400.0);
  return aerosol + rayleigh;
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
 * Measured on near water at a low eyepoint, red came out at exactly 0 — which is
 * the "foreground red channel hard-clipped to zero" an art review reported, and
 * why a low camera saw a near-black sea that looked correct from higher up.
 *
 * ACES is y = x(ax+b) / (x(cx+d)+e), so inverting is a quadratic:
 *   (yc - a)x^2 + (yd - b)x + ye = 0.  One sqrt, round trip is identity.
 */
uniform float uGradeExposure;
vec3 acesInverse(vec3 y) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  // Overexposure has to run to white, not through the nearest primary.
  //
  // The clamp below is per channel, so a colour whose red passes one first is
  // held there while green and blue keep climbing. The sun's glow is a single
  // warm hue scaled over four orders of magnitude, and that clamp turned it into
  // a ringed target: a pink halo where only red had clipped, a yellow ring where
  // red and green had, a white core where all three had. Nothing in the scene is
  // pink. Pull the channel ratios together as the peak goes past one so they
  // arrive at the ceiling together, which is also what film does.
  float peak = max(max(y.r, y.g), y.b);
  if (peak > 1.0) {
    float s = 1.0 / (1.0 + (peak - 1.0) * 1.2);
    y = mix(vec3(1.0), y / peak, s) * peak;
  }
  y = clamp(y, 0.0, 0.9999);
  vec3 A = y * c - a;
  vec3 B = y * d - b;
  vec3 C = y * e;
  vec3 disc = max(B * B - 4.0 * A * C, vec3(0.0));
  return max((-B - sqrt(disc)) / (2.0 * A), vec3(0.0));
}

void main() {
  // Cut a hole for the detailed wave field.
  //
  // The far disc and the Gerstner field overlap by design, and depth was
  // supposed to arbitrate: the wave field is nearer, so it wins. It does not.
  // A wave TROUGH is several metres below the far disc's flat surface, so in
  // every trough the disc is genuinely the closer surface and shows through as
  // a flat, hard-edged patch of smooth water — polygonal shapes scattered across
  // the sea that no amount of polygon offset will fix, because the geometry
  // really does interpenetrate. Discarding inside the field's radius removes the
  // overlap entirely. uWaveFieldR goes to zero when the field is hidden at
  // altitude, at which point the disc takes over the whole ocean.
  if (vDist < uWaveFieldR) discard;

  vec3 viewDir = normalize(uCamPos - vWorldPos);
  float dist = length(uCamPos - vWorldPos);

  // A gentle, very large-scale swell field. At these distances individual waves
  // are far below a pixel, so what actually reads is the banding of the swell
  // and the way it modulates the glitter path — which is what the ocean looks
  // like from a window seat.
  // Screen-space LOD, measured rather than guessed.
  //
  // At the horizon a single pixel covers kilometres of sea, so any noise field
  // finer than that is being point-sampled far below its Nyquist rate. That is
  // what drew the one-pixel band of crawling salt-and-pepper along the horizon
  // in every wide shot: not a seam, not z-fighting, just an fbm sampled at a
  // hundredth of the rate it needs. fwidth gives the actual world-space
  // footprint of this pixel, so each octave can be faded out exactly when it
  // stops being resolvable and never gets the chance to alias.
  float fp = max(fwidth(vWorldPos.x), fwidth(vWorldPos.z));
  float lodSwell = clamp(1.0 - fp / 1400.0, 0.0, 1.0);
  float lodChop  = clamp(1.0 - fp / 320.0, 0.0, 1.0);

  vec2 sp = vWorldPos.xz * 0.00035 + uTime * 0.0025;
  float swell = (fbm(sp) - 0.5) * lodSwell;
  vec2 sp2 = vWorldPos.xz * 0.0016 - uTime * 0.006;
  float chop = (fbm(sp2) - 0.5) * lodChop;
  vec3 N = normalize(vec3(swell * 0.10 + chop * 0.05, 1.0, swell * 0.09 - chop * 0.045));

  float NdotV = clamp(dot(N, viewDir), 0.0, 1.0);
  // A distant sea is not a mirror. Inside a single pixel at twenty kilometres
  // there are millions of wave facets pointing in every direction, so the
  // grazing Fresnel that a flat plane would give is far too high — that is what
  // turns a far ocean into a sheet of white paper. Roughening the Fresnel by the
  // sea state is the cheapest honest approximation of that facet distribution.
  float seaRough = clamp(0.30 + 0.30 * uWaveAmp, 0.25, 0.80);
  float fres = mix(0.02, 1.0, pow(1.0 - NdotV, 5.0));
  fres = mix(fres, fres * 0.30 + 0.05, seaRough);

  vec3 refl = textureCube(uEnvMap, reflect(-viewDir, N)).rgb;
  // A rough sea blurs what it reflects. Without this the cube map's cloud deck
  // reads as hard vertical smears painted on the horizon band.
  refl = mix(refl, refl * 0.66, seaRough);
  refl = mix(refl, uHorizonColor * 0.9, seaRough * 0.55);

  // Deep-water body colour, darkening with the sun low and the water deep.
  vec3 body = mix(uDeepColor * 0.62, uShallowColor * 0.5, 0.22 + swell * 0.25);

  // Sun glitter path: a broad specular lobe roughened by the swell, which is
  // what turns a mirror into a shimmering road on the water.
  vec3 h = normalize(uSunDirection + viewDir);
  float NdotH = clamp(dot(N, h), 0.0, 1.0);
  float rough = 0.10 + 0.09 * uWaveAmp;
  float spec = pow(NdotH, 2.0 / (rough * rough)) * 0.55;
  // Two scales of glitter so the sun road has structure at ten kilometres and at
  // two hundred, without either turning into a single moving blob.
  // Glitter is the finest field of the lot, so it is the first thing to go once
  // a pixel outruns it — otherwise the sun road turns into crawling static.
  float lodGlint = clamp(1.0 - fp / 60.0, 0.0, 1.0);
  float sparkle = smoothstep(0.45, 1.0, fbm(vWorldPos.xz * 0.011 + uTime * 0.05))
    * smoothstep(0.30, 0.95, fbm(vWorldPos.xz * 0.00065 - uTime * 0.004)) * lodGlint;
  float sun = cloudSunlight(vWorldPos.xz - uCamPos.xz, uSunDirection, uTime);
  vec3 glint = uSunColor * (spec * (0.35 + 1.15 * sparkle)) * sun;

  // Swell bands modulate how much sky each patch of water throws back, which is
  // what gives a distant ocean its mottled, breathing texture instead of a flat wash.
  // The swell banding is the coarsest field on the disc and still finer than a
  // horizon pixel, so it gets the same treatment — it fades to its own mean
  // rather than being point-sampled into speckle.
  float lodBand = clamp(1.0 - fp / 9000.0, 0.0, 1.0);
  float band = 0.72 + 0.55 * mix(0.5, fbm(vWorldPos.xz * 0.00021 - uTime * 0.0016), lodBand);
  vec3 color = mix(body, refl, clamp(fres * band, 0.0, 1.0)) + glint;
  // The same upwelling the detailed field has, so the two agree across the
  // altitude at which one hands over to the other.
  color += uShallowColor * (1.0 - fres) * (0.30 + 0.70 * sun) * 0.30;
  color *= mix(0.70, 1.0, sun);

  // Aerial perspective. The sky's own horizon colour is the correct thing to
  // fade into — using a flat grey fog is the classic giveaway of a fake ocean.
  // Koschmieder: 3.912 e-foldings to the meteorological visual range, integrated
  // through an exponential atmosphere so the view from altitude stays legible.
  // Water takes its colour from the sky. Under a storm the sky goes grey and so
  // must the sea — without this the ocean rendered MORE saturated in a gale than
  // in fair weather, because the body colour is a constant and only the sun term
  // was changing. Drive a desaturation off how grey the horizon has become.
  float skyGrey = 1.0 - clamp((max(uHorizonColor.b - uHorizonColor.r, 0.0)) * 5.5, 0.0, 1.0);
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(color, mix(vec3(lum), uHorizonColor * 0.42, 0.45), skyGrey * 0.62);
  color *= mix(uLightScale, 1.0, clamp(fres * band, 0.0, 1.0));

  float airMass = 1.0 - exp(-opticalDepth(dist, uCamPos.y, vWorldPos.y, 3.912 / uVisibility));
  // Grazing-angle wash-out. This was far too eager: from bridge height the view
  // vector is within a thousandth of horizontal for everything past a couple of
  // kilometres, so a 0.995-to-1.0 ramp with a 0.35 weight turned the ENTIRE sea
  // beyond the wave field into one flat pale band with a hard edge where the
  // detailed field stopped. Aerial perspective is real, but it belongs in
  // opticalDepth, not in a term that saturates the moment the camera comes down
  // to the height of an actual bridge wing.
  float grazing = smoothstep(0.99965, 0.99999, 1.0 - abs(viewDir.y));
  vec3 air = mix(uHorizonColor, mix(uHorizonColor, uZenithColor, 0.35), clamp(dist / 400000.0, 0.0, 1.0));
  color = mix(color, air * 0.94, clamp(airMass + grazing * 0.16, 0.0, 0.985));

  // Distant whitecap speckle. Individual breakers are far below a pixel out here,
  // but their aggregate is a visible mottling that stops the far sea reading as a
  // painted gradient — and it is the same phenomenon the near field draws, just
  // integrated over a lot more water.
  // Whitecaps are not evenly distributed. A real sea has streaks and patches
  // where the wind is doing something slightly different, and a uniform speckle
  // over every square metre of the far field reads as noise rather than water.
  float capPatchFar = smoothstep(0.38, 0.78, fbm(vWorldPos.xz * 0.00016 + uTime * 0.002));
  float capsFar = smoothstep(0.62, 0.95, fbm(vWorldPos.xz * 0.0022 + uTime * 0.01))
    * smoothstep(0.5, 1.1, uWaveAmp) * smoothstep(60000.0, 8000.0, dist)
    * (0.25 + 0.75 * capPatchFar);
  color = mix(color, vec3(0.72, 0.78, 0.81), capsFar * 0.15);

  float dither = (hash(gl_FragCoord.xy * 0.17 + uTime * 0.31) - 0.5) * (2.2 / 255.0);
  // Hand the grade pass LINEAR radiance — it now applies ACES and the sRGB
  // transfer to the whole frame. See the note in VIGNETTE_GRADE_SHADER.
  gl_FragColor = vec4(acesInverse(color + dither) / uGradeExposure, 1.0);
}
`;

export class OceanField {
  constructor(renderer, sunDirection) {
    this.renderer = renderer;

    this.size = WAVE_FIELD_R * 2;
    this.segments = 140;
    const geo = buildWaveGrid(140, 256, WAVE_FIELD_R);

    const waveA = WAVE_SET.map(w => new THREE.Vector4(w[0], w[1], w[2], w[3]));
    const waveB = WAVE_SET.map(w => new THREE.Vector2(w[4], w[5]));

    this.uniforms = {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uWaveA: { value: waveA },
      uWaveB: { value: waveB },
      uSunDirection: { value: sunDirection.clone() },
      uSunColor: { value: new THREE.Color(0xfff0d8) },
      uLightScale: { value: 1.0 },
      uEnvMap: { value: null },
      uDeepColor: { value: new THREE.Color(0x123a55) },
      uShallowColor: { value: new THREE.Color(0x1d5878) },
      uFogColor: { value: new THREE.Color(0xa8bcc8) },
      uFogDensity: { value: 0.00095 },
      uWaveAmp: { value: 1.0 },
      uIsland: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uDetailLevel: { value: 0.85 },
      uGradeExposure: { value: 1.3 },
      uRain: { value: 0 },
      uVisibility: { value: 46000 },
      uHorizonColor: { value: new THREE.Color(0xa8c6da) },
      uEarthR: { value: EARTH_R },
      uFieldR: { value: WAVE_FIELD_R },
      uCloudCoverage: { value: 0.40 },
      uCloudField: { value: null },
      uSeaField: { value: null },
      uCloudiness: { value: 0.95 },
      uWakePos: { value: Array.from({ length: NUM_WAKES }, () => new THREE.Vector4()) },
      uWakeCol: { value: Array.from({ length: NUM_WAKES }, () => new THREE.Vector4(0.42, 0.45, 0.48, 0)) },
      uWakeDim: { value: Array.from({ length: NUM_WAKES }, () => new THREE.Vector4()) },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERTEX,
      fragmentShader: OCEAN_FRAGMENT,
      // lights:true is what supplies directionalShadowMap / directionalShadowMatrix
      // to the shadow chunks above. The shader does not otherwise use the light
      // uniforms, but without this flag three.js never binds them and the ocean
      // receives nothing.
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, this.uniforms]),
      lights: true,
      fog: false,
      // DoubleSide: the radial grid's triangle winding is not worth being clever
      // about, and a back-face-culled ocean that silently disappears is a much
      // more expensive bug than the handful of hidden back faces this costs.
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 4,
    });
    // UniformsUtils.merge CLONES, so the object we kept a reference to is no
    // longer the one the material uses. Re-point at the material's copy, or
    // every per-frame uniform write in this file silently goes nowhere.
    for (const k in this.uniforms) {
      if (this.material.uniforms[k]) this.material.uniforms[k].value = this.uniforms[k].value;
    }
    this.uniforms = this.material.uniforms;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;

    // ── far ocean ────────────────────────────────────────────────────────
    // Beyond the Gerstner patch the sea is drawn by a single huge disc whose
    // vertices are dropped by the earth's curvature, d²/2R. That one term does
    // three jobs at once: it gives a true curved horizon from altitude, it makes
    // the sea fall away naturally instead of ending at a polygon edge, and at
    // sea level it puts distant ships hull-down exactly where the geometry says
    // they should be — which is the whole reason a mast height matters.
    this.skirt = new THREE.Mesh(buildFarSeaGeometry(), new THREE.ShaderMaterial({
      vertexShader: FAR_SEA_VERTEX,
      fragmentShader: FAR_SEA_FRAGMENT,
      uniforms: {
        uTime: this.uniforms.uTime,
        uCamPos: this.uniforms.uCamPos,
        uSunDirection: this.uniforms.uSunDirection,
        uSunColor: this.uniforms.uSunColor,
        uLightScale: this.uniforms.uLightScale,
        uDeepColor: this.uniforms.uDeepColor,
        uShallowColor: this.uniforms.uShallowColor,
        uFogColor: this.uniforms.uFogColor,
        uFogDensity: this.uniforms.uFogDensity,
        uHorizonColor: this.uniforms.uHorizonColor,
        uZenithColor: { value: new THREE.Color(0x1c4d86) },
        uEnvMap: this.uniforms.uEnvMap,
        uWaveAmp: this.uniforms.uWaveAmp,
        uEarthR: this.uniforms.uEarthR,
        // SHARE the exposure uniform with the main ocean material. The far-sea
        // shader inverts the grade pass's ACES like every other hand-authored
        // surface, and it divides by this — so leaving it out of the skirt's
        // uniform block meant three.js bound zero, the division produced
        // infinity, and the whole disc rendered BLACK. It drew as a hard dark
        // band straight across the horizon in every wide shot.
        uGradeExposure: this.uniforms.uGradeExposure,
        uInner: { value: FAR_SEA_INNER },
        uWaveFieldR: { value: WAVE_FIELD_R * 0.985 },
        uCloudCoverage: this.uniforms.uCloudCoverage,
        uCloudField: this.uniforms.uCloudField,
        uSeaField: this.uniforms.uSeaField,
        uCloudiness: this.uniforms.uCloudiness,
        uVisibility: this.uniforms.uVisibility,
      },
      fog: false,
      side: THREE.DoubleSide,
      depthWrite: true,
      // The far disc overlaps the detailed Gerstner patch by design (so there is
      // no gap along the patch's axes, where its inscribed circle is closest).
      // Push it behind in depth so the detailed water always wins that overlap —
      // without this the flat far sea paints straight over the waves.
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 40,
    }));
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = -1;
    this.skirtMat = this.skirt.material;

    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.add(this.skirt);
    this._wakeCount = 0;
    // Default cull range for wake shader work; SceneView tunes it by quality.
    this._wakeCullRange = 3200;
  }

  setEnvMap(cubeTexture) { this.uniforms.uEnvMap.value = cubeTexture; }

  setFogColor(color) {
    this.uniforms.uFogColor.value.copy(color);
  }

  /** Meteorological visual range in metres — drives the far sea's aerial haze. */
  setVisibility(v) { this.uniforms.uVisibility.value = Math.max(4000, v); }

  /** Keep the far sea's aerial perspective locked to the live sky gradient. */
  setSkyColors(horizon, zenith) {
    this.uniforms.uHorizonColor.value.copy(horizon);
    this.skirtMat.uniforms.uZenithColor.value.copy(zenith);
  }

  setQuality(q) {
    const levels = { low: 0.15, medium: 0.6, high: 0.95, exquisite: 1.0 };
    this.uniforms.uDetailLevel.value = levels[q] ?? 0.75;
  }

  /**
   * Wave amplitude from a DOUGLAS SEA STATE, not from a raw multiplier.
   *
   * There were two callers passing two different ad-hoc formulas, and both of
   * them bottomed out around 0.8 — which put five metres of peak-to-trough on a
   * sea state 1. Once flat calm already looks like a rough day, a gale has
   * nowhere left to go, and an art review correctly reported that forcing sea
   * state 6 changed nothing. The whole weather system was invisible because its
   * output range was compressed into the top third of the scale.
   *
   * Douglas significant wave heights are roughly 0.1 / 0.3 / 0.9 / 1.9 / 3.3 /
   * 5.0 m for states 1 to 6, and peak-to-trough runs about twice that. This
   * shader's amplitude is a multiplier on the base Gerstner set, measured at
   * about 6.6 m of peak-to-trough per unit, so a quadratic ramp to 1.6 lands the
   * whole scale where it should be — glassy at 1, and genuinely dangerous at 6.
   */
  setSeaState(douglas) {
    const ss = Math.max(0, Math.min(8, douglas));
    const amp = 0.05 + Math.pow(ss / 6, 2.0) * 1.55;
    this.uniforms.uWaveAmp.value = Math.max(0.04, Math.min(2.6, amp));
  }
  get seaState() { return this.uniforms.uWaveAmp.value; }
  setRain(v) { this.uniforms.uRain.value = v; }

  /** Metres: hulls further than this from the camera get no wake shader work. */
  setWakeCullRange(m) { this._wakeCullRange = m; }

  /**
   * Feed the N nearest moving hulls into the wake uniforms. `sources` entries are
   * { x, z (render-space metres), heading, speedKts, length, beam }.
   */
  setWakeSources(sources) {
    const pos = this.uniforms.uWakePos.value;
    const dim = this.uniforms.uWakeDim.value;
    const col = this.uniforms.uWakeCol.value;
    // Only hulls the camera can actually SEE a wake on.
    //
    // Every live slot costs the ocean fragment shader a full pass over that
    // hull — the shadow column walk, the reflection band, the foam collar, the
    // Kelvin system — on every water pixel in the frame. Handing it eight ships
    // regardless of range meant a task force spread over forty kilometres was
    // charging the whole screen for wakes that were a fraction of a pixel wide.
    // Past a couple of kilometres the far-sea disc is drawing that water anyway.
    const lim = this._wakeCullRange;
    const near = lim > 0 ? sources.filter(s => (s.d ?? 0) < lim) : sources;
    sources = near;
    const n = Math.min(NUM_WAKES, sources.length);
    for (let i = 0; i < NUM_WAKES; i++) {
      if (i < n) {
        const s = sources[i];
        pos[i].set(s.x, s.z, Math.sin(s.heading), Math.cos(s.heading));
        // w carries the ship's topside height, which the fragment shader needs to
        // cast a hull shadow. Anything above 0.5 also reads as "this slot is
        // live", which is what the shader's activity test looks for.
        dim[i].set(
          Math.min(1.35, Math.abs(s.speedKts) / 22),
          (s.length || 140) * 0.48,
          s.beam || 18,
          Math.max(1.0, s.height || 26),
        );
        // Topside tone, for the reflection the hull lays down the water.
        const c = s.color || [0.42, 0.45, 0.48];
        col[i].set(c[0], c[1], c[2], (s.length || 140) * 0.5);
      } else {
        dim[i].w = 0;
      }
    }
    this._wakeCount = n;
    this._sources = sources.slice(0, n);
  }

  update(dt, elapsed, camera) {
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uCamPos.value.copy(camera.position);
    // Above a few kilometres a Gerstner wave is well under a pixel, so the
    // detailed field buys nothing but a visible circular seam where it ends.
    // Hand the whole ocean over to the far-sea disc, which now reaches in to
    // 220 m specifically so it can cover on its own.
    const showField = camera.position.y < 5200;
    this.mesh.visible = showField;
    this.skirtMat.uniforms.uWaveFieldR.value = showField ? WAVE_FIELD_R * 0.985 : 0;
    // The radial field is centred on the camera exactly. (A square grid had to be
    // snapped to its own cell size to stop the wave phase crawling; a radial one
    // gets its phase from world position in the shader, so it can follow freely.)
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.skirt.position.set(camera.position.x, 0, camera.position.z);
  }

  /** CPU-side wave height, matching the vertex shader so hulls sit in the water. */
  getHeightAt(x, z, t) {
    let y = 0;
    const waveAmp = this.uniforms.uWaveAmp.value;
    for (const [dx, dz, steepness, wavelength, speed, phase] of WAVE_SET) {
      const k = (2 * Math.PI) / wavelength;
      const c = Math.sqrt(9.8 / k) * speed * 0.35 + speed * 0.15;
      const f = k * (dx * x + dz * z - c * t * 3.0) + phase;
      const a = (steepness / k / WAVE_SET.length) * 3.35 * waveAmp;
      y += a * Math.sin(f) * 0.92;
    }
    for (const s of this._sources || []) {
      const spd = Math.min(1.35, Math.abs(s.speedKts) / 22);
      if (spd < 0.02) continue;
      const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
      const tx = x - s.x, tz = z - s.z;
      if (tx * tx + tz * tz > 400000) continue;
      const along = tx * fx + tz * fz;
      const side = Math.abs(tx * -fz + tz * fx);
      const bowMound = Math.max(0, Math.min(1,
        (1 - Math.max(0, Math.min(1, (along - 2) / 56))) *
        Math.max(0, Math.min(1, (along + 8) / 30)) *
        Math.max(0, Math.min(1, 1 - (side - 1.2) / 22.8))
      )) * spd;
      const sternLift = Math.max(0, Math.min(1,
        Math.max(0, Math.min(1, (8 - along) / 22)) *
        Math.max(0, Math.min(1, (along + 100) / 80)) *
        Math.max(0, Math.min(1, 1 - (side - 2) / 16))
      )) * spd * 0.4;
      y += bowMound * 5.5 + sternLift * 2.2;
    }
    return y;
  }
}
