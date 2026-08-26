import * as THREE from 'three';

/*
 * The cloud field, baked once into a texture.
 *
 * The cloud shape is built from a domain-warped fractal: four five-octave value
 * noise stacks plus a billow fold, twenty-four lattice lookups, ninety-six hash
 * evaluations. That is a reasonable way to author a cloud and a catastrophic way
 * to SAMPLE one — the raymarch asks for it eight to ten times per pixel, over a
 * full screen, sixty times a second. Measured on the fleet-level view, where the
 * deck fills the frame, it was 224 ms of a 232 ms frame: the entire cost of the
 * game, in one function.
 *
 * The field does not depend on time, on the camera, or on coverage. It is a
 * fixed function of horizontal position. So it is baked once, on the GPU, into a
 * two-channel texture — red is the density field, green is the low-frequency
 * coverage modulation — and every later lookup is a single bilinear fetch.
 *
 * The bake uses a WRAPPED lattice so the result tiles seamlessly, which means
 * the sampler can repeat it forever. That requires the octave frequencies to be
 * integer multiples of the tile, so the ratios here are powers of two rather
 * than the irrational values used when the field was evaluated analytically.
 * Irrational ratios exist to stop octaves reinforcing into visible axis-aligned
 * structure; the domain warp, which is itself two octaves of the same noise,
 * already breaks that up.
 */

/** Tile span in cloud-field UV units. uv = metres * 0.00026, so 16 ≈ 61 km. */
export const CLOUD_TILE = 16.0;

const BAKE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTile;

/* Value noise on a lattice that WRAPS at the given period, so the bake tiles. */
float bHash(vec2 i, float period) {
  i = mod(i, vec2(period));
  vec2 p = fract(i * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float bNoise(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  float a = bHash(i, period), b = bHash(i + vec2(1.0, 0.0), period);
  float c = bHash(i + vec2(0.0, 1.0), period), d = bHash(i + vec2(1.0, 1.0), period);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
/* Five octaves, frequency doubling, each wrapping at its own multiple. */
float bFbm(vec2 p, float period) {
  float v = 0.0, amp = 0.5, norm = 0.0, per = period;
  for (int i = 0; i < 5; i++) {
    v += amp * bNoise(p, per);
    norm += amp;
    p = p * 2.0 + vec2(3.1, 1.7);
    per *= 2.0;
    amp *= 0.52;
  }
  return v / norm * 0.97;
}
float bBillow(vec2 p, float period) {
  float v = 0.0, amp = 0.5, norm = 0.0, per = period;
  for (int i = 0; i < 4; i++) {
    v += amp * (1.0 - abs(bNoise(p, per) * 2.0 - 1.0));
    norm += amp;
    p = p * 2.0 + vec2(1.3, 5.9);
    per *= 2.0;
    amp *= 0.5;
  }
  return v / norm;
}

void main() {
  vec2 uv = vUv * uTile;

  // Low-frequency coverage modulation: which parts of the sky are cloudier.
  float cover = bFbm(uv * 0.125, uTile * 0.125);

  // Domain warp, then the billowed cumulus body. Same construction as the
  // analytic field, at power-of-two frequencies so every octave wraps.
  vec2 w = vec2(bFbm(uv * 0.5 + 11.5, uTile * 0.5),
                bFbm(uv * 0.5 + 27.1, uTile * 0.5));
  vec2 uw = uv + (w - 0.5) * 2.9;
  float base = mix(bFbm(uw, uTile), bBillow(uw * 1.5, uTile * 1.5), 0.45);

  gl_FragColor = vec4(base, cover, 0.0, 1.0);
}
`;

const BAKE_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * Render the field once and return the texture. Costs a single 1024² draw at
 * startup and nothing thereafter.
 */
export function bakeCloudField(renderer, size = 1024) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.RawShaderMaterial({
    vertexShader: `precision highp float;
      attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: BAKE_FRAG,
    uniforms: { uTile: { value: CLOUD_TILE } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  scene.add(quad);

  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);

  quad.geometry.dispose();
  mat.dispose();

  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.wrapT = THREE.RepeatWrapping;

  // Build the mip chain by hand.
  //
  // A minifying filter with no mip levels behind it samples undefined data, and
  // this field is minified hard: at a grazing angle through the deck one screen
  // pixel spans kilometres of cloud, so the sampler drops several levels down
  // immediately. Without the chain that came back as per-pixel garbage and the
  // whole deck rendered as a stipple of white dots. Render targets do not always
  // get their mipmaps generated for us, so do it explicitly.
  const gl = renderer.getContext();
  const glTex = renderer.properties.get(rt.texture).__webglTexture;
  if (glTex) {
    const prevBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, prevBinding);
  }
  return rt.texture;
}
