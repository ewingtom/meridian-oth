import * as THREE from 'three';
import { getSharedMicroDetailMaps } from '../utils/ProceduralTextures.js';

/**
 * Procedural aircraft and ordnance.
 *
 * The ship hulls come from the MERIDIAN asset set; everything that flies is built
 * here from lathes, tapered boxes and revolutions, because a naval game without
 * a distinguishable Poseidon, Hawkeye, Seahawk, Bear and Backfire is a naval game
 * where you cannot tell at a glance whether the contact overhead is a friend
 * looking for a submarine or a scout about to call in a regiment of bombers.
 *
 * Everything is bow/nose = +Z, up = +Y, matching the GLB convention, so a unit's
 * yaw is just rotation.y = heading.
 */

const _mats = new Map();
function mat(key, make) {
  let m = _mats.get(key);
  if (!m) { m = make(); _mats.set(key, m); }
  return m;
}

function detailed(m, scale = 0.5) {
  try {
    const { normalMap, roughnessMap } = getSharedMicroDetailMaps();
    if (normalMap) {
      m.normalMap = normalMap;
      m.normalScale = new THREE.Vector2(scale, scale);
    }
    if (roughnessMap && !m.roughnessMap) m.roughnessMap = roughnessMap;
  } catch (e) { /* micro-detail is polish, never a hard dependency */ }
  return m;
}

/**
 * Aircraft skin detail, generated in the fragment shader from object space.
 *
 * Airframes are covered in panel joins, and the joins are what tell the eye it is
 * looking at a machine made of sheet metal rather than at a solid of revolution.
 * Add fuselage station lines, stringer lines, a dielectric radome nose, exhaust
 * staining aft of the engines and a walkway darkening on the wing roots.
 */
function airSkin(m) {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAirPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAirPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vAirPos;
float aHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float aNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(aHash(i), aHash(i + vec2(1.0,0.0)), f.x),
             mix(aHash(i + vec2(0.0,1.0)), aHash(i + vec2(1.0,1.0)), f.x), f.y);
}
float aLine(float x, float period, float w) {
  float t = abs(fract(x / period + 0.5) - 0.5) * period;
  return 1.0 - smoothstep(0.0, w, t);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec3 P = vAirPos;
  // Fuselage stations across the airframe, stringers along it.
  float station = aLine(P.z, 2.6, 0.020);
  float stringer = aLine(atan(P.y, P.x) * 2.0, 0.62, 0.012);
  float panel = clamp(station * 0.8 + stringer * 0.45, 0.0, 1.0);
  vec3 c = diffuseColor.rgb;
  c *= 1.0 - panel * 0.13;
  // Very slight per-panel tonal drift, as on any repainted airframe.
  c *= 1.0 + (aHash(floor(vec2(P.z / 2.6, atan(P.y, P.x) * 3.2))) - 0.5) * 0.05;
  // Exhaust and hydraulic staining, streaming aft.
  float soot = smoothstep(0.45, 1.0, aNoise(vec2(P.x * 5.0, P.z * 0.5)))
    * smoothstep(2.0, -6.0, P.z) * 0.16;
  c = mix(c, vec3(0.24, 0.23, 0.22), soot);
  // Dielectric radome at the nose.
  float nose = smoothstep(0.55, 0.85, P.z / max(1.0, abs(P.z) + 6.0));
  c = mix(c, vec3(0.30, 0.31, 0.33), nose * 0.55);
  diffuseColor.rgb = c;
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (aNoise(vAirPos.xz * 2.2) - 0.5) * 0.16, 0.05, 1.0);`);
  };
  m.needsUpdate = true;
  return m;
}

export const MATS = {
  get whiteSkin() {
    // Light gull grey, not white. Maritime patrol aircraft are painted a low-vis
    // grey; a pure-white airframe against a grey sea is the most obvious "this
    // is an untextured primitive" signal an aircraft can send.
    return mat('whiteSkin', () => airSkin(detailed(new THREE.MeshStandardMaterial({
      color: 0xa9b2ba, metalness: 0.06, roughness: 0.42, envMapIntensity: 1.1,
    }), 0.35)));
  },
  get greySkin() {
    return mat('greySkin', () => airSkin(detailed(new THREE.MeshStandardMaterial({
      color: 0x7d858d, metalness: 0.05, roughness: 0.46, envMapIntensity: 1.1,
    }), 0.4)));
  },
  get navyGrey() {
    return mat('navyGrey', () => detailed(new THREE.MeshStandardMaterial({
      color: 0x505a63, metalness: 0.05, roughness: 0.52, envMapIntensity: 1.05,
    }), 0.45));
  },
  get darkGrey() {
    return mat('darkGrey', () => detailed(new THREE.MeshStandardMaterial({
      color: 0x2b3036, metalness: 0.25, roughness: 0.5, envMapIntensity: 1.0,
    }), 0.5));
  },
  get bareMetal() {
    return mat('bareMetal', () => detailed(new THREE.MeshStandardMaterial({
      color: 0x9aa0a6, metalness: 0.92, roughness: 0.3,
    }), 0.6));
  },
  get canopy() {
    return mat('canopy', () => new THREE.MeshPhysicalMaterial({
      color: 0x101820, metalness: 0.1, roughness: 0.06,
      transmission: 0.35, thickness: 0.4, clearcoat: 1, clearcoatRoughness: 0.05,
      transparent: true, opacity: 0.85,
    }));
  },
  get radome() {
    return mat('radome', () => new THREE.MeshStandardMaterial({
      color: 0xcfd4d8, metalness: 0.05, roughness: 0.62,
    }));
  },
  get rubber() {
    return mat('rubber', () => new THREE.MeshStandardMaterial({
      color: 0x14171a, metalness: 0.0, roughness: 0.85,
    }));
  },
  get exhaust() {
    return mat('exhaust', () => new THREE.MeshStandardMaterial({
      color: 0x3a3d40, metalness: 0.85, roughness: 0.35,
    }));
  },
  get missileBody() {
    return mat('missileBody', () => detailed(new THREE.MeshStandardMaterial({
      color: 0xa8adb3, metalness: 0.12, roughness: 0.45, envMapIntensity: 0.9,
    }), 0.5));
  },
  get missileDark() {
    return mat('missileDark', () => new THREE.MeshStandardMaterial({
      color: 0x26292d, metalness: 0.4, roughness: 0.55,
    }));
  },
  get warhead() {
    return mat('warhead', () => new THREE.MeshStandardMaterial({
      color: 0x8f3227, metalness: 0.3, roughness: 0.6,
    }));
  },
};

// ── primitive helpers ────────────────────────────────────────────────────────

/**
 * A revolved fuselage from a [z, radius] profile, nose at +Z.
 *
 * LatheGeometry revolves a 2-D outline about the Y axis, so the profile's
 * long axis comes out VERTICAL. Rotating the geometry a quarter turn about X
 * maps +Y onto +Z and lays the body down along the game's nose-forward axis —
 * without it every aircraft stands on its tail like a launch vehicle.
 */
function fuselage(profile, segments = 22, material) {
  const pts = profile.map(([z, r]) => new THREE.Vector2(Math.max(0.001, r), z));
  const geo = new THREE.LatheGeometry(pts, segments);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

/**
 * A wing panel: a lofted, tapered, swept surface with a real aerofoil section.
 *
 * The first version of this extruded a flat shape and then pushed its vertices
 * around, which produced something with the right bounding box and none of the
 * right silhouette — a needle rather than a wing. Lofting a NACA-style symmetric
 * section along the span costs nothing extra and gives the one thing that makes
 * an aircraft readable at a glance: a planform with a leading edge, a taper and
 * a tip. The panel spans +X from the root; mirror it with scale.x = -1.
 *
 *   root/tip  chord at the root and the tip, metres
 *   span      semi-span
 *   sweep     how far aft the tip sits relative to the root
 *   thickness thickness/chord ratio
 *   dihedral  radians
 */
function wingPanel({
  root, tip, span, sweep = 0, thickness = 0.11, dihedral = 0.05, material,
}) {
  const NC = 14;     // chordwise stations
  const NS = 6;      // spanwise stations
  const camber = [];
  for (let i = 0; i <= NC; i++) {
    // Cosine spacing packs points at the leading edge where the curvature is.
    const xc = 0.5 * (1 - Math.cos((i / NC) * Math.PI));
    const yt = 5 * thickness * (0.2969 * Math.sqrt(xc) - 0.1260 * xc
      - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1015 * xc ** 4);
    camber.push([xc, yt]);
  }

  const verts = [];
  const idx = [];
  const ring = (NC + 1) * 2;               // upper + lower per station
  for (let s = 0; s <= NS; s++) {
    const f = s / NS;
    const c = root + (tip - root) * f;
    const xOff = -sweep * f;               // sweep is aft (toward -Z here)
    const yOff = Math.tan(dihedral) * span * f;
    const zPos = span * f;
    for (let i = 0; i <= NC; i++) {
      const [xc, yt] = camber[i];
      const chordPos = (0.5 - xc) * c + xOff;      // +Z is forward
      verts.push(zPos, yOff + yt * c, chordPos);   // upper
      verts.push(zPos, yOff - yt * c, chordPos);   // lower
    }
  }
  for (let s = 0; s < NS; s++) {
    for (let i = 0; i < NC; i++) {
      const a = s * ring + i * 2;
      const b = a + 2;
      const a2 = a + ring;
      const b2 = b + ring;
      idx.push(a, a2, b, b, a2, b2);                 // upper skin
      idx.push(a + 1, b + 1, a2 + 1, b + 1, b2 + 1, a2 + 1);  // lower skin
    }
  }
  // Cap the tip so the wing is a closed solid rather than an open shell.
  const tipBase = NS * ring;
  for (let i = 0; i < NC; i++) {
    const a = tipBase + i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

/** A vertical fin: the same loft stood on edge. */
function finPanel(opts) {
  const m = wingPanel(opts);
  m.rotation.z = Math.PI / 2;
  return m;
}

/** Mirror a panel to the other side. */
function mirror(m) {
  const c = m.clone();
  c.scale.x = -1;
  return c;
}

function nacelle(len, rad, material) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 0.86, len, 18, 1, true), material);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rad, rad * 0.09, 8, 20), MATS.bareMetal);
  lip.position.z = len * 0.5;
  g.add(lip);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.85, len * 0.45, 16), MATS.exhaust);
  cone.rotation.x = -Math.PI / 2;
  cone.position.z = -len * 0.65;
  g.add(cone);
  const fan = new THREE.Mesh(new THREE.CircleGeometry(rad * 0.92, 20), MATS.darkGrey);
  fan.position.z = len * 0.46;
  g.add(fan);
  return g;
}

function propeller(radius, blades, material) {
  const g = new THREE.Group();
  const hub = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.13, radius * 0.36, 12), MATS.bareMetal);
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  for (let i = 0; i < blades; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.11, radius, radius * 0.03), material);
    b.position.y = radius * 0.5;
    b.rotation.z = 0.22;
    const holder = new THREE.Group();
    holder.rotation.z = (i / blades) * Math.PI * 2;
    holder.add(b);
    g.add(holder);
  }
  // Motion-blur disc so a spinning prop reads as a disc rather than a strobe.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 28),
    new THREE.MeshBasicMaterial({ color: 0x9099a0, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }),
  );
  g.add(disc);
  g.userData.spin = true;
  return g;
}

// ── aircraft ────────────────────────────────────────────────────────────────

/** P-8A Poseidon: a 737 airframe with a weapons bay and a very long day ahead. */
export function buildPoseidon() {
  const g = new THREE.Group();
  const L = 39;
  const body = fuselage([
    [L * 0.50, 0.06], [L * 0.47, 0.75], [L * 0.43, 1.35], [L * 0.36, 1.78],
    [L * 0.26, 1.93], [L * 0.02, 1.95], [-L * 0.20, 1.90], [-L * 0.32, 1.62],
    [-L * 0.42, 1.05], [-L * 0.48, 0.42], [-L * 0.50, 0.10],
  ], 26, MATS.whiteSkin);
  g.add(body);

  // Navy grey belly, the P-8's most recognisable marking after the white top.
  const belly = new THREE.Mesh(
    new THREE.CylinderGeometry(1.97, 1.97, L * 0.72, 26, 1, true, Math.PI * 0.15, Math.PI * 0.7),
    MATS.navyGrey,
  );
  belly.rotation.set(Math.PI / 2, 0, Math.PI);
  belly.position.set(0, -0.02, L * 0.02);
  g.add(belly);

  const cp = new THREE.Mesh(new THREE.SphereGeometry(1.5, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.4), MATS.canopy);
  cp.position.set(0, 0.72, L * 0.36);
  cp.rotation.x = -0.55;
  cp.scale.set(1, 0.55, 1.7);
  g.add(cp);

  const wing = wingPanel({ root: 6.6, tip: 1.9, span: 17.2, sweep: 5.6, dihedral: 0.10, material: MATS.whiteSkin });
  wing.position.set(0, -0.75, -1.0);
  g.add(wing);
  g.add(mirror(wing));

  // Raked wingtips
  for (const sgn of [1, -1]) {
    const wt = wingPanel({ root: 1.9, tip: 0.5, span: 2.4, sweep: 1.5, dihedral: 0.9, material: MATS.whiteSkin });
    wt.position.set(sgn * 17.1, 0.98, -6.6);
    wt.scale.x = sgn;
    g.add(wt);
  }

  for (const sgn of [1, -1]) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.36, 1.7, 4.2), MATS.whiteSkin);
    pylon.position.set(sgn * 6.2, -1.35, 1.6);
    g.add(pylon);
    const n = nacelle(5.6, 1.32, MATS.whiteSkin);
    n.position.set(sgn * 6.2, -2.15, 2.6);
    g.add(n);
  }

  const fin = finPanel({ root: 5.4, tip: 1.7, span: 6.6, sweep: 4.2, dihedral: 0, thickness: 0.09, material: MATS.whiteSkin });
  fin.position.set(0, 1.55, -L * 0.34);
  g.add(fin);
  const stab = wingPanel({ root: 3.2, tip: 1.0, span: 6.2, sweep: 2.2, dihedral: 0.08, thickness: 0.09, material: MATS.whiteSkin });
  stab.position.set(0, 0.55, -L * 0.42);
  g.add(stab);
  g.add(mirror(stab));

  // Wing-root fairing — the fat blister that blends the wing box into the belly.
  const fairing = new THREE.Mesh(new THREE.SphereGeometry(2.5, 20, 12), MATS.whiteSkin);
  fairing.scale.set(1.15, 0.5, 2.6);
  fairing.position.set(0, -1.55, -1.2);
  g.add(fairing);

  // Cabin windows, as a thin dark strip. At any range where the aircraft is more
  // than a few pixels this is the single detail that reads as "airliner".
  for (const sgn of [1, -1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, L * 0.52), MATS.canopy);
    win.position.set(sgn * 1.88, 0.62, L * 0.02);
    g.add(win);
  }

  // Belly radar fairing and the MAD boom on the tail cone.
  const rad = new THREE.Mesh(new THREE.SphereGeometry(1.35, 18, 12), MATS.radome);
  rad.scale.set(1, 0.52, 2.2);
  rad.position.set(0, -1.85, L * 0.20);
  g.add(rad);
  const mad = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.05, 5.6, 8), MATS.darkGrey);
  mad.rotation.x = Math.PI / 2;
  mad.position.set(0, 0.25, -L * 0.56);
  g.add(mad);

  g.userData.wingSpan = 35;
  return g;
}

/** E-2D Hawkeye: twin turboprop, four fins, and a rotating 24-foot rotodome. */
export function buildHawkeye() {
  const g = new THREE.Group();
  const L = 18;
  const body = fuselage([
    [L * 0.50, 0.08], [L * 0.44, 0.85], [L * 0.34, 1.42], [L * 0.14, 1.62],
    [-L * 0.10, 1.58], [-L * 0.30, 1.22], [-L * 0.44, 0.60], [-L * 0.50, 0.18],
  ], 22, MATS.greySkin);
  g.add(body);

  const cp = new THREE.Mesh(new THREE.SphereGeometry(1.2, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), MATS.canopy);
  cp.position.set(0, 0.62, L * 0.31);
  cp.rotation.x = -0.5;
  cp.scale.set(1, 0.6, 1.5);
  g.add(cp);

  const wing = wingPanel({ root: 3.3, tip: 1.6, span: 12.2, sweep: 0.5, dihedral: 0.03, material: MATS.greySkin });
  wing.position.set(0, 0.85, -0.6);
  g.add(wing);
  g.add(mirror(wing));

  g.userData.props = [];
  for (const sgn of [1, -1]) {
    const n = nacelle(5.4, 0.95, MATS.greySkin);
    n.position.set(sgn * 3.6, 0.55, 1.2);
    g.add(n);
    const p = propeller(2.35, 8, MATS.darkGrey);
    p.position.set(sgn * 3.6, 0.55, 4.0);
    g.add(p);
    g.userData.props.push(p);
    // Main gear fairings hanging off the nacelles
    const gearPod = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.6, 4, 10), MATS.greySkin);
    gearPod.rotation.x = Math.PI / 2;
    gearPod.position.set(sgn * 3.6, -0.15, 0.4);
    g.add(gearPod);
  }

  // Rotodome on its pylon
  const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 1.9, 12), MATS.greySkin);
  pylon.position.set(0, 2.25, -1.6);
  g.add(pylon);
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.7, 0.58, 34), MATS.radome);
  dome.position.set(0, 3.3, -1.6);
  g.add(dome);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(3.72, 0.12, 8, 36), MATS.darkGrey);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0, 3.3, -1.6);
  g.add(rim);
  g.userData.rotodome = dome;

  // The Hawkeye's four-fin tail, so it fits under a hangar deck.
  const stab = wingPanel({ root: 2.3, tip: 1.2, span: 4.9, sweep: 0.4, dihedral: 0.02, thickness: 0.09, material: MATS.greySkin });
  stab.position.set(0, 0.55, -L * 0.42);
  g.add(stab);
  g.add(mirror(stab));
  for (let i = 0; i < 4; i++) {
    const x = (-1.5 + i) * 2.9;
    const f = finPanel({ root: 2.0, tip: 1.1, span: 2.2, sweep: 0.7, dihedral: 0, thickness: 0.09, material: MATS.greySkin });
    f.position.set(x, 0.7, -L * 0.42);
    if (Math.abs(x) > 3) f.rotation.x = (x > 0 ? -1 : 1) * 0.18;
    g.add(f);
  }

  g.userData.wingSpan = 25;
  return g;
}

/** MH-60R Seahawk. */
export function buildSeahawk() {
  const g = new THREE.Group();
  const body = fuselage([
    [9.4, 0.10], [8.6, 0.72], [7.4, 1.12], [5.2, 1.36], [1.2, 1.38],
    [-1.6, 1.10], [-4.2, 0.62], [-6.4, 0.40], [-9.2, 0.30], [-9.8, 0.09],
  ], 20, MATS.navyGrey);
  body.scale.set(1.05, 0.95, 1);
  g.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.7, 2.3, 4.4), MATS.navyGrey);
  cabin.position.set(0, 0.2, 1.8);
  g.add(cabin);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), MATS.canopy);
  glass.position.set(0, 0.55, 5.4);
  glass.rotation.x = -0.75;
  glass.scale.set(1.05, 0.85, 1.55);
  g.add(glass);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.32, 1.2, 12), MATS.bareMetal);
  mast.position.set(0, 1.95, 0.9);
  g.add(mast);
  const rotor = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.10, 8.2), MATS.darkGrey);
    blade.position.z = 4.2;
    const arm = new THREE.Group();
    arm.rotation.y = (i / 4) * Math.PI * 2;
    arm.add(blade);
    rotor.add(arm);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(8.3, 34),
    new THREE.MeshBasicMaterial({ color: 0x8a9298, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2;
  rotor.add(disc);
  rotor.position.set(0, 2.5, 0.9);
  g.add(rotor);
  g.userData.rotor = rotor;

  const tailFin = finPanel({ root: 2.1, tip: 1.1, span: 2.7, sweep: 0.7, dihedral: 0, thickness: 0.10, material: MATS.navyGrey });
  tailFin.position.set(0, 0.4, -8.4);
  g.add(tailFin);
  const tailRotor = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.7, 0.06), MATS.darkGrey);
    b.position.y = 0.85;
    const arm = new THREE.Group(); arm.rotation.z = (i / 4) * Math.PI * 2; arm.add(b);
    tailRotor.add(arm);
  }
  tailRotor.position.set(0.42, 2.1, -8.6);
  tailRotor.rotation.y = Math.PI / 2;
  g.add(tailRotor);
  g.userData.tailRotor = tailRotor;
  const stab = wingPanel({ root: 1.4, tip: 0.8, span: 1.7, sweep: 0.2, dihedral: 0, thickness: 0.10, material: MATS.navyGrey });
  stab.position.set(0, 0.45, -7.7);
  g.add(stab);
  g.add(mirror(stab));

  for (const sgn of [1, -1]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 2.2), MATS.navyGrey);
    sp.position.set(sgn * 1.7, -0.85, 0.6);
    g.add(sp);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 8), MATS.darkGrey);
    strut.position.set(sgn * 1.7, -1.4, 0.6);
    g.add(strut);
  }
  // Dipping sonar housing and the sonobuoy rack
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), MATS.radome);
  dome.scale.set(1, 0.6, 1.5);
  dome.position.set(0, -1.2, 3.2);
  g.add(dome);
  const rack = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 2.6), MATS.darkGrey);
  rack.position.set(-1.5, -0.5, -1.6);
  g.add(rack);

  g.userData.wingSpan = 16;
  g.userData.helo = true;
  return g;
}

/** Tu-142 MEDVED — four contra-rotating turboprops and a very long reach. */
export function buildBear() {
  const g = new THREE.Group();
  const L = 50;
  const body = fuselage([
    [L * 0.50, 0.08], [L * 0.46, 0.95], [L * 0.40, 1.75], [L * 0.30, 2.30],
    [L * 0.05, 2.45], [-L * 0.18, 2.38], [-L * 0.32, 1.95], [-L * 0.43, 1.15],
    [-L * 0.49, 0.45], [-L * 0.50, 0.12],
  ], 24, MATS.greySkin);
  g.add(body);

  const cp = new THREE.Mesh(new THREE.SphereGeometry(1.9, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.4), MATS.canopy);
  cp.position.set(0, 1.0, L * 0.38);
  cp.rotation.x = -0.6;
  cp.scale.set(1, 0.5, 1.7);
  g.add(cp);

  const wing = wingPanel({ root: 8.4, tip: 2.4, span: 24.0, sweep: 8.5, dihedral: -0.03, material: MATS.greySkin });
  wing.position.set(0, 0.25, -2.5);
  g.add(wing);
  g.add(mirror(wing));

  g.userData.props = [];
  for (const sgn of [1, -1]) {
    for (const [ox, oz] of [[5.6, 3.4], [11.6, 1.2]]) {
      const n = nacelle(9.0, 1.4, MATS.greySkin);
      n.position.set(sgn * ox, -0.35, oz);
      g.add(n);
      for (let k = 0; k < 2; k++) {
        const p = propeller(3.2, 8, MATS.darkGrey);
        p.position.set(sgn * ox, -0.35, oz + 4.9 + k * 0.55);
        p.userData.reverse = k === 1;
        g.add(p);
        g.userData.props.push(p);
      }
    }
  }

  const fin = finPanel({ root: 7.2, tip: 2.2, span: 8.4, sweep: 5.6, dihedral: 0, thickness: 0.09, material: MATS.greySkin });
  fin.position.set(0, 2.1, -L * 0.34);
  g.add(fin);
  const stab = wingPanel({ root: 4.4, tip: 1.4, span: 8.2, sweep: 3.0, dihedral: 0.04, thickness: 0.09, material: MATS.greySkin });
  stab.position.set(0, 1.2, -L * 0.42);
  g.add(stab);
  g.add(mirror(stab));

  const rad = new THREE.Mesh(new THREE.SphereGeometry(2.3, 18, 12), MATS.radome);
  rad.scale.set(1, 0.55, 1.8);
  rad.position.set(0, -2.3, L * 0.04);
  g.add(rad);
  // The Bear's tail turret — an anachronism that is still bolted on.
  const turret = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), MATS.darkGrey);
  turret.position.set(0, 0.4, -L * 0.49);
  g.add(turret);

  g.userData.wingSpan = 50;
  return g;
}

/** Tu-22M RAIDER — variable geometry wing (drawn swept), tail-mounted engines. */
export function buildBackfire() {
  const g = new THREE.Group();
  const L = 40;
  const body = fuselage([
    [L * 0.50, 0.06], [L * 0.45, 0.72], [L * 0.37, 1.35], [L * 0.22, 1.85],
    [L * 0.00, 2.05], [-L * 0.18, 1.98], [-L * 0.34, 1.62], [-L * 0.46, 1.15],
    [-L * 0.50, 0.75],
  ], 22, MATS.greySkin);
  g.add(body);

  const cp = new THREE.Mesh(new THREE.SphereGeometry(1.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), MATS.canopy);
  cp.position.set(0, 0.95, L * 0.33);
  cp.rotation.x = -0.62;
  cp.scale.set(1, 0.5, 2.1);
  g.add(cp);

  // Wing gloves (fixed) plus the swept outer panels.
  for (const sgn of [1, -1]) {
    const glove = wingPanel({ root: 9.0, tip: 6.0, span: 3.2, sweep: 2.2, dihedral: 0, thickness: 0.08, material: MATS.greySkin });
    glove.position.set(0, -0.35, -2.0);
    glove.scale.x = sgn;
    g.add(glove);
  }
  const wing = wingPanel({ root: 6.0, tip: 1.4, span: 11.5, sweep: 9.0, dihedral: -0.02, thickness: 0.07, material: MATS.greySkin });
  wing.position.set(3.2, -0.35, -4.2);
  g.add(wing);
  g.add(mirror(wing));

  for (const sgn of [1, -1]) {
    const intake = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 8.0), MATS.darkGrey);
    intake.position.set(sgn * 2.5, -0.35, 1.0);
    g.add(intake);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.9, 0.4), MATS.bareMetal);
    lip.position.set(sgn * 2.5, -0.35, 5.1);
    g.add(lip);
    const nz = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.2, 3.4, 18, 1, true), MATS.exhaust);
    nz.rotation.x = Math.PI / 2;
    nz.position.set(sgn * 2.1, -0.35, -L * 0.47);
    g.add(nz);
  }

  const fin = finPanel({ root: 7.0, tip: 1.9, span: 6.8, sweep: 5.2, dihedral: 0, thickness: 0.08, material: MATS.greySkin });
  fin.position.set(0, 1.8, -L * 0.28);
  g.add(fin);
  const stab = wingPanel({ root: 4.2, tip: 1.1, span: 6.4, sweep: 3.8, dihedral: -0.05, thickness: 0.08, material: MATS.greySkin });
  stab.position.set(0, -0.15, -L * 0.36);
  g.add(stab);
  g.add(mirror(stab));

  // Two Kh-32 under the gloves — the whole reason this aircraft is a problem.
  for (const sgn of [1, -1]) {
    const m = buildMissileMesh({ length: 11, radius: 0.45, tone: 'dark' });
    m.position.set(sgn * 3.4, -1.7, 0.5);
    g.add(m);
  }

  g.userData.wingSpan = 26;
  return g;
}

// ── ordnance ────────────────────────────────────────────────────────────────

/** Generic missile airframe: ogive nose, body, cruciform fins, booster skirt. */
/**
 * A tapered, swept control surface. Built as an eight-vertex solid rather than a
 * scaled box so the fin has a real planform (leading-edge sweep, tip chord
 * shorter than root chord) and a real, thin section. Ships' missiles are mostly
 * body; the surfaces are small. Fins the size of the ones on a firework are the
 * single quickest way to make an airframe read as a toy.
 *
 * Local frame: +Z is nose-forward, +Y is span, root at y = 0.
 */
function finPlate(span, rootChord, tipChord, sweep, thick) {
  const h = thick * 0.5;
  const r0 = rootChord * 0.5, r1 = -rootChord * 0.5;
  const t0 = r0 - sweep, t1 = t0 - tipChord;
  const v = [
    // root quad
    [-h, 0, r0], [h, 0, r0], [h, 0, r1], [-h, 0, r1],
    // tip quad
    [-h * 0.45, span, t0], [h * 0.45, span, t0], [h * 0.45, span, t1], [-h * 0.45, span, t1],
  ];
  const idx = [
    0, 1, 2, 0, 2, 3,        // root
    4, 6, 5, 4, 7, 6,        // tip
    0, 4, 5, 0, 5, 1,        // leading edge
    3, 2, 6, 3, 6, 7,        // trailing edge
    1, 5, 6, 1, 6, 2,        // starboard face
    0, 3, 7, 0, 7, 4,        // port face
  ];
  const pos = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    const p = v[idx[i]];
    pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * An anti-ship missile airframe.
 *
 * The proportions are the whole job. A real cruise missile is a long, almost
 * featureless tube — the LRASM is four and a quarter metres of body on half a
 * metre of diameter — with wings that span about four body diameters and tail
 * fins you have to look for. The earlier build gave it wings spanning eight
 * diameters and fins standing three radii off the skin, which from the chase
 * camera read as a dart with a firework's tail rather than a weapon.
 */
export function buildMissileMesh({ length = 5, radius = 0.18, wings = true, tone = 'light', booster = false } = {}) {
  const g = new THREE.Group();
  const body = MATS[tone === 'dark' ? 'missileDark' : 'missileBody'];

  // Faceted body. Eight sides, not sixteen: subsonic ASMs are shaped for radar
  // return, and the flats catch the light in a way a smooth tube does not.
  const bodyLen = length * 0.66;
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.97, bodyLen, 8, 1), body);
  hull.rotation.x = Math.PI / 2;
  hull.rotation.z = Math.PI / 8;
  hull.position.z = -length * 0.03;
  g.add(hull);

  // Ogive nose, lathed so the profile curves like a real radome.
  const nosePts = [];
  const nl = length * 0.24;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    nosePts.push(new THREE.Vector2(radius * Math.sqrt(Math.max(0, 1 - t * t)) + 0.004, t * nl));
  }
  const nose = new THREE.Mesh(new THREE.LatheGeometry(nosePts, 12), MATS.radome);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = length * 0.30;
  g.add(nose);

  // Boattail into the nozzle.
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.9, length * 0.09, 8), MATS.exhaust);
  tail.rotation.x = Math.PI / 2;
  tail.rotation.z = Math.PI / 8;
  tail.position.z = -length * 0.40;
  g.add(tail);

  // A dark band aft of the seeker sells the scale: without one reference the eye
  // has nothing to measure the body against and reads the whole thing as small.
  const band = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.015, radius * 1.015, length * 0.035, 8), MATS.missileDark);
  band.rotation.x = Math.PI / 2;
  band.rotation.z = Math.PI / 8;
  band.position.z = length * 0.235;
  g.add(band);

  if (wings) {
    // Mid-body lifting surfaces: span about two body diameters each side.
    const wGeo = finPlate(radius * 3.6, length * 0.20, length * 0.115, length * 0.075, radius * 0.10);
    for (let i = 0; i < 2; i++) {
      const w = new THREE.Mesh(wGeo, body);
      const arm = new THREE.Group();
      // Port and starboard, in the horizontal plane — a lifting surface lifts.
      arm.rotation.z = i === 0 ? -Math.PI / 2 : Math.PI / 2;
      arm.add(w);
      arm.position.z = -length * 0.04;
      g.add(arm);
    }
    // Tail control fins: four, small, standing barely a radius off the skin.
    const fGeo = finPlate(radius * 1.35, length * 0.105, length * 0.06, length * 0.045, radius * 0.09);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(fGeo, body);
      const arm = new THREE.Group();
      arm.rotation.z = (i / 4) * Math.PI * 2 + Math.PI / 4;
      arm.add(f);
      arm.position.z = -length * 0.35;
      g.add(arm);
    }
    // Ventral inlet fairing — the giveaway that this is an air-breather.
    const inlet = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 1.05, radius * 0.62, length * 0.24), MATS.missileDark,
    );
    inlet.position.set(0, -radius * 1.05, -length * 0.10);
    g.add(inlet);
  }
  if (booster) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.15, radius * 1.05, length * 0.3, 10), MATS.darkGrey);
    b.rotation.x = Math.PI / 2;
    b.position.z = -length * 0.62;
    g.add(b);
  }
  return g;
}

export function buildTorpedoMesh({ length = 6, radius = 0.27 } = {}) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length * 0.72, 6, 14), MATS.missileDark);
  hull.rotation.x = Math.PI / 2;
  g.add(hull);
  const prop = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.8, length * 0.16, 12), MATS.bareMetal);
  prop.rotation.x = -Math.PI / 2;
  prop.position.z = -length * 0.5;
  g.add(prop);
  return g;
}

export function buildSonobuoyMesh() {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.9, 8), MATS.darkGrey);
  g.add(b);
  const flag = new THREE.Mesh(new THREE.CircleGeometry(0.5, 10),
    new THREE.MeshBasicMaterial({ color: 0xffb020, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
  flag.rotation.x = -Math.PI / 2;
  flag.position.y = 0.5;
  g.add(flag);
  return g;
}

export const AIRCRAFT_BUILDERS = {
  MPA_P8: buildPoseidon,
  AEW_E2D: buildHawkeye,
  MH60R: buildSeahawk,
  MPA_BEAR: buildBear,
  BOMBER_BACKFIRE: buildBackfire,
};
