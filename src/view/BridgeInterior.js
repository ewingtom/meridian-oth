import * as THREE from 'three';
import { loadModel } from './UnitView.js';

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
      c.position.z = DEPTH * 0.5 - 0.75;           // tucked under the window sill
      c.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      this.group.add(c);
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
    this.glow = new THREE.PointLight(0xff6a3a, 6.5, 9, 2);
    this.glow.position.set(0, -0.55, DEPTH * 0.5 - 1.1);
    this.group.add(this.glow);
    this.chartLamp = new THREE.PointLight(0x4a86c4, 3.0, 6, 2);
    this.chartLamp.position.set(-width * 0.28, -0.3, -0.6);
    this.group.add(this.chartLamp);
  }

  /**
   * Eye position in the unit's local frame: standing at the console, a metre
   * inside the aft bulkhead, looking out through the window band.
   */
  eyeLocal() {
    // Standing AT the window — 1.4 m inside it, not 1.1 m inside the aft
    // bulkhead 3.4 m away from it.
    // 1.55 m above the deck — eye height for a standing watchkeeper, and clear
    // of a 1.05 m console — set back far enough to see the whole window band.
    return new THREE.Vector3(0, this.group.position.y + 0.20,
      this.group.position.z + DEPTH * 0.5 - 2.0);
  }

  setVisible(v) { this.group.visible = v; }

  /**
   * Instrument lighting against daylight. dayFactor 1 is full day, 0 is night.
   * A darkened bridge is a night condition; in daylight the displays are just
   * screens and should not light the room.
   */
  setDaylight(dayFactor) {
    const night = 1 - Math.min(1, Math.max(0, dayFactor));
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
