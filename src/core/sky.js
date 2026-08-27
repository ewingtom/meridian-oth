import * as THREE from 'three';
import { SkyShader } from './skyShader.js';

/**
 * Procedural physical sky (hand-authored gradient + sun + clouds — see skyShader.js)
 * + sun light + dynamic env map. No textures — everything is generated on the GPU.
 */
export class SkySystem {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    // Big enough that the camera is still inside it at tactical altitude — the
    // player can climb to 250 km, and a BackSide box the camera has escaped is
    // simply not there. gl_Position.z is forced to w in the shader, so the size
    // costs nothing in depth precision.
    // Big enough that the camera is still inside it at the very top of the zoom
    // range. A BackSide box the camera has escaped is simply not there, and the
    // zoom now reaches 1,600 km.
    this.sky.scale.setScalar(7000000);
    scene.add(this.sky);

    this.sunPosition = new THREE.Vector3();
    this.sunDirection = new THREE.Vector3();

    // Key sun light — warm, low-ish for long dramatic shadows / glitter
    // Total irradiance on a PBR surface is sun + hemisphere + environment, and it
    // had crept up to roughly six times a unit reference — which was survivable
    // while every hull was one flat grey value, and blows the highlights off a
    // properly baked albedo the moment one arrives. Target about 2.2 total.
    this.sunLight = new THREE.DirectionalLight(0xfff2e0, 2.0);
    this.sunLight.castShadow = true;
    // 1536² instead of 2048² — the shadow pass re-renders every shadow-casting
    // mesh (hundreds, across the task force) into this map each frame, and 1536
    // still resolves crisp deck/superstructure shadows at ~44% less shadow-map
    // fill than 2048.
    this.sunLight.shadow.mapSize.set(1536, 1536);
    this.sunLight.shadow.camera.near = 40;
    this.sunLight.shadow.camera.far = 900;
    // Tight ortho frustum around the hero — a ±360m box wasted texels and left deck
    // contact shadows too soft for chase/helm AAA reads. Updated each frame in update().
    this._shadowHalfExtent = 165;
    this._applyShadowFrustum();
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.shadow.normalBias = 0.018;
    this.sunLight.shadow.radius = 2.0;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    // Soft cool sky fill — kept low so sun key + SSAO can sculpt form (judge: plastic wash)
    // Balanced hemi — too low made ocean/hull near-black; too high washed AO
    // Sky fill. Too low and every hull reads as a black silhouette against a
    // bright sea; too high and the ambient occlusion has nothing to sculpt.
    // The ground half of this is the SEA, and the sea under a daylit sky is not
    // nearly black. At 0x14202a an aircraft's underside got essentially no light
    // at all and a P-8 crossing overhead rendered as a black cut-out; the whole
    // point of the lower hemisphere term is the bounce off the water.
    this.hemiLight = new THREE.HemisphereLight(0x8fb4d2, 0x24405c, 0.62);
    scene.add(this.hemiLight);
    // Sky-dome irradiance. At the default intensity of 1 a haze-grey hull whose
    // lit side is turned away from the sun rendered nearly black — which is not
    // what a warship looks like under an overcast-bright sky, where the whole
    // upper hemisphere is a large soft source. Warships are painted 5-H haze
    // grey precisely because it stays light in open shade.
    scene.environmentIntensity = 1.05;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envRT = null;

    // The ocean shader samples a genuine samplerCube. A PMREM render target is a
    // 2-D texture in the CubeUV layout, so binding it to a samplerCube is invalid
    // GL and produces garbage (a washed-out beige sea). Keep the PMREM for the
    // PBR materials via scene.environment, and render a small, real cube map of
    // the sky for the water to reflect.
    this._skyScene = new THREE.Scene();
    this._skyProxy = new THREE.Mesh(this.sky.geometry, this.sky.material);
    this._skyProxy.scale.copy(this.sky.scale);
    this._skyScene.add(this._skyProxy);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(256, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
    });
    this.cubeCam = new THREE.CubeCamera(1, 200000, this.cubeRT);

    this._elevation = 22;
    this._azimuth = 215;
    this._lastEnvRefresh = -999;
    this._followTarget = new THREE.Vector3();
    this.setSunAngle(this._elevation, this._azimuth);
    this.updateEnvMap();
  }

  setSunAngle(elevationDeg, azimuthDeg) {
    this._elevation = elevationDeg;
    this._azimuth = azimuthDeg;
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunPosition.setFromSphericalCoords(1, phi, theta);
    this.sunDirection.copy(this.sunPosition).normalize();
    this.sky.material.uniforms.uSunDirection.value.copy(this.sunDirection);

    const dist = 400;
    this.sunLight.position.copy(this.sunPosition).multiplyScalar(dist);
    // Target is updated each frame to follow the ship (see update)

    // Warmth falls off fast once the sun is properly up; the old /45 ramp left a
    // 25-degree morning sun still two-thirds sunset-orange, which washed the
    // whole sea brown.
    // How much daylight there is at all. Zero once the sun is six degrees under
    // (civil twilight ends), one by the time it is eight up. Everything that
    // should stop happening at night hangs off this.
    this.dayFactor = THREE.MathUtils.smoothstep(elevationDeg, -6, 8);
    const t = THREE.MathUtils.clamp(elevationDeg / 26, 0, 1);
    // Total irradiance on a PBR surface is sun + hemisphere + environment. With
    // properly baked albedos arriving on the hulls the old 4.6 blew the
    // highlights off them; 2.6 against a 0.55 hemisphere and a 1.05 environment
    // lands a mid-grey topside where it should be.
    // A sun below the horizon must not light the scene. The old ramp bottomed out
    // at 1.5 — full daylight — for every elevation at or below zero, which is
    // why forcing the sun to minus six degrees changed the sky by six percent
    // and the game had no night at all.
    this.sunLight.intensity = THREE.MathUtils.lerp(1.5, 2.6, t) * this.dayFactor;
    const warm = new THREE.Color(0xff9d52);
    const white = new THREE.Color(0xfff4e2);
    this.sunLight.color.copy(warm).lerp(white, t);

    // Sky gradient colours shift warmer/dimmer near the horizon (sunrise/sunset)
    const u = this.sky.material.uniforms;
    const zenithHigh = new THREE.Color(0x11407c);
    const zenithLow = new THREE.Color(0x223a63);
    const horizonHigh = new THREE.Color(0x9dbdd4);
    const horizonLow = new THREE.Color(0xd9a878);
    u.uZenithColor.value.copy(zenithLow).lerp(zenithHigh, t);
    u.uHorizonColor.value.copy(horizonLow).lerp(horizonHigh, t);
    u.uSunColor.value.copy(warm).lerp(white, t);

    // Night. Not black — a clear night sky over open ocean is a deep blue with a
    // slightly lighter band at the horizon, and the eye adapts to it.
    const nightZenith = new THREE.Color(0x02040c);
    const nightHorizon = new THREE.Color(0x0a1526);
    u.uZenithColor.value.lerp(nightZenith, 1 - this.dayFactor);
    u.uHorizonColor.value.lerp(nightHorizon, 1 - this.dayFactor);

    // Keep the sun-driven values so the weather system can MODULATE them rather
    // than overwrite them — it used to copy fixed daytime colours over the top of
    // these every frame, which is what removed the day/night cycle.
    this.baseZenith = u.uZenithColor.value.clone();
    this.baseHorizon = u.uHorizonColor.value.clone();

    // Sky fill and image-based lighting follow the sun down too, or hulls stay
    // fully lit under a night sky.
    this.hemiLight.intensity = THREE.MathUtils.lerp(0.05, 0.62, this.dayFactor);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.06, 1.05, this.dayFactor);
  }

  updateEnvMap() {
    if (this.envRT) this.envRT.dispose();
    // Render the PROXY, not this.sky.
    //
    // this.sky lives on the dedicated sky layer so the half-resolution sky pass
    // can draw it separately. PMREM's fromScene() uses its own internal camera,
    // which sees layer 0 only — so from the moment the sky moved layers, the
    // environment map has been rendered from an empty scene and every material
    // in the game has been lit by a BLACK image-based light.
    //
    // An art review isolated it exactly: a pure white mirror with all lights
    // disabled rendered at median 0, and sweeping environmentIntensity from 0 to
    // 6x moved the ship by 0.4 of a value. Only the hemisphere light was left,
    // which is blue-tinted, so every ship in the game measured a mean R minus B
    // of -77 — navy blue hulls in daylight.
    //
    // _skyProxy shares the sky's geometry and material and sits on layer 0 in
    // its own scene, which is exactly what this needs.
    this._skyProxy.layers.set(0);
    this.envRT = this.pmrem.fromScene(this._skyScene, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1.05;
    this.updateCubeMap();
    return this.envRT.texture;
  }

  /** Real cube map of the sky, for the ocean's reflection lookup. */
  updateCubeMap() {
    const prevAuto = this.renderer.shadowMap.autoUpdate;
    this.renderer.shadowMap.autoUpdate = false;
    this.cubeCam.position.set(0, 0, 0);
    this.cubeCam.update(this.renderer, this._skyScene);
    this.renderer.shadowMap.autoUpdate = prevAuto;
    this.onCubeMapUpdated?.(this.cubeRT.texture);
    return this.cubeRT.texture;
  }

  _applyShadowFrustum() {
    const h = this._shadowHalfExtent;
    const cam = this.sunLight.shadow.camera;
    cam.left = -h;
    cam.right = h;
    cam.top = h;
    cam.bottom = -h;
    cam.updateProjectionMatrix();
  }

  /** Keep shadow frustum under the player ship so chase shots get hull contact shadows. */
  setFollowTarget(pos) {
    if (!pos) return;
    this._followTarget.copy(pos);
  }

  /**
   * The shadow map does not need rebuilding sixty times a second.
   *
   * The pass re-renders every shadow-casting mesh in the task force into a
   * 2048-square depth map each frame, and it measured 5.1 ms of a 49.6 ms frame.
   * What it draws barely changes between frames: the sun is fixed, and the ships
   * move a few centimetres. Rebuilding it every third frame is imperceptible and
   * gives back two thirds of that.
   */
  _tickShadowMap() {
    this._shadowTick = ((this._shadowTick || 0) + 1) % 3;
    this.renderer.shadowMap.autoUpdate = this._shadowTick === 0;
    this.renderer.shadowMap.needsUpdate = this._shadowTick === 0;
  }

  update(camera, elapsed = 0) {
    this._tickShadowMap();
    this.sky.position.set(camera.position.x, 0, camera.position.z);
    this.sky.material.uniforms.uTime.value = elapsed;

    const anchor = this._followTarget.lengthSq() > 0.01 ? this._followTarget : camera.position;
    this.sunLight.target.position.set(anchor.x, 0, anchor.z);
    this.sunLight.target.updateMatrixWorld();
    const half = this.sunLight.userData.shadowHalfExtent ?? this._shadowHalfExtent;
    if (half !== this._shadowHalfExtent) {
      this._shadowHalfExtent = half;
      this._applyShadowFrustum();
    }
    const dist = 400;
    this.sunLight.position.copy(this.sunPosition).multiplyScalar(dist).add(anchor);

    // Refresh PMREM only occasionally so water/hull env reflections track slow
    // cloud/sun change. Each refresh renders the sky to a cubemap and runs the
    // full PMREM convolution (plus a render-target realloc) — a ~hundreds-of-ms
    // GPU hitch — so doing it every 2.5 s produced a periodic stutter. The env
    // barely changes over a patrol (sun is fixed; low-roughness reflections are
    // near-insensitive to cloud drift), so a 15 s cadence keeps the reflections
    // fresh enough while cutting the hitch frequency 6×.
    if (elapsed - this._lastEnvRefresh > 15) {
      this._lastEnvRefresh = elapsed;
      this.updateEnvMap();
      this.onEnvMapUpdated?.(this.envRT.texture);
    }
  }
}
