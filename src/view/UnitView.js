import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AIRCRAFT_BUILDERS, MATS } from './models.js';
import { getSharedMicroDetailMaps, getSharedHullTextures, getSharedWakeFoamTexture } from '../utils/ProceduralTextures.js';
import { TrailRibbon } from '../utils/TrailRibbon.js';
import { SIDE, KNOT } from '../sim/constants.js';

const ASSET_BASE = import.meta.env.BASE_URL || '/';
const _fireP = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _rayO = new THREE.Vector3();
const _rayD = new THREE.Vector3();
const _nrm = new THREE.Matrix3();
const _inv = new THREE.Matrix4();
const loader = new GLTFLoader();
const cache = new Map();

export function loadModel(name) {
  if (!cache.has(name)) {
    // Cache the PROMISE so a hundred ships of a class share one fetch — but drop
    // it again if it rejects. A cached rejected promise is a permanent failure:
    // one transient miss (a file still being written, a reload landing mid-fetch)
    // and every ship of that class renders as the grey placeholder box for the
    // rest of the session, with no way back short of a page reload.
    const p = loader.loadAsync(`${ASSET_BASE}assets/models/${name}.glb`)
      .then(g => g.scene)
      .catch((e) => { cache.delete(name); throw e; });
    cache.set(name, p);
  }
  return cache.get(name);
}

const _hullCal = new Map();
// One prepared, surfaced hull per class-and-side. Every UnitView clones from
// here, so streaming a ship in is a scene-graph clone rather than a glTF parse
// plus twenty shader compiles.
const _prepared = new Map();
/** Modelled airframes, by class. Anything absent falls back to the procedural build. */
const AIRCRAFT_MODELS = {
  MPA_P8: 'aircraft_p8',
  AEW_E2D: 'aircraft_e2d',
  MH60R: 'aircraft_mh60',
  MPA_BEAR: 'aircraft_bear',
  BOMBER_BACKFIRE: 'aircraft_backfire',
};
const _preparing = new Map();
const _missing = new Set();

/**
 * Put an arbitrary hull glTF into the game's frame: bow = +Z, up = +Y, beam = X,
 * waterline at y = 0, and scaled to the class's real length.
 *
 * This exists because the source assets do not agree with each other. escort_hull
 * and merchant_ship carry a root rotation that lands them bow = +Z as expected;
 * player_ship does not, and is authored bow = +Y / up = -Z straight out of
 * Blender. Assuming +Z was the length axis therefore scaled the destroyers by the
 * ratio of their real length to their BEAM — a factor of three — and stood them
 * on their sterns. Rather than hard-code a per-asset fixup table that silently
 * breaks the next time an asset is re-exported, work the orientation out from the
 * geometry:
 *
 *   - the longest axis of a ship is its length;
 *   - of the remaining two, the taller is "up" and the shorter is the beam;
 *   - the hull sits mostly BELOW the superstructure, so the up direction is the
 *     one with less geometry on it near the extremes;
 *   - the stern is blunter than the bow, so the wider end is aft.
 *
 * The result is cached per source model, because it is the same answer every time.
 */
function normalizeHull(inst, cls) {
  const holder = new THREE.Group();
  holder.add(inst);

  const key = cls.model || 'escort_hull';
  let cal = _hullCal.get(key);
  if (!cal) {
    inst.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inst);
    const size = new THREE.Vector3(); box.getSize(size);
    const ranked = [['x', size.x], ['y', size.y], ['z', size.z]].sort((a, b) => b[1] - a[1]);
    const lenAxis = ranked[0][0], upAxis = ranked[1][0], beamAxis = ranked[2][0];

    // Which way is up along upAxis? Sample the geometry and compare how much
    // cross-section survives at each extreme: a superstructure tapers to masts,
    // a hull bottom does not.
    // Which way is up?
    //
    // Two heuristics have already failed here. "The narrow end is the top,
    // because masts" fails on a V-bottomed hull, whose keel is just as narrow.
    // "The widest slice is low, because the deck edge is the beam" fails on a
    // container ship, whose deck cargo is as wide as the hull.
    //
    // What does not fail is CROSS-SECTIONAL AREA. Slice the model along the
    // candidate axis and, for each slice, multiply how wide it is by how far it
    // runs fore-and-aft. A hull slice is wide AND runs the whole length of the
    // ship; a superstructure or a container stack is at best wide over a third
    // of it, and a mast slice is nothing at all. Sum the area over each half and
    // the hull half wins by a mile for every ship afloat.
    const v = new THREE.Vector3();
    const lo = box.min[upAxis], hi = box.max[upAxis];
    const span = Math.max(1e-3, hi - lo);
    const BINS = 16;
    const wMax = new Float64Array(BINS);
    const lMin = new Float64Array(BINS).fill(Infinity);
    const lMax = new Float64Array(BINS).fill(-Infinity);
    inst.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 1600));
      for (let i = 0; i < p.count; i += step) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        const t = (v[upAxis] - lo) / span;
        const b = Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)));
        const w = Math.abs(v[beamAxis]);
        if (w > wMax[b]) wMax[b] = w;
        if (v[lenAxis] < lMin[b]) lMin[b] = v[lenAxis];
        if (v[lenAxis] > lMax[b]) lMax[b] = v[lenAxis];
      }
    });
    let areaLow = 0, areaHigh = 0;
    for (let i = 0; i < BINS; i++) {
      const len = (lMax[i] > lMin[i]) ? lMax[i] - lMin[i] : 0;
      const a = wMax[i] * len;
      if (i < BINS / 2) areaLow += a; else areaHigh += a;
    }
    const upSign = areaLow >= areaHigh ? 1 : -1;

    // Bow vs stern along lenAxis: the blunter (wider) end is the stern.
    let fwdWidth = 0, aftWidth = 0;
    const l0 = box.min[lenAxis], l1 = box.max[lenAxis];
    const lspan = Math.max(1e-3, l1 - l0);
    inst.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 900));
      for (let i = 0; i < p.count; i += step) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        const t = (v[lenAxis] - l0) / lspan;
        const w = Math.abs(v[beamAxis]);
        if (t > 0.86) fwdWidth = Math.max(fwdWidth, w);
        else if (t < 0.14) aftWidth = Math.max(aftWidth, w);
      }
    });
    const lenSign = fwdWidth < aftWidth ? 1 : -1;   // narrow end is the bow

    cal = { lenAxis, upAxis, beamAxis, upSign, lenSign, length: size[lenAxis] };
    _hullCal.set(key, cal);
  }

  // Build the change-of-basis: model lenAxis*lenSign -> +Z, upAxis*upSign -> +Y.
  const axis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const fwd = axis[cal.lenAxis].clone().multiplyScalar(cal.lenSign);
  const up = axis[cal.upAxis].clone().multiplyScalar(cal.upSign);
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  // Rows of the basis matrix map model axes onto world axes.
  const m = new THREE.Matrix4().makeBasis(right, up, fwd).transpose();

  // COMPOSE with the source node's own transform rather than replacing it. The
  // axes above were measured from the geometry as the glTF already places it,
  // root rotation included — so overwriting that rotation throws away the very
  // frame the measurement was taken in. escort_hull and merchant_ship happen to
  // carry an identity root and survived it; enemy_destroyer carries a quarter
  // turn, and the Slava rendered as a hundred-and-eighty-metre plank lying flat
  // on the sea.
  if (!inst.userData._baseTRS) {
    inst.userData._baseTRS = { q: inst.quaternion.clone(), s: inst.scale.clone() };
  }
  const base = inst.userData._baseTRS;
  inst.quaternion.setFromRotationMatrix(m).multiply(base.q);

  const scale = (cls.length || 140) / Math.max(1, cal.length);
  inst.scale.set(base.s.x * scale, base.s.y * scale, base.s.z * scale);

  // Re-centre: beam and length about the origin, and the keel at the class's
  // real draft below the waterline so hulls sit in the sea, not on it.
  inst.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(inst);
  const c2 = new THREE.Vector3(); b2.getCenter(c2);
  const draft = cls.sub ? (b2.max.y - b2.min.y) * 0.5 : (cls.draft || 7);
  inst.position.set(-c2.x, -b2.min.y - draft, -c2.z);
  return holder;
}

/** Merchant hulls, so a shipping lane is not a fleet of identical clones. */
const MERCHANT_HULLS = [0x1d4f7a, 0x7a2b22, 0x1f5c46, 0x2b3742, 0x6b5320, 0x4a2f5c, 0x8a6a2c];
const CONTAINER_COLORS = [0xa8402c, 0x2c5aa8, 0x2f7a4a, 0xa8862c, 0x8a3f7a, 0x37474f, 0xb05a20];

/** Blue wears haze grey; Volsk ships wear a colder, darker northern-fleet grey. */
const SIDE_TINT = {
  [SIDE.BLUE]: new THREE.Color(0x6d7880),
  [SIDE.RED]: new THREE.Color(0x59605c),
  [SIDE.NEUTRAL]: new THREE.Color(0x8a7f72),
};

/**
 * The 3-D body of one unit: hull or airframe, wake, damage effects, and the
 * bobbing that couples it to the sea. Created on demand when a unit comes inside
 * the detail bubble and disposed when it leaves, so the renderer never carries
 * more than a few dozen hulls even though the sim is tracking a hundred contacts.
 */
/**
 * Apply the baked vertex AO at a SANE STRENGTH.
 *
 * three.js multiplies COLOR_0 straight into the albedo, and the bake in these
 * assets is far heavier than ambient occlusion has any business being: measured
 * on the destroyer's hull mesh it averages 0.44 and never rises above 0.30 over
 * most of the plating. That is not "darken the recesses", it is "darken the
 * ship" — and multiplied into an already dark baked albedo it took the hull to
 * roughly a fiftieth of the reflectance of haze grey paint. An art review read
 * the result, correctly, as ships rendering as black slabs in full daylight.
 *
 * AO is an ambient-visibility term: it belongs in the range 0.75-1.0 across open
 * surfaces, reaching down only inside genuine cavities. Remapping toward white
 * keeps the shape information the bake carries — which is real, and worth having
 * — while returning the hull to a believable brightness.
 */
const AO_STRENGTH = 0.42;
function _tempVertexAO(m) {
  if (!m || m._aoTempered) return;
  m._aoTempered = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       #ifdef USE_COLOR
         // Lift the baked occlusion toward white; see AO_STRENGTH.
         // vColor is a vec4 whenever COLOR_0 ships with alpha, which these
         // assets do — so take .rgb explicitly rather than letting the type
         // depend on how the exporter happened to write the attribute.
         vec3 ao_ = vColor.rgb;
         diffuseColor.rgb /= max(vec3(0.02), ao_);
         diffuseColor.rgb *= mix(vec3(1.0), ao_, ${AO_STRENGTH.toFixed(2)});
       #endif`,
    );
  };
  m.needsUpdate = true;
}

/*
 * Warship paint calibration.
 *
 * This used to apply a 2.4x albedo gain, on the measurement that the destroyer's
 * atlas averaged sRGB 83 where haze grey should sit near 130. That measurement
 * was real but the diagnosis was wrong, and so was every other attempt at this
 * across four review rounds. The atlas is correct — median sRGB 85 on paint
 * texels, which IS haze grey. The ships were dark because the pipeline had no
 * tone mapping and no linear-to-sRGB transfer at all (see the note in
 * VIGNETTE_GRADE_SHADER), so linear radiance was going to an sRGB display raw
 * and everything physically-based came out about six times too dark.
 *
 * With the transfer function in place the gain is back to 1.0, where the earlier
 * comment here correctly predicted it belonged. Measured with it at 1.0: lit
 * topside reads p90 152 against a 150-190 target for sunlit haze grey.
 *
 * What remains is the metalness clamp, which is a genuine asset correction:
 * painted steel is a dielectric and the bakes carry values an order of magnitude
 * too high for paint.
 */
// The baked topside atlas is too dark for the paint it represents.
//
// Measured through an offscreen target with the composer out of the loop and the
// probe calibrated first (K = 0.05/0.252/0.50/1.00 must return K x 255): the map
// sample decodes to linear 0.151, the glTF colour factor is 0.886, so lighting
// consumes an albedo of 0.134. US Navy haze grey 5-H is 0.252. The paint is 1.88x
// too dark, and the scene compensated with an ambient fill roughly three times
// too strong — which is why a hull's lit side and its shadow side measured within
// three luminance values of each other. There was no key light shaping at all.
//
// Properly the atlas should be re-baked; lifting the factor is the fix that does
// not require re-exporting every asset. It puts a factor above 1, which is not a
// legal glTF authoring value, but it is compensating for a texture that is wrong,
// and the product is what lighting actually sees: 0.134 x 1.88 = 0.252.
const PAINT_ALBEDO_GAIN = 1.88;
const PAINT_MAX_METALNESS = 0.12;
// Fittings, davits, masts and deck machinery. Oxidised or painted steel, not a
// mirror: an art review found this material at 13,240 triangles — the second
// largest on the ship — sitting at metalness 1.0 with a white colour factor, so
// it returned no diffuse at all and read as a hole in the hull.
const FITTING_MAX_METALNESS = 0.35;
function _calibratePaint(c, name) {
  if (/darkmetal|metal|fitting|davit|rail|stanchion|vent|pipe/.test(name)) {
    c.metalness = Math.min(c.metalness ?? 1, FITTING_MAX_METALNESS);
    return;
  }
  if (!/hull|super|deck|paint|grey|gray|haze|boot|keel|nonskid|mast|funnel|house|rubber|anechoic|casing/.test(name)) return;
  c.metalness = Math.min(c.metalness ?? 1, PAINT_MAX_METALNESS);
  if (PAINT_ALBEDO_GAIN !== 1.0) c.color.multiplyScalar(PAINT_ALBEDO_GAIN);
}

/*
 * A contrail is soft at the edges. A wake is not.
 *
 * The contrail ribbon was borrowing the wake foam texture, which is opaque and
 * hard-edged because that is what churned water looks like. Stretched across a
 * 170-metre-wide billboard ribbon at 0.85 opacity, each segment read as exactly
 * what an art review called it: a hard-edged translucent polygon slab.
 *
 * What it needs is a gaussian ACROSS the ribbon and near-uniform along it, so
 * the quad edges dissolve and only the line remains. Built once, shared.
 */
let _contrailTex = null;
function getContrailTexture() {
  if (_contrailTex) return _contrailTex;
  const H = 64, W = 8;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    // Gaussian across the width, with a slightly denser core.
    const t = (y / (H - 1)) * 2 - 1;              // -1..1 across the ribbon
    const g = Math.exp(-t * t * 3.2);
    const core = Math.exp(-t * t * 14.0) * 0.45;
    const a = Math.min(1, g * 0.72 + core);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  cx.putImageData(img, 0, 0);
  _contrailTex = new THREE.CanvasTexture(cv);
  _contrailTex.wrapS = THREE.RepeatWrapping;
  _contrailTex.wrapT = THREE.ClampToEdgeWrapping;
  _contrailTex.minFilter = THREE.LinearFilter;
  _contrailTex.magFilter = THREE.LinearFilter;
  return _contrailTex;
}

export class UnitView {
  constructor(scene, unit, opts = {}) {
    this.scene = scene;
    this.unit = unit;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    scene.add(this.group);
    this.ready = false;
    this.spin = [];
    this.rotor = null;
    this.fires = [];
    this._smokeT = 0;
    this._t = 0;
    this.fx = opts.fx || null;
    this.quality = opts.quality || 'high';

    if (unit.isAir) { this._buildAircraft(); this._buildContrail(scene); }
    else this._buildHull();

    // Ships no longer carry a ribbon wake. The ocean shader draws a real Kelvin
    // system — cusp arms, a transverse train, a prop-wash lane and decay with
    // distance — and a flat alpha quad laid over the top of it only ever
    // contributed a hard-edged grey line that could not follow the wave field.
  }

  /**
   * Aircraft.
   *
   * Prefer a modelled GLB where one exists and fall back to the procedural
   * builder otherwise, so the air wing can be replaced type by type without the
   * game ever losing an aircraft. The GLBs are authored nose = +Z / up = +Y,
   * which is already the engine's frame, so no basis solve is needed — only a
   * scale to the class's declared length and a lift of the named moving parts
   * (rotodome, propellers, rotors) out of the hierarchy so they can be spun.
   */
  _buildAircraft() {
    const u = this.unit;
    const file = AIRCRAFT_MODELS[u.className];
    if (!file) { this._buildAircraftProcedural(); return; }

    const key = `air|${u.className}|${u.side}`;
    const template = _prepared.get(key);
    if (template) { this._attachAircraft(template.clone(true)); return; }

    // One frame of the procedural airframe while the GLB streams, so an aircraft
    // is never an invisible hole in the sky.
    this._buildAircraftProcedural();
    this._placeholderAir = this.model;

    if (_missing.has(key)) return;
    let pending = _preparing.get(key);
    if (!pending) {
      pending = (async () => {
        const src = await loadModel(file);
        const inst = src.clone(true);
        // Scale to the class's declared length along the nose axis.
        const box = new THREE.Box3().setFromObject(inst);
        const len = Math.max(1, box.max.z - box.min.z);
        inst.scale.setScalar((u.cls.length || len) / len);
        this._polish(inst, u);
        inst.traverse((o) => {
          if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData._shared = true; }
        });
        const holder = new THREE.Group();
        holder.add(inst);
        _prepared.set(key, holder);
        _preparing.delete(key);
        return holder;
      })();
      _preparing.set(key, pending);
    }
    pending.then((tpl) => {
      if (this.disposed) return;
      if (this._placeholderAir) {
        this.group.remove(this._placeholderAir);
        this._placeholderAir = null;
      }
      this._attachAircraft(tpl.clone(true));
    }).catch(() => {
      // No modelled airframe for this type yet; keep the procedural one and stop
      // asking, so a missing file is one failed fetch rather than one per ship.
      _missing.add(key);
      _preparing.delete(key);
    });
  }

  /**
   * Measure where the bridge actually is on THIS hull.
   *
   * The bridge camera used to place the eye from class numbers — a fraction of
   * the mast height, a fraction of the length — and those fractions cannot know
   * where a given model's deckhouse begins. On the DDG they put the eye at
   * fifteen metres and thirty-three metres forward, which is inside the tower:
   * the whole lower half of the frame was a flat white wall.
   *
   * So ask the geometry. Find the tallest part of the ship (the mast tower),
   * put the eye a little forward of it at about six tenths of its height, and
   * out at the wing rail. That lands on the bridge of anything shaped like a
   * warship, whatever its dimensions.
   */
  _measureBridgeEye(root) {
    const v = new THREE.Vector3();
    root.updateMatrixWorld(true);
    // Pass one: how tall is the ship?
    let top = -1e9;
    const pts = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const a = o.geometry.getAttribute('position');
      if (!a) return;
      for (let i = 0; i < a.count; i += 5) {
        v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
        pts.push(v.x, v.y, v.z);
        if (v.y > top) top = v.y;
      }
    });
    if (top < 1) return;
    // Pass two: the FORWARD FACE of the deckhouse — the furthest-forward point
    // that is still properly superstructure rather than deck fittings — and the
    // height of the structure right there. That is where the bridge is. Keying
    // off the masthead instead put the eye inside the tower, looking at a wall.
    let front = -1e9;
    for (let i = 0; i < pts.length; i += 3) {
      if (pts[i + 1] > top * 0.42 && pts[i + 2] > front) front = pts[i + 2];
    }
    const L = this.unit.cls.length || 150;
    const fwd = Math.min(front + 3, L * 0.40);

    // Pass three: how wide is the ship AT THE EYE'S STATION?
    //
    // A fraction of the beam is the wrong measure for this. Beam is the ship's
    // width amidships, and the bridge sits well forward of amidships on a hull
    // that is tapering hard toward the bow — so beam * 0.40 put the eyepoint
    // some seven metres OUTBOARD of the actual hull, hanging in the air beside
    // the ship with a clear view of her own side. Measure the half-width of the
    // real geometry in a slice around the eye's fore-and-aft position instead.
    let halfW = 0;
    const band = Math.max(6, L * 0.045);
    for (let i = 0; i < pts.length; i += 3) {
      if (Math.abs(pts[i + 2] - fwd) > band) continue;
      if (pts[i + 1] < top * 0.12) continue;          // ignore the underwater form
      halfW = Math.max(halfW, Math.abs(pts[i]));
    }
    if (halfW < 1) halfW = (this.unit.cls.beam || 18) * 0.5;

    this.bridgeEye = {
      // Height from ship design (a destroyer's bridge is about an eighth of her
      // length above the water), clamped so it can never climb above the model's
      // own superstructure.
      h: Math.min(top * 0.62, L * 0.128),
      // Fore-and-aft from the MODEL: three metres forward of the furthest-
      // forward point of the deckhouse, which is the bridge wing. Anything aft of
      // that and the deckhouse fills half the frame; anything forward of the bow
      // and you are flying.
      fwd,
      // Just inboard of the real edge, so the eye is standing ON the wing with
      // the rail in view rather than floating off the side of the ship.
      side: Math.max(1.5, halfW - 1.2),
    };
  }

  /** Hook up a built airframe and find its moving parts by name. */
  _attachAircraft(g) {
    this.model = g;
    this.group.add(g);
    const props = [];
    let rotor = null, tailRotor = null, rotodome = null;
    g.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      // Match only the top-level spin nodes. `prop_1` is the group that turns;
      // `prop_1_2` is one of its meshes, and spinning both applies the rotation
      // twice.
      if (/^prop_\d+$/.test(n) || n === 'propeller' || n === 'prop') props.push(o);
      else if (n === 'rotor' || n === 'mainrotor') rotor = o;
      else if (n === 'tailrotor' || n === 'tail_rotor') tailRotor = o;
      else if (n === 'rotodome') rotodome = o;
    });
    // Contra-rotating pairs: the second disc of each pair turns the other way.
    // The Bear's eight prop nodes are numbered front 1-4, rear 5-8 for exactly
    // this, and without the flag both discs of a pair spin together, which reads
    // as one very thick propeller.
    props.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
    if (props.length >= 8) {
      for (let i = 4; i < props.length; i++) props[i].userData.reverse = true;
    }
    this.spin = props.length ? props : (g.userData.props || []);
    this.rotor = rotor || g.userData.rotor || null;
    this.tailRotor = tailRotor || g.userData.tailRotor || null;
    this.rotodome = rotodome || g.userData.rotodome || null;
    this.ready = true;
  }

  _buildAircraftProcedural() {
    const b = AIRCRAFT_BUILDERS[this.unit.className];
    const g = b ? b() : AIRCRAFT_BUILDERS.MPA_P8();
    this.model = g;
    this.group.add(g);
    this.spin = g.userData.props || [];
    this.rotor = g.userData.rotor || null;
    this.tailRotor = g.userData.tailRotor || null;
    this.rotodome = g.userData.rotodome || null;
    this.ready = true;
    this._applyShadows(g);
  }

  async _buildHull() {
    const u = this.unit;
    const key = `${u.cls.model || 'escort_hull'}|${u.side}|${u.neutral ? u.uid : 0}`;

    // A prepared hull is a normalised, surfaced, shadow-flagged clone that is
    // ready to drop straight into the scene. Building one takes a glTF parse, a
    // basis solve and twenty-odd shader compiles; doing that every time a ship
    // streams back into the detail bubble is why a camera round trip left the
    // player's own flagship rendering as the grey placeholder box. Prepare once
    // per class-and-side, then clone — and clone SHARES geometry and materials,
    // which is what we want: two Burkes are the same ship.
    let template = _prepared.get(key);
    if (!template) {
      // Placeholder so a hull that has just entered the bubble is never an
      // invisible hole in the ocean while its glTF streams in. Only ever seen
      // once per class, on the very first ship of it.
      // Dark, low and translucent — a hull-down SILHOUETTE, not a lit grey brick.
      // A properly shaded box is worse than nothing: it reads as a finished
      // object that happens to be a box, which is the single most damning thing
      // an art review can find in a frame. A dim shape on the water for the two
      // hundred milliseconds a glTF takes to arrive reads as haze.
      const ph = new THREE.Mesh(
        new THREE.BoxGeometry((u.cls.beam || 18) * 0.8, (u.cls.mastHeight || 20) * 0.22, (u.cls.length || 140) * 0.94),
        new THREE.MeshBasicMaterial({
          color: 0x2b3742, transparent: true, opacity: 0.42, depthWrite: false,
        }),
      );
      ph.position.y = (u.cls.mastHeight || 20) * 0.06;
      this.group.add(ph);
      this.placeholder = ph;

      let pending = _preparing.get(key);
      if (!pending) {
        pending = (async () => {
          const src = await loadModel(u.cls.model || 'escort_hull');
          const inst = src.clone(true);
          const holder = normalizeHull(inst, u.cls);
          this._polish(inst, u);
          if (!u.isSub) this._applyWetting(inst);
          holder.traverse((o) => {
            if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData._shared = true; }
          });
          _prepared.set(key, holder);
          _preparing.delete(key);
          return holder;
        })().catch((e) => { _preparing.delete(key); throw e; });
        _preparing.set(key, pending);
      }
      try {
        template = await pending;
      } catch (e) {
        // Same rule one level up: forget the failed attempt so the next ship of
        // this class tries again rather than inheriting the failure.
        _preparing.delete(key);
        this.ready = true;
        return;
      }
      if (this.disposed) return;
      this.group.remove(ph);
      ph.geometry.dispose(); ph.material.dispose();
      this.placeholder = null;
    }

    this.model = template.clone(true);
    this.group.add(this.model);
    this._measureBridgeEye(this.model);
    this.ready = true;
  }

  /**
   * Surfacing.
   *
   * The source glTFs author almost every hull surface as roughness 1.0 / metalness
   * ~0.9. A fully rough metal has no diffuse term at all, so under an environment
   * map it renders as a black silhouette — which is exactly how every ship in the
   * game looked before this pass. Warship paint is a dielectric: metalness near
   * zero, roughness in the 0.55–0.9 band depending on whether it is topside
   * enamel, non-skid, or boot-topping. This classifies each source material by
   * name and gives it a physically sane surface, then tints the paint by side.
   *
   * Materials are shared across every instance of a cached glTF, so each must be
   * cloned before it is touched or one ship's paint becomes every ship's paint.
   */
  _polish(root, u) {
    const tint = SIDE_TINT[u.side] || new THREE.Color(0x707070);
    let micro = null;
    try { micro = getSharedMicroDetailMaps(); } catch (e) { /* optional */ }

    // Merchants get individually painted so a shipping lane doesn't read as a
    // fleet of clones — the hue is derived from the unit id so it is stable.
    const hullHue = MERCHANT_HULLS[(u.uid * 7) % MERCHANT_HULLS.length];

    const seen = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        if (!m) continue;
        // Key the cache on material AND mesh name: the surface classifier reads
        // both, because the source assets disagree about which one carries the
        // meaning. escort_hull names its materials (SS_EH_HullMat); the Volsk
        // hulls leave them generic and put the meaning on the mesh (Deckhouse,
        // Funnel, BootTop). Reading only the material name sent every Volsk ship
        // down the fall-through branch, which kept the authored near-white and
        // rendered a Slava-class cruiser as a white plastic model.
        const key = `${m.uuid}|${o.name || ''}`;
        let c = seen.get(key);
        if (!c) {
          c = m.clone();
          const n = `${m.name || ''} ${o.name || ''}`.toLowerCase();
          // A material that arrives with a baked baseColor texture has already
          // been art-directed: plate seams, weathering, decals, the lot. The
          // classifier below exists to rescue assets that shipped as one flat
          // value, and running it over a real texture set would MULTIPLY the
          // authored albedo and throw the work away. Take only the side tint,
          // and only faintly.
          if (m.map) {
            // Even on an art-directed asset the ENVIRONMENT response is not in
            // the maps: how much sky a surface picks up is a renderer setting,
            // and leaving every material on 1.0 is what makes paint, glazing,
            // radome GRP and non-skid read as one material under a bright sky.
            // Roughness and metalness come from the authored MR pack; this only
            // says how strongly each surface answers the sky.
            c.envMapIntensity =
              /glass|canopy|window/.test(n) ? 2.6 :
              /radome|dome/.test(n) ? 0.62 :
              /nonskid/.test(n) ? 0.55 :
              /darkmetal|bareste|metal|gun|steel|prop/.test(n) ? 1.25 :
              /keel|antifoul/.test(n) ? 0.7 :
              (m.envMapIntensity ?? 1.0);
            // THE AMBIENT OCCLUSION SWITCH.
            //
            // Every asset ships with baked AO in the COLOR_0 vertex attribute,
            // and three.js ignores a vertex-colour attribute entirely unless the
            // material opts in. Three consecutive art reviews reported "no
            // ambient occlusion anywhere in the build, every recess at full
            // ambient" — the occlusion was in the geometry the whole time and
            // the renderer was told not to look at it.
            c.vertexColors = true;
            _tempVertexAO(c);
            _calibratePaint(c, n);
            if (!u.neutral && /hull|super|deck|paint/.test(n)) c.color.lerp(tint, u.side === SIDE.RED ? 0.26 : 0.14);
            c._baked = true;
            seen.set(key, c);
            if (Array.isArray(o.material)) o.material[i] = c; else o.material = c;
            continue;
          }
          const set = (hex, rough, metal, envI = 1.0) => {
            if (hex !== null) c.color.setHex(hex);
            c.roughness = rough; c.metalness = metal; c.envMapIntensity = envI;
          };

          if (/glass|canopy|window/.test(n)) {
            // Bridge glazing: near-black tint, mirror-smooth, strong env pickup.
            set(0x0b1016, 0.045, 0.02, 2.6);
          } else if (/boottop|boot/.test(n)) {
            set(0x121619, 0.42, 0.04, 1.0);            // glossy black boot topping
          } else if (/keel|antifoul/.test(n)) {
            set(0x6b3026, 0.88, 0.02, 0.7);            // red anti-fouling below the waterline
          } else if (/nonskid/.test(n)) {
            set(0x353d44, 0.94, 0.03, 0.55);           // weather-deck non-skid, dead matte
          } else if (/radome|dome/.test(n)) {
            set(0xc4c9cd, 0.82, 0.0, 0.62);            // glass-reinforced plastic, not chrome
          } else if (/spy|arrayface|array/.test(n)) {
            set(0x4c5155, 0.38, 0.18, 1.3);            // phased-array face
          } else if (/vls|cell|hatch/.test(n)) {
            set(0x2c3238, 0.5, 0.42, 1.1);
          } else if (/darkmetal|bareste|metal|gun|steel/.test(n)) {
            set(0x8a9096, 0.40, 0.86, 1.25);
          } else if (/navlight/.test(n)) {
            c.emissive = new THREE.Color(/_p$/.test(n) ? 0xff3020 : 0x30ff60);
            c.emissiveIntensity = 2.2;
            set(null, 0.4, 0.0, 1.0);
          } else if (/rubber|subrubber/.test(n)) {
            set(0x14171a, 0.96, 0.02, 0.35);           // anechoic tile
          } else if (/subhull|subsail|subdark/.test(n)) {
            set(0x1b1f22, 0.88, 0.05, 0.5);
          } else if (/funnelblack|dark/.test(n)) {
            set(0x1e2226, 0.72, 0.08, 0.8);
          } else if (/funnelred|rescue/.test(n)) {
            set(0xa8321f, 0.62, 0.04, 0.9);
          } else if (/mark|number|helipad|iff|white|cream/.test(n)) {
            // Markings keep their authored colour; only the surface is corrected.
            set(null, 0.66, 0.02, 0.85);
            if (u.side === SIDE.RED && /iff/.test(n)) c.color.setHex(0x8a2020);
          } else if (/container/.test(n)) {
            // Seven authored container colours, baked into the atlas. The
            // neutral branch below would repaint all of them one per-hull hue.
            set(null, 0.72, 0.05, 0.85);
          } else if (/box\d/.test(n)) {
            set(CONTAINER_COLORS[(u.uid * 3 + parseInt(n.slice(-1), 10) || 0) % CONTAINER_COLORS.length], 0.78, 0.06, 0.8);
          } else {
            // Topside enamel, and the DEFAULT. Everything on a warship that is
            // not glass, boot-topping, a marking or bare machinery is painted the
            // ship's grey, so painting anything unrecognised grey is right far
            // more often than preserving whatever the exporter happened to
            // author — which for the Volsk hulls was a flat near-white that blew
            // out to a plastic model under sky irradiance.
            if (u.neutral) c.color.setHex(hullHue);
            else { c.color.setHex(0x8b939a); c.color.lerp(tint, 0.72); }
            set(null, 0.63, 0.055, 1.05);
            if (micro?.normalMap && !c.normalMap) {
              c.normalMap = micro.normalMap;
              c.normalScale = new THREE.Vector2(0.5, 0.5);
            }
            if (micro?.roughnessMap && !c.roughnessMap) c.roughnessMap = micro.roughnessMap;
          }
          seen.set(key, c);
        }
        if (Array.isArray(o.material)) o.material[i] = c; else o.material = c;
      }
    });
  }

  /**
   * Surfacing.
   *
   * The source hulls arrive as single flat values — one grey for the whole ship —
   * and that is the loudest "this is CG" tell there is. A real warship has no
   * square metre that is one value: there are plate seams every couple of metres,
   * horizontal strakes, weld beads, a dark matte non-skid on everything you can
   * walk on, salt bleaching on the upward faces, rust weeping down from every
   * edge and fitting, and soot aft of the funnels.
   *
   * All of that is generated here in the fragment shader from OBJECT-SPACE
   * position and world normal, deliberately not from UVs — the source assets
   * have unreliable UVs and some have none worth using, and object space is
   * exactly the frame the details live in anyway: plating runs along the hull,
   * rust runs down the hull, non-skid lies flat on the hull.
   *
   * The ship is authored with its waterline at y = 0, so the same frame gives the
   * wet band above the waterline for free, and it rolls and pitches with the hull.
   */
  _applyWetting(root) {
    const rustSeed = ((this.unit.uid || 1) * 7919) % 1000 / 1000;
    root.traverse((o) => {
      if (!o.isMesh || !o.material || o.material._surfaced) return;
      const m = o.material;
      const n = `${m.name || ''} ${o.name || ''}`.toLowerCase();
      if (/glass|canopy|navlight|radome|mark|number|iff|container/.test(n)) return;
      const isHull = /hull|deck|super|boot|keel|paint|grey|haze|skin|house|bridge|funnel|tier/.test(n);
      m._surfaced = true;
      if (m.map && !m.vertexColors) m.vertexColors = true;
      _tempVertexAO(m);
      // On a properly textured asset the plating, rust and non-skid are already
      // in the map. Generating them again on top produces a double image. Keep
      // only the wet band, which is dynamic and cannot be baked.
      const baked = !!m.map || m._baked;
      // CHAIN, do not replace.
      //
      // _tempVertexAO above installs its own onBeforeCompile to lift the baked
      // occlusion toward white. Assigning a fresh handler here threw that away
      // silently — the compiled shader had no colour injection at all — so the
      // AO fix written to cure the black-slab hulls has never once run on any
      // textured asset. An art review caught it by inspecting the compiled
      // shader source, which is the only way this kind of thing shows up.
      const prevOBC = m.onBeforeCompile;
      m.onBeforeCompile = (shader, renderer) => {
        prevOBC?.call(m, shader, renderer);
        shader.uniforms.uSurfSeed = { value: rustSeed };
        shader.uniforms.uSurfHull = { value: isHull ? 1 : 0 };
        shader.uniforms.uSurfBaked = { value: baked ? 1 : 0 };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vWorldNrm;')
          .replace('#include <begin_vertex>',
            '#include <begin_vertex>\nvObjPos = position;\nvWorldNrm = normalize(mat3(modelMatrix) * objectNormal);');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
varying vec3 vObjPos;
varying vec3 vWorldNrm;
uniform float uSurfSeed;
uniform float uSurfHull;
uniform float uSurfBaked;
float shHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float shNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(shHash(i), shHash(i + vec2(1.0, 0.0)), f.x),
             mix(shHash(i + vec2(0.0, 1.0)), shHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float shFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * shNoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
// A thin dark line at a fixed spacing, with a soft shoulder: a plate seam.
float shSeam(float x, float period, float width) {
  float t = abs(fract(x / period + 0.5) - 0.5) * period;
  return 1.0 - smoothstep(0.0, width, t);
}`)
          .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec3 P = vObjPos;
  vec3 N = normalize(vWorldNrm);
  float up = clamp(N.y, 0.0, 1.0);
  float sideness = 1.0 - up;

  // ── plating ─────────────────────────────────────────────────────────────
  // Butt seams across the hull every ~2.4 m, strakes along it every ~1.35 m,
  // and a slight per-plate tonal variation so no two plates are quite alike.
  float seamA = shSeam(P.z, 2.4, 0.035);
  float seamB = shSeam(P.y, 1.35, 0.030) * sideness;
  float seamC = shSeam(P.x, 2.1, 0.030) * up;
  float seams = clamp(seamA + seamB + seamC, 0.0, 1.0);
  float plateId = shHash(floor(vec2(P.z / 2.4, P.y / 1.35)) + uSurfSeed * 13.0);
  float plateTone = (plateId - 0.5) * 0.055;

  // ── grime and salt ──────────────────────────────────────────────────────
  float grime = shFbm(P.xz * 0.55 + uSurfSeed * 20.0);
  float salt = up * smoothstep(0.35, 0.85, shFbm(P.xz * 0.9 + 7.0)) * 0.12;

  // ── rust weeping downward ───────────────────────────────────────────────
  // A drip is NARROW across and LONG down, so the noise has to be high frequency
  // horizontally and very low frequency vertically. Which horizontal axis that
  // is depends on which way the plate faces, so blend by the normal — otherwise
  // the streaks run the wrong way round on half the ship and read as scratches.
  float horiz = mix(P.z, P.x, abs(N.x));
  float streak = smoothstep(0.66, 0.99, shFbm(vec2(horiz * 7.0 + uSurfSeed * 40.0, P.y * 0.11)));
  float dripAge = smoothstep(0.0, 6.0, max(0.0, P.y));
  float rust = streak * sideness * (1.0 - dripAge * 0.6) * 0.30;
  rust *= smoothstep(0.30, 0.72, shFbm(P.xz * 0.18 + 30.0));

  // ── non-skid: everything you can walk on is dark, matte and worn ─────────
  float nonskid = smoothstep(0.72, 0.93, up) * uSurfHull;
  float traffic = smoothstep(0.4, 0.75, shFbm(P.xz * 0.7 + 60.0));

  vec3 c = diffuseColor.rgb;
  // Which generated detail survives on a BAKED asset.
  //
  // The blanket rule used to be "none of it", on the reasoning that a properly
  // textured hull already has its plating and non-skid in the map and drawing
  // them again gives a double image. That reasoning holds for the STRUCTURAL
  // detail — seams follow real plate lines and non-skid follows real walkways,
  // and a procedural guess at either lands next to the baked one rather than on
  // it. It does not hold for WEATHERING, which the bakes turn out not to carry
  // at all: an art review found zero weathering on any textured asset in the
  // game, and a warship at sea is streaked with rust weeping from every scupper
  // and hazed with salt from the boot topping up.
  //
  // Rust and salt are also the two that cannot double-image, because they are
  // stains rather than structure — there is nothing underneath for them to be
  // misaligned with. They come back at reduced strength; the structural detail
  // stays gated.
  float gen = 1.0 - uSurfBaked;
  float genStain = mix(0.45, 1.0, gen);
  seams *= gen; nonskid *= gen;
  rust *= genStain; salt *= genStain;
  grime = mix(0.72, grime, max(gen, 0.55));
  c *= 1.0 - seams * 0.14;
  c *= 1.0 + plateTone;
  c *= mix(1.0, 0.96 + grime * 0.07, uSurfHull);
  c += vec3(salt);
  c = mix(c, vec3(0.34, 0.20, 0.13), rust * uSurfHull);
  c = mix(c, c * vec3(0.58, 0.60, 0.63), nonskid * (0.70 - traffic * 0.24));

  // Soaked band above the waterline: darker, glossier, a little green.
  //
  // A BAND, not a half-space. Written as one smoothstep this ran all the way
  // down to the keel and dropped the whole underwater body to roughness 0.09,
  // so the sun laid a specular streak along hull plating four metres under the
  // sea — reported as "sun glint appears on the underwater hull". Below the
  // waterline is chalk-matte anti-fouling and it is under water besides.
  float wet = (1.0 - smoothstep(0.0, 2.9, P.y)) * smoothstep(-1.3, -0.15, P.y);
  c *= mix(1.0, 0.68, wet);
  c = mix(c, c * vec3(0.88, 1.0, 0.95), wet * 0.5);

  diffuseColor.rgb = c;
}`)
          .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
{
  vec3 P = vObjPos;
  vec3 N = normalize(vWorldNrm);
  float up = clamp(N.y, 0.0, 1.0);
  // Roughness is what sells painted steel. Seams and rust are rough; the wet
  // band is nearly a mirror; walking surfaces are dead matte.
  float rough = roughnessFactor;
  rough += shFbm(P.xz * 1.1 + 3.0) * 0.14 - 0.06;
  rough = mix(rough, 0.93, smoothstep(0.72, 0.93, up) * uSurfHull);
  float wet2 = (1.0 - smoothstep(0.0, 2.9, P.y)) * smoothstep(-1.3, -0.15, P.y);
  rough = mix(rough, 0.09, wet2);
  roughnessFactor = clamp(rough, 0.04, 1.0);
}`);
      };
      m.needsUpdate = true;
    });
  }

  _applyShadows(root) {
    root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  /**
   * Contrails.
   *
   * Above the tropopause a jet leaves a line in the sky you can see for fifty
   * miles, and in a game about finding people it is both beautiful and useful:
   * it is the one thing a high-altitude aircraft does that gives it away to the
   * naked eye. Turboprops at low level do not make one, so the trigger is real —
   * altitude and jet propulsion, not "is an aircraft".
   */
  _buildContrail(scene) {
    const u = this.unit;
    if (u.cls.helo) return;
    let map = null;
    try { map = getContrailTexture(); } catch (e) { /* optional */ }
    if (!map) return;
    this.contrail = new TrailRibbon(scene, {
      capacity: 90, life: 220, color: 0xf2f6fa, map,
      // A jet at cruise covers a lot of ground between samples, and at high time
      // compression it covers a great deal more, so the restart threshold has to
      // be generous or the trail resets itself every frame.
      maxGap: 26000,
      orientation: 'billboard', uvRepeat: 1, renderOrder: 3, opacity: 0.55,
      widthFn: (age, life, uu) => 22 + (1 - uu) * 150,
      alphaFn: (age, life, uu) => {
        // uu = 0 at the oldest sample, 1 at the aircraft. A contrail takes a
        // second to form behind the engines and then persists for minutes, so it
        // is faint right at the tail, full a little way back, and dissolves at
        // the far end rather than stopping.
        const fade = Math.pow(Math.max(0, 1 - age / life), 1.1);
        const tail = Math.min(1, uu * 6);
        const head = Math.min(1, (1 - uu) * 12);
        return fade * tail * head * 0.9;
      },
    });
  }

  update(dt, elapsed, cam, ocean) {
    const u = this.unit;
    const g = this.group;
    const x = cam.rx(u.x), z = cam.rz(u.z);
    this._t += dt;

    const drop = cam.drop(x, z);
    if (u.isAir) {
      g.position.set(x, Math.max(6, u.alt) - drop, z);
      g.rotation.y = u.heading;
      // Bank into the turn — the single cheapest cue that an aircraft is flying
      // rather than sliding across a plane.
      const turnRate = (u._lastHdg === undefined) ? 0 : ((u.heading - u._lastHdg + Math.PI * 3) % (Math.PI * 2) - Math.PI) / Math.max(1e-3, dt);
      u._lastHdg = u.heading;
      const bank = THREE.MathUtils.clamp(turnRate * 5.5, -0.6, 0.6);
      g.rotation.z += (bank - g.rotation.z) * Math.min(1, dt * 2.5);
      g.rotation.x = THREE.MathUtils.clamp(-(u.ordered.alt - u.alt) * 0.0006, -0.14, 0.14);
      const spin = dt * 44;
      for (const p of this.spin) p.rotation.z += p.userData.reverse ? -spin : spin;
      if (this.rotor) this.rotor.rotation.y += dt * 34;
      if (this.tailRotor) this.tailRotor.rotation.x += dt * 52;
      if (this.rotodome) this.rotodome.rotation.y += dt * 0.63;
    } else if (u.isSub) {
      const surfaced = u.alt > -12;
      g.position.set(x, Math.min(-1.5, u.alt * 0.35) - drop, z);
      g.rotation.set(0, u.heading, 0);
      g.visible = u.alt > -55;
      if (this.model) {
        this.model.traverse(o => {
          if (o.isMesh && o.material && !o.material._subTuned) {
            o.material._subTuned = true;
            o.material.roughness = 0.85;
            o.material.metalness = 0.15;
          }
        });
      }
    } else if (!u.alive) {
      // ── sinking ──────────────────────────────────────────────────────────
      // A warship does not disappear when its hit points reach zero. It takes on
      // a list, settles by the head or the stern, and goes down over the better
      // part of a minute with the sea boiling around it. Getting this beat right
      // is most of what makes a kill land emotionally rather than numerically.
      const t = (this._sinkT = (this._sinkT || 0) + dt);
      const f = Math.min(1, t / 42);
      const wy = ocean ? ocean.getHeightAt(x, z, elapsed) : 0;
      g.position.set(x, wy * 0.9 - Math.pow(f, 2.1) * (u.cls.mastHeight || 25) * 2.4 - drop, z);
      g.rotation.set(
        (this._sinkPitch ?? (this._sinkPitch = (Math.random() - 0.5) * 0.9)) * f,
        u.heading,
        (this._sinkRoll ?? (this._sinkRoll = (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 0.7))) * Math.pow(f, 0.7),
      );
      this._fireT = (this._fireT || 0) + dt;
      if (this._fireT > 0.12 && f < 0.75 && this.fx) {
        this._fireT = 0;
        const l = (u.cls.length || 140) * 0.5;
        this.fx.hullFire(new THREE.Vector3(
          x + (Math.random() - 0.5) * l, wy + 6 + Math.random() * 10, z + (Math.random() - 0.5) * l,
        ), 1.0);
      }
      if (f >= 1) g.visible = false;
    } else {
      // Ships ride the sea. Sample the wave field fore/aft and abeam so the hull
      // pitches into swells rather than sliding along a flat plane.
      let wy = 0, pitch = 0, roll = 0;
      if (ocean) {
        const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
        const half = (u.cls.length || 140) * 0.36;
        const beam = (u.cls.beam || 18) * 0.5;
        const c = ocean.getHeightAt(x, z, elapsed);
        const f = ocean.getHeightAt(x + sh * half, z + ch * half, elapsed);
        const a = ocean.getHeightAt(x - sh * half, z - ch * half, elapsed);
        const p = ocean.getHeightAt(x - ch * beam, z + sh * beam, elapsed);
        const s = ocean.getHeightAt(x + ch * beam, z - sh * beam, elapsed);
        wy = (c + f + a) / 3;
        // Big hulls average the sea out; a corvette does not.
        const damp = THREE.MathUtils.clamp(120 / (u.cls.length || 140), 0.35, 1.4);
        pitch = Math.atan2(f - a, half * 2) * 0.55 * damp;
        roll = Math.atan2(p - s, beam * 2) * 0.85 * damp;
      }
      // Flooding puts a permanent list on the hull, and it is the first thing a
      // player notices about a damaged ship without reading a single number.
      const listing = u.damage.flooding * 0.30;
      g.position.set(x, wy * 0.92 - drop - u.damage.flooding * 1.8, z);
      g.rotation.set(pitch, u.heading, roll + listing);

      // Fire and smoke. A hit burns where it landed, so each ship gets a fixed
      // set of fire seats the first time it catches — one column amidships that
      // stays put reads as a wounded ship, whereas puffs sprayed randomly along
      // the whole waterline read as a particle emitter.
      if (u.damage.fire > 0.04 && this.fx) {
        const I = Math.min(1, u.damage.fire * 1.35);
        if (!this._fireSeats) {
          const l = (u.cls.length || 140);
          const n = 1 + Math.floor(Math.min(0.99, u.damage.fire) * 2);
          this._fireSeats = [];
          for (let i = 0; i < n; i++) {
            this._fireSeats.push({
              along: (Math.random() - 0.5) * 0.62 * l,
              beam: (Math.random() - 0.5) * (u.cls.beam || 18) * 0.45,
              h: 5 + Math.random() * 4,
              w: 0.5 + Math.random() * 0.8,
            });
          }
        }
        this._fireT = (this._fireT || 0) + dt;
        const interval = 0.30 - Math.min(0.20, I * 0.20);
        if (this._fireT > interval) {
          this._fireT = 0;
          const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
          for (const s of this._fireSeats) {
            this.fx.hullFire(_fireP.set(
              x + sh * s.along - ch * s.beam,
              wy + s.h,
              z + ch * s.along + sh * s.beam,
            ), Math.min(1, I * s.w * 1.4));
          }
        }
      }
    }

    // Contrail: only where the air is cold and dry enough for one to persist.
    if (this.contrail) {
      const on = u.alive && u.isAir && u.alt > 6200 && !u.cls.helo;
      if (on) {
        // Sample by DISTANCE FLOWN, not by wall clock. A time-based emitter lays
        // trail points a hundred metres apart at 1x and two kilometres apart at
        // 16x, which makes the trail change shape with the time-compression
        // setting — visibly wrong, and the player is the one changing it.
        const back = (u.cls.length || 30) * 0.35;
        const px = x - Math.sin(u.heading) * back;
        const pz = z - Math.cos(u.heading) * back;
        const last = this.contrail.samples[this.contrail.samples.length - 1];
        if (!last || Math.hypot(px - last.x, pz - last.z) > 220) {
          this.contrail.addSample(new THREE.Vector3(px, u.alt - cam.drop(px, pz), pz), elapsed, null);
        }
      }
      this.contrail.update(elapsed, cam.camera);
      if (!on && this.contrail.samples.length === 0) this.contrail.mesh.visible = false;
    }

    // Bow spray. Rate follows speed cubed-ish, because the amount of water a
    // stem throws goes up very fast indeed with the last few knots.
    if (this.fx && !u.isAir && !u.isSub && u.alive) {
      const spd = Math.abs(u.speedKts) / 26;
      if (spd > 0.22) {
        this._sprayT = (this._sprayT || 0) + dt;
        const iv = 0.16 - Math.min(0.11, spd * 0.10);
        if (this._sprayT > iv) {
          this._sprayT = 0;
          const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
          const fwdLen = (u.cls.length || 140) * 0.44;
          const bx = x + sh * fwdLen, bz = z + ch * fwdLen;
          const by = ocean ? ocean.getHeightAt(bx, bz, elapsed) : 0;
          this.fx.bowSpray(
            _fireP.set(bx, by - cam.drop(bx, bz), bz),
            { x: sh, z: ch }, spd, u.cls.beam || 18,
          );
        }
      }
    }

    return true;
  }

  /**
   * Battle damage, as geometry on the hull.
   *
   * A ship at a third of its hit points with a hundred-metre smoke column and no
   * mark on it anywhere is the sort of thing a reviewer screenshots. Each hit
   * leaves a blackened crater with torn plating curled out of it, placed on the
   * side the missile came from and carried by the hull, so it rolls and pitches
   * with the ship and is still there when the fire goes out.
   */
  addDamage(fromX, fromZ) {
    if (!this.model || this.disposed) return;
    const u = this.unit;
    this._scars = this._scars || [];
    if (this._scars.length > 5) return;

    // Impact point: on the hull side facing where the weapon came from, at a
    // plausible height, somewhere along the length.
    const sh = Math.sin(u.heading), ch = Math.cos(u.heading);
    const rel = { x: fromX - u.x, z: fromZ - u.z };
    const side = Math.sign(rel.x * ch - rel.z * sh) || 1;
    const along = (Math.random() - 0.45) * (u.cls.length || 140) * 0.62;
    const beam = (u.cls.beam || 18) * 0.5;
    const hy = 2.5 + Math.random() * ((u.cls.mastHeight || 26) * 0.28);

    // Placed analytically against the class's beam rather than by raycast. A
    // raycast finds the true plating, but on a tumblehome hull it also happily
    // returns an interior face, and a ten-metre decal oriented to an interior
    // normal reads as a black band painted across the whole ship. Slightly
    // inboard of maximum beam is close enough on every hull in the game.
    const g = new THREE.Group();
    g.position.set(side * beam * 0.88, hy, along);
    g.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;

    const R = 1.6 + Math.random() * 1.5;
    // The crater: a shallow blackened dish sunk into the plating.
    const hole = new THREE.Mesh(
      new THREE.SphereGeometry(R, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({
        color: 0x0b0908, roughness: 0.96, metalness: 0.12, side: THREE.DoubleSide,
      }),
    );
    hole.rotation.x = -Math.PI / 2;
    hole.scale.set(1, 0.42, 1);
    g.add(hole);

    // Scorch: a wider, softer stain around it, sooted upward by the fire.
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(R * 1.7, 18),
      new THREE.MeshBasicMaterial({
        color: 0x120e0b, transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    scorch.position.set(0, R * 0.6, 0.02);
    scorch.scale.set(1, 1.35, 1);
    g.add(scorch);

    // Torn plating curled out of the hole.
    const shard = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.85, metalness: 0.5, side: THREE.DoubleSide });
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const w = 0.5 + Math.random() * 1.1;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, R * (0.7 + Math.random() * 0.7)), shard);
      p.position.set(Math.cos(a) * R * 0.85, Math.sin(a) * R * 0.85, 0.25 + Math.random() * 0.4);
      p.rotation.set((Math.random() - 0.5) * 1.1, (Math.random() - 0.5) * 1.4, a);
      g.add(p);
    }

    this.group.add(g);
    this._scars.push(g);
    // Fires start where the holes are.
    this._fireSeats = this._fireSeats || [];
    this._fireSeats.push({ along, beam: side * beam * 0.5, h: hy + 1.5, w: 0.7 + Math.random() * 0.5 });
  }

  /** Shift the ribbon's already-recorded world samples when the origin rebases. */
  rebase(dx, dz) {
    if (this.contrail) for (const s of this.contrail.samples) { s.x -= dx; s.z -= dz; }
  }

  dispose() {
    this.disposed = true;
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      // NEVER dispose geometry that came from a prepared template: every other
      // ship of the class is drawing from the same buffers. Freeing them when
      // one hull leaves the detail bubble forced a re-upload for the whole
      // class, and combined with the rebuild cost was why ships flickered back
      // as placeholder boxes.
      if (o.isMesh && !o.userData._shared) o.geometry?.dispose?.();
    });
    this.contrail?.dispose();
  }
}
