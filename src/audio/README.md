# Audio Engine

Procedurally-synthesized audio for the naval combat game. **Zero external
audio assets** — every sound (ambience, weapons, explosions, UI, comms) is
generated at runtime with the Web Audio API: oscillators, filtered noise
buffers, a synthesized convolution-reverb impulse for the sonar ping, and a
waveshaper for distortion/grit. A `DynamicsCompressorNode` limiter sits on
the master bus so overlapping SFX never clip.

## Quick start

```js
import { AudioEngine } from "./audio/AudioEngine.js";

const audio = new AudioEngine();

// Do NOT call anything else until this resolves — browsers block audio
// until a user gesture. Wire it to the first click/keydown in the game.
window.addEventListener(
  "pointerdown",
  () => { audio.unlock(); },
  { once: true }
);
// or: await audio.unlock() inside any click/keydown handler.
// Safe to call unlock() again later too (e.g. to re-resume after the tab
// was backgrounded) — it's idempotent.

audio.setMasterVolume(1);
audio.setMusicVolume(0.8);
audio.setSfxVolume(1);

const ocean = audio.startOceanAmbience();
const engineHum = audio.startEngineHum(0.2); // 0-1 rpm fraction
const wind = audio.startWind(0.3);

audio.setListenerPosition(0, 0, 0);
audio.setListenerOrientation({ x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });

audio.playDeckGunFire({ position: { x: 5, y: 2, z: 0 } });
audio.playSonarPing();

const alarm = audio.playAlarmKlaxon();
// ...later, when the threat clears:
alarm.stop(0.6);
```

Every public method on `AudioEngine` is a no-op (with a one-time
`console.warn`) if called before `unlock()` has completed, so it's safe to
wire SFX calls into gameplay code without worrying about call order —
nothing will throw if a sound fires a frame before the engine is unlocked.

## Public API

```js
class AudioEngine {
  constructor()
  async unlock()                 // idempotent, safe to call repeatedly
  async dispose()                // optional: tears down the AudioContext

  setMasterVolume(v)             // 0-1
  setMusicVolume(v)              // 0-1
  setSfxVolume(v)                // 0-1 (also drives the ambience bus, see below)

  // Looping beds — return a handle: { stop(fadeSeconds), setIntensity(0-1)?, setRpm(0-1)? }
  startOceanAmbience()
  startEngineHum(rpmFraction)    // handle.setRpm(fraction)
  startWind(intensityFraction)   // handle.setIntensity(fraction)

  // One-shot SFX — opts: { volume?, pan?, position?: {x,y,z} }
  playDeckGunFire(opts)
  playMissileLaunch(opts)
  playCiwsBurst(opts)
  playExplosionSmall(opts)
  playExplosionLarge(opts)
  playTorpedoLaunch(opts)
  playSonarPing(opts)
  playRadarBlip(opts)
  playAlarmKlaxon(opts)          // loops — returns handle with .stop(fadeSeconds)
  playUiClick(opts)
  playUiHover(opts)
  playUiConfirm(opts)
  playUiError(opts)
  playHitImpact(opts)
  playSplash(opts)
  playRadioBlip(opts)

  setListenerPosition(x, y, z)
  setListenerOrientation(forwardVec3, upVec3)   // {x,y,z} each, need not be pre-normalized
}
```

This matches the requested sketch almost exactly. The only deliberate
change: **no separate `setAmbienceVolume`** was requested, so the ambience
bus (ocean/engine/wind) is driven by `setSfxVolume` alongside one-shot SFX
— see architecture note below. `dispose()` was added as an optional extra
for page-unload/hot-reload cleanup; nothing else needs it.

## Architecture

```
musicBus     ─┐
sfxBus        ├─▶ masterGain ─▶ DynamicsCompressor (limiter) ─▶ ctx.destination
ambienceBus  ─┘
```

- **Buses**: three `GainNode`s (`musicBus`, `sfxBus`, `ambienceBus`) feed a
  `masterGain`, which feeds a `DynamicsCompressorNode` acting as a soft
  limiter, which feeds `ctx.destination`. `setMasterVolume` controls the
  master gain; `setMusicVolume` controls `musicBus` (reserved for a future
  music system — no music playback is implemented here); `setSfxVolume`
  controls **both** `sfxBus` and `ambienceBus`, since the brief only
  specified three volume knobs and ambience reads as environmental SFX.
- **One-shot voices**: every `playX()` call builds a small, disposable node
  graph (oscillators/noise → filters/shaper → a per-call gain) that feeds
  into a "voice" gain node (`voice.js: createVoice`), which applies
  `opts.volume` and, if `opts.position` is given, a simple stereo pan +
  inverse-distance gain rolloff relative to the tracked `listener`
  (`positional.js`) — not a full HRTF `PannerNode`, by design, for
  predictable/cheap positioning. Nodes are scheduled for `disconnect()`
  shortly after they finish playing (`AudioEngine._scheduleCleanup`).
- **Looping beds & the alarm**: return a `LoopHandle` (`voice.js`) wrapping
  a persistent gain node plus bed-specific `setIntensity`/`setRpm`
  callbacks and a `stop(fadeSeconds)` that fades and tears the graph down.
- **Shared DSP building blocks** live in `synth.js` (noise buffer
  generation, a procedural reverb impulse generator, ADSR-ish envelope
  helpers, a waveshaper distortion curve, small LFO/numeric utilities) and
  are cached once per `AudioEngine` instance in `unlock()`
  (`_buildCaches()`): three 4-second noise buffers (white/pink/brown) that
  one-shots slice at random offsets, two reverb impulse responses (a
  bright long "plate" tail for the sonar ping, a darker shorter "room" tail
  for large explosions), and a few distortion curves.

## File layout

- `AudioEngine.js` — the public class; owns the bus graph, volume state,
  listener, and caches, and delegates synthesis to the modules below.
- `synth.js` — low-level DSP building blocks (noise, reverb IR, envelopes,
  distortion curve, LFO helper, numeric utils).
- `positional.js` — `Listener` + simple pan/distance attenuation math.
- `voice.js` — `createVoice` (per-sound output chain) and `LoopHandle`.
- `ambience.js` — `startOceanAmbience`, `startEngineHum`, `startWind`.
- `sfx/weapons.js` — deck gun, missile launch, CIWS burst, torpedo launch.
- `sfx/explosions.js` — small/large explosions.
- `sfx/sonarRadar.js` — sonar ping, radar blip.
- `sfx/ui.js` — click, hover, confirm, error.
- `sfx/impacts.js` — hit impact, splash.
- `sfx/comms.js` — alarm klaxon (looping), radio blip.

## Notes for the integrator

- Call `audio.unlock()` from the first `pointerdown`/`keydown` handler
  before triggering any other method. It's async but you don't have to
  await it everywhere — it's safe to call `play*()` before it resolves
  (it'll just warn once and no-op) and safe to call `unlock()` itself
  multiple times.
- `position` on one-shots is a plain `{x, y, z}` in world space; distance
  falloff uses `refDistance: 15` (full volume within 15 units) out to
  `maxDistance: 1200` (silent beyond that), tunable via
  `audio.attenuationOpts` if the game's scale needs different numbers.
- `playAlarmKlaxon()` and the three `start*` ambience beds are the only
  calls that return a handle — everything else is fire-and-forget.
- All internal helpers/fields prefixed `_` (e.g. `engine._buffers`,
  `engine._scheduleCleanup`) are implementation details, not part of the
  supported API.
