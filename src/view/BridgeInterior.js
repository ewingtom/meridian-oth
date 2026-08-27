import * as THREE from 'three';
import { loadModel } from './UnitView.js';

/*
 * The console screens.
 *
 * They were one flat emissive cyan material shared by all three panels — three
 * identical glowing rectangles, the single most obviously procedural thing in the
 * first-person view, on the one surface the player is looking straight at.
 *
 * A warship's bridge repeats are the ship's own instruments, so these are drawn
 * from the live sim: the centre panel is a PPI scope showing the tracks the
 * player's own picture actually holds, and the outer two are the helm and sensor
 * repeats. Nothing here invents information the player does not have — a contact
 * that is not in world.picture(BLUE) does not appear on the scope, which is the
 * whole point of the game.
 *
 * All three panels share one UV region in the model, so the mesh is split by
 * triangle centroid into three and each half gets its own canvas.
 */
const SCR_W = 320, SCR_H = 240;

function makeScreenCanvas() {
  const cv = document.createElement('canvas');
  cv.width = SCR_W; cv.height = SCR_H;
  return cv;
}

function scopeRangeM(unit) {
  // Match the scope to the ship's own surface-search set, rounded to a scale a
  // real PPI would actually have.
  const r = unit?.cls?.sensors?.find(s => s.navRadar)?.refRange ?? 70000;
  const scales = [9260, 18520, 37040, 74080, 148160];   // 5/10/20/40/80 nm
  return scales.find(s => s >= r * 0.55) ?? scales[scales.length - 1];
}

function drawScope(cx, world, unit, t) {
  cx.fillStyle = '#03120e'; cx.fillRect(0, 0, SCR_W, SCR_H);
  const cxx = SCR_W * 0.5, cyy = SCR_H * 0.5, R = Math.min(cxx, cyy) - 8;
  const range = scopeRangeM(unit);

  cx.strokeStyle = 'rgba(60,255,170,0.22)'; cx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    cx.beginPath(); cx.arc(cxx, cyy, R * i / 4, 0, Math.PI * 2); cx.stroke();
  }
  cx.beginPath();
  for (let a = 0; a < 12; a++) {
    const th = a * Math.PI / 6;
    cx.moveTo(cxx + Math.sin(th) * R * 0.12, cyy - Math.cos(th) * R * 0.12);
    cx.lineTo(cxx + Math.sin(th) * R, cyy - Math.cos(th) * R);
  }
  cx.strokeStyle = 'rgba(60,255,170,0.10)'; cx.stroke();

  // Sweep, with a decaying tail — the thing that makes a scope read as live.
  const sweep = (t * 0.9) % (Math.PI * 2);
  for (let i = 0; i < 26; i++) {
    const a = sweep - i * 0.035;
    cx.strokeStyle = `rgba(90,255,190,${0.22 * (1 - i / 26)})`;
    cx.beginPath(); cx.moveTo(cxx, cyy);
    cx.lineTo(cxx + Math.sin(a) * R, cyy - Math.cos(a) * R); cx.stroke();
  }

  // Own ship, head-up: the scope rotates with the ship the way a real one does.
  const hdg = unit?.heading ?? 0;
  const table = world.picture?.(unit?.side);
  if (table) {
    for (const tr of table.list) {
      if (tr.faded || tr.own) continue;
      const dx = tr.x - unit.x, dz = tr.z - unit.z;
      const rel = Math.atan2(dx, dz) - hdg;
      const d = Math.hypot(dx, dz);
      if (d > range) continue;
      const px = cxx + Math.sin(rel) * (d / range) * R;
      const py = cyy - Math.cos(rel) * (d / range) * R;
      const col = tr.identity === 'HOSTILE' ? '#ff5a4a'
        : tr.identity === 'FRIEND' ? '#6ec8ff'
        : tr.identity === 'NEUTRAL' ? '#8bffa6' : '#ffd75a';
      // Paint brightness follows how recently the sweep passed the contact.
      const dAng = ((sweep - rel) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const fresh = Math.max(0.25, 1 - dAng / (Math.PI * 2));
      cx.globalAlpha = fresh;
      cx.fillStyle = col;
      cx.beginPath(); cx.arc(px, py, tr.identity === 'HOSTILE' ? 3.2 : 2.4, 0, Math.PI * 2);
      cx.fill();
      cx.globalAlpha = 1;
    }
  }
  cx.fillStyle = '#dfffe9';
  cx.beginPath(); cx.moveTo(cxx, cyy - 5); cx.lineTo(cxx - 3.5, cyy + 4);
  cx.lineTo(cxx + 3.5, cyy + 4); cx.closePath(); cx.fill();

  cx.font = '10px ui-monospace, monospace'; cx.fillStyle = 'rgba(120,255,200,0.8)';
  cx.textAlign = 'left';
  cx.fillText(`${(range / 1852).toFixed(0)} NM`, 6, 14);
  cx.textAlign = 'right';
  cx.fillText('SPS-67  REL', SCR_W - 6, 14);
}

function drawHelm(cx, world, unit) {
  cx.fillStyle = '#07100f'; cx.fillRect(0, 0, SCR_W, SCR_H);
  const R2D = 180 / Math.PI;
  const hdg = ((unit?.heading ?? 0) * R2D + 360) % 360;
  const ord = ((unit?.ordered?.heading ?? 0) * R2D + 360) % 360;
  cx.font = '600 13px ui-monospace, monospace';
  cx.fillStyle = 'rgba(150,255,210,0.55)'; cx.textAlign = 'left';
  cx.fillText('HELM REPEAT', 8, 18);

  cx.font = '600 44px ui-monospace, monospace';
  cx.fillStyle = '#9effd0'; cx.textAlign = 'center';
  cx.fillText(`${String(Math.round(hdg)).padStart(3, '0')}`, SCR_W * 0.5, 74);
  cx.font = '11px ui-monospace, monospace';
  cx.fillStyle = 'rgba(150,255,210,0.5)';
  cx.fillText(`ORDERED ${String(Math.round(ord)).padStart(3, '0')}`, SCR_W * 0.5, 92);

  // A compass ribbon under the numerals, so the heading reads as motion.
  const y = 118, span = 60;
  cx.strokeStyle = 'rgba(120,255,200,0.25)';
  cx.beginPath(); cx.moveTo(10, y + 14); cx.lineTo(SCR_W - 10, y + 14); cx.stroke();
  cx.font = '10px ui-monospace, monospace';
  for (let d = -span; d <= span; d += 10) {
    const b = ((Math.round(hdg / 10) * 10 + d) + 360) % 360;
    const px = SCR_W * 0.5 + (d - (hdg - Math.round(hdg / 10) * 10)) * (SCR_W * 0.5 / span);
    if (px < 8 || px > SCR_W - 8) continue;
    const major = b % 30 === 0;
    cx.strokeStyle = `rgba(120,255,200,${major ? 0.55 : 0.25})`;
    cx.beginPath(); cx.moveTo(px, y + 14); cx.lineTo(px, y + (major ? 4 : 9)); cx.stroke();
    if (major) {
      cx.fillStyle = 'rgba(150,255,210,0.65)'; cx.textAlign = 'center';
      cx.fillText(String(b).padStart(3, '0'), px, y);
    }
  }
  cx.fillStyle = '#dfffe9';
  cx.beginPath(); cx.moveTo(SCR_W * 0.5, y + 18); cx.lineTo(SCR_W * 0.5 - 4, y + 26);
  cx.lineTo(SCR_W * 0.5 + 4, y + 26); cx.closePath(); cx.fill();

  const kts = unit?.speedKts ?? 0;
  const oKts = (unit?.ordered?.speed ?? 0) / (1852 / 3600);
  cx.textAlign = 'left'; cx.font = '600 12px ui-monospace, monospace';
  cx.fillStyle = 'rgba(150,255,210,0.55)';
  cx.fillText('LOG', 12, 168);
  cx.font = '600 30px ui-monospace, monospace'; cx.fillStyle = '#9effd0';
  cx.fillText(`${kts.toFixed(1)}`, 12, 198);
  cx.font = '11px ui-monospace, monospace'; cx.fillStyle = 'rgba(150,255,210,0.5)';
  cx.fillText(`KTS  ORD ${oKts.toFixed(0)}`, 12, 214);

  // Rudder: the difference between ordered and actual, which is what the
  // helmsman is actually holding on.
  let err = ord - hdg; while (err > 180) err -= 360; while (err < -180) err += 360;
  const rud = Math.max(-1, Math.min(1, err / 25));
  const bx = SCR_W - 118, bw = 104, by = 176;
  cx.strokeStyle = 'rgba(120,255,200,0.3)'; cx.strokeRect(bx, by, bw, 14);
  cx.fillStyle = rud < 0 ? '#ffc85a' : '#5affc8';
  cx.fillRect(bx + bw * 0.5, by + 1, rud * bw * 0.5, 12);
  cx.strokeStyle = 'rgba(200,255,235,0.7)';
  cx.beginPath(); cx.moveTo(bx + bw * 0.5, by); cx.lineTo(bx + bw * 0.5, by + 14); cx.stroke();
  cx.font = '10px ui-monospace, monospace'; cx.fillStyle = 'rgba(150,255,210,0.55)';
  cx.textAlign = 'center';
  cx.fillText(`RUDDER ${Math.abs(err) < 1 ? 'AMIDSHIPS' : (err < 0 ? 'PORT' : 'STBD')}`,
    bx + bw * 0.5, by + 28);
}

function drawSensors(cx, world, unit, t) {
  cx.fillStyle = '#0d0b06'; cx.fillRect(0, 0, SCR_W, SCR_H);
  cx.font = '600 13px ui-monospace, monospace';
  cx.fillStyle = 'rgba(255,205,120,0.55)'; cx.textAlign = 'left';
  cx.fillText('SENSOR / EMCON', 8, 18);

  const em = unit?.ordered?.emcon ?? '—';
  cx.font = '600 26px ui-monospace, monospace';
  cx.fillStyle = em === 'SILENT' ? '#7ad0ff' : em === 'ACTIVE' ? '#ff8b5a' : '#ffcd78';
  cx.fillText(String(em), 10, 50);

  const sensors = unit?.cls?.sensors ?? [];
  cx.font = '11px ui-monospace, monospace';
  let y = 76;
  for (const s of sensors.slice(0, 5)) {
    const radiating = s.emits && em === 'ACTIVE';
    cx.fillStyle = radiating ? '#ff8b5a' : 'rgba(255,205,120,0.45)';
    cx.fillText(radiating ? '●' : '○', 10, y);
    cx.fillStyle = 'rgba(255,225,175,0.8)';
    cx.fillText(String(s.id || s.type).slice(0, 16), 26, y);
    cx.fillStyle = 'rgba(255,205,120,0.45)'; cx.textAlign = 'right';
    cx.fillText(radiating ? 'RAD' : 'STBY', SCR_W - 12, y);
    cx.textAlign = 'left';
    y += 17;
  }

  const table = world.picture?.(unit?.side);
  let hostile = 0, unk = 0, total = 0;
  if (table) for (const tr of table.list) {
    if (tr.faded || tr.own) continue;
    total++;
    if (tr.identity === 'HOSTILE') hostile++;
    else if (tr.identity === 'UNKNOWN' || tr.identity === 'PENDING') unk++;
  }
  cx.strokeStyle = 'rgba(255,205,120,0.25)';
  cx.beginPath(); cx.moveTo(8, 174); cx.lineTo(SCR_W - 8, 174); cx.stroke();
  cx.font = '600 12px ui-monospace, monospace';
  cx.fillStyle = 'rgba(255,205,120,0.5)';
  cx.fillText('TRACKS HELD', 10, 194);
  cx.font = '600 22px ui-monospace, monospace';
  cx.fillStyle = '#ffe1af'; cx.fillText(String(total), 10, 220);
  cx.font = '11px ui-monospace, monospace';
  cx.fillStyle = hostile ? '#ff5a4a' : 'rgba(255,205,120,0.45)';
  cx.fillText(`${hostile} HOSTILE`, 62, 208);
  cx.fillStyle = 'rgba(255,205,120,0.6)';
  cx.fillText(`${unk} UNKNOWN`, 62, 222);

  // A threat warning is a border, not a wash. Filling the whole panel — even at
  // 0.16 — turns into a solid red rectangle once the emissive map is at 1.25 and
  // the bloom pass gets hold of it, and the panel stops being a display at all.
  if (hostile > 0) {
    const pulse = 0.45 + 0.55 * Math.max(0, Math.sin(t * 4));
    cx.strokeStyle = `rgba(255,70,60,${(0.85 * pulse).toFixed(3)})`;
    cx.lineWidth = 6;
    cx.strokeRect(3, 3, SCR_W - 6, SCR_H - 6);
  }
}


/*
 * The wheelhouse.
 *
 * "Take the bridge" has been a headline feature and a key on the controls screen
 * since the beginning of this project, and there has never been a bridge. The
 * camera was placed on the open starboard bridge WING — outdoors, outboard of
 * the superstructure — because putting it anywhere near the centreline filled
 * the screen with the outside of the deckhouse. Two authored assets,
 * bridge_console.glb and bridge_chair.glb, shipped in the build and were
 * referenced by nothing at all.
 *
 * A wheelhouse is a shallow, wide box with a continuous band of forward-raked
 * windows, a console under them, chairs behind, and a dark interior — dark on
 * purpose, because a lit wheelhouse blinds the watch and every warship runs hers
 * black at night. Rendering the interior dark also does the honest thing to the
 * eye: it frames the sea in a bright band and makes the horizon the subject.
 *
 * Two things here were learned the hard way and are the whole reason this works:
 *
 *  1. The room hangs FORWARD of the deckhouse face, not centred on the bridge
 *     station. UnitView measures eye.fwd as three metres forward of the
 *     furthest-forward point of the superstructure; centring the room there puts
 *     the camera a couple of metres back inside the ship's own hull mesh, and
 *     what you see is its backfaces — a black screen.
 *  2. The eye height must NOT have wave motion added to it. The room is parented
 *     to the ship's view, so it already carries whatever vertical motion that
 *     view has; adding the wave term on top lifted the eye a further metre and
 *     jammed it into the deckhead, which also renders as a black screen.
 */

const W_FRAC = 0.62;      // wheelhouse width as a fraction of beam
const DEPTH = 4.6;        // fore-and-aft, metres
const HEIGHT = 2.9;       // deck to deckhead, metres

function makeShell(width) {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({
    color: 0x14181c, roughness: 0.72, metalness: 0.08, side: THREE.DoubleSide,
  });
  const trim = new THREE.MeshStandardMaterial({ color: 0x0c0f12, roughness: 0.55, metalness: 0.20 });

  const deck = new THREE.Mesh(new THREE.BoxGeometry(width, 0.12, DEPTH), dark);
  deck.position.y = -1.35; g.add(deck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(width, 0.12, DEPTH), dark);
  head.position.y = HEIGHT - 1.35; g.add(head);
  for (const s of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.12, HEIGHT, DEPTH), dark);
    wall.position.set(s * width * 0.5, HEIGHT * 0.5 - 1.35, 0);
    g.add(wall);
  }
  const aft = new THREE.Mesh(new THREE.BoxGeometry(width, HEIGHT, 0.12), dark);
  aft.position.set(0, HEIGHT * 0.5 - 1.35, -DEPTH * 0.5); g.add(aft);

  // Window mullions. A warship's bridge windows rake FORWARD at the top, which
  // throws reflections of the instruments down rather than into the watch's
  // eyes, so the uprights lean. The glass itself is not drawn — nothing should
  // stand between the player and the sea.
  // A BRIDGE WINDOW IS BIG, AND YOU STAND AT IT.
  //
  // The first version put a 1.3 m window 3.4 m ahead of the eye. At a 62 degree
  // field of view that subtends a letterbox slot in the middle of the frame, and
  // the rest is deckhead and bulkhead — an art review measured the whole room
  // contributing 0.02% of the pixels, which is what a dark box with a slot in it
  // looks like. A real wheelhouse window runs from below waist height to above
  // the head, and the officer of the deck stands AT it, not three metres back.
  const sillY = -0.55, headY = HEIGHT - 0.75, rake = 0.22;
  const n = Math.max(4, Math.round(width / 1.6));
  for (let i = 0; i <= n; i++) {
    const x = -width * 0.5 + (i / n) * width;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, headY - sillY, 0.09), trim);
    post.position.set(x, (sillY + headY) * 0.5, DEPTH * 0.5 - rake * 0.5);
    post.rotation.x = -Math.atan2(rake, headY - sillY);
    g.add(post);
  }
  const sill = new THREE.Mesh(new THREE.BoxGeometry(width, 0.14, 0.22), trim);
  sill.position.set(0, sillY, DEPTH * 0.5); g.add(sill);
  const header = new THREE.Mesh(new THREE.BoxGeometry(width, 0.20, 0.22), trim);
  header.position.set(0, headY, DEPTH * 0.5 - rake); g.add(header);
  return g;
}

export class BridgeInterior {
  constructor(unit, parent, eye) {
    this.unit = unit;
    this.group = new THREE.Group();
    this.group.visible = false;
    parent.add(this.group);

    const beam = unit.cls?.beam || 18;
    const width = Math.max(6, beam * W_FRAC);
    this.width = width;

    // Forward of the deckhouse face — see note 1 above.
    this.group.position.set(0, (eye?.h ?? 20), (eye?.fwd ?? 20) + DEPTH * 0.5);
    this.group.add(makeShell(width));

    loadModel('bridge_console').then((src) => {
      const c = src.clone(true);
      // SIZE IT SO YOU CAN SEE OVER IT.
      //
      // Scaled to 82% of an eleven-metre room this is a nine-metre wall, and
      // with the eye standing at the window it sat directly in front of the
      // player's face — the frame went completely black. A bridge console is
      // chest height and you look over it at the sea. Scale to a fixed HEIGHT,
      // not to the room's width, and cap it below eye level.
      const size = new THREE.Vector3(); new THREE.Box3().setFromObject(c).getSize(size);
      const CONSOLE_H = 1.05;                      // chest height above the deck
      if (size.y > 0.01) c.scale.setScalar(CONSOLE_H / size.y);
      const b2 = new THREE.Box3().setFromObject(c);
      c.position.y = -1.35 - b2.min.y;             // stand it on the deck
      c.position.z = DEPTH * 0.5 - 0.50;           // hard up under the window sill
      c.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      // Centre it on its own bounding box, not on its origin. The model's origin
      // sits off to one side, so a console placed at x = 0 hung in the right of
      // the frame with the helm out of reach of the man supposedly conning.
      const b3 = new THREE.Box3().setFromObject(c);
      c.position.x -= (b3.min.x + b3.max.x) * 0.5;
      this.group.add(c);
      this._wireScreens(c);
    }).catch(() => { /* the room stands without it */ });

    loadModel('bridge_chair').then((src) => {
      for (const s of [-1, 1]) {
        const ch = src.clone(true);
        const size = new THREE.Vector3(); new THREE.Box3().setFromObject(ch).getSize(size);
        if (size.y > 0.01) ch.scale.setScalar(1.25 / size.y);
        const b2 = new THREE.Box3().setFromObject(ch);
        ch.position.set(s * width * 0.26, -1.35 - b2.min.y, -0.35);
        ch.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
        this.group.add(ch);
      }
    }).catch(() => { /* optional */ });

    // Instrument glow. A darkened wheelhouse is lit only by its own displays, and
    // that red wash on the deckhead is most of what makes the room feel like a
    // warship's bridge rather than a shed.
    // Instrument glow — and it has to KNOW WHAT TIME IT IS.
    //
    // A 6.5-candela orange lamp a metre from the eye is right at night, when a
    // wheelhouse is darkened and lit only by its own displays. At midday it is a
    // sunlamp: an art review found it burning under a 58-degree sun and turning
    // the console salmon. Displays dim in daylight because they have to compete
    // with the sun; these now do the same, via setDaylight below.
    // Behind and above the watchkeeper, not in the console's face. At
    // z = DEPTH/2 - 1.1 this sat 0.35 m off the panel faces, and inverse-square
    // falloff at that range put a bright orange pool straight across the three
    // repeats — which, once they had real displays on them, was the first thing
    // you saw instead of the displays.
    this.glow = new THREE.PointLight(0xff6a3a, 6.5, 7, 2);
    this.glow.position.set(0, HEIGHT - 1.75, -0.2);
    this.group.add(this.glow);
    this.chartLamp = new THREE.PointLight(0x4a86c4, 3.0, 6, 2);
    this.chartLamp.position.set(-width * 0.28, -0.3, -0.6);
    this.group.add(this.chartLamp);

    /*
     * Daylight coming in through the windows.
     *
     * The room was lit by its own two instrument lamps and nothing else, and both
     * correctly dim to almost nothing in daylight — so in daylight the interior
     * had no light source at all. A review measured 55.3 percent of the bridge
     * frame below luminance 3: over half the picture crushed to black while the
     * sea outside the glass sat at 150.
     *
     * A wheelhouse in daylight is lit by the sea and sky through a continuous
     * band of window, which is a large soft source in front of and below the eye.
     * A hemisphere standing in for it is the cheap, stable way to say that: sky
     * colour from above, a dimmer bounce off the deck below, and it goes out with
     * the sun rather than with the instrument lamps.
     */
    this.dayFill = new THREE.HemisphereLight(0xa8c4dc, 0x30363c, 0.0);
    this.dayFill.position.set(0, HEIGHT * 0.5, DEPTH * 0.5);
    this.group.add(this.dayFill);
  }

  /**
   * Eye position in the unit's local frame: standing at the console, a metre
   * inside the aft bulkhead, looking out through the window band.
   */
  /*
   * The conning position, set once from the geometry.
   *
   * Across four rounds this view has gone dark, then console-filling-the-frame,
   * then a black void, then lit-but-console-filling-the-frame again, because the
   * eye kept being nudged to fix whichever symptom was showing. So state it as
   * dimensions and stop moving it:
   *
   *   deck            group.y - 1.35
   *   console top     1.05 m above the deck        = group.y - 0.30
   *   eye             1.55 m above the deck        = group.y + 0.20
   *   glass           group.z + DEPTH * 0.5
   *   eye             1.40 m inside the glass      = group.z + DEPTH * 0.5 - 1.4
   *   console face    0.50 m inside the glass      (set where it is built)
   *
   * Which puts the eye 0.90 m abaft the console and 0.50 m above its top, so the
   * console's top edge falls about 29 degrees below the horizontal against a 62
   * degree vertical field — the bottom sliver of the frame, and the horizon at
   * eye level where a watchkeeper expects it.
   */
  eyeLocal() {
    return new THREE.Vector3(0, this.group.position.y + 0.20,
      this.group.position.z + DEPTH * 0.5 - 1.4);
  }

  /*
   * Split the screen mesh into three panels and give each its own display.
   *
   * All three share one material and one UV region in the model, so a single
   * texture would show the same picture on all three. Split by triangle centroid
   * x into left / centre / right and hand each half its own canvas.
   */
  _wireScreens(console3) {
    let mesh = null;
    console3.traverse(o => {
      if (o.isMesh && /Console_Screen/i.test(o.name || o.material?.name || '')) mesh = o;
    });
    if (!mesh) return;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const tri = [];
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3;
      const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const cc = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      tri.push({ a, b, cc, x: (pos.getX(a) + pos.getX(b) + pos.getX(cc)) / 3 });
    }
    const xs = tri.map(t => t.x).sort((p, q) => p - q);
    const q1 = xs[Math.floor(xs.length / 3)], q2 = xs[Math.floor(xs.length * 2 / 3)];
    const buckets = [[], [], []];
    for (const t of tri) buckets[t.x < q1 ? 0 : t.x < q2 ? 1 : 2].push(t);

    this.screens = [];
    const drawers = [drawHelm, drawScope, drawSensors];
    for (let i = 0; i < 3; i++) {
      if (!buckets[i].length) continue;
      const sub = g.clone();
      sub.setIndex(buckets[i].flatMap(t => [t.a, t.b, t.cc]));
      const cv = makeScreenCanvas();
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      // The panel's UVs run the other way, so a canvas laid on it straight comes
      // out rotated a half turn — the helm repeat read 330 as 0EE. Turn the
      // texture rather than the artwork, so the drawing code stays readable.
      tex.flipY = false;
      tex.center.set(0.5, 0.5);
      tex.rotation = Math.PI;
      // Matte. A CRT or an LCD under a bonded anti-glare filter is not a mirror,
      // and at 0.35 the panels caught a specular hotspot that drowned the trace.
      const mat = new THREE.MeshStandardMaterial({
        color: 0x000000, roughness: 0.86, metalness: 0.0,
        emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.25,
      });
      const m = new THREE.Mesh(sub, mat);
      m.castShadow = false; m.receiveShadow = false;
      // Sibling, not child. Parented to `mesh` these inherit its visibility, and
      // `mesh` is about to be hidden — which left three black panels.
      m.position.copy(mesh.position);
      m.quaternion.copy(mesh.quaternion);
      m.scale.copy(mesh.scale);
      (mesh.parent || console3).add(m);
      this.screens.push({ cv, cx: cv.getContext('2d'), tex, draw: drawers[i] });
    }
    mesh.visible = false;                  // the original flat panel is replaced
  }

  /** Repaint the console repeats. Throttled — these are instruments, not video. */
  updateScreens(world, unit, elapsed) {
    if (!this.screens || !world || !unit) return;
    if (elapsed - (this._lastScreen ?? -9) < 0.11) return;
    this._lastScreen = elapsed;
    for (const s of this.screens) {
      s.draw(s.cx, world, unit, elapsed);
      s.tex.needsUpdate = true;
    }
  }

  setVisible(v) { this.group.visible = v; }

  /**
   * Instrument lighting against daylight. dayFactor 1 is full day, 0 is night.
   * A darkened bridge is a night condition; in daylight the displays are just
   * screens and should not light the room.
   */
  setDaylight(dayFactor) {
    const night = 1 - Math.min(1, Math.max(0, dayFactor));
    if (this.dayFill) this.dayFill.intensity = 2.6 * Math.min(1, Math.max(0, dayFactor));
    if (this.glow) this.glow.intensity = 0.35 + 6.15 * night;
    if (this.chartLamp) this.chartLamp.intensity = 0.2 + 2.8 * night;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh && !o.userData._shared) o.geometry?.dispose?.();
    });
  }
}
