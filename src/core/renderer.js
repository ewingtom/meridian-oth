import * as THREE from 'three';
import { SkyLayerPass, SKY_LAYER } from './SkyLayerPass.js';
import { PipView } from './PipView.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { CheapBloomPass } from './CheapBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

// UnrealBloomPass's internal mip-chain composite leaves renderer.setViewport()/
// setScissor()/setScissorTest() pointed at one of its small blur-mip rectangles
// instead of restoring the full frame. Every pass after it renders to a real
// WebGLRenderTarget (which carries its own always-correct .viewport/.scissor), so
// nothing else notices — except the final pass, which renders to the screen
// (renderTarget === null), and for that case three.js reuses whatever viewport/scissor
// was last set on the renderer rather than the full drawing-buffer size. Net effect:
// the composer path silently draws into a small scissored corner of the canvas every
// frame. This no-op pass restores full viewport and disables the scissor test right
// after bloom, before anything else can inherit the stale state.
class ViewportRestorePass extends Pass {
  constructor(renderer) {
    super();
    this.needsSwap = false;
    this._renderer = renderer;
  }
  render(renderer) {
    const size = renderer.getSize(ViewportRestorePass._v2);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.setScissorTest(false);
  }
}
ViewportRestorePass._v2 = new THREE.Vector2();

export const VIGNETTE_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uVignetteStrength: { value: 0.22 },
    uGrainAmount: { value: 0.0 },
    uTime: { value: 0 },
    uContrast: { value: 1.03 },
    uSaturation: { value: 1.06 },
    uExposure: { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVignetteStrength;
    uniform float uGrainAmount;
    uniform float uTime;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uExposure;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5453123); }

    /*
     * TONE MAPPING LIVES HERE, because it lives nowhere else.
     *
     * renderer.toneMapping is set to ACESFilmic and toneMappingExposure to 1.3,
     * and neither has ever done anything. three.js only compiles tone mapping
     * into a material when it is rendering to the CANVAS; render through an
     * EffectComposer into a target and every material is compiled with
     * NoToneMapping instead. Reading the compiled hull shader back off the GL
     * context confirms it: no toneMappingExposure uniform, no ACES code, just
     * the empty stub. Sweeping the exposure knob across eight stops moved the
     * whole-frame mean from 31.9 to 31.8.
     *
     * So every physically-based material in the game has been writing LINEAR
     * radiance into the buffer and having it sent to an sRGB display with no
     * transfer function at all. An 18% grey card came out at sRGB 21 instead of
     * about 118. That is a factor of six, it is the same factor everywhere, and
     * it is the real reason four consecutive art reviews found the ships black —
     * every fix aimed at the albedo, the ambient occlusion, the image-based
     * lighting or the atlas was aimed at the wrong thing, because none of those
     * was ever more than a rounding error next to a missing transfer function.
     */
    vec3 acesFilmic(vec3 x) {
      // Narkowicz's fit — visually indistinguishable from the full RRT/ODT here
      // and a fraction of the cost.
      const float a = 2.51, b = 0.03, c2 = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c2 * x + d) + e), 0.0, 1.0);
    }
    /*
     * Bright colours have to lose their saturation on the way to white.
     *
     * The Narkowicz fit is applied per channel, so each one saturates on its own
     * schedule. Where a warm highlight sits on a blue sky the red channel reaches
     * one first and the clamp holds it there while green and blue keep climbing —
     * so the sum reads pink, then yellow-green further in as green catches up.
     * A dawn frame showed exactly that around the sun: a white core inside a
     * yellow-green ring inside a magenta halo. Nothing in the scene is magenta.
     *
     * The full ACES RRT carries a glow module and a highlight desaturation that
     * do this properly; the fit drops both. Approximate it by pulling the channel
     * ratios toward equal as the peak channel goes past one, which is also how
     * film behaves: an overexposed highlight of any hue ends up white.
     */
    vec3 desaturateHighlights(vec3 c) {
      float peak = max(max(c.r, c.g), c.b);
      if (peak <= 1.0) return c;
      vec3 ratio = c / peak;
      // Full saturation at the knee, falling as the peak climbs above it. The
      // 0.55 puts a three-stop overexposure at roughly a quarter saturation.
      float s = 1.0 / (1.0 + (peak - 1.0) * 0.55);
      return mix(vec3(1.0), ratio, s) * peak;
    }
    vec3 linearToSRGB(vec3 c) {
      return mix(c * 12.92,
                 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }
    /*
     * Interleaved-gradient noise.
     *
     * A sine-fract hash sampled on the pixel lattice is not white noise — it is
     * a REGULAR PATTERN, and both the grain and the anti-banding dither below
     * were laying a fixed diagonal crosshatch over every gradient in the frame.
     * An art review found it at 100% zoom on the sky. IGN is built to be sampled
     * exactly this way and has no visible structure at any scale.
     */
    float ign(vec2 p, float t) {
      vec3 m = vec3(0.06711056, 0.00583715, 52.9829189);
      return fract(m.z * fract(dot(p + vec2(t * 5.588238, t * 3.301), m.xy)));
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      // BRING HDR INTO RANGE BEFORE GRADING. This is not a nicety.
      //
      // The buffer this reads is half-float and genuinely carries values above
      // one: the sky is toneMapped:false and writes the sun disc at thirty-four
      // times white so that bloom, which runs before this pass, has something to
      // bloom. The S-curve below is the smoothstep polynomial, and smoothstep is
      // only monotonic on [0,1]. At c = 34 it evaluates to -75,140.
      //
      // So the brightest thing in the frame came out of this pass as a large
      // negative number and clamped to black — the sun rendered as a dark hole
      // in the middle of its own glare, red channel first because the sun colour
      // is warm. An art review reported it as "there is no sun", across sixty-
      // nine frames and every sun elevation tested.
      //
      // Everything downstream of bloom is display-referred, so range-limiting
      // here is correct as well as necessary. Roll off rather than hard-clip, so
      // the disc keeps a bright core with a gradient into the glare instead of a
      // flat white plate with a hard edge.
      // Linear radiance in; display-referred out. ACES handles the range that
      // the hand-rolled rolloff used to (the sky writes the sun disc at thirty-
      // four times white so bloom has something to work with), and it does it
      // with a shoulder rather than a hard knee.
      c = desaturateHighlights(c * uExposure);
      c = acesFilmic(c);
      c = linearToSRGB(c);
      c = clamp(c, 0.0, 1.0);

      vec3 sCurve = c * c * (3.0 - 2.0 * c);
      c = mix(c, sCurve, 0.12);
      c = (c - 0.5) * uContrast + 0.5;
      // Shadow lift. ACES plus a bright sky drives deep shadows to zero, and a
      // deck under an overcast is not black — it is a dim, cool, still-readable
      // grey. Lift the toe without touching anything above about a fifth.
      c = c + (1.0 - smoothstep(0.0, 0.20, c)) * vec3(0.016, 0.019, 0.026);
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, uSaturation);
      float shadowW = 1.0 - smoothstep(0.0, 0.5, luma);
      float highlightW = smoothstep(0.5, 1.0, luma);
      c += vec3(-0.008, -0.003, 0.01) * shadowW + vec3(0.01, 0.004, -0.01) * highlightW;
      vec2 d = vUv - 0.5;
      c *= 1.0 - dot(d, d) * uVignetteStrength;
      // Always-on luma dither — breaks fog/sky gradient banding left in the post chain
      float dither = (ign(gl_FragCoord.xy, uTime) - 0.5) * (1.0 / 255.0) * 2.5;
      c += dither;
      if (uGrainAmount > 0.0001) {
        float g = (ign(gl_FragCoord.xy, uTime * 13.0 + 7.0) - 0.5) * uGrainAmount;
        c += g;
      }
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

// Hardware MSAA on the canvas. Overridable from the URL (?aa=0) purely so a
// headless capture harness can turn it off — a multisampled default framebuffer
// cannot be read back, so drawImage/readPixels come back empty with it on.
const AA_ON = (() => {
  try { return new URLSearchParams(location.search).get('aa') !== '0'; } catch (e) { return true; }
})();

/** The four graphics presets, cheapest first. */
export const QUALITY_TIERS = ['low', 'medium', 'high', 'exquisite'];

export class RenderPipeline {
  constructor(canvas) {
    // MSAA on the CANVAS.
    //
    // This game renders straight to the canvas: the post chain is off by default
    // (see setQuality — the composer has never produced a correct frame and is
    // opt-in until it does), so the canvas's own multisampling is the AA that
    // actually runs. It was switched off on the assumption that the composer
    // owned the frame and FXAA would cover it — with the result that every mast,
    // yardarm, railing and missile fin in the game stair-stepped, which is what
    // an art review found on every silhouette in the build. Hardware MSAA is
    // both cheaper and far better than FXAA at exactly that job.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: AA_ON,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // Soft PCF over hard PCF — hull/deck contact shadows in chase/helm views were
    // reading with a hard stair-stepped edge that telegraphs "real-time shadow map".
    // Soft filtering costs a few extra taps but is the cheapest single step toward a
    // photographic shadow.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.composer = null;
    this.fxaaPass = null;
    this.gradePass = null;
    this.bloomPass = null;
    this.ssaoPass = null;
    this._quality = 'medium';
    this._wantComposer = false;
    this._useComposer = true;
    this._composerHealthy = false;
    this._probeFrames = 0;
    this._sunLight = null;

    // ── dynamic resolution ────────────────────────────────────────────────
    // The post stack and the ocean shader are both fill-rate bound, so the one
    // knob that reliably buys frame time is the number of pixels shaded. Rather
    // than pick a fixed pixel ratio and hope it suits every machine, measure the
    // frame time and let the render scale float underneath the quality tier's
    // cap. Console games have done this for fifteen years for exactly this
    // reason: a soft 8% resolution change is invisible in motion, and a frame
    // that misses vsync is not.
    this._basePr = 1;
    this._dynScale = 1;
    this._dynMin = 0.62;
    this._frameEma = 16.7;
    this._lastFrameT = 0;
    this._dynCooldown = 0;
    this.dynamicResolution = true;
  }

  /** Optional DirectionalLight used for quality-driven shadow map size. */
  bindSunLight(light) {
    this._sunLight = light;
  }

  setup(scene, camera) {
    this._scene = scene;
    this._camera = camera;
    this.skyPass = new SkyLayerPass(this.renderer, scene, camera);
    this.pip = new PipView(this.renderer, scene);

    const w = window.innerWidth;
    const h = window.innerHeight;

    try {
      const renderPass = new RenderPass(scene, camera);
      // Contact occlusion — kills the plastic "floating graybox" look on deck recesses.
      // Measured live: at full-res/32-sample defaults this alone nearly HALVED frame
      // rate under combat load (26.6fps with it off vs 14.1fps on, same scene) — a
      // severe cost for a subtle effect, and the direct cause of user-reported choppy/
      // unplayable framerates. Half resolution (same proven-safe trick already used for
      // bloom below) plus a much smaller sample kernel (16 vs the default 32) cuts the
      // per-pixel cost roughly 8x combined, while still selling the contact-shadow read.
      // GTAO, not SSAO.
      //
      // three.js's SSAOPass was in the pipeline and producing NOTHING: probed at
      // render time its normal pre-pass came back pure black and its AO term was
      // 1.0 across the whole frame, which is exactly what three consecutive art
      // reviews reported — "no ambient occlusion anywhere in the build, every
      // internal corner exactly as bright as the open faces". Ground-truth
      // ambient occlusion builds its own depth/normal G-buffer and is the
      // better-maintained pass; it also actually respects a world-space radius,
      // which is what let the old one be mis-tuned into invisibility.
      this.ssaoPass = new GTAOPass(scene, camera, w * 0.5, h * 0.5);
      this.ssaoPass.output = GTAOPass.OUTPUT.Default;
      this.ssaoPass.blendIntensity = 0.85;
      // OFF unless the quality tier asks for it. Ground-truth AO is a depth and
      // normal pre-pass plus a denoise over the whole frame, and this game is
      // already spending its budget on the water. The assets carry baked
      // ambient occlusion in COLOR_0, which costs nothing.
      this.ssaoPass.enabled = false;
      // Half-res bloom: ~4× cheaper mip chain, still sells soft specular bloom.
      // NOT UnrealBloomPass. Measured at 1280x720 on the target machine it was
      // 20.6 ms of a 35.7 ms frame — fifty-eight percent of everything the
      // renderer did, for a glow around the sun. It builds a five-level mip
      // pyramid and runs a thirteen-tap separable blur at every level on
      // half-float targets, which lands on a slow path here; its own reported
      // resolution had also drifted to 298x338, an aspect the frame never had.
      // Bloom is a low-frequency effect and does not need any of that.
      this.bloomPass = new CheapBloomPass({ strength: 0.55, threshold: 0.82, radius: 1.0 });
      this.gradePass = new ShaderPass(VIGNETTE_GRADE_SHADER);
      this.fxaaPass = new ShaderPass(FXAAShader);
      const pr = this.renderer.getPixelRatio();
      this.fxaaPass.material.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));

      // MULTISAMPLED composer target.
      //
      // The canvas's own `antialias` flag does nothing once EffectComposer owns
      // the frame — the composer renders into its own target and the canvas is
      // only ever a full-screen blit — which is why this was switched off and
      // FXAA left to carry the whole load. FXAA is a post-process on a resolved
      // image: it cannot recover a sub-pixel mast, a railing stanchion or a
      // missile fin, because by the time it runs that geometry has already been
      // quantised to one sample per pixel. An art review counted the resulting
      // stair-stepping on every silhouette in the build.
      //
      // WebGL2 can multisample the composer's own render target, which is the
      // one place it actually helps. Four samples on the scene pass, FXAA still
      // on the end for the shader-aliased edges MSAA cannot see (specular
      // sparkle, alpha-tested rigging).
      const msaaTarget = new THREE.WebGLRenderTarget(
        Math.max(1, Math.floor(w * pr)), Math.max(1, Math.floor(h * pr)),
        {
          type: THREE.HalfFloatType,
          // NO MSAA by default — see _applyMsaa. Measured at 11.9 ms on a 25 ms
          // frame, which is not a price antialiasing can justify when FXAA is
          // already in the chain doing most of the same job.
          samples: 0,
        },
      );
      this.composer = new EffectComposer(this.renderer, msaaTarget);
      this.composer.setPixelRatio(pr);
      this.composer.addPass(renderPass);
      this.composer.addPass(this.ssaoPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new ViewportRestorePass(this.renderer));
      // NO OutputPass.
      //
      // OutputPass exists to apply tone mapping and the sRGB transfer at the end
      // of a LINEAR post chain. This chain is not linear: RenderPass renders
      // through the renderer's own ACES tone mapping and sRGB output, and the
      // ocean, sky and cloud shaders are all authored `toneMapped: false`, which
      // means they write display-referred colour directly. Putting an OutputPass
      // on the end tone-mapped and gamma-encoded an already-encoded frame — the
      // whole image came back pure white. The chain here operates on an already
      // display-referred image by design.
      this.composer.addPass(this.gradePass);
      this.composer.addPass(this.fxaaPass);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[RenderPipeline] composer setup failed', err);
      this.composer = null;
    }

    this.setQuality(this._quality);
  }

  /**
   * Apply a graphics preset. medium is the smoothness default; high/exquisite opt into
   * the expensive post stack and denser shading.
   */
  setQuality(q) {
    if (!QUALITY_TIERS.includes(q)) q = 'high';
    this._quality = q;
    const dpr = window.devicePixelRatio || 1;
    // The entire post stack (SSAO, bloom, grade, FXAA) plus the dense ocean shader
    // renders at this pixel ratio, so on a Retina panel a cap of 1.65 was pushing
    // ~2.5 M shaded pixels/frame and dominating frame time. Trimmed the caps: the
    // extra super-sampling was a small crispness gain for a large fill-rate cost.
    // These caps were tuned when the composer was silently switched off and the
    // game was doing a single raw render. With the post chain actually running —
    // a multisampled scene pass plus bloom, tone map, grade and FXAA over the
    // whole frame — a 1.4 pixel ratio on a Retina panel is two million shaded
    // pixels through five passes, on top of an ocean shader that is already the
    // most expensive thing in the frame. Native is the default; super-sampling
    // is an explicit Ultra choice.
    // Four tiers. The render scale is the single biggest lever on frame time,
    // because the ocean shader is the expensive thing and it fills the screen.
    const caps = {
      low: 0.8,
      medium: 1,
      high: Math.min(1.15, dpr),
      // Not 1.5. Exquisite also turns on 2x MSAA, renders the sky at full
      // resolution instead of half, and grows the shadow map — and 1.5x
      // supersampling on top of MSAA is paying twice for the same edges. Stacked,
      // the cost pushed the dynamic controller into cutting resolution so hard
      // that the top tier rendered 1.13 MP against high's 1.22: strictly fewer
      // pixels, at 49 fps instead of 61. Spend the budget on the effects that
      // high does not have and leave a little headroom so the controller holds.
      exquisite: Math.min(1.25, dpr),
    };
    this._basePr = caps[q] ?? caps.medium;
    this._dynScale = 1;
    this.renderer.setPixelRatio(this._basePr);

    // Post-processing: on everywhere except Low.
    //
    // For most of this project's life a probe in render() kept the composer
    // switched off and silently fell back to a raw render, so bloom, the colour
    // grade and the vignette never once appeared on screen and every visual
    // decision was made against an ungraded frame.
    //
    // It briefly looked as though the composer itself was broken — it appeared
    // to render pure white. It was not. That was two separate measurement
    // failures stacked on top of each other: the GPU process had been starved
    // into a state where it accepted commands and executed none, and the capture
    // path was reading back an offscreen target that the composer, which renders
    // to its own buffers, had never written to. Verified working against a
    // healthy context: the chain renders correctly and costs a few milliseconds
    // in a frame with roughly eleven to spare.
    const usePost = q !== 'low';
    this._wantComposer = usePost && !!this.composer;
    this._useComposer = this._wantComposer;
    this._composerHealthy = false;
    this._composerFail = 0;
    this._probeFrames = 0;

    // MSAA is an Exquisite-only luxury.
    //
    // Multisampling a half-float target costs bandwidth on every scene pixel,
    // and this scene is mostly a full-screen ocean shader. Measured at a
    // verified 1280x720 buffer it was 11.94 ms of a 27.23 ms frame — 27.23 ms
    // with it, 15.29 ms without, or 38 fps against 65. Compared frame for frame
    // the difference is slight, because FXAA is already in the chain and the
    // thin geometry it helps most with (masts, rigging) is a small part of the
    // image. Half the frame rate is not a fair trade for that.
    this._applyMsaa(q === 'exquisite' ? 2 : 0);

    // Exquisite renders the sky at full resolution; everything else halves it.
    if (this.skyPass) {
      this.skyPass.scale = q === 'exquisite' ? 1.0 : 0.5;
      this.skyPass.enabled = q !== 'exquisite';
    }

    if (this.ssaoPass) {
      // ULTRA only. Ground-truth AO is a full-frame depth + normal pre-pass and
      // a poisson denoise on top of a pipeline whose ocean shader is already the
      // expensive thing in the frame. It also currently blacks out the sky (the
      // sky writes no depth, so the AO term discards and the pass composites the
      // cleared value over it), so it stays off until that is dealt with.
      this.ssaoPass.enabled = false && (q === 'exquisite');
      // kernelRadius, minDistance and maxDistance are all in VIEW-SPACE METRES.
      // They were set as though they were normalised depth: a 20 m sampling
      // kernel that only counted occluders between 0.4 mm and 16 cm of depth
      // difference, which is why every recess on every ship rendered at full
      // ambient and the hulls read as flat cut-outs. Real values are set per
      // frame in _tuneAO() because the right radius depends on how far away the
      // subject is.
      this._aoQuality = q;
      this._tuneAO();
    }
    if (this.bloomPass) {
      // A judge once flagged bloom turning waterline/wake into emissive glow. The fix
      // that landed disabled bloom outright instead of raising the threshold — which
      // throws out real, explicitly-requested bloom on the sun/explosions/muzzle
      // flashes along with the wake glow it was actually meant to fix. threshold=0.92
      // (only near-white pixels bloom) + strength=0.08 already excludes the water/wake
      // (which never gets that bright); re-enable bloom using those already-tuned,
      // conservative values instead of cutting the effect entirely.
      // Bloom was throttled almost to nothing to stop the wake glowing. The wake
      // no longer gets anywhere near this threshold, and the cost of the caution
      // was a sun with no glow, muzzle flashes with no bite and explosions that
      // did not read as bright. Open it back up.
      this.bloomPass.enabled = usePost;
      // Strength is on a different scale to UnrealBloomPass's: this composites a
      // single blurred bright-pass rather than a weighted mip pyramid, so the
      // same visible glow needs a larger number.
      this.bloomPass.strength = q === 'exquisite' ? 0.62 : 0.52;
      this.bloomPass.threshold = 0.84;
      this.bloomPass.radius = q === 'exquisite' ? 1.4 : 1.0;
    }
    if (this.gradePass) {
      this.gradePass.enabled = usePost;
      this.gradePass.uniforms.uGrainAmount.value = q === 'exquisite' ? 0.012 : (q === 'high' ? 0.006 : 0.003);
      this.gradePass.uniforms.uVignetteStrength.value = q === 'exquisite' ? 0.26 : 0.2;
      this.gradePass.uniforms.uContrast.value = q === 'low' ? 1.0 : 1.14;
      this.gradePass.uniforms.uSaturation.value = q === 'low' ? 1.0 : 1.12;
    }
    if (this.fxaaPass) this.fxaaPass.enabled = usePost;

    if (q === 'low') {
      this.renderer.shadowMap.enabled = false;
      this.renderer.shadowMap.type = THREE.BasicShadowMap;
    } else if (q === 'exquisite') {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    } else {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    if (this._sunLight) {
      // Shadow-map resolution per tier. These were 4096/3072/2048 — a 4096² map is
      // 16 M texels re-rendered over every shadow-caster each frame, a large steady
      // GPU cost for shadow detail few players notice on a fast-moving warship.
      // Halved-ish: crisp enough for deck/superstructure contact shadows, far cheaper.
      const map = q === 'exquisite' ? 2560 : q === 'high' ? 2048 : q === 'medium' ? 1536 : 512;
      if (this._sunLight.shadow.mapSize.x !== map) {
        this._sunLight.shadow.mapSize.set(map, map);
        this._sunLight.shadow.map?.dispose();
        this._sunLight.shadow.map = null;
      }
      this._sunLight.castShadow = q !== 'low';
      // Slightly wider frustum on medium so escorts in formation still cast; high/exquisite
      // stay tight for crisp hero deck/superstructure contact shadows.
      this._sunLight.userData.shadowHalfExtent = q === 'medium' ? 220 : q === 'low' ? 280 : 165;
    }

    // Slight exposure lift on High for glitter / ocean specular
    // Drive the exposure that is actually connected to something. The renderer's
    // own toneMappingExposure is inert while the composer owns the frame (see
    // the note in VIGNETTE_GRADE_SHADER); keep it in step for the raw path.
    // Shadow map, bloom radius and grain already key off the tier; make the
    // heavier ones do so too, so the tiers are not byte-identical at equal
    // resolution as an art review measured.
    if (this.gradePass) {
      this.gradePass.uniforms.uVignetteStrength.value = q === 'low' ? 0.10 : 0.22;
    }
    const exposure = q === 'exquisite' ? 1.34 : q === 'high' ? 1.30 : 1.22;
    this.renderer.toneMappingExposure = exposure;
    if (this.gradePass) this.gradePass.uniforms.uExposure.value = exposure;

    this.resize();
  }

  /** Set multisampling on the composer's targets, recreating them if it changed. */
  _applyMsaa(samples) {
    if (!this.composer) return;
    const t1 = this.composer.renderTarget1, t2 = this.composer.renderTarget2;
    if (!t1 || t1.samples === samples) return;
    t1.samples = samples; t2.samples = samples;
    // three.js reallocates the framebuffer on next use after a dispose, which is
    // how a sample-count change actually takes effect.
    t1.dispose(); t2.dispose();
  }

  /**
   * Opt into the post-processing chain. Development only for now — see the note
   * in setQuality about why it is not the default.
   */
  enablePost(on = true) {
    this._postOptIn = on;
    this.setQuality(this._quality);
    return this._wantComposer;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = this._basePr * this._dynScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
    }
    // Composer.setSize resets bloom to full-res; force half-res for the mip chain.
    // The pass downsamples to a quarter of each axis internally, so hand it the
    // real frame size rather than a pre-halved one.
    if (this.bloomPass) this.bloomPass.setSize(w, h);
    if (this.ssaoPass) this.ssaoPass.setSize(w * 0.5, h * 0.5);
    if (this.fxaaPass) {
      this.fxaaPass.material.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));
    }
  }

  /**
   * Walk every material that has been compiled so far and report any program
   * that failed to link. WebGL reports a broken custom shader only as a stream
   * of "useProgram: program not valid" warnings with no indication of which
   * material or which line — so an ocean that vanished because of a single
   * undeclared uniform looks, from the console, exactly like a rendering bug.
   */
  validateShaders(scene) {
    const gl = this.renderer.getContext();
    const props = this.renderer.properties;
    const seen = new Set();
    const bad = [];
    const check = (mat, label) => {
      if (!mat || seen.has(mat.uuid)) return;
      seen.add(mat.uuid);
      const pr = props.get(mat);
      if (!pr || !pr.programs) return;
      for (const p of pr.programs.values()) {
        if (gl.getProgramParameter(p.program, gl.LINK_STATUS)) continue;
        const logs = (gl.getAttachedShaders(p.program) || [])
          .map(sh => gl.getShaderInfoLog(sh))
          .filter(Boolean).join(' | ');
        bad.push(`${label} (${mat.type}${mat.name ? ' "' + mat.name + '"' : ''}): ${logs}`);
      }
    };
    scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) check(m, o.name || o.type);
    });
    if (bad.length) {
      // eslint-disable-next-line no-console
      console.error('[RenderPipeline] SHADER LINK FAILURE — these objects will not draw:\n' + bad.join('\n'));
    }
    return bad;
  }

  /**
   * Nudge the render scale to hold the frame budget. Deliberately sluggish:
   * one step at most every three quarters of a second, and only when the
   * long-run average is clearly on the wrong side of the target, so the picture
   * never visibly breathes in and out during a fight.
   */
  _tuneResolution() {
    if (!this.dynamicResolution) return;
    const now = performance.now();
    const dt = this._lastFrameT ? now - this._lastFrameT : 16.7;
    this._lastFrameT = now;
    if (dt > 250) return;                       // tab was backgrounded; ignore
    // React in about ten frames rather than thirty: the point of a dynamic
    // resolution controller is that the player never sees the slow frames, and a
    // controller that takes half a second to notice is one they do see.
    this._frameEma += (dt - this._frameEma) * 0.14;
    if (now < this._dynCooldown) return;

    /*
     * A vsync-capped frame time is not a load signal.
     *
     * The thresholds were TARGET + 1.6 to step down and TARGET - 3.5 to climb
     * back. With vsync on a 60 Hz panel every frame that makes its budget
     * measures 16.7 ms no matter how much headroom is left underneath, so the
     * climb condition of 13.2 ms could never once be true, while any single
     * hitch past 18.3 stepped the scale down for good. The controller was a
     * ratchet: it could only ever lose resolution.
     *
     * It had done exactly that. Measured at 1280x720, exquisite was rendering
     * 1190x669 while high rendered 1472x827 — the top tier had ground itself
     * down to below the tier beneath it, and could not climb back out.
     *
     * With vsync, frame times quantise: about 16.7 when the budget is made and
     * about 33.3 when it is missed. So the decision threshold belongs between
     * those two, not a millimetre above the first one. Step down only on a real
     * miss, and let it climb whenever the frame is still landing on the refresh.
     */
    const TARGET = 16.7;
    const DROP_AT = TARGET * 1.26;              // 21.0 — genuinely missing vsync
    const CLIMB_UNDER = TARGET * 1.10;          // 18.4 — still landing on it
    let next = this._dynScale;
    // Step down in proportion to how far over budget the frame is — one notch at
    // a time takes several cooldowns to climb out of a bad hole.
    if (this._frameEma > DROP_AT) {
      const over = this._frameEma / TARGET;
      next = Math.max(this._dynMin, this._dynScale - (over > 1.6 ? 0.18 : over > 1.25 ? 0.12 : 0.07));
    }
    else if (this._frameEma < CLIMB_UNDER) next = Math.min(1, this._dynScale + 0.05);
    if (Math.abs(next - this._dynScale) < 0.001) return;
    this._dynScale = next;
    this._dynCooldown = now + 450;
    this._frameEma = TARGET;                    // let the new scale prove itself
    this.resize();
  }

  /**
   * Ambient occlusion works in world metres, so its radius has to track the
   * scale the camera is actually looking at: a bridge-wing shot wants a
   * half-metre kernel that finds ladder rungs and door frames, while a shot of a
   * whole task force wants a several-metre one that shades the gap between a
   * deckhouse and a funnel. One fixed radius cannot do both.
   */
  _tuneAO(subjectDist) {
    if (!this.ssaoPass?.updateGtaoMaterial) return;
    const d = subjectDist ?? this._aoDist ?? 300;
    this._aoDist = d;
    // The radius is in WORLD METRES, so it has to scale with how far away the
    // subject is: a fixed radius that reads correctly on a deck fitting at
    // thirty metres does nothing at all on a hull at four hundred.
    const r = Math.min(9.0, Math.max(0.45, d * 0.014));
    this.ssaoPass.updateGtaoMaterial({
      radius: r,
      distanceExponent: 1.0,
      thickness: r * 0.6,
      scale: this._aoQuality === 'exquisite' ? 1.15 : 0.95,
      samples: this._aoQuality === 'exquisite' ? 16 : 10,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
  }

  /** Called from the frame loop with the camera's working distance. */
  setSubjectDistance(d) {
    if (Math.abs((this._aoDist || 0) - d) > d * 0.15) this._tuneAO(d);
  }

  render(elapsed) {
    this._tuneResolution();
    if (this.gradePass) this.gradePass.uniforms.uTime.value = elapsed;

    // Sky and clouds first, at half resolution, into their own target. The blit
    // quad in the scene carries the result and the main pass skips that layer.
    // The inset renders BEFORE the sky pass and the main frame, so the canvas is
    // left bound to the main output. It borrows the sky layer directly (see
    // PipView) rather than the blit quad, which belongs to the main camera.
    this.pip?.render(this.skyPass);

    this.skyPass?.render();

    if (!this._wantComposer || !this.composer) {
      this.renderer.render(this._scene, this._camera);
      this.skyPass?.restore();
      this.pip?.drawOverlay();
      return;
    }

    // The composer is the DEFAULT path, and the only thing that takes it away is
    // it actually failing.
    //
    // What used to be here rendered raw for a warm-up period and switched the
    // composer in only on the frame the counter hit exactly eight, guarded by a
    // flag that latched. Any early quality change reset the counter, any path
    // that turned the composer off again could never turn it back on, and the
    // build ran for a long time with ambient occlusion, bloom, the tone-map
    // output pass, the colour grade and FXAA ALL SILENTLY DISABLED — which is
    // precisely what three consecutive art reviews reported as "no ambient
    // occlusion anywhere" and "dynamic range is flat".
    //
    // A fallback that can silently delete half the renderer has to be much
    // harder to trip than that: run the composer, and only give up after it has
    // demonstrably drawn nothing many frames in a row.
    if (!this._useComposer) this._useComposer = true;

    // WebGLRenderer resets `info.render` at the top of every internal render() call,
    // and EffectComposer's later passes each do their own full-screen-quad render() —
    // so reading info.render.triangles right after composer.render() only ever reflects
    // that LAST quad. Disable autoReset and accumulate across all passes in this frame.
    const info = this.renderer.info;
    const prevAutoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    try {
      this.composer.render();
      this.skyPass?.restore();
      const total = info.render.triangles;
      if (total <= 10) {
        this._composerFail = (this._composerFail || 0) + 1;
        if (this._composerFail > 30) {
          this._useComposer = false;
          this._wantComposer = false;
          this._composerHealthy = false;
          // eslint-disable-next-line no-console
          console.warn('[RenderPipeline] composer output collapsed; using raw renderer');
        }
      } else {
        this._composerHealthy = true;
        this._composerFail = 0;
      }
    } catch (err) {
      this._useComposer = false;
      this._wantComposer = false;
      this.renderer.render(this._scene, this._camera);
      // eslint-disable-next-line no-console
      console.warn('[RenderPipeline] composer threw; raw fallback', err);
    } finally {
      info.autoReset = prevAutoReset;
    }

    // Composite last, straight onto the canvas, so no pass can grade it twice.
    this.pip?.drawOverlay();
  }
}
