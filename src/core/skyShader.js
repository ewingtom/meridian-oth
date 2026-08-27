import { Vector3, Color } from 'three';

/**
 * Hand-authored procedural sky: gradient (horizon -> zenith), sun disc + corona + halo,
 * and a soft animated cumulus cloud layer via fbm noise. Chosen over a raw physical
 * (Preetham) model because that model's calibration desaturates badly under normal
 * exposure (see git history / comments in sky.js) — an authored gradient is what
 * real AAA game skies use anyway, since it gives direct, reliable art control.
 */
export const SkyShader = {
  uniforms: {
    uSunDirection: { value: new Vector3(0, 0.5, -1) },
    uZenithColor: { value: new Color(0x1c4d86) },
    uHorizonColor: { value: new Color(0xaecbdd) },
    uSunColor: { value: new Color(0xfff2d6) },
    uCloudCoverage: { value: 0.40 },
    uGradeExposure: { value: 1.3 },
    uCloudField: { value: null },
    uCloudiness: { value: 0.95 },
    uCloudColorLit: { value: new Color(0xf4f7fb) },
    uCloudColorShadow: { value: new Color(0x394b60) },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      gl_Position.z = gl_Position.w;
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vWorldPosition;
    uniform vec3 uSunDirection;
    uniform vec3 uZenithColor;
    uniform vec3 uHorizonColor;
    uniform vec3 uSunColor;
    uniform float uCloudCoverage;
    uniform float uCloudiness;
    uniform vec3 uCloudColorLit;
    uniform vec3 uCloudColorShadow;
    uniform float uTime;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    /*
     * Dither noise for the sky gradient.
     *
     * The sine-and-fract hash above is fine as a scatter source but it is NOT a
     * dither: sampled on a regular pixel lattice it produces a regular pattern,
     * and multiplying the fragment coordinate by 0.37 first made that pattern a
     * coarse diagonal crosshatch laid over every gradient in the game. An art
     * review picked it out at 100% zoom on two separate frames.
     *
     * Interleaved-gradient noise is the standard answer: it is designed to be
     * sampled exactly this way, it has no visible structure at any scale, and
     * rolling it with the frame number turns what is left into temporal grain
     * the eye integrates away rather than a fixed screen artefact.
     */
    float ignDither(vec2 fragCoord, float t) {
      vec3 m = vec3(0.06711056, 0.00583715, 52.9829189);
      return fract(m.z * fract(dot(fragCoord + vec2(t * 5.588238, t * 3.301) , m.xy)));
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    // Full-detail fbm for the visible cloud silhouette / erosion.
    float fbm(vec2 p) {
      float v = 0.0, amp = 0.52;
      for (int i = 0; i < 5; i++) { v += amp * noise(p); p = p * 2.03 + vec2(1.7, 9.2); amp *= 0.5; }
      return v;
    }
    // Cheap 3-octave fbm reused by the sun light-march taps below (the shadow only
    // needs the coarse cloud mass, not the fine erosion detail, so paying for 5
    // octaves per tap would be wasted).
    float fbm3(vec2 p) {
      float v = 0.0, amp = 0.5;
      for (int i = 0; i < 3; i++) { v += amp * noise(p); p = p * 2.02 + vec2(3.1, 1.7); amp *= 0.5; }
      return v;
    }

    /**
     * Distance from the camera to a spherical shell at height h, along dir.
     * Handles the camera being both below the shell (the usual case, looking up
     * at a cloud base) and above it (a tactical camera at altitude looking down
     * on the tops). Returns -1 when the ray misses the shell entirely.
     */
    float shellHit(vec3 d, float hCam, float h, float Re) {
      float Rc = Re + hCam;
      float Rs = Re + h;
      float b = Rc * d.y;
      float c = Rc * Rc - Rs * Rs;
      float disc = b * b - c;
      if (disc < 0.0) return -1.0;
      float sq = sqrt(disc);
      if (c < 0.0) return -b + sq;        // camera below the shell
      if (d.y >= 0.0) return -1.0;        // above it and looking up: no hit
      return -b - sq;                     // above it, looking down at the tops
    }

    // Coarse cloud mass with domain warping. The warp is what turns blobby value
    // noise into billowing cumulus cauliflower shapes — it is the single biggest
    // difference between "procedural noise" and "clouds". thr is the coverage
    // threshold (WeatherSystem drives it; lower = cloudier). Reused for both the
    // displayed shape and the light-march occlusion taps so they agree.
    float cloudShape(vec2 uv, float thr) {
      // Large-scale coverage modulation: real skies are not a uniform deck, they
      // are fields of cloud with open lanes of blue between them. Without this the
      // sky reads as one continuous grey lid no matter how good the cell shapes are.
      float cover = fbm3(uv * 0.13 + 61.7);
      float t = clamp(thr + (cover - 0.5) * 0.42, -0.15, 0.85);
      // Domain warping is what turns blobby value noise into billowing cauliflower.
      vec2 w = vec2(fbm3(uv * 0.62 + 11.5), fbm3(uv * 0.62 + 27.1));
      vec2 uw = uv + (w - 0.5) * 2.9;
      float d = fbm3(uw);
      return clamp((d - t) / (1.0 - t), 0.0, 1.0);
    }

    /*
 * Exact inverse of the ACES fit the grade pass applies.
 *
 * This shader's palette is authored by eye, in display space. The grade pass
 * applies ACES and the sRGB transfer to the whole frame, so this surface has to
 * hand it something that comes back out looking as authored.
 *
 * The first attempt used pow(colour, 2.2), assuming linearise -> ACES -> sRGB
 * round-trips. It does not: ACES sits in the middle and compresses midtones, so
 * these surfaces were darkened TWICE and the darkest channel crushed hardest.
 * Measured on near water at a low eyepoint, red came out at exactly 0 — the
 * "foreground red channel hard-clipped to zero" an art review reported, and why
 * a low camera saw a near-black sea that looked correct from higher up.
 *
 * ACES is y = x(ax+b) / (x(cx+d)+e), so inverting is a quadratic:
 *   (yc - a)x^2 + (yd - b)x + ye = 0.  One sqrt, and the round trip is identity.
 */
uniform float uGradeExposure;
vec3 acesInverse(vec3 y) {
  const float ia = 2.51, ib = 0.03, ic = 2.43, id = 0.59, ie = 0.14;
  y = clamp(y, 0.0, 0.9999);
  vec3 A = y * ic - ia;
  vec3 B = y * id - ib;
  vec3 C = y * ie;
  vec3 disc = max(B * B - 4.0 * A * C, vec3(0.0));
  return max((-B - sqrt(disc)) / (2.0 * A), vec3(0.0));
}

void main() {
      vec3 dir = normalize(vWorldPosition - cameraPosition);
      float elevation = dir.y;

      // Dither AFTER the curve, never before it.
      //
      // This jitter exists to break Mach banding on the long horizon-to-zenith
      // ramp, and it was being added to the elevation and then pushed through
      // pow(x, 0.38). That curve's slope goes to infinity at the horizon: two
      // tenths of a degree up, its derivative is already about sixteen, so a
      // jitter meant to be worth a fraction of a level was being amplified into
      // plus or minus eight levels of colour. The result was a fifteen-pixel
      // band of crawling speckle sitting directly on the sea horizon in every
      // wide shot in the game — the dither WAS the artefact it was added to
      // prevent. Applying it to the mixed result instead keeps it at the one
      // least-significant bit it was always supposed to be, everywhere.
      float skyMix = pow(clamp(elevation, 0.0, 1.0), 0.38);
      skyMix += (ignDither(gl_FragCoord.xy, uTime) - 0.5) * 0.0055;
      vec3 sky = mix(uHorizonColor, uZenithColor, clamp(skyMix, 0.0, 1.0));

      // How grey has the weather made the sky? A storm horizon is neutral; a
      // fair-weather one is strongly blue. Everything warm below keys off this,
      // because adding a fixed warm tint to a neutral overcast is what turned
      // the whole sky KHAKI BROWN in a gale — the single loudest wrong colour in
      // the game.
      float wxGrey = 1.0 - clamp((uHorizonColor.b - uHorizonColor.r) * 6.0, 0.0, 1.0);
      float warmth = 1.0 - wxGrey * 0.92;

      // subtle extra warmth low near the horizon
      float lowBand = 1.0 - smoothstep(0.0, 0.22, elevation);
      sky = mix(sky, sky + vec3(0.05, 0.02, -0.02), lowBand * 0.5 * warmth);

      // Directional aerial-perspective haze: real skies are visibly brighter and warmer
      // in a band around the sun's azimuth near the horizon (forward Mie scattering),
      // and slightly darker/cooler on the anti-sun side. A horizonColor that's flat in
      // every direction is one of the biggest "cheap CG sky" tells — this breaks that up
      // and gives the sky a sense of depth/directionality without touching the base
      // gradient uniforms (still fully driven by uZenithColor/uHorizonColor).
      vec3 horizDirN = normalize(vec3(dir.x, 0.0, dir.z));
      vec3 horizSunN = normalize(vec3(uSunDirection.x, 0.0, uSunDirection.z));
      float sunAz = dot(horizDirN, horizSunN);
      float hazeBand = (1.0 - smoothstep(0.0, 0.5, elevation)) * clamp(elevation * 4.0 + 0.15, 0.0, 1.0);
      float hazeDir = sunAz * 0.5 + 0.5;
      vec3 hazeWarm = vec3(0.07, 0.032, -0.034) * pow(hazeDir, 2.0);
      vec3 hazeCool = vec3(-0.016, -0.006, 0.012) * pow(1.0 - hazeDir, 2.0);
      sky += (hazeWarm * warmth + hazeCool) * hazeBand;

      // Below the horizon the sky box is only ever seen past the edge of the
      // ocean, so it holds the horizon colour — but eased across a few
      // thousandths of a radian rather than switched, because a hard branch at
      // exactly elevation zero draws a one-pixel step the width of the frame.
      sky = mix(uHorizonColor * 0.9, sky, smoothstep(-0.0045, 0.0015, elevation));

      // sun disc / corona / halo
      float sunDot = dot(dir, normalize(uSunDirection));
      // The sun subtends 0.53 degrees. The old disc was smoothstepped over
      // 0.9992..0.99982, which is a four-degree ball — eight times too wide, and
      // the single loudest "this is a game sky" tell in the whole frame.
      float sunDisc = smoothstep(0.9999830, 0.9999940, sunDot);
      // Mie forward scattering. The sun does not sit on the sky like a sticker —
      // the air immediately around it is measurably brighter, over a lobe tens of
      // degrees wide, and that gradient is most of what tells the eye it is
      // looking at an atmosphere. Four terms: the disc, a tight corona, a glare
      // ring, and a broad aureole that reaches a long way out.
      float sd = clamp(sunDot, 0.0, 1.0);
      float corona = pow(sd, 2600.0) * 0.9;
      float glare = pow(sd, 190.0) * 0.34;
      float halo = pow(sd, 11.0) * 0.30;
      float aureole = pow(sd, 2.4) * 0.16 * (1.0 - smoothstep(0.0, 0.55, elevation) * 0.45);
      vec3 sunContribution = uSunColor * (sunDisc * 34.0 + corona * 4.0 + glare + halo + aureole);

      // ---- Cloud layer -----------------------------------------------------
      // Flat-plane projection (dir.xz / elevation), continuous in every direction
      // and physically the right mapping — it gives real perspective
      // foreshortening toward the horizon rather than uniform dome-stretched noise.
      //
      // The clouds are lit with a fake-volumetric model: a short light-march
      // toward the sun accumulates cloud mass between each point and the sun, and
      // Beer's law turns that into a transmittance. That is what gives the cloud
      // dimensional form — bright tops, shadowed undersides, and a bright rim
      // (silver lining) where the sun burns through thin edges. All in a single
      // fragment pass, no 3D volume, so it stays cheap enough for a sky box.
      // The cumulus deck is NOT drawn here. A sky box can only ever paint behind
      // everything in the scene, which is exactly wrong once the camera climbs
      // above the cloud base — and this game's camera goes to 250 km. The deck is
      // real geometry instead (see CloudLayer.js); the sky keeps only the high
      // cirrus, which nothing in the game ever flies above.
      float Re = 6371000.0;
      float hCam = max(cameraPosition.y, 0.0);
      float cloudA = 0.0;

      float cirH = 8200.0;
      float distCir = shellHit(dir, hCam, cirH, Re);
      vec2 cir = (dir * max(distCir, 0.0)).xz * 0.000075 + vec2(uTime * 0.0016, uTime * 0.0006);
      // Cirrus, in two bands at different scales. One octave of fbm at one scale
      // is a marbling pattern; a coarse band that decides WHERE there is cirrus
      // at all, multiplied by a fine fibrous band that gives it the streaked
      // texture, is cirrus.
      float cirBand = smoothstep(0.44, 0.78, fbm(cir * 0.62));
      float cirFib = smoothstep(0.42, 0.86, fbm(cir * vec2(5.5, 1.7)));
      float cirrus = cirBand * cirFib
        * smoothstep(0.015, 0.20, abs(elevation)) * (1.0 - smoothstep(0.9, 1.0, elevation))
        * (distCir > 0.0 ? 1.0 : 0.0)
        * (1.0 - smoothstep(220000.0, 520000.0, distCir));
      // Cirrus is ice, so it is bright where it is between you and the sun.
      vec3 cirCol = mix(uCloudColorLit * 1.02, uSunColor * 1.25, pow(sd, 3.0) * 0.7);
      sky = mix(sky, cirCol, cirrus * 0.34 * uCloudiness);

      vec3 color = sky + sunContribution * (1.0 - cloudA * 0.92);
      // ONE dither, at one LSB, and no more.
      //
      // There used to be three stacked here — 3/255 full-frame, 2.8/255 more near
      // the horizon, and 1.6/255 of static luma noise — on top of the grade
      // pass's own dither at the end of the chain. Nine levels of noise is not
      // dithering, it is a visible screen door over every sky pixel in the game,
      // and it was the single most-cited defect in the art review. One LSB is
      // exactly enough to break an 8-bit ramp and is invisible.
      color += (ignDither(gl_FragCoord.xy, uTime * 7.0) - 0.5) * (1.0 / 255.0);
      // Hand the grade pass LINEAR radiance — it now applies ACES and the sRGB
  // transfer to the whole frame. See the note in VIGNETTE_GRADE_SHADER.
  gl_FragColor = vec4(acesInverse(color) / uGradeExposure, 1.0);
    }
  `,
};

/**
 * The cloud field, shared between the sky and the ocean.
 *
 * The sky draws it; the sea is darkened by it. Both have to evaluate exactly the
 * same function with exactly the same parameterisation or the shadows will drift
 * away from the clouds that are supposedly casting them — which is a tell the eye
 * catches immediately even when it cannot say why.
 *
 * The field is parameterised by horizontal offset from the CAMERA on the cloud
 * shell, not by absolute world position, because the renderer uses a floating
 * origin: anchoring the clouds to world coordinates would make the whole sky jump
 * every time the origin rebased.
 */
export const CLOUD_FIELD_GLSL = /* glsl */`
uniform float uCloudCoverage;
uniform float uCloudiness;
uniform sampler2D uCloudField;
#define CLOUD_TILE 16.0
// Bake is 2048 texels across CLOUD_TILE uv, and uv = metres * 0.00026.
#define CLOUD_TEXEL_M 30.05

float cf_hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float cf_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  float a = cf_hash(i), b = cf_hash(i + vec2(1.0, 0.0));
  float c = cf_hash(i + vec2(0.0, 1.0)), d = cf_hash(i + vec2(1.0, 1.0));
  // Quintic interpolant, not cubic. The cubic smoothstep is only C1: its second
  // derivative jumps at every lattice boundary, and once the field is pushed
  // through a threshold those jumps show up as hard contour lines tracing the
  // noise cells across the whole sky. The quintic is C2 and the contours vanish.
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float cf_fbm3(vec2 p) {
  // Five octaves rather than three. Three leaves the largest cells big enough to
  // read individually, which is the other half of the contouring problem, and
  // gives cloud edges a smooth blobby quality instead of a fractal one.
  float v = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 5; i++) {
    v += amp * cf_noise(p);
    norm += amp;
    p = p * 2.02 + vec2(3.1, 1.7);
    amp *= 0.52;
  }
  return v / norm * 0.97;
}
/**
 * Billowed form of the same field. Cumulus is made of rising bubbles, and the
 * classic way to get that cauliflower read out of value noise is to fold it:
 * take the absolute deviation from the midpoint, which turns smooth hills into
 * rounded lobes with creases between them.
 */
float cf_billow(vec2 p) {
  float v = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 4; i++) {
    v += amp * (1.0 - abs(cf_noise(p) * 2.0 - 1.0));
    norm += amp;
    p = p * 2.11 + vec2(1.3, 5.9);
    amp *= 0.5;
  }
  return v / norm;
}
/**
 * Soft form of the cloud mass. cf_shape clamps at zero, which gives its result a
 * level-set boundary that traces the underlying value noise's interpolation
 * cells — invisible in a cloud (the alpha ramp hides it) but glaringly obvious
 * when the same field is used to cast a shadow on the sea, where it reads as a
 * polygon with straight edges. This ramps smoothly through the coverage
 * threshold instead, so the shadow has a real penumbra.
 */
/*
 * Both forms are now a single texture fetch.
 *
 * The field they used to evaluate — four five-octave stacks plus a billow fold,
 * twenty-four lattice lookups — is baked into uCloudField at startup (see
 * CloudField.js): red is the density, green the coverage modulation. The
 * raymarch asks for this eight to ten times per pixel over a full screen, and
 * computing it analytically was measured at 224 ms of a 232 ms frame in the
 * fleet-level view. A bilinear fetch is roughly two orders of magnitude cheaper
 * and, being mipmapped, is also properly filtered when a pixel covers kilometres
 * of cloud — which the analytic version never was.
 */
vec2 cf_field(vec2 uv) {
  return texture2D(uCloudField, uv / CLOUD_TILE).rg;
}

/*
 * Explicit-LOD form, for use inside the raymarch.
 *
 * Automatic mip selection is only defined under UNIFORM control flow, and the
 * march is the opposite of that: its trip count varies per pixel and it breaks
 * early when the ray saturates, so neighbouring pixels run different numbers of
 * iterations. The derivatives the hardware needs are then undefined, and what it
 * actually does is resolve them per 2x2 quad against whatever its neighbours
 * happened to be doing — which drew the cloud deck as a grid of hard screen-
 * aligned blocks. Passing the level in explicitly, computed once before the loop
 * where the flow is still uniform, removes the guesswork entirely.
 */
vec2 cf_fieldLod(vec2 uv, float lod) {
  return texture2DLodEXT(uCloudField, uv / CLOUD_TILE, lod).rg;
}

float cf_shapeLod(vec2 uv, float thr, float lod) {
  vec2 f = cf_fieldLod(uv, lod);
  float t = clamp(thr + (f.g - 0.5) * 0.42, -0.15, 0.85);
  // SMOOTHSTEP, not a hard clamp.
  //
  // clamp((d - t) / (1 - t)) has a corner at d == t: density is exactly zero on
  // one side of the threshold and rising linearly on the other. Integrate that
  // along a sixteen-step march and every step lands the cloud edge on a discrete
  // density level, so the SHAPE quantises into terraces — which is what an art
  // review found across all ninety-three of its sky frames. It measured 11,269
  // unique colours in the sky, correctly concluding the problem was not colour
  // banding but the silhouette itself being stepped.
  //
  // A C1 ramp through the threshold removes the corner and the terracing with
  // it. The blend width is the same one cf_softShape uses, so the deck and the
  // shadows it casts on the sea stay consistent with each other.
  float d = smoothstep(t - 0.06, t + 0.30, f.r);
  return d * d * (3.0 - 2.0 * d);
}

float cf_softShape(vec2 uv, float thr) {
  vec2 f = cf_field(uv);
  float t = clamp(thr + (f.g - 0.5) * 0.42, -0.15, 0.85);
  return smoothstep(t - 0.11, t + 0.27, f.r);
}

float cf_shape(vec2 uv, float thr) {
  vec2 f = cf_field(uv);
  float t = clamp(thr + (f.g - 0.5) * 0.42, -0.15, 0.85);
  return clamp((f.r - t) / (1.0 - t), 0.0, 1.0);
}

/**
 * How much of the sun reaches a point on the sea. 1 = full sun, ~0.35 = under the
 * core of a cumulus. Trace from the water point along the sun direction up to the
 * cloud base and ask the same field the sky is drawing what is there.
 */
/*
 * Cloud shadows on the sea.
 *
 * This runs on EVERY OCEAN PIXEL, and the ocean is most of the screen. It used
 * to take four taps of cf_softShape — which is itself four five-octave fbm
 * stacks plus a billow — so roughly a hundred noise evaluations per water pixel,
 * every frame. It was, by a wide margin, the most expensive thing in the game.
 *
 * A cloud shadow does not need the cloud's silhouette. It is two kilometres out
 * of focus: the sun is half a degree wide, so the penumbra is hundreds of metres
 * across and every fine detail in the cloud edge is smeared out of existence
 * before the light reaches the water. Three octaves of plain noise, thresholded
 * softly, is indistinguishable from the exact field once blurred — and costs
 * about a twentieth as much.
 */
float cloudSunlight(vec2 worldOffsetXZ, vec3 sunDir, float time) {
  const float BASE_H = 2100.0;
  float sy = max(sunDir.y, 0.10);
  vec2 hit = worldOffsetXZ + sunDir.xz * (BASE_H / sy);
  vec2 uv = (hit + vec2(time * 4.2, time * 1.3)) * 0.00026;
  // Same domain and same low-frequency coverage modulation as the deck, so the
  // shadows still fall where the clouds are.
  float cover = cf_noise(uv * 0.13 + 61.7);
  float t = clamp(uCloudCoverage + (cover - 0.5) * 0.42, -0.15, 0.85);
  float m = cf_noise(uv) * 0.55 + cf_noise(uv * 2.1 + 3.7) * 0.30 + cf_noise(uv * 4.3 - 1.9) * 0.15;
  float d = smoothstep(t - 0.20, t + 0.34, m);
  return 1.0 - clamp(d, 0.0, 1.0) * uCloudiness * 0.50;
}
`;
