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
    // HALF FLOAT, not 8-bit.
    //
    // The raymarch thresholds this field — smoothstep(t-0.06, t+0.30, density) —
    // and a threshold AMPLIFIES quantisation. At 8 bits the density has 256
    // levels, so a threshold window a third of the range wide resolves to about
    // ninety, and every one of them draws a contour line where neighbouring
    // texels cross it. Integrated over sixteen march steps that reads as the
    // cloud SHAPE being terraced, which is exactly what an art review found in
    // all ninety-three of its sky frames — correctly noting that the sky held
    // 11,269 unique colours, so the problem was never colour banding.
    //
    // Sixteen-bit float has no visible steps left to amplify. Two channels
    // instead of four keeps a 2048-square bake at 16 MB.
    format: THREE.RGFormat,
    type: THREE.HalfFloatType,
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


/*
 * The SEA's noise field, baked the same way and for the same reason.
 *
 * The ocean shader calls fbm() fourteen times and noise() three times per water
 * pixel, and the ocean is most of the screen. Measured with GPU timer queries it
 * was 27.7 ms of a 50 ms frame — the most expensive thing left in the game once
 * the clouds became a texture lookup.
 *
 * Every one of those calls has the form fbm(worldXZ * scale + time * drift).
 * Adding a time term is a TRANSLATION of the sample domain, and a translation of
 * the domain is exactly what scrolling a texture lookup does — so the animation
 * survives the bake untouched. Only the field itself is precomputed.
 *
 * R holds the three-octave fbm the shader's fbm() produced; G holds the single
 * octave its noise() produced. Both wrap, so the sampler can repeat forever.
 */
export const SEA_TILE = 8.0;

const SEA_BAKE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTile;

/* The ocean's own hash, with the lattice wrapped so the bake tiles. */
float sHash(vec2 p, float period) {
  p = mod(p, vec2(period));
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float sNoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = sHash(i, period);
  float b = sHash(i + vec2(1.0, 0.0), period);
  float c = sHash(i + vec2(0.0, 1.0), period);
  float d = sHash(i + vec2(1.0, 1.0), period);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
/*
 * Three octaves, matching the shader's fbm(). The octave ratio was 2.02 there —
 * irrational on purpose, to stop octaves reinforcing into axis-aligned
 * structure. A tiling bake cannot have that: every octave has to close on the
 * tile boundary, so the ratio must be exactly 2. The visible cost is a slight
 * tendency for features to line up, which is far less objectionable in water —
 * where the Gerstner displacement is already breaking the surface up — than the
 * frame time was.
 */
float sFbm(vec2 p, float period) {
  float v = 0.0, amp = 0.5, per = period;
  for (int i = 0; i < 3; i++) {
    v += amp * sNoise(p, per);
    p *= 2.0; per *= 2.0; amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = vUv * uTile;
  // R: fbm as the shader produced it (peaks at 0.875, so it fits in [0,1]).
  // G: one octave, for the plain noise() calls.
  gl_FragColor = vec4(sFbm(uv, uTile), sNoise(uv, uTile), 0.0, 1.0);
}
`;

/** Bake the sea's noise field. One 1024-square draw at startup. */
export function bakeSeaField(renderer, size = 1024) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    // Half float here too — the sea thresholds this field for whitecaps and foam
    // patches, and the same amplification applies.
    format: THREE.RGFormat,
    type: THREE.HalfFloatType,
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
    fragmentShader: SEA_BAKE_FRAG,
    uniforms: { uTile: { value: SEA_TILE } },
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
