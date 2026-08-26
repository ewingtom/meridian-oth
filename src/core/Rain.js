import * as THREE from 'three';

/*
 * Rain.
 *
 * The weather system has been driving sea state, visibility, cloud coverage and
 * every sensor factor in the sim for a while — and in a gale, with the sky black
 * and the sea running, absolutely nothing fell out of it. The rain existed as a
 * number. That is the single most conspicuous way for a weather model to look
 * like a colour grade rather than weather.
 *
 * So: a genuine volume of falling water locked to the camera. One instanced quad
 * per drop, wrapped modulo a box centred on the eye, so a fixed 9,000 drops give
 * the impression of an infinite field without any of them ever being far away.
 * The whole motion is in the vertex shader — there is no per-frame CPU work at
 * all beyond writing two uniforms.
 *
 * Streaks, not spheres. A raindrop crossing a 1/60 s exposure draws a line, and
 * the line is what the eye reads as rain; it leans with the wind and it leans
 * harder the faster the wind blows. Drops near the camera are longer, fatter and
 * more transparent (they are out of focus), which is what stops the field
 * reading as a flat particle texture stuck to the lens.
 */

// Six thousand, not fifteen. Every drop is a transparent quad and they overlap
// heavily near the eye, so the cost is overdraw rather than vertices; at
// screen-space sizing six thousand still fills the frame.
const COUNT = 6000;
const BOX_R = 62;     // metres, radius of the wrap cylinder
const BOX_H = 34;     // metres, height of the wrap column

const VERT = /* glsl */`
uniform float uTime;
uniform vec3  uCamPos;
uniform float uFall;      // m/s
uniform vec2  uWind;      // m/s, horizontal drift
uniform float uAmount;
uniform vec2  uViewport;
attribute vec3 iSeed;     // x,z in [-1,1], y phase in [0,1]
attribute float iScale;
varying float vFade;
varying float vNear;

void main() {
  // Home cell for this drop, in a cylinder around the eye.
  vec2 base = iSeed.xz * ${BOX_R.toFixed(1)};
  float phase = iSeed.y;

  // Fall, wrapped. The wrap has to be relative to the CAMERA height, not to the
  // world, or the column empties out the moment the camera climbs.
  float fallT = uTime * uFall + phase * ${BOX_H.toFixed(1)} * 6.2831;
  float y = ${BOX_H.toFixed(1)} * 0.5 - mod(fallT, ${BOX_H.toFixed(1)});

  vec2 drift = uWind * (uTime * 0.35);
  vec2 xz = base + mod(drift, ${(BOX_R * 2).toFixed(1)});
  // Wrap x/z back into the cylinder so wind never blows the field away.
  xz = mod(xz + ${BOX_R.toFixed(1)}, ${(BOX_R * 2).toFixed(1)}) - ${BOX_R.toFixed(1)};

  vec3 world = uCamPos + vec3(xz.x, y, xz.y);

  float r = length(xz);
  // Drops beyond the cylinder, and the whole field when it is not raining hard,
  // collapse to zero size — cheaper than a branch and it gives a soft edge.
  float amt = smoothstep(0.02, 0.55, uAmount);
  float cull = (1.0 - smoothstep(${(BOX_R * 0.78).toFixed(1)}, ${BOX_R.toFixed(1)}, r))
             * step(1.0 - amt, fract(iSeed.x * 91.7 + iSeed.y * 37.3 + iSeed.z * 13.1) + 0.0001);

  // The streak: a quad stretched along the drop's own velocity vector, in view
  // space, so it always faces the camera and always leans the right way.
  vec3 vel = normalize(vec3(uWind.x, -uFall, uWind.y));
  vec3 vDir = normalize((viewMatrix * vec4(vel, 0.0)).xyz);
  vec3 vPos = (viewMatrix * vec4(world, 1.0)).xyz;

  float dist = max(1.2, -vPos.z);
  // Size the streak in PIXELS, not metres.
  //
  // A raindrop is two millimetres across. Sized in world units it is either
  // invisible at ten metres or a pane of glass at two, and the first attempt at
  // this drew a ring of white bars a metre wide around the lens. What the eye
  // actually reads as rain is a constant-width bright line a couple of pixels
  // across, whatever the distance — so convert pixels back into view-space
  // metres at this drop's depth and build the quad from that.
  float mPerPx = 2.0 * dist / (projectionMatrix[1][1] * uViewport.y);
  float near   = smoothstep(26.0, 2.5, dist);
  float len   = mPerPx * mix(13.0, 44.0, near) * iScale * (0.6 + amt * 0.7);
  float width = mPerPx * mix(1.15, 2.3, near) * (0.75 + iScale * 0.4);

  vec3 side = normalize(cross(vDir, vec3(0.0, 0.0, 1.0)));
  vPos += vDir * (position.y * len) + side * (position.x * width);
  vPos *= cull;                                  // degenerate the culled quads
  vFade = cull * amt * mix(0.30, 1.0, smoothstep(60.0, 5.0, dist));
  vNear = smoothstep(14.0, 2.0, dist);
  gl_Position = projectionMatrix * vec4(vPos, 1.0);
}
`;

const FRAG = /* glsl */`
uniform vec3 uTint;
varying float vFade;
varying float vNear;
void main() {
  if (vFade < 0.004) discard;
  // Rain is not white — it is a lens on whatever is behind it, which at sea is
  // the sky. Additive with a cool tint, brightened slightly on the near drops
  // where the specular streak along the drop catches the sky.
  gl_FragColor = vec4(uTint * (0.70 + vNear * 0.7), vFade * 0.21);
}
`;

export class RainField {
  constructor(shared) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.instanceCount = COUNT;

    const seed = new Float32Array(COUNT * 3);
    const scale = new Float32Array(COUNT);
    // A plain uniform scatter clumps; stratify the disc so the field is even.
    for (let i = 0; i < COUNT; i++) {
      const a = (i * 2.399963229728653) % (Math.PI * 2);   // golden angle
      const r = Math.sqrt((i + 0.5) / COUNT);
      seed[i * 3] = Math.cos(a) * r;
      seed[i * 3 + 1] = (i * 0.61803398875) % 1;
      seed[i * 3 + 2] = Math.sin(a) * r;
      scale[i] = 0.6 + ((i * 0.7548776662) % 1) * 0.9;
    }
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 3));
    geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scale, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: shared?.uTime ?? { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uFall: { value: 9.0 },
        uWind: { value: new THREE.Vector2(3, 1) },
        uAmount: { value: 0 },
        uViewport: { value: new THREE.Vector2(1920, 1080) },
        uTint: { value: new THREE.Color(0xbcd4e4) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  /**
   * @param {THREE.Camera} camera
   * @param {number} amount   0..1 rain intensity from the weather model
   * @param {number} wind     m/s
   * @param {THREE.Color} tint  sky horizon colour — rain takes the sky's light
   */
  setViewport(w, h) { (this._vp ||= new THREE.Vector2()).set(w, h); }

  update(camera, amount, wind, tint) {
    const u = this.material.uniforms;
    // Above the cloud base there is no rain to be inside of, and at tactical
    // altitude nine thousand streaks around the eye is just noise.
    const alt = camera.position.y;
    const a = amount * (1 - THREE.MathUtils.smoothstep(alt, 300, 1400));
    u.uAmount.value = a;
    this.mesh.visible = a > 0.02;
    if (!this.mesh.visible) return;
    u.uCamPos.value.copy(camera.position);
    if (this._vp) u.uViewport.value.copy(this._vp);
    u.uFall.value = 7.5 + amount * 6.0;
    // Wind blows the rain across the frame; a gale rains almost sideways.
    u.uWind.value.set(wind * 0.38, wind * 0.11);
    if (tint) u.uTint.value.copy(tint).lerp(new THREE.Color(0xffffff), 0.25);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
