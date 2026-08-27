import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CheapBloomPass } from './CheapBloomPass.js';
import { VIGNETTE_GRADE_SHADER } from './renderer.js';
import { WAVE_FIELD_R } from './ocean.js';

/*
 * The second window.
 *
 * A missile leaving the rails is the most interesting thing that happens in this
 * game and the player was watching it from six hundred kilometres up, as a
 * moving arrowhead on a chart. The alternative already in the code was worse:
 * autoMissileCam took the MAIN camera and flew it out with the round, so the
 * spectacle cost you the tactical picture at exactly the moment you needed it —
 * which is why it defaulted to off.
 *
 * So: a small inset that carries the spectacle while the plot keeps the frame.
 *
 * Three things make this harder than "render the scene again":
 *
 * THE GRADE PASS IS NOT OPTIONAL. The ocean, sky, cloud and island shaders all
 * author in display space and apply an ACES INVERSE on output, because the grade
 * pass re-applies the curve for the whole frame. Render this view without that
 * pass and every one of those surfaces comes back inverse-tone-mapped — blown
 * out and wrong. So the inset gets its own small chain: render, bloom, grade.
 * SSAO and FXAA are dropped; at this size neither is worth the pixels.
 *
 * THE SKY IS SOMEBODY ELSE'S. SkyLayerPass renders the sky at half resolution
 * for the MAIN camera and blits it back through a full-screen quad on layer 0.
 * A second camera looking somewhere else would happily draw that quad and show
 * the main view's sky behind its own subject. So the inset hides the quad and
 * renders the sky layer inline, which at this size costs nothing.
 *
 * IT ONLY RUNS WHEN THERE IS SOMETHING TO SEE. The frame is vsync-bound with
 * about two milliseconds of headroom, so a second chain running permanently
 * would cost frames. This one is live only while an event is playing, and even
 * then it renders every other frame and reuses the texture between — the subject
 * is a missile in flight, not text.
 */

const PIP_W = 512;
const PIP_H = 288;

export class PipView {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.active = false;
    this.enabled = true;

    this.camera = new THREE.PerspectiveCamera(38, PIP_W / PIP_H, 2, 6000000);
    this.camera.layers.enableAll();

    this.target = new THREE.WebGLRenderTarget(PIP_W, PIP_H, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    this.composer = new EffectComposer(this.renderer, this.target);
    this.composer.setSize(PIP_W, PIP_H);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new CheapBloomPass({ strength: 0.6, threshold: 0.82, radius: 1.0 });
    this.bloom.setSize(PIP_W, PIP_H);
    this.composer.addPass(this.bloom);
    // ShaderPass clones the uniform block, so this shares nothing with the main
    // grade pass and can be tuned independently.
    const grade = new ShaderPass(VIGNETTE_GRADE_SHADER);
    grade.uniforms.uVignetteStrength.value = 0.34;   // heavier, it reads as a monitor
    grade.uniforms.uGrainAmount.value = 0.004;
    grade.renderToScreen = false;
    this.composer.addPass(grade);
    this.grade = grade;

    // Overlay: the inset is drawn as a flat quad in its own orthographic scene
    // after the main frame, so nothing about the main pipeline has to change.
    this.overlayScene = new THREE.Scene();
    // near/far must STRADDLE zero: the quads sit at z = 0, and a near plane of 0
    // puts them exactly on it, which clips them away entirely.
    this.overlayCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -10, 10);
    // DoubleSide is not cosmetic here. The overlay camera puts y = 0 at the TOP
    // so positions can be written in screen coordinates, and that flip inverts
    // the projection's handedness — which reverses the winding of every triangle
    // and back-face-culls a front-facing quad into nothing.
    this.frameMat = new THREE.MeshBasicMaterial({
      color: 0x0a1015, transparent: true, opacity: 0.92, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.frameMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.frameMat);
    this.frameMesh.renderOrder = 0;
    this.overlayScene.add(this.frameMesh);
    this.quadMat = new THREE.MeshBasicMaterial({
      map: this.composer.readBuffer.texture, side: THREE.DoubleSide,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.quadMat);
    this.quad.renderOrder = 1;
    this.overlayScene.add(this.quad);

    this._frame = 0;
    this._opacity = 0;
    this._v2 = new THREE.Vector2();
    this._lift = 0;
    this.world = null;
    this.rect = null;
    /** CSS-pixel box the inset must stay inside. Set by the game each resize. */
    this.safeArea = null;
  }

  /**
   * The scene is laid out for ONE camera per frame and this is the price of a
   * second one.
   *
   * Two things in this renderer are functions of where the main camera is, not
   * of where anything actually is. Every hull, wake and symbol is drawn a
   * curvature drop below the flat plane — d²/2R against the MAIN camera — which
   * is what puts distant ships hull-down. And the sea, the sky dome and the
   * cloud slab are all re-centred on the main camera every frame, because they
   * are unbounded surfaces that only ever need to exist near the viewer.
   *
   * So an inset watching something 200 km from the main camera would find its
   * subject a kilometre underground, with no detailed sea beneath it and quite
   * possibly outside the sky dome altogether.
   *
   * The fix is a change of frame, not a re-layout. Lift the whole scene by the
   * drop at the subject and the subject comes back to its true altitude, along
   * with everything near it — the drop is smooth, so neighbours share it. Then
   * re-centre the four camera-anchored surfaces on the INSET camera and cancel
   * the lift on them, since they were never dropped to begin with. Now every
   * altitude in the inset is a real height above a real sea, which is what the
   * ocean and cloud shaders assume when they read uCamPos.y for optical depth.
   *
   * Restored immediately afterwards, before the main frame is drawn.
   */
  bindWorld({ scene, sky, ocean, clouds, camDirector }) {
    this.world = { scene, sky, ocean, clouds, camDirector };
  }

  /** Render-space point the shot is built around; sets this frame's lift. */
  anchor(rx, rz) {
    this._lift = this.world ? this.world.camDirector.drop(rx, rz) : 0;
  }

  _stage() {
    const w = this.world;
    if (!w) return null;
    const eye = this.camera.position;
    const followers = [w.ocean.mesh, w.ocean.skirt, w.sky.sky, w.clouds.mesh];
    const saved = {
      sceneY: w.scene.position.y,
      pos: followers.map((o) => o.position.clone()),
      camPos: w.ocean.uniforms.uCamPos.value.clone(),
      oceanVis: w.ocean.mesh.visible,
      waveR: w.ocean.skirtMat.uniforms.uWaveFieldR.value,
      shadowAuto: this.renderer.shadowMap.autoUpdate,
    };
    const lift = this._lift;
    w.scene.position.y = lift;
    for (let i = 0; i < followers.length; i++) {
      const o = followers[i];
      o.position.set(eye.x, saved.pos[i].y - lift, eye.z);
    }
    w.ocean.uniforms.uCamPos.value.copy(eye);
    // The inset always sits low over the water, so the detailed wave field is
    // always wanted here even when the main view is too high to draw it.
    w.ocean.mesh.visible = true;
    w.ocean.skirtMat.uniforms.uWaveFieldR.value = WAVE_FIELD_R * 0.985;
    // Do not re-render the shadow map for the inset. It is framed on the main
    // camera; re-framing it would cost a full shadow pass and then have to be
    // undone for the main frame.
    this.renderer.shadowMap.autoUpdate = false;
    return { saved, followers };
  }

  _unstage(st) {
    if (!st) return;
    const w = this.world;
    w.scene.position.y = st.saved.sceneY;
    for (let i = 0; i < st.followers.length; i++) st.followers[i].position.copy(st.saved.pos[i]);
    w.ocean.uniforms.uCamPos.value.copy(st.saved.camPos);
    w.ocean.mesh.visible = st.saved.oceanVis;
    w.ocean.skirtMat.uniforms.uWaveFieldR.value = st.saved.waveR;
    this.renderer.shadowMap.autoUpdate = st.saved.shadowAuto;
    w.scene.updateMatrixWorld(true);
  }

  /** Point the inset. `at` and `eye` are RENDER-space vectors. */
  look(eye, at, fov = 38) {
    this.camera.position.copy(eye);
    this.camera.lookAt(at);
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }

  /**
   * Render the inset into its own target. Must be called BEFORE the main frame
   * so the main pass is the thing that ends up bound to the canvas.
   */
  render(skyPass) {
    if (!this.active || !this.enabled) return;
    // Half rate. The subject is a missile in flight, not something being read.
    if ((this._frame++ & 1) === 1) return;

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    // The sky blit quad belongs to the main camera. Hide it and let this camera
    // draw the real sky layer instead.
    const quadWas = skyPass?.quad?.visible;
    if (skyPass?.quad) skyPass.quad.visible = false;
    this.camera.layers.enableAll();

    const st = this._stage();
    try {
      this.composer.render();
    } finally {
      this._unstage(st);
    }

    if (skyPass?.quad && quadWas !== undefined) skyPass.quad.visible = quadWas;
    r.setRenderTarget(prevTarget);
    const tex = this.composer.readBuffer.texture;
    // The grade pass already encoded sRGB, but the target is tagged linear, so a
    // MeshBasicMaterial drawing it to an sRGB canvas would encode a second time.
    // Declaring it sRGB makes the sample decode and the output re-encode, which
    // is the identity this needs.
    if (tex.colorSpace !== THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    this.quadMat.map = tex;
    this.quadMat.needsUpdate = true;
  }

  /** Composite the inset over the finished frame. */
  drawOverlay(dtOpacityTarget) {
    if (!this.enabled) return;
    const target = this.active ? 1 : 0;
    this._opacity += (target - this._opacity) * 0.16;
    if (this._opacity < 0.012) return;

    const r = this.renderer;
    r.getSize(this._v2);
    const W = this._v2.x, H = this._v2.y;
    // Inside the plot, not on top of the panels. The first version anchored to
    // the top-right corner of the FRAME, which on any real layout lands square
    // on the contact list — the one panel a player is reading while a missile
    // is inbound. The safe area is measured from the DOM; see Game._pipSafeArea.
    const sa = this.safeArea || { x: 0, y: 0, w: W, h: H };
    const w = Math.min(440, Math.max(240, sa.w * 0.34));
    const h = w * (PIP_H / PIP_W);
    const pad = 16;
    const bw = 2;

    // Slide in from the right as it fades, so it arrives rather than blinks.
    const slide = (1 - this._opacity) * w * 0.22;
    const cx = sa.x + sa.w - pad - w * 0.5 + slide;
    const cy = sa.y + sa.h - pad - h * 0.5;

    this.overlayCam.left = 0; this.overlayCam.right = W;
    this.overlayCam.top = 0; this.overlayCam.bottom = H;
    this.overlayCam.updateProjectionMatrix();

    this.frameMesh.scale.set(w + bw * 2, h + bw * 2, 1);
    this.frameMesh.position.set(cx, cy, 0);
    this.frameMat.opacity = 0.92 * this._opacity;

    // Negative height: the same y-down projection that lets these positions be
    // written in screen coordinates also mirrors the sampled texture, so the
    // quad is flipped back here rather than the whole camera being rebuilt.
    this.quad.scale.set(w, -h, 1);
    this.quad.position.set(cx, cy, 0);
    this.quadMat.opacity = this._opacity;

    // Where the DOM label goes. Same units the overlay camera works in, which
    // are CSS pixels, so the HUD can position type against it directly.
    this.rect = { x: cx - w * 0.5, y: cy - h * 0.5, w, h, opacity: this._opacity };

    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(null);
    r.render(this.overlayScene, this.overlayCam);
    r.autoClear = prevAuto;
  }

  dispose() {
    this.target.dispose();
    this.quad.geometry.dispose();
    this.frameMesh.geometry.dispose();
    this.quadMat.dispose();
    this.frameMat.dispose();
  }
}
