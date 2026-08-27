import * as THREE from 'three';

/*
 * Sky and clouds, rendered at half resolution.
 *
 * Profiled on the target machine at 1280x720, the cloud deck alone was 9.4 ms of
 * a 44 ms frame, and the sky dome sits behind it costing more. Both are pure
 * BACKGROUND: they are drawn behind everything, they write no depth that
 * anything else tests against, and their content is low-frequency — a raymarched
 * cloud has no edge sharper than its own soft silhouette. Shading them at full
 * resolution is spending the most expensive pixels in the frame on the least
 * detailed thing in it.
 *
 * So: render that layer once into a half-size target (a quarter of the pixels),
 * then blit it back as the frame's background before anything else draws. The
 * upsample is a plain bilinear stretch, which is exactly right for content with
 * no high-frequency detail to lose, and there is no depth interaction to get
 * wrong because nothing in this layer occludes anything.
 *
 * The sun disc is the one thing that IS high-frequency, and it survives because
 * it is a smooth radial falloff — bilinear magnification of a smooth gradient is
 * still a smooth gradient.
 */

/** Objects on this layer are drawn only into the half-res sky pass. */
export const SKY_LAYER = 2;

const BLIT_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  // Full-screen triangle-pair in clip space; no matrices involved.
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

const BLIT_FRAG = /* glsl */`
uniform sampler2D uSky;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uSky, vUv);
  // Background: never occlude, never write depth.
  gl_FragColor.a = 1.0;
}
`;

export class SkyLayerPass {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this.scale = 0.5;

    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    const geo = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: BLIT_VERT,
      fragmentShader: BLIT_FRAG,
      uniforms: { uSky: { value: this.target.texture } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;
    // Draw before everything, and stay off the sky layer so the sky pass itself
    // does not try to draw its own blit quad.
    this.quad.renderOrder = -100000;
    this.quad.layers.set(0);
    scene.add(this.quad);

    this._size = new THREE.Vector2();
  }

  setSize(w, h) {
    const tw = Math.max(2, Math.floor(w * this.scale));
    const th = Math.max(2, Math.floor(h * this.scale));
    if (this.target.width !== tw || this.target.height !== th) {
      this.target.setSize(tw, th);
    }
  }

  /**
   * Render the sky layer into the half-res target. Call immediately before the
   * main render; it leaves the render target unbound and the camera's layer mask
   * set to everything-except-sky, which is what the main pass wants.
   */
  render() {
    const r = this.renderer, cam = this.camera;
    if (!this.enabled) {
      // Fall back to drawing the sky inline with everything else.
      this.quad.visible = false;
      cam.layers.enableAll();
      return;
    }
    this.quad.visible = true;

    r.getDrawingBufferSize(this._size);
    this.setSize(this._size.x, this._size.y);

    const prevTarget = r.getRenderTarget();
    const prevMask = cam.layers.mask;

    // Pass 1: ONLY the sky layer, at half size.
    cam.layers.set(SKY_LAYER);
    this.quad.visible = false;                  // never blit into its own source
    r.setRenderTarget(this.target);
    r.clear(true, true, true);
    r.render(this.scene, cam);
    r.setRenderTarget(prevTarget);

    // Hand the main pass everything EXCEPT the sky layer; the blit quad carries it.
    this.quad.visible = true;
    cam.layers.mask = prevMask;
    cam.layers.disable(SKY_LAYER);
  }

  /** Restore the camera mask after the main render. */
  restore() {
    this.camera.layers.enable(SKY_LAYER);
  }

  dispose() {
    this.quad.parent?.remove(this.quad);
    this.quad.geometry.dispose();
    this.material.dispose();
    this.target.dispose();
  }
}
