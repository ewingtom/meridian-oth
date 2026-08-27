import * as THREE from 'three';
import { CLOUD_FIELD_GLSL } from './skyShader.js';

/**
 * The cumulus deck, as real geometry.
 *
 * A sky box can only ever draw clouds BEHIND everything, which is fine while the
 * camera is under the deck and wrong the moment it is not. This game's camera
 * climbs to 250 km and its aircraft cruise at 8,000 m, so the deck has to be a
 * surface in the world: something the sea can be seen through gaps in, something
 * a Poseidon flies above and a sea-skimming missile flies under.
 *
 * It is a single horizontal disc at cloud-base height, centred on the camera,
 * with the cloud field evaluated per fragment. Thickness is faked by the standard
 * trick of dividing optical depth by the cosine of the view angle: look at the
 * deck edge-on and you are looking through kilometres of cloud, so it goes solid;
 * look straight up through a gap and it is clear. Combined with the light march
 * toward the sun (bright tops, grey bases, burning rims where the sun comes
 * through thin edges) that reads as volume from every angle the game can take.
 */

const BASE_H = 2100;
const OUTER_R = 260000;
const INNER_R = 300;

function buildDisc(rings = 52, segs = 160) {
  const pos = new Float32Array((rings + 1) * (segs + 1) * 3);
  const idx = [];
  let p = 0;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const rad = INNER_R * Math.pow(OUTER_R / INNER_R, t);
    for (let s = 0; s <= segs; s++) {
      const a = (s === segs ? 0 : s / segs) * Math.PI * 2;   // exact wrap, no crack
      pos[p++] = Math.cos(a) * rad;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * rad;
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s;
      idx.push(a, a + (segs + 1), a + 1, a + 1, a + (segs + 1), a + segs + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = OUTER_R * 1.5;
  return geo;
}

const VERT = /* glsl */`
uniform float uEarthR;
varying vec3 vWorldPos;
varying float vRad;
void main() {
  vec3 p = position + vec3(modelMatrix[3].x, modelMatrix[3].y, modelMatrix[3].z);
  float d = length(position.xz);
  vRad = d;
  // The deck follows the curve of the earth like everything else, which is what
  // lets it meet the sea horizon instead of hanging above it like a ceiling.
  p.y -= (d * d) / (2.0 * uEarthR);
  vWorldPos = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uLitColor;
uniform vec3 uShadowColor;
uniform vec3 uHorizonColor;
uniform float uVisibility;
uniform float uOuter;
uniform float uCloudSteps;   // march step count, uniform across the frame
uniform vec4 uSquall[4];   // xz centre, z radius, w strength
varying vec3 vWorldPos;
varying float vRad;

${CLOUD_FIELD_GLSL}

float layerDepth(float dist, float lo, float hi, float H) {
  float dh = hi - lo;
  if (dh < 1.0) return dist * exp(-lo / H);
  return dist * (H / dh) * (exp(-lo / H) - exp(-hi / H));
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
  // Overexposure has to run to white, not through the nearest primary.
  //
  // The clamp below is per channel, so a colour whose red passes one first is
  // held there while green and blue keep climbing. The sun's glow is a single
  // warm hue scaled over four orders of magnitude, and that clamp turned it into
  // a ringed target: a pink halo where only red had clipped, a yellow ring where
  // red and green had, a white core where all three had. Nothing in the scene is
  // pink. Pull the channel ratios together as the peak goes past one so they
  // arrive at the ceiling together, which is also what film does.
  float peak = max(max(y.r, y.g), y.b);
  if (peak > 1.0) {
    float s = 1.0 / (1.0 + (peak - 1.0) * 1.2);
    y = mix(vec3(1.0), y / peak, s) * peak;
  }
  y = clamp(y, 0.0, 0.9999);
  vec3 A = y * ic - ia;
  vec3 B = y * id - ib;
  vec3 C = y * ie;
  vec3 disc = max(B * B - 4.0 * A * C, vec3(0.0));
  return max((-B - sqrt(disc)) / (2.0 * A), vec3(0.0));
}

void main() {
  vec3 toCam = uCamPos - vWorldPos;
  float dist = length(toCam);
  vec3 viewDir = toCam / max(dist, 1e-4);
  vec2 uv0 = (vWorldPos.xz - uCamPos.xz) * 0.00026;

  vec2 wind = vec2(uTime * 4.2, uTime * 1.3);

  // ── raymarch ──────────────────────────────────────────────────────────────
  //
  // A real march with transmittance, not an average of samples.
  //
  // The previous implementation averaged N density samples taken at fixed
  // heights and then pushed the mean through one Beer-Lambert term. Two things
  // came out of that, and an art review measured both: horizontal density
  // banding at the sample spacing (an FFT of the sky put its peaks at exactly
  // dy = +/-5, +/-7, +/-11, dx = 0), and — from the per-pixel offset added to
  // hide it — a screen-locked 8x8 ordered lattice over every cloud pixel in the
  // game, which reads as a dithered GIF.
  //
  // Marching properly fixes both at the root. Each step contributes
  // exp(-sigma*ds) to the transmittance, so the result is a smooth integral
  // rather than a quantised mean, and no dither is needed to hide anything. The
  // offset that remains is a temporally-varying hash at a fraction of a step,
  // which averages out over frames instead of standing still on the screen.
  const float SLAB_LO = 1450.0;
  const float SLAB_HI = 3350.0;
  // Eight steps, not twelve. The march runs on every sky pixel in the frame and
  // each step is a shape evaluation plus a three-tap sun march; the step count
  // is the single biggest lever on its cost, and with the distance-adaptive LOD
  // below doing the antialiasing, twelve buys very little over eight.
  // Sixteen steps.
  //
  // The step count was cut to eight when each sample cost twenty-four noise
  // lookups. It now costs one texture fetch, so the march can afford to be
  // properly sampled again — and it HAS to be. An under-sampled march hides its
  // banding behind a per-pixel offset, and a per-pixel offset in a signal this
  // coarse does not read as smooth cloud; it reads as a stipple of hard dots,
  // which is precisely the "ordered-dither halftone" an art review found across
  // every frame in the game. The cure for that is samples, not more dithering.
  const int STEPS = 16;   // loop bound; the live count is uCloudSteps

  vec3 rd = -viewDir;                       // from the camera outward
  if (abs(rd.y) < 1e-4) discard;

  // World-space size of this pixel on the deck.
  float fpx = max(fwidth(vWorldPos.x), fwidth(vWorldPos.z));

  // Slab entry and exit along the ray.
  float t0 = (SLAB_LO - uCamPos.y) / rd.y;
  float t1 = (SLAB_HI - uCamPos.y) / rd.y;
  if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
  t0 = max(t0, 0.0);
  if (t1 <= t0) discard;
  // Bound the march. At grazing incidence the true slab crossing is hundreds of
  // kilometres, which both costs everything and aliases; forty kilometres of
  // cloud is already opaque.
  t1 = min(t1, t0 + 34000.0);
  float span = t1 - t0;
  float horiz = length(rd.xz);

  // Sub-step offset — deliberately SMALL.
  //
  // A full one-step random offset per pixel is the usual way to trade banding
  // for noise, and it is the wrong trade without a temporal filter to average
  // the noise back out: neighbouring rays land in different parts of the cloud
  // and the deck turns into a dot screen. A quarter-step is enough to break the
  // step boundaries into a gradient while keeping adjacent pixels correlated,
  // and with sixteen quadratically-spaced samples there is little banding left
  // to hide in the first place.
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float jitter = fract(ign + uTime * 0.61803399) * 0.25;

  // How many steps this pixel actually needs.
  //
  // A march step only buys something if it can resolve a cloud feature. Once one
  // step spans more than a cloud is wide — which is every pixel near the horizon,
  // and every pixel at all once the camera climbs above the deck and the disc
  // fills the frame — extra steps are integrating the same low-frequency average
  // over and over. This is what made the fleet-level view fifteen times more
  // expensive than the close one: the deck covered the whole screen and every
  // pixel paid the full eight-step march.
  // The step count is UNIFORM across the frame. It must be.
  //
  // It used to be computed per pixel from the ray's own slab crossing, and
  // truncated to an int — so neighbouring pixels integrated a different NUMBER
  // of steps and landed on measurably different results. The boundaries where
  // that count ticked over drew as thin contour lines tracing the cloud, which
  // is the terracing an art review found in every one of its ninety-three sky
  // frames. It is not a quantised colour or a quantised field: raising the bake
  // to half float changed nothing, because the steps were in the integrator.
  //
  // A count that varies only per DRAW cannot band, and it also makes the
  // derivatives inside the loop well defined.
  int NS = int(uCloudSteps);
  float fNS = uCloudSteps;

  // Mip level for the whole ray, computed HERE — before the loop, while control
  // flow is still uniform and a footprint can be reasoned about at all.
  float footprint = max(fpx, (span / fNS) * horiz);
  float fieldLod = log2(max(1.0, footprint / CLOUD_TEXEL_M));
  float detailFade = smoothstep(7000.0, 150.0, footprint);

  // Sun occlusion, sampled at ONE fixed point on the ray, before the loop.
  //
  // This used to be evaluated lazily at the first step whose density passed a
  // threshold. The density field varies smoothly across the screen, but the
  // INDEX of the step that first crosses a threshold does not — it jumps between
  // integers — so the lit side of the cloud jumped with it and drew a contour
  // line at every one of those transitions. Sixteen steps, sixteen nested
  // contours: the terracing an art review found in all ninety-three sky frames.
  // Raising the bake to half float did nothing because the steps were never in
  // the field; they were in where the shading was sampled from.
  //
  // Sampling the slab's mid-height on this ray is continuous in the view
  // direction, so the shading is too.
  vec2 sunUV = normalize(uSunDirection.xz + vec2(1e-4, 0.0)) * 0.10;
  vec3 pMid = uCamPos + rd * (t0 + span * 0.5);
  vec2 uvMidSun = ((pMid.xz - uCamPos.xz) + wind + vec2(575.0, -340.0)) * 0.00026;
  float sunOccLod = max(0.0, fieldLod - 0.5);

  // An overcast is not a flat ceiling.
  //
  // Once coverage passes about 0.8 the density field saturates: the threshold has
  // dropped far enough that almost every sample is fully dense, powder pins at
  // 0.98, sun occlusion pins with it, and every pixel of the deck shades to the
  // same grey. Measured across the top of the frame, a gale sky came out at
  // standard deviation 3.1 against 14.8 for a clear one — the flatness was right
  // in direction and far too complete. Real stratus varies in thickness over a
  // few kilometres, and that variation is most of what you see from underneath.
  //
  // Two octaves at kilometre scale, sampled once per ray rather than per step,
  // modulating how much light gets through. It is gated on coverage so scattered
  // cumulus, which already has structure from its own shapes, is untouched.
  float deckVary = smoothstep(0.55, 0.95, 1.0 - uCloudCoverage);
  float deckThick = cf_noise(uvMidSun * 3.1 + 17.3) * 0.68
                  + cf_noise(uvMidSun * 7.7 - 5.9) * 0.32;
  // The two taps sum to 3.0 when the field is dense, and exp(-3.0 * 1.6) is
  // 0.008 — so under any real overcast EVERY sample came back fully shadowed and
  // the whole deck rendered in the shadow colour alone. Measured with the alpha
  // forced opaque, an overcast deck was painting itself [30,55,85]: a dark slate
  // blue almost exactly the colour of the sky behind it. The deck was at 0.98
  // opacity across the entire sky and simply invisible, which is why three art
  // reviews called an overcast gale cloudless.
  //
  // Scaled so a dense deck is strongly but not totally shadowed, which is what
  // an overcast actually looks like from underneath: grey and bright, not black.
  float sunOcc = (cf_shapeLod(uvMidSun + sunUV * 1.2, uCloudCoverage, sunOccLod) * 0.62
                + cf_shapeLod(uvMidSun + sunUV * 3.4, uCloudCoverage, sunOccLod) * 0.48);

  float trans = 1.0;                        // transmittance along the ray
  vec3 scatter = vec3(0.0);                 // accumulated in-scattered light
  float squallHit = 0.0;
  float firstHitH = -1.0;
  vec2 uvMid = uv0;


  // Steps grow with distance, and the field is BLURRED to match the step.
  //
  // Uniform steps are what produced the soft rectangular blotches across the sky
  // in a low camera. Near the horizon the slab crossing is tens of kilometres,
  // so twelve even steps land three kilometres apart — more than two full
  // periods of the cloud noise — and each sample falls in an uncorrelated cell.
  // The march then reconstructs garbage: big square patches at the step spacing.
  //
  // The fix is the one cone tracing uses. Steps are distributed quadratically so
  // the near field, where detail is actually visible, gets the resolution; and
  // whenever a step is longer than a cloud feature, that sample reads a
  // low-frequency version of the field instead of point-sampling a detail it
  // cannot resolve. Undersampled detail becomes smooth average density, which is
  // exactly what a distant cloud bank looks like anyway.
  for (int i = 0; i < STEPS; i++) {
    if (i >= NS) break;
    float u0 = (float(i) + jitter) / fNS;
    float u1 = (float(i) + 1.0 + jitter) / fNS;
    float a0 = u0 * u0 * 0.72 + u0 * 0.28;
    float a1 = u1 * u1 * 0.72 + u1 * 0.28;
    float t = t0 + span * a0;
    float ds = max(1.0, span * (a1 - a0));
    vec3 p = uCamPos + rd * t;
    float f = clamp((p.y - SLAB_LO) / (SLAB_HI - SLAB_LO), 0.0, 1.0);
    // Vertical density profile — a cumulus has a base, a body and a broken top.
    /*
     * A cumulus is flat-bottomed and domed; a stratus deck is not.
     *
     * sin squared is symmetric about mid-slab, which is right for a layer and
     * wrong for a heap cloud: cumulus condense at a definite level and build
     * upward from it, so the base is a hard floor and the top is what billows.
     * Blend between the two on coverage, which is the only thing that
     * distinguishes them here.
     */
    float cumulus = smoothstep(0.30, 0.62, uCloudCoverage);
    float layered = sin(f * 3.14159);
    layered *= layered;
    float heaped = smoothstep(0.0, 0.14, f) * (1.0 - smoothstep(0.42, 1.0, f));
    float prof = mix(layered, heaped, cumulus);
    // Shear the field with height.
    //
    // The cloud shape is a 2-D field extruded up the slab, so every sample along
    // one view ray reads the SAME horizontal position — a dense cell therefore
    // smears along the ray and projects to a hard vertical streak on screen,
    // which is exactly what the sky showed in any low camera. Offsetting the
    // lookup with altitude breaks that: each level of the cloud is displaced
    // from the one below it, so a ray crosses different cloud at different
    // heights, which is also what a real cumulus does under wind shear.
    vec2 shear = vec2(f * 1150.0, f * -680.0);
    vec2 uvi = ((p.xz - uCamPos.xz) + wind + shear) * 0.00026;
    // Two things can undersample the field, and both have to be accounted for:
    // the march step (handled by ds * horiz) and the SCREEN PIXEL itself. Near
    // the horizon one pixel of the deck covers tens of kilometres of cloud, so
    // even a perfectly fine march reads a different cloud in each neighbouring
    // pixel — which drew a fifteen-pixel band of crawling speckle immediately
    // above the sea horizon in every wide shot. fpx is the pixel's own world
    // footprint, and the field steps down through three octave levels as either
    // measure outruns it.
    // PICK an octave level; do not evaluate all three and blend.
    //
    // The blend was costing four full shape evaluations per march step — each of
    // them four five-octave fbm stacks — on every sky pixel, eight steps deep.
    // The three levels only ever differ where one of them is already being
    // faded out, so choosing between them is visually the same thing and costs a
    // quarter as much. The branch is spatially coherent (it depends on distance
    // along the ray), so the whole warp takes the same side of it.
    // No manual octave chain. The mip chain IS the octave chain.
    //
    // This used to pick between the field at three different scales — 1.0, 0.34
    // and 0.075 — depending on how much world a pixel covered. Those are not
    // filtered versions of one another; they are three unrelated patterns. The
    // original code cross-faded them, which merely smeared the seam; switching
    // between them hard, as an earlier optimisation here did, drew the boundary
    // as a patchwork of screen-aligned blocks over the whole deck.
    //
    // Now that the field is a mipmapped texture, the correctly filtered version
    // at any footprint already exists, and the hardware picks it per pixel from
    // the UV derivatives — continuously, and for free. One lookup, no seams.
    float d = cf_shapeLod(uvi, uCloudCoverage, fieldLod);
    // Close in the texture is magnified, so put the fine structure back with two
    // live octaves — a fiftieth of the cost of evaluating the whole field.
    if (detailFade > 0.01) {
      float fine = cf_noise(uvi * 7.3) * 0.66 + cf_noise(uvi * 15.1 + 4.1) * 0.34;
      d = clamp(d + (fine - 0.5) * 0.42 * detailFade * d, 0.0, 1.0);
    }
    d *= prof;

    // Squall cells: a real, positioned body of rain thickens and blackens the
    // deck over itself. The plot knows where these are and so does the sensor
    // model, so a dark shaft on the horizon is somewhere you can actually hide.
    for (int q = 0; q < 4; q++) {
      if (uSquall[q].z < 1.0) continue;
      float sd = length(p.xz - uSquall[q].xy) / uSquall[q].z;
      float inCell = 1.0 - smoothstep(0.45, 1.0, sd);
      d = mix(d, min(1.0, d + 0.6), inCell * uSquall[q].w);
      squallHit = max(squallHit, inCell * uSquall[q].w);
    }
    if (d <= 0.002) continue;
    if (firstHitH < 0.0) { firstHitH = f; uvMid = uvi; }

    // Light march toward the sun, evaluated ONCE for the ray and reused.
    //
    // It used to run inside the step loop — up to three more field lookups on
    // every one of eight steps, which was the majority of the entire shader's
    // cost. The sun direction is fixed and the slab is under two kilometres
    // thick, so the amount of cloud between a sample and the sun barely changes
    // between the base of the ray and its top; computing it at the first hit and
    // carrying it down the ray is visually the same lit-side/shadow-side result
    // for a fraction of the work.
    // Thicker where the deck is thicker; see deckThick above.
    float sunT = exp(-sunOcc * 1.6) * mix(1.0, 0.42 + 1.05 * deckThick, deckVary);
    // Powder / dark-edge: thin cloud scatters more light back than thick cloud.
    float powder = 1.0 - exp(-d * 4.0);
    // Height within the slab: tops are bright, bases are slate.
    vec3 lit = mix(uShadowColor, uLitColor, sunT * (0.28 + 0.72 * powder));
    lit = mix(lit * 0.72, lit, mix(0.30, 1.0, f));

    /*
     * Overhead you see through the least cloud, so an overcast is brightest at
     * the zenith and dimmest at the horizon.
     *
     * CIE S 011 / ISO 15469 gives the standard overcast sky as
     *   L(theta) = L_zenith * (1 + 2 sin theta) / 3
     * a three-to-one ratio from zenith to horizon. The deck had no view-angle
     * term at all, so once coverage saturated it shaded to one flat value in
     * every direction and the measured up-over-horizon ratio came out at 0.82 —
     * slightly INVERTED, where the standard asks for about 2.
     *
     * Note this is the deck, not the dome behind it. Under a real overcast the
     * deck is the whole sky, so the gradient has to live here; correcting the
     * dome's zenith and horizon colours does nothing when a solid ceiling is
     * drawn over the top of them.
     */
    // At full strength, not gated on coverage. The ramp belongs to the cloud's
    // own radiance, and a pixel with no cloud in front of it receives no cloud
    // contribution to scale — so gating it on how overcast the sky is only
    // weakened it where it matters. Gated at deckVary it ran at 44 percent and
    // moved the measured ratio from 0.82 to 1.06 against a target of 1.63 for
    // that elevation span. The term only ever darkens toward the horizon: it is
    // 1.0 at the zenith by construction, so nothing gets brighter.
    float sinAlt = clamp(abs(rd.y), 0.0, 1.0);
    lit *= (1.0 + 2.0 * sinAlt) / 3.0;

    float sigma = d * 0.00085;              // extinction per metre
    float aStep = 1.0 - exp(-sigma * ds);
    scatter += trans * aStep * lit;
    trans *= 1.0 - aStep;
    if (trans < 0.012) break;
  }

  float alpha = (1.0 - trans) * uCloudiness;
  if (alpha < 0.004) discard;
  vec2 uv = uvMid;
  float dens = 1.0 - trans;
  vec3 col = scatter / max(0.02, 1.0 - trans);

  float sunDot = clamp(dot(-viewDir, uSunDirection), 0.0, 1.0);
  // Silver lining: thin cloud in front of the sun glows, thick cloud does not.
  // Under a storm the sun is behind kilometres of water and the lining is a
  // pale grey, not gold — a warm sun colour smeared over a sixty-degree lobe is
  // what turned an overcast gale sky khaki brown.
  float wxGrey = 1.0 - clamp((uHorizonColor.b - uHorizonColor.r) * 6.0, 0.0, 1.0);
  vec3 lining = mix(uSunColor, vec3(dot(uSunColor, vec3(0.33))), wxGrey * 0.85);
  col += lining * pow(sunDot, 6.0) * (1.0 - dens) * mix(1.9, 0.55, wxGrey);
  col += lining * pow(sunDot, 22.0) * (1.0 - alpha) * mix(0.7, 0.25, wxGrey);
  // Under a squall the base goes slate and the whole cell darkens.
  col = mix(col, col * vec3(0.34, 0.38, 0.44), squallHit);
  alpha = min(1.0, alpha + squallHit * 0.30);

  // Flying through the deck: fade out as the camera crosses cloud base, so an
  // aircraft does not punch through an infinitely thin sheet.
  //
  // Measure against the SLAB, not against vWorldPos. vWorldPos carries the earth
  // curvature drop the vertex shader applies — radial squared over twice the
  // earth's radius — which at 68 km is 2,096 m. The deck sits at 2,100 m. So for
  // any camera at sea level there is a ring at about 68 km where the deformed
  // deck passes through the camera's own altitude, |camY - deckY| goes to zero,
  // and this fade takes the cloud to nothing.
  //
  // That ring is precisely the band a low camera spends all its time looking at.
  // The deck was rendering at 0.95 density and full opacity and then being
  // multiplied away right where it would have been visible: three art reviews
  // called the sky cloudless, and the deck was there the whole time.
  //
  // The slab is a fixed altitude band, so testing against it is immune to
  // whatever the vertex shader does to the geometry.
  float outsideSlab = max(SLAB_LO - uCamPos.y, uCamPos.y - SLAB_HI);
  float thru = smoothstep(0.0, 520.0, outsideSlab);
  alpha *= thru;
  alpha *= 1.0 - smoothstep(11000.0, 19000.0, uCamPos.y);

  // Aerial perspective, so the far edge of the deck dissolves into the horizon
  // rather than terminating at a visible rim.
  float k = 3.912 / uVisibility;
  float lo = min(uCamPos.y, vWorldPos.y);
  float hi = max(uCamPos.y, vWorldPos.y);
  float air = 1.0 - exp(-(k * layerDepth(dist, max(lo,0.0), max(hi,0.0), 1250.0)
                        + 1.15e-5 * layerDepth(dist, max(lo,0.0), max(hi,0.0), 8400.0)));
  col = mix(col, uHorizonColor * 0.97, air * 0.92);
  alpha *= 1.0 - smoothstep(uOuter * 0.55, uOuter * 0.98, vRad);
  // One LSB of dither on the alpha, from a hash that MOVES with time. A static
  // hash is a fixed screen pattern, and a fixed screen pattern over every cloud
  // pixel is exactly the artefact this was meant to prevent.
  // Interleaved-gradient noise, not a sine hash: a sine hash on the pixel
  // lattice IS a fixed pattern, which is the whole artefact this line exists to
  // avoid.
  {
    vec3 m = vec3(0.06711056, 0.00583715, 52.9829189);
    float ignA = fract(m.z * fract(dot(gl_FragCoord.xy + vec2(uTime * 5.588238, uTime * 3.301), m.xy)));
    alpha += (ignA - 0.5) * (1.2 / 255.0);
  }
  alpha = clamp(alpha, 0.0, 1.0);
  if (alpha < 0.004) discard;
  // The grade pass now applies ACES and the sRGB transfer to the whole frame, so
  // everything must hand it LINEAR radiance. This shader's palette is authored by
  // eye in display space, so undo the transfer on the way out; the grade pass
  // puts it back. Net identity for this surface, while the PBR materials finally
  // get the tone mapping they have always been written to expect.
  col = acesInverse(col) / uGradeExposure;
  gl_FragColor = vec4(col, alpha);
}
`;

export class CloudLayer {
  constructor(sharedUniforms) {
    this.material = new THREE.ShaderMaterial({
      // texture2DLodEXT: explicit mip selection inside the march (see cf_fieldLod).
      extensions: { shaderTextureLOD: true },
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: sharedUniforms.uTime,
        uCamPos: sharedUniforms.uCamPos,
        uSunDirection: sharedUniforms.uSunDirection,
        uSunColor: sharedUniforms.uSunColor,
        uCloudCoverage: sharedUniforms.uCloudCoverage,
        uCloudField: sharedUniforms.uCloudField,
        uCloudSteps: { value: 16.0 },
        uGradeExposure: { value: 1.3 },
        uCloudiness: sharedUniforms.uCloudiness,
        uHorizonColor: sharedUniforms.uHorizonColor,
        uVisibility: sharedUniforms.uVisibility,
        uEarthR: sharedUniforms.uEarthR,
        uLitColor: { value: new THREE.Color(0xf6f9fc) },
        // The underside of an overcast is a bright neutral grey, not a dark blue.
        // At 0x62748a it sat within a few values of the zenith and the deck
        // vanished into the sky it was supposed to be covering.
        uShadowColor: { value: new THREE.Color(0x9aa6b4) },
        uOuter: { value: OUTER_R },
        uSquall: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });
    // Authored for daylight; setDaylight takes them down once the sun is gone.
    this._litBase = this.material.uniforms.uLitColor.value.clone();
    this._shadowBase = this.material.uniforms.uShadowColor.value.clone();
    this.mesh = new THREE.Mesh(buildDisc(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.position.y = BASE_H;
  }

  // A cloud deck is not self-luminous.
  //
  // uLitColor and uShadowColor were fixed constants — 0xf6f9fc and 0x9aa6b4 —
  // so the deck was lit for noon at every hour of the night. A frame at 0100
  // showed a bright white overcast against a black sky full of stars, which is
  // the one lighting arrangement that cannot occur.
  //
  // The deck does not go black: at night it is lit by airglow and by the sky
  // itself, and against a dark sky it still reads as a slightly lighter mass.
  // So take the level almost all the way down and let what is left settle
  // toward the colour of the sky it is sitting in front of.
  // overcast: 0 for scattered cumulus, 1 for a solid storm deck. A thick deck's
  // underside is dark slate — the thing that makes a gale sky read as a gale is
  // that the ceiling is DARK. uShadowColor was a fixed light grey chosen so an
  // overcast would not vanish into the zenith behind it, which is right for a
  // stratus layer and much too bright for a storm.
  setDaylight(day, nightSky, overcast = 0) {
    const u = this.material.uniforms;
    const oc = Math.max(0, Math.min(1, overcast));
    const k = (0.05 + 0.95 * day);
    const n = 1 - day;
    u.uLitColor.value.copy(this._litBase).multiplyScalar(k * (1 - 0.30 * oc));
    u.uShadowColor.value.copy(this._shadowBase).multiplyScalar(k * (1 - 0.46 * oc));
    if (nightSky) {
      u.uLitColor.value.lerp(nightSky, n * 0.55);
      u.uShadowColor.value.lerp(nightSky, n * 0.70);
    }
  }

  update(camera) {
    this.mesh.position.set(camera.position.x, BASE_H, camera.position.z);
  }
}

export const CLOUD_BASE_H = BASE_H;
