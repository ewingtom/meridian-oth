import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/*
 * Bloom, at a price bloom is worth paying.
 *
 * Profiled at 1280x720 on the target machine, UnrealBloomPass was 20.6 ms of a
 * 35.7 ms frame — fifty-eight percent of the entire frame, for a soft glow around
 * the sun and the explosions. It builds a five-level mip pyramid and runs a
 * thirteen-tap separable blur at every level, on half-float targets, and on this
 * GPU that lands on a slow path badly enough to dominate everything else the
 * renderer does. Its own reported resolution had also drifted to 298x338, which
 * is not even the aspect of the frame.
 *
 * Bloom is a low-frequency effect. It does not need a mip pyramid and it does
 * not need to be computed at anything like display resolution. This does the
 * whole thing in four small passes:
 *
 *   1. bright-pass and downsample to a quarter of each axis (a sixteenth of the
 *      pixels), taking four bilinear taps so the downsample itself does some of
 *      the blurring for free;
 *   2. a nine-tap horizontal blur at that size;
 *   3. the same vertically;
 *   4. add it back over the frame.
 *
 * The result is visually the same class of effect — the sun blooms, hot pixels
 * bleed — for a small fraction of the cost.
 */

const THRESH_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
varying vec2 vUv;
void main() {
  // Four bilinear taps half a source-texel apart: a cheap box downsample that
  // already carries some of the blur.
  vec3 c = texture2D(tDiffuse, vUv + uTexel * vec2(-0.5, -0.5)).rgb
         + texture2D(tDiffuse, vUv + uTexel * vec2( 0.5, -0.5)).rgb
         + texture2D(tDiffuse, vUv + uTexel * vec2(-0.5,  0.5)).rgb
         + texture2D(tDiffuse, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  // Soft knee so the bloom fades in around the threshold instead of switching
  // on at it, which is what makes a hard-thresholded bloom crawl and flicker.
  float k = uSoftKnee * uThreshold + 1e-5;
  float soft = clamp(l - uThreshold + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k);
  float w = max(soft, l - uThreshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uDir;          // texel-sized step along the blur axis
varying vec2 vUv;
void main() {
  // Nine taps on a gaussian, using the linear-sampling trick: five fetches cover
  // nine taps because each interior fetch sits between two texels.
  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  c += texture2D(tDiffuse, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tDiffuse, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tDiffuse, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tDiffuse, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  gl_FragColor = vec4(base.rgb + bloom * uStrength, base.a);
}
`;

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// Eight-bit, not half float. The bright pass has already thresholded and scaled
// the values, so what reaches these targets is a low-dynamic-range glow map —
// and on this GPU half-float render targets are markedly slower to blend and
// filter. Bloom is the last place in the pipeline that needs HDR precision.
const rt = (w, h) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.UnsignedByteType,
  depthBuffer: false,
  stencilBuffer: false,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
});

export class CheapBloomPass extends Pass {
  constructor({ strength = 0.55, threshold = 0.82, radius = 1.0 } = {}) {
    super();
    this.strength = strength;
    this.threshold = threshold;
    this.radius = radius;
    this._w = 2; this._h = 2;

    this.rtA = rt(2, 2);
    this.rtB = rt(2, 2);

    this.matThresh = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: threshold },
        uSoftKnee: { value: 0.6 },
      },
      vertexShader: VERT, fragmentShader: THRESH_FRAG, depthTest: false, depthWrite: false,
    });
    this.matBlur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
    });
    this.matComp = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, uStrength: { value: strength } },
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.matThresh);
  }

  setSize(w, h) {
    // A quarter of each axis: a sixteenth of the pixels. Bloom has no detail to
    // lose at this scale — that is the entire point of it.
    this._w = Math.max(2, Math.floor(w * 0.25));
    this._h = Math.max(2, Math.floor(h * 0.25));
    this.rtA.setSize(this._w, this._h);
    this.rtB.setSize(this._w, this._h);
    this.matThresh.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }

  render(renderer, writeBuffer, readBuffer) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1. bright-pass + downsample
    this.matThresh.uniforms.tDiffuse.value = readBuffer.texture;
    this.matThresh.uniforms.uThreshold.value = this.threshold;
    this.quad.material = this.matThresh;
    renderer.setRenderTarget(this.rtA);
    renderer.clear();
    this.quad.render(renderer);

    // 2-3. separable blur
    this.quad.material = this.matBlur;
    this.matBlur.uniforms.tDiffuse.value = this.rtA.texture;
    this.matBlur.uniforms.uDir.value.set(this.radius / this._w, 0);
    renderer.setRenderTarget(this.rtB);
    renderer.clear();
    this.quad.render(renderer);

    this.matBlur.uniforms.tDiffuse.value = this.rtB.texture;
    this.matBlur.uniforms.uDir.value.set(0, this.radius / this._h);
    renderer.setRenderTarget(this.rtA);
    renderer.clear();
    this.quad.render(renderer);

    // 4. composite
    this.matComp.uniforms.tDiffuse.value = readBuffer.texture;
    this.matComp.uniforms.tBloom.value = this.rtA.texture;
    this.matComp.uniforms.uStrength.value = this.strength;
    this.quad.material = this.matComp;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.matThresh.dispose(); this.matBlur.dispose(); this.matComp.dispose();
    this.quad.dispose();
  }
}
