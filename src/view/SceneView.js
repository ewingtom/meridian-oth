import * as THREE from 'three';
import { SkySystem } from '../core/sky.js';
import { OceanField, WIND_DIR } from '../core/ocean.js';
import { CloudLayer } from '../core/CloudLayer.js';
import { bakeCloudField, bakeSeaField } from '../core/CloudField.js';
import { RainField } from '../core/Rain.js';
import { SKY_LAYER } from '../core/SkyLayerPass.js';

const _rainVp = new THREE.Vector2();
import { buildIsland, makeIslandMaterial } from '../core/Islands.js';
import { UnitView } from './UnitView.js';
import { buildMissileMesh, buildTorpedoMesh, MATS } from './models.js';
import { TrailRibbon } from '../utils/TrailRibbon.js';
import { getSharedFoamTexture, getSharedDotTexture, getSharedWakeFoamTexture } from '../utils/ProceduralTextures.js';
import { getWeaponFx } from './FxParticles.js';
import { loadModel } from './UnitView.js';
import { Explosion } from './Explosion.js';
import { SIDE, clamp } from '../sim/constants.js';

const _wxTmp = new THREE.Color();

// One shared, prepared anti-ship-missile airframe. Rounds are spawned dozens at
// a time in a salvo, so this must be a clone of a ready template rather than a
// parse per round.
let _asmTemplate = null;
let _asmLoading = false;
function _loadAsm(view) {
  if (_asmLoading || _asmTemplate) return;
  _asmLoading = true;
  loadModel('missile_asm').then((src) => {
    const g = src.clone(true);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

    // Normalise the airframe into the engine's convention: nose at +Z, origin at
    // the centre of the body, one metre long. The asset is authored nose-to-−Z,
    // and the flight code, the weapon camera and the motor plume all assume +Z —
    // which put the exhaust cone INSIDE the nose. From the weapon camera that
    // read as a detached nose cone with an orange line burning through the body,
    // because an additive double-sided cone buried in the airframe is exactly
    // what that looks like.
    const box = new THREE.Box3().setFromObject(g);
    const size = new THREE.Vector3(); box.getSize(size);
    const ctr = new THREE.Vector3(); box.getCenter(ctr);

    // Which end is the nose? The pointed one. Measure the cross-sectional radius
    // in the first and last tenth of the body and take the smaller as the nose,
    // rather than trusting an axis convention that has already been wrong once.
    let rFwd = 0, rAft = 0;
    const zLo = box.min.z + size.z * 0.12, zHi = box.max.z - size.z * 0.12;
    const v = new THREE.Vector3();
    g.updateMatrixWorld(true);
    g.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i += 3) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const r = Math.hypot(v.x - ctr.x, v.y - ctr.y);
        if (v.z > zHi) rFwd = Math.max(rFwd, r);
        else if (v.z < zLo) rAft = Math.max(rAft, r);
      }
    });

    const inner = new THREE.Group();
    inner.add(g);
    g.position.sub(ctr);
    if (rAft < rFwd) inner.rotation.y = Math.PI;   // nose was aft — turn it round

    const holder = new THREE.Group();
    holder.add(inner);
    // Unit length, so callers scale straight to the round's real length instead
    // of dividing by a magic number that stops being true when the asset changes.
    const L = Math.max(0.001, size.z);
    inner.scale.setScalar(1 / L);
    _asmTemplate = holder;
    // Any round already in the air is still carrying the placeholder. Upgrade it
    // in place rather than leaving one salvo permanently wrong.
    view?._upgradeOrdnanceMeshes?.();
  }).catch(() => { _asmLoading = false; });
}

/**
 * The 3-D world.
 *
 * Only what is close enough to read gets a mesh. The player spends most of the
 * game at chart altitude looking at symbols, and drops down to sea level for the
 * moments that matter — a launch, an intercept, a hull taking a hit — so the
 * renderer keeps a "detail bubble" around the camera focus and streams hulls in
 * and out of it. Everything outside is still fully simulated; it just isn't drawn.
 */
/**
 * Cloud COVERAGE (how much of the sky has cloud in it, 0..1) to the cloud
 * shader's THRESHOLD (the density level above which cloud exists).
 *
 * These are opposite senses, and the weather system was feeding coverage
 * straight into the threshold. A clear day asked for 0.16 and got a threshold of
 * 0.16, which is almost solid overcast; a gale asked for 0.95, the threshold
 * clamped at its 0.85 ceiling, and the sky came out CLOUDLESS. Every weather
 * state in the game has been rendering as its own opposite, which is why a
 * forced gale produced a clear blue sky with heavy swell under it.
 *
 * The field sits mostly between about 0.15 and 0.75, so that is the useful
 * threshold range to map into, inverted.
 */
function coverageToThreshold(coverage) {
  return 0.78 - Math.max(0, Math.min(1, coverage)) * 0.62;
}

export class SceneView {
  constructor(renderPipeline, camDirector, world) {
    this.pipeline = renderPipeline;
    this.renderer = renderPipeline.renderer;
    this.cam = camDirector;
    this.world = world;

    this.scene = new THREE.Scene();
    this.scene.fog = null;

    this.sky = new SkySystem(this.renderer, this.scene);
    // Mid-morning rather than dawn. At 22-27 degrees the key light is weak and
    // warm, the sky sits close to the sea in value, and every frame in the game
    // reads as the same flat overcast whatever the weather is doing. Putting the
    // sun properly up gives the whole product a key/fill separation to work
    // with: hard warm light on one side of a hull, cool sky bounce on the other.
    this.sky.setSunAngle(41, 118);
    renderPipeline.bindSunLight(this.sky.sunLight);

    this.ocean = new OceanField(this.renderer, this.sky.sunDirection);
    this.scene.add(this.ocean.group);
    // The water samples a real samplerCube (see SkySystem.updateCubeMap) — the
    // PMREM target is a 2-D CubeUV texture and binding it here is invalid GL.
    this.ocean.setEnvMap(this.sky.cubeRT.texture);
    this.sky.onCubeMapUpdated = (tex) => this.ocean.setEnvMap(tex);
    this.ocean.uniforms.uSunDirection.value.copy(this.sky.sunDirection);

    this.fogColor = new THREE.Color(0xa9bfd0);
    this.ocean.setFogColor(this.fogColor);

    // The cumulus deck is geometry, not sky box — see CloudLayer.
    // Bake the cloud density field once, then hand the same texture to
    // everything that samples it — the deck, the sky dome and the sea's cloud
    // shadows all read the identical field, so they stay in register with each
    // other for free. This replaces roughly a hundred noise evaluations per
    // lookup with one bilinear fetch.
    this.cloudField = bakeCloudField(this.renderer, 2048);
    this.ocean.uniforms.uCloudField.value = this.cloudField;
    this.sky.sky.material.uniforms.uCloudField.value = this.cloudField;
    // Same treatment for the sea's own noise; see bakeSeaField.
    this.seaField = bakeSeaField(this.renderer, 1024);
    this.ocean.uniforms.uSeaField.value = this.seaField;

    this.clouds = new CloudLayer(this.ocean.uniforms);
    // The sky dome and the cloud deck are pure background: drawn behind
    // everything, depth-tested against by nothing. Putting them on their own
    // layer is what lets the pipeline shade them at half resolution.
    this.sky.sky.layers.set(SKY_LAYER);
    this.clouds.mesh.layers.set(SKY_LAYER);

    this.rain = new RainField(this.ocean.uniforms);
    this.scene.add(this.rain.mesh);

    // Start the anti-ship airframe loading NOW, not on the first round fired.
    // _makeOrdView only uses the modelled airframe if the template has already
    // arrived, and it was kicking the load off itself — so the first salvo of
    // every session was created a frame too early, kept the placeholder tube for
    // its entire flight, and that is what the weapon camera showed.
    _loadAsm(this);
    this.scene.add(this.clouds.mesh);

    this.views = new Map();       // unit -> UnitView
    this.ordViews = new Map();    // ordnance -> { group, trail, light }
    this.explosions = [];
    this.fx = getWeaponFx(this.scene);
    this.islands = [];
    // One permanently-resident point light, re-assigned every frame to the
    // nearest burning hull. Adding and removing lights would recompile every
    // material in the scene the moment a ship caught fire, so the light is
    // always there and simply carries zero intensity when nothing is alight.
    this.fireLight = new THREE.PointLight(0xff7a25, 0, 400, 2);
    this.fireLight.position.set(0, -1000, 0);
    this.scene.add(this.fireLight);
    this.quality = 'high';

    this._tmp = new THREE.Vector3();
    this.elapsed = 0;

    this._buildDeckMarkers();
    this.cam.onRebase = (dx, dz) => this._rebase(dx, dz);
  }

  _buildDeckMarkers() {
    // Selection halo drawn on the water under the selected hull.
    const ringGeo = new THREE.RingGeometry(0.955, 1, 96);
    ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0x7fe3ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.selRing.visible = false;
    this.selRing.renderOrder = 3;
    this.scene.add(this.selRing);
  }

  setQuality(q) {
    // Cloud march depth. Safe to vary now that the count is a UNIFORM rather
    // than a per-pixel value — a count that changes per draw cannot draw the
    // contour lines a per-pixel one did.
    if (this.clouds) {
      this.clouds.mesh.material.uniforms.uCloudSteps.value =
        q === 'exquisite' ? 16 : q === 'high' ? 12 : q === 'medium' ? 10 : 7;
    }
    this.quality = q;
    this.ocean.setQuality(q);
  }

  setSeaState(ss) {
    // One mapping, in one place — see OceanField.setSeaState. This used to apply
    // its own linear curve while the weather loop applied a different one, so
    // the sea had two unrelated ideas of what a given sea state looked like.
    this.ocean.setSeaState(ss);
  }

  setWeatherLook({ fog, zenith, horizon, coverage, rain = 0, exposure }) {
    if (fog) { this.fogColor.set(fog); this.ocean.setFogColor(this.fogColor); }
    const u = this.sky.sky.material.uniforms;
    if (zenith) u.uZenithColor.value.set(zenith);
    if (horizon) u.uHorizonColor.value.set(horizon);
    if (coverage !== undefined) u.uCloudCoverage.value = coverageToThreshold(coverage);
    this.ocean.setRain(rain);
  }

  /**
   * Raise the scenario's land. Built once, then simply translated as the
   * floating origin steps — terrain is static, so this costs nothing per frame.
   */
  buildIslands(world) {
    if (this._islandsBuilt || !world.scenario?.islands) return;
    this._islandsBuilt = true;
    // Modelled terrain where we have it, and the procedural heightfield as the
    // fallback for the outliers. The GLBs carry their own baked rock/sand/grass/
    // snow atlases, so they keep their own materials — but they still need the
    // engine's earth-curvature drop and its aerial perspective, or an island at
    // fifteen kilometres floats above the horizon and stays fully saturated.
    const FILES = { KESTREL: 'island_a', BRANT: 'island_b', SKUA: 'island_b', GANNET: 'island_b' };
    for (const spec of world.scenario.islands) {
      const entry = { spec, mesh: null };
      this.islands.push(entry);
      const file = FILES[spec.id];
      if (file) {
        loadModel(file).then((src) => {
          const g = src.clone(true);
          const box = new THREE.Box3().setFromObject(g);
          // Scale by PLAN extent so the shoreline lands on the radius the ocean
          // shader is shoaling against.
          const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
          const want = spec.radius * 1.78;
          if (span > 1) g.scale.setScalar(want / span);
          g.rotation.y = (spec.seed % 360) * Math.PI / 180;
          g.traverse((o) => {
            if (!o.isMesh) return;
            o.frustumCulled = true;
            o.receiveShadow = false;
            o.castShadow = false;
            this._terrainShader(o.material);
          });
          const holder = new THREE.Group();
          holder.add(g);
          holder.renderOrder = -1;
          this.scene.add(holder);
          entry.mesh = holder;
        }).catch(() => {
          entry.mesh = this._proceduralIsland(spec);
        });
      } else {
        entry.mesh = this._proceduralIsland(spec);
      }
    }
  }

  _proceduralIsland(spec) {
    if (!this.islandMaterial) this.islandMaterial = makeIslandMaterial(this.ocean.uniforms);
    const { geometry } = buildIsland({
      radius: spec.radius, height: spec.height, seed: spec.seed,
      res: spec.radius > 3000 ? 160 : 96,
    });
    const mesh = new THREE.Mesh(geometry, this.islandMaterial);
    mesh.frustumCulled = true;
    mesh.renderOrder = -1;
    this.scene.add(mesh);
    return mesh;
  }

  /**
   * Give a terrain material the two things the engine needs from everything it
   * draws: the earth-curvature drop, so land meets the sea horizon instead of
   * hanging above it, and aerial perspective, so a headland fifteen kilometres
   * off is the colour of the air rather than the colour of rock.
   */
  _terrainShader(m) {
    if (!m || m._terrain) return;
    m._terrain = true;
    // Terrain ships baked AO in COLOR_0 too, and the same opt-in applies.
    if (!m.vertexColors) { m.vertexColors = true; m.needsUpdate = true; }
    const oceanU = this.ocean.uniforms;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uEarthR = oceanU.uEarthR;
      shader.uniforms.uHorizonC = oceanU.uHorizonColor;
      shader.uniforms.uVis = oceanU.uVisibility;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uEarthR;\nvarying float vTerrDist;\nvarying vec3 vTerrWorld;')
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          vec4 wp = modelMatrix * vec4(transformed, 1.0);
          float radial = length(wp.xz - cameraPosition.xz);
          vTerrDist = radial;
          vTerrWorld = wp.xyz;
          wp.y -= (radial * radial) / (2.0 * uEarthR);
          mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
        }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
        uniform vec3 uHorizonC;
        uniform float uVis;
        varying float vTerrDist;
        varying vec3 vTerrWorld;
        float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float tNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), f.x),
                     mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        {
          // Macro variation.
          //
          // The rock detail map tiles at a few metres, and one frequency across
          // a six-hundred-metre hillside reads as a uniform gravel stipple
          // rather than as ground: real terrain is patchy at every scale from
          // the boulder up to the whole flank. Two much lower-frequency bands,
          // multiplied in, break that uniformity without touching the detail
          // that carries the close-up.
          float mMid  = tNoise(vTerrWorld.xz * 0.0125 + vTerrWorld.y * 0.004);
          float mWide = tNoise(vTerrWorld.xz * 0.0022 - 11.0);
          float macro = 0.78 + 0.30 * mMid + 0.26 * mWide;
          // Damp, dark ground in the hollows and on the north-facing flanks; the
          // wide band also shifts hue slightly so it is not just a brightness
          // ripple.
          gl_FragColor.rgb *= macro;
          gl_FragColor.rgb *= mix(vec3(0.94, 0.98, 1.02), vec3(1.05, 1.01, 0.94), mWide);

          float air = 1.0 - exp(-vTerrDist * (3.912 / max(2000.0, uVis)) * 0.62);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uHorizonC * 0.97, clamp(air, 0.0, 0.96));
        }`);
    };
    m.needsUpdate = true;
  }

  _rebase(dx, dz) {
    for (const [, v] of this.views) v.rebase(dx, dz);
    for (const [, o] of this.ordViews) {
      if (o.trail) for (const s of o.trail.samples) { s.x -= dx; s.z -= dz; }
    }
    for (const e of this.explosions) e.rebase(dx, dz);
    // Particles carry baked world-space spawn points, so they have to move too —
    // otherwise every smoke column and tracer jumps a kilometre sideways the
    // moment the origin steps.
    this.fx.smoke.rebase(dx, dz);
    this.fx.fire.rebase(dx, dz);
    this.fx.streaks.rebase(dx, dz);
  }

  /** Radius around the camera focus inside which units get real meshes. */
  get bubble() {
    const d = this.cam.dist;
    if (d > 120000) return 0;
    return clamp(d * 5.5, 26000, 150000);
  }

  update(dt, world, selection) {
    this.elapsed += dt;
    const cam = this.cam;
    const camera = cam.camera;

    // Smoke has to know which way the wind is blowing. A column that stands
    // straight up is a chimney; one that leans to leeward is a ship on fire.
    if (world.weather) {
      const ws = world.weather.windSpeed || 8;
      this.fx.wind.set(WIND_DIR.x * ws, 0, WIND_DIR.z * ws);
    }

    // ── land ───────────────────────────────────────────────────────────────
    this.buildIslands(world);
    for (const it of this.islands) {
      if (it.mesh) it.mesh.position.set(cam.rx(it.spec.x), 0, cam.rz(it.spec.z));
    }
    // Hand the four nearest to the ocean so it can shoal and break against them.
    {
      const arr = this.ocean.uniforms.uIsland.value;
      const near = this.islands
        .map(it => ({ it, d: Math.hypot(it.spec.x - cam.focus.x, it.spec.z - cam.focus.y) }))
        .sort((a, b) => a.d - b.d).slice(0, 4);
      for (let i = 0; i < 4; i++) {
        if (i < near.length) {
          const sp = near[i].it.spec;
          arr[i].set(cam.rx(sp.x), cam.rz(sp.z), sp.radius, sp.height);
        } else arr[i].set(0, 0, 0, 0);
      }
    }

    // ── weather look ───────────────────────────────────────────────────────
    // Driven every frame from the sim's own weather state, which is itself
    // easing continuously between regimes. Nothing here snaps: the sky, the sea
    // and the visibility all walk to their new values over minutes, because a
    // step change in the horizon colour is more jarring than any amount of bad
    // weather.
    if (world.weatherSys) {
      const s = world.weatherSys.state;
      const u = this.sky.sky.material.uniforms;
      const k = Math.min(1, dt * 0.9);
      u.uCloudCoverage.value += (coverageToThreshold(s.coverage) - u.uCloudCoverage.value) * k;
      this._wxZen = this._wxZen || new THREE.Color(s.zenith);
      this._wxHor = this._wxHor || new THREE.Color(s.horizon);
      this._wxFog = this._wxFog || new THREE.Color(s.fog);
      this._wxZen.lerp(_wxTmp.setHex(s.zenith), k);
      this._wxHor.lerp(_wxTmp.setHex(s.horizon), k);
      this._wxFog.lerp(_wxTmp.setHex(s.fog), k);

      // MODULATE the sun-driven sky; do not replace it.
      //
      // These three colours used to be copied straight over the uniforms every
      // frame. The weather regimes carry fixed daytime colours, so whatever
      // setSunAngle had computed from the sun's elevation was overwritten one
      // frame later and the game had no night: an art review swept the sun from
      // +75 degrees to six degrees BELOW the horizon and measured the sky
      // changing by six percent.
      //
      // Weather says how grey and flat the sky is; the sun says how bright it
      // is. Overcast at midnight is a dark grey sky, not a daylight one.
      const day = this.sky.dayFactor ?? 1;
      const base = this.sky.baseZenith, baseH = this.sky.baseHorizon;
      if (base && baseH) {
        // Cloud cover pulls the sky toward the regime colour, scaled by daylight.
        u.uZenithColor.value.copy(base).lerp(_wxTmp.copy(this._wxZen).multiplyScalar(day), 0.72);
        u.uHorizonColor.value.copy(baseH).lerp(_wxTmp.copy(this._wxHor).multiplyScalar(day), 0.72);
        this.fogColor.copy(this._wxFog).multiplyScalar(0.10 + 0.90 * day);
      } else {
        u.uZenithColor.value.copy(this._wxZen);
        u.uHorizonColor.value.copy(this._wxHor);
      }
      this.ocean.setFogColor(this.fogColor);
      this.ocean.uniforms.uHorizonColor.value.copy(this._wxHor);
      this.ocean.setSeaState(s.seaState);
      this.ocean.setRain(s.rain);
      this.ocean.setVisibility(s.visNm * 1852);
      // Hand the four nearest squall cells to the cloud shader, in render space.
      if (this.clouds) {
        const arr = this.clouds.material.uniforms.uSquall.value;
        const cells = world.weatherSys.squalls
          .map(c => ({ c, d: Math.hypot(c.x - cam.focus.x, c.z - cam.focus.y) }))
          .sort((p, q) => p.d - q.d).slice(0, 4);
        for (let i = 0; i < 4; i++) {
          if (i < cells.length) {
            const c = cells[i].c;
            arr[i].set(cam.rx(c.x), cam.rz(c.z), c.r, c.strength);
          } else arr[i].set(0, 0, 0, 0);
        }
      }
      const skyU = this.sky.sky.material.uniforms;
      if (skyU.uVisibility) skyU.uVisibility.value = Math.max(1800, s.visNm * 1852);
      // Rain that you can actually see fall, in the frame, around the eye.
      if (this.rain) {
        const dv = this.renderer?.getDrawingBufferSize?.(_rainVp);
        if (dv) this.rain.setViewport(dv.x, dv.y);
        this.rain.update(camera, s.rain, world.weather.windSpeed || 6, this._wxHor);
      }
    }

    // ── stream unit views in and out of the detail bubble ──────────────────
    //
    // Two tests, and the second is the one that matters. The focus bubble decides
    // how much of the world is "near the action"; the angular test decides whether
    // a given hull is big enough on screen to be worth a mesh at all. A frigate
    // sixty kilometres from the camera is two pixels — the plot draws its NTDS
    // symbol either way — so streaming its full model in cost five hundred draw
    // calls at the tactical zoom for nothing anyone could see.
    const bubble = this.bubble;
    const fx = cam.focus.x, fz = cam.focus.y;
    const camSimX = cam.origin.x + camera.position.x;
    const camSimZ = cam.origin.y + camera.position.z;
    const wanted = new Set();
    if (bubble > 0) {
      for (const u of world.units) {
        // Keep a view alive for a while after a unit dies so the sinking plays
        // out; a hull that vanishes the instant its hit points reach zero robs
        // the player of the only feedback that actually lands.
        if (!u.alive && (u.despawned || !u.sunkAt || world.time - u.sunkAt > 50)) continue;
        const d = Math.hypot(u.x - fx, u.z - fz);
        if (d > bubble) continue;
        // Never draw a submerged submarine the player has no business seeing.
        if (u.isSub && u.alt < -55 && u.side !== SIDE.BLUE) continue;
        const dCam = Math.hypot(u.x - camSimX, u.z - camSimZ);
        if (dCam > (u.cls.length || 120) * 280) continue;
        wanted.add(u);
      }
    }
    for (const [u, v] of this.views) {
      if (!wanted.has(u)) { v.dispose(); this.views.delete(u); }
    }
    for (const u of wanted) {
      if (!this.views.has(u)) this.views.set(u, new UnitView(this.scene, u, { quality: this.quality, fx: this.fx }));
    }
    for (const [u, v] of this.views) v.update(dt, this.elapsed, cam, this.ocean);

    // ── the one fire light: nearest burning hull inside its useful radius ───
    {
      let best = null, bestD = 1e9;
      for (const [u, v] of this.views) {
        if (!u.alive || !(u.damage?.fire > 0.12) || !v.group.visible) continue;
        const d = v.group.position.distanceToSquared(camera.position);
        if (d < bestD) { bestD = d; best = { u, v }; }
      }
      const L = this.fireLight;
      if (best && bestD < 900 * 900) {
        const seat = best.v._fireSeats?.[0];
        const h = best.u.heading;
        L.position.copy(best.v.group.position);
        if (seat) {
          L.position.x += Math.sin(h) * seat.along - Math.cos(h) * seat.beam;
          L.position.z += Math.cos(h) * seat.along + Math.sin(h) * seat.beam;
          L.position.y += seat.h * 0.6;
        } else L.position.y += 8;
        // Flicker: two incommensurate rates so it never reads as a sine wave.
        const t = this.elapsed;
        const fl = 0.62 + 0.26 * Math.sin(t * 11.3) + 0.16 * Math.sin(t * 4.1 + 1.7);
        const fade = 1 - clamp((Math.sqrt(bestD) - 550) / 350, 0, 1);
        // Candela. A structural fire is bright: the adjacent superstructure, the
        // mast standing in it and the water underneath all have to pick it up,
        // and at 1/r^2 that needs a big number to still read thirty metres away.
        L.intensity = clamp(best.u.damage.fire, 0, 1) * 5200 * fl * fade;
        L.distance = 420;
      } else {
        L.intensity = 0;
      }
    }

    // ── ocean wake sources: the nearest moving hulls we are actually drawing ──
    const sources = [];
    for (const [u, v] of this.views) {
      if (u.isAir || u.isSub) continue;
      if (Math.abs(u.speedKts) < 1.5) continue;
      sources.push({
        u,
        x: cam.rx(u.x), z: cam.rz(u.z), heading: u.heading,
        speedKts: u.speedKts, length: u.cls.length, beam: u.cls.beam,
        height: (u.cls.mastHeight || 24) * 0.72,
        // Topside tone for the water reflection. Warships are 5-H haze grey and
        // read light against the sea; a merchant is whatever her owner painted
        // her, and a red hull throws a red smear, which is half of why a
        // shipping lane looks like a shipping lane.
        color: u.neutral ? [0.40, 0.36, 0.33] : (u.side === SIDE.RED ? [0.34, 0.36, 0.38] : [0.46, 0.49, 0.52]),
        d: Math.hypot(cam.rx(u.x) - camera.position.x, cam.rz(u.z) - camera.position.z),
      });
    }
    sources.sort((a, b) => a.d - b.d);
    // Wake shader work is charged to every water pixel in the frame, so the set
    // of hulls that get it has to shrink when the camera pulls back — at the
    // tactical zoom a wake is a fraction of a pixel and costs exactly as much as
    // one filling the screen.
    this.ocean.setWakeCullRange(this.quality === 'exquisite' ? 6000
      : this.quality === 'high' ? 3200
        : this.quality === 'medium' ? 1800 : 900);
    this.ocean.setWakeSources(sources);

    // ── ordnance ───────────────────────────────────────────────────────────
    this._updateOrdnance(dt, world, cam);

    // ── explosions & particles ─────────────────────────────────────────────
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      if (!e.update(dt)) { e.dispose(); this.explosions.splice(i, 1); }
    }
    this.fx.update(this.elapsed);

    // ── selection halo ─────────────────────────────────────────────────────
    // The halo is a plot affordance. On the bridge or riding a weapon it is a
    // hundred-metre cyan ring lying on the water in front of you, which reads as
    // a solid object and was the source of the "turquoise sandbar" across the bow.
    const sel = selection && selection.length === 1 && this.cam.mode === 'TACTICAL'
      ? selection[0] : null;
    if (sel && sel.alive && this.views.has(sel) && !sel.isAir) {
      const r = Math.max(70, (sel.cls.length || 140) * 0.85);
      this.selRing.position.set(cam.rx(sel.x), 1.2 - cam.drop(cam.rx(sel.x), cam.rz(sel.z)), cam.rz(sel.z));
      this.selRing.scale.setScalar(r);
      this.selRing.visible = cam.dist < 60000 && cam.camera.position.y > 260;
      this.selRing.material.opacity = 0.22 + 0.16 * (0.5 + 0.5 * Math.sin(this.elapsed * 3));
    } else {
      this.selRing.visible = false;
    }

    // ── sky / ocean bookkeeping ────────────────────────────────────────────
    this.ocean.update(dt, this.elapsed, camera);
    this.clouds.update(camera);
    this.sky.setFollowTarget(new THREE.Vector3(
      cam.rx(cam.focus.x), 0, cam.rz(cam.focus.y),
    ));
    this.sky.update(camera, this.elapsed);
    this.ocean.uniforms.uSunDirection.value.copy(this.sky.sunDirection);
    this.ocean.uniforms.uSunColor.value.copy(this.sky.sunLight.color);
    const su = this.sky.sky.material.uniforms;
    this.ocean.setSkyColors(su.uHorizonColor.value, su.uZenithColor.value);
    // Keep the ocean's copy of the cloud field identical to the sky's, or the
    // shadows on the water will drift away from the clouds casting them.
    this.ocean.uniforms.uCloudCoverage.value = su.uCloudCoverage.value;
    this.ocean.uniforms.uCloudiness.value = su.uCloudiness.value;

    // Atmospheric extinction, tied to the meteorological visual range the weather
    // system is reporting rather than to an arbitrary art number — the same figure
    // the lookout would give you in miles.
    // FALLBACK ONLY.
    //
    // This ran unconditionally, a hundred and sixty lines after the weather block
    // had already set the real visibility from weatherSys.state.visNm — so it
    // overwrote it every single frame with a coarse value derived from a
    // clamped factor. The measured result was 58,979 m of visibility in a gale
    // that the sim itself was reporting as 6,482 m: the game ran permanently
    // clearer than its own CLEAR regime, and no weather state could ever close
    // the horizon down. Only reach for this when there is no weather system to
    // ask.
    if (!this.world.weatherSys) {
      this.ocean.setVisibility(this.world.weather.visFactor * 46000);
    }
    // uFogDensity is only used by the legacy near-field paths now; the actual
    // aerial perspective is integrated through an exponential atmosphere in the
    // shaders (see opticalDepth), which is what keeps the tactical view from
    // altitude legible instead of a flat white wash.
    // Read back whatever visibility actually ended up on the shader, rather than
    // recomputing it from the fallback that no longer runs.
    const vis = Math.max(1200, this.ocean.uniforms.uVisibility.value);
    this.ocean.uniforms.uFogDensity.value = clamp(3.912 / vis, 0.000004, 0.0008);
  }

  _updateOrdnance(dt, world, cam) {
    const live = new Set();
    for (const o of world.weapons) {
      if (!o.alive) continue;
      const d = Math.hypot(o.x - cam.focus.x, o.z - cam.focus.y);
      const bubble = Math.max(this.bubble, cam.mode === 'MISSILE' ? 200000 : 0);
      if (bubble <= 0 || d > bubble * 1.4) continue;
      live.add(o);
      let v = this.ordViews.get(o);
      if (!v) { v = this._makeOrdView(o); this.ordViews.set(o, v); }
      const x = cam.rx(o.x), z = cam.rz(o.z);
      const y = (o.category === 'TORPEDO' ? Math.min(-2, o.alt) : Math.max(1.5, o.alt)) - cam.drop(x, z);
      v.group.position.set(x, y, z);
      v.group.rotation.set(0, o.heading, 0);
      if (v.pitchNode) {
        const climb = (v._lastY === undefined) ? 0 : (y - v._lastY) / Math.max(1e-3, dt);
        v._lastY = y;
        v.pitchNode.rotation.x = clamp(-Math.atan2(climb, Math.max(20, o.speed)), -0.8, 0.8);
      }
      if (v.trail) {
        v._tt = (v._tt || 0) + dt;
        if (v._tt > 0.045) {
          v._tt = 0;
          // Start the trail BEHIND the round, not at its centre. A billboarded
          // ribbon whose newest sample is inside the missile draws a hairline
          // straight through the body — which from the weapon camera is exactly
          // what it looked like: an orange line stabbed through the airframe.
          const back = (o.def.length || 9) * 0.6 + 3;
          const sh = Math.sin(o.heading), ch = Math.cos(o.heading);
          v.trail.addSample(
            new THREE.Vector3(x - sh * back, y, z - ch * back),
            this.elapsed, { spd: o.speed },
          );
        }
        v.trail.update(this.elapsed, cam.camera);
      }
      const hot = o.phase === 'BOOST' ? 1.35 : 0.75;
      if (v.glow) {
        const cruise = (o.def.speed || 900) < 380;
        const base = cruise ? 0.5 : ((o.def.warhead || 200) > 400 ? 1.7 : 0.8);
        v.glow.scale.setScalar(base * hot * (0.85 + Math.random() * 0.3));
      }
      if (v.flame) {
        const f = hot * (0.8 + Math.random() * 0.4);
        v.flame.scale.set(f, f, f);
        v.flame.material.opacity = 0.5 + 0.35 * Math.random();
      }
      // Rocket motor puffs, close in only — they are expensive and invisible at range.
      if (o.category !== 'TORPEDO' && cam.dist < 9000 && d < 12000) {
        v._puff = (v._puff || 0) + dt;
        if (v._puff > 0.06) {
          v._puff = 0;
          this.fx.motorPuff(
            new THREE.Vector3(x - Math.sin(o.heading) * 4, y, z - Math.cos(o.heading) * 4),
            new THREE.Vector3(-Math.sin(o.heading), 0, -Math.cos(o.heading)),
            { hot: o.phase === 'BOOST' ? 1.4 : 0.7, size: o.def.speed > 600 ? 1.5 : 1 },
          );
        }
      }
    }
    for (const [o, v] of this.ordViews) {
      if (live.has(o)) continue;
      // Let the smoke trail hang in the air for a beat after the round is gone.
      v._fade = (v._fade || 0) + dt;
      if (v.group.parent) { this.scene.remove(v.group); }
      if (v.trail) v.trail.update(this.elapsed, cam.camera);
      if (v._fade > 4) {
        v.trail?.dispose();
        this.ordViews.delete(o);
      }
    }
  }

  /** Re-mesh in-flight ASMs once the modelled airframe finishes loading. */
  _upgradeOrdnanceMeshes() {
    if (!_asmTemplate) return;
    for (const [o, v] of this.ordViews) {
      if (o.category !== 'ASM' || !v.pitchNode || v.mesh?.userData?._asm) continue;
      if (v.mesh) {
        v.pitchNode.remove(v.mesh);
        v.mesh.traverse?.((m) => {
          if (m.isMesh && !m.userData._shared) { m.geometry?.dispose?.(); m.material?.dispose?.(); }
        });
      }
      const m = _asmTemplate.clone(true);
      m.scale.setScalar((o.def.warhead || 200) > 400 ? 11 : 5.5);
      m.userData._asm = true;
      v.pitchNode.add(m);
      v.mesh = m;
    }
  }

  _makeOrdView(o) {
    const g = new THREE.Group();
    const pitchNode = new THREE.Group();
    g.add(pitchNode);
    let mesh;
    const isTorp = o.category === 'TORPEDO';
    if (!isTorp && o.category === 'ASM') {
      // Modelled airframe if it has loaded; the procedural one until then, and
      // permanently if the file is missing. A round in flight is on screen for
      // minutes at a time in the weapon camera, so it is worth the swap.
      if (_asmTemplate) {
        mesh = _asmTemplate.clone(true);
        mesh.scale.setScalar((o.def.warhead || 200) > 400 ? 11 : 5.5);
        mesh.userData._asm = true;
      } else {
        _loadAsm(this);
        mesh = buildMissileMesh({
          length: (o.def.warhead || 200) > 400 ? 11 : 5.5,
          radius: (o.def.warhead || 200) > 400 ? 0.42 : 0.2,
          tone: o.side === SIDE.RED ? 'dark' : 'light',
          booster: false,
        });
      }
    } else if (isTorp) {
      mesh = buildTorpedoMesh({ length: 6, radius: 0.27 });
    } else {
      const big = (o.def.warhead || 200) > 400;
      mesh = buildMissileMesh({
        length: o.category === 'SAM' ? 5.2 : (big ? 11 : 5.5),
        radius: o.category === 'SAM' ? 0.17 : (big ? 0.42 : 0.2),
        tone: o.side === SIDE.RED ? 'dark' : 'light',
        // Only surface-launched interceptors still have their booster attached
        // where the player sees them. A cruise missile drops its booster in the
        // first seconds of flight, and leaving it modelled in cruise put a dark
        // stub on the tail that read, from the weapon camera, as half the round
        // being a different object.
        booster: o.category === 'SAM',
      });
    }
    pitchNode.add(mesh);
    this.scene.add(g);

    let trail = null;
    if (!isTorp) {
      let map = null;
      try { map = getSharedFoamTexture(); } catch (e) { /* optional */ }
      if (map) {
        const hot = o.def.speed > 600;
        // A sea-skimmer's trail is a thin thread, not a cloud. At nine metres
        // base width flaring to two and a half times that, a salvo six rounds
        // deep drew a row of fat tan puffs sitting on the horizon with no
        // airframe visible in any of them — the trail was an order of magnitude
        // wider than the missile it came off. A booster-burning SAM does throw a
        // real column, so that one stays fat.
        const sam = o.category === 'SAM';
        trail = new TrailRibbon(this.scene, {
          capacity: 190, life: sam ? 5 : 22,
          color: hot ? 0xd8d2c8 : 0xc9ccd0,
          map, orientation: 'billboard', uvRepeat: 1, renderOrder: 3,
          opacity: sam ? 0.85 : 0.30,
          widthFn: (age, life, uu) => (sam ? 6 : 1.5) * (0.3 + (1 - uu) * (sam ? 2.6 : 1.6)),
          alphaFn: (age, life) => Math.max(0, 1 - age / life) * (sam ? 0.75 : 0.42),
        });
      }
    } else {
      let map = null;
      try { map = getSharedWakeFoamTexture(); } catch (e) { /* optional */ }
      if (map) {
        trail = new TrailRibbon(this.scene, {
          capacity: 120, life: 26, color: 0xbfd6de, map,
          orientation: 'horizontal', uvRepeat: 5, renderOrder: 2, opacity: 0.3,
          widthFn: () => 5,
          alphaFn: (age, life) => Math.max(0, 1 - age / life) * 0.5,
        });
      }
    }

    // Rocket motor: a short tapered flame cone plus a small additive bloom, sat
    // behind the nozzle rather than over the airframe. A fat sprite parked on the
    // missile's centre hides the very thing the weapon camera exists to show.
    let glow = null;
    const isTorpedo = o.category === 'TORPEDO';
    if (!isTorpedo) {
      const big = (o.def.warhead || 200) > 400;
      const len = o.category === 'SAM' ? 5.2 : (big ? 11 : 5.5);
      const rad = o.category === 'SAM' ? 0.17 : (big ? 0.42 : 0.2);
      // A subsonic cruise missile is an air-breather on a small turbofan: what
      // comes out of the tailpipe is a short shimmer, not the six-metre white
      // lance a rocket motor throws. Getting this wrong made every sea-skimmer
      // in the weapon camera look like a firework.
      const cruise = (o.def.speed || 900) < 380;
      const flameLen = cruise ? len * 0.22 : len * 0.5;
      // A hard-edged cone with a flat colour reads as a paper party hat stuck on
      // the tail — which is what it looked like in the weapon camera. An exhaust
      // has no edge: it is bright and dense on the axis and fades to nothing at
      // the rim and along its length. Shade it that way, and fade the very base
      // out too so it does not meet the airframe in a visible ring.
      const flameMat = new THREE.ShaderMaterial({
        uniforms: {
          uHot: { value: new THREE.Color(cruise ? 0xffb066 : (o.def.speed > 600 ? 0xfff2d0 : 0xffc98a)) },
          uTip: { value: new THREE.Color(cruise ? 0xff6a1e : 0xffa040) },
          uGain: { value: cruise ? 0.5 : 0.95 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUvF;
          varying vec3 vNrmF;
          varying vec3 vViewF;
          void main() {
            vUvF = uv;
            vNrmF = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vViewF = -mv.xyz;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uHot; uniform vec3 uTip; uniform float uGain;
          varying vec2 vUvF; varying vec3 vNrmF; varying vec3 vViewF;
          void main() {
            // Along the cone: 0 at the nozzle, 1 at the tip of the plume.
            float t = clamp(1.0 - vUvF.y, 0.0, 1.0);
            // Edge-on the plume is thickest — the classic volumetric cue, and it
            // is what removes the hard silhouette.
            float rim = 1.0 - abs(dot(normalize(vNrmF), normalize(vViewF)));
            float body = pow(1.0 - t, 1.7) * (0.35 + 0.85 * rim);
            body *= smoothstep(0.0, 0.14, t);      // no ring at the nozzle lip
            vec3 c = mix(uHot, uTip, t);
            gl_FragColor = vec4(c, clamp(body * uGain, 0.0, 1.0));
          }`,
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      });
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(rad * (cruise ? 1.05 : 0.95), flameLen, 16, 1, true),
        flameMat,
      );
      // Cone apex is +Y; a quarter turn the other way points it AFT, which is
      // where a rocket's plume goes.
      flame.rotation.x = -Math.PI / 2;
      flame.position.z = -len * 0.46 - flameLen * 0.5;
      pitchNode.add(flame);
      try {
        const dot = getSharedDotTexture();
        glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: dot, color: o.def.speed > 600 ? 0xfff0c0 : 0xffb060,
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55,
        }));
        glow.scale.setScalar(rad * 4);
        glow.position.z = -len * 0.55;
        pitchNode.add(glow);
      } catch (e) { /* optional */ }
      g.userData.flame = flame;
      g.userData.flameScale = 1;
    }

    return { group: g, mesh, trail, glow, pitchNode, flame: g.userData.flame };
  }

  /** Put a scar on a hull that has just been hit. */
  markDamage(unit, fromX, fromZ) {
    const v = this.views.get(unit);
    if (v) v.addDamage(fromX, fromZ);
  }

  /** Spawn a detonation at a sim-space position. */
  boom(x, z, alt, { scale = 1, underwater = false, airburst = false } = {}) {
    const rx = this.cam.rx(x), rz = this.cam.rz(z);
    const p = new THREE.Vector3(rx, alt - this.cam.drop(rx, rz), rz);
    const e = new Explosion(this.scene, p, { scale, underwater, airburst });
    this.explosions.push(e);
    return e;
  }

  splash(x, z, scale = 1) {
    this.fx.seaSpray(new THREE.Vector3(this.cam.rx(x), 1, this.cam.rz(z)), new THREE.Vector3(0, 1, 0), { scale });
  }

  launchCloud(x, z, alt, dir, scale = 1) {
    this.fx.launchCloud(
      new THREE.Vector3(this.cam.rx(x), alt, this.cam.rz(z)),
      new THREE.Vector3(Math.sin(dir), 0.3, Math.cos(dir)), { scale },
    );
  }
}
