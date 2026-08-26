# MERIDIAN: OVER THE HORIZON

A modern naval combat simulator about the thing that actually decides engagements
at sea: **not the missile, but whether anyone knows where the enemy is.**

You command Task Force 44. You search an ocean, manage what you radiate, build a
kill web out of aircraft and submarines and destroyers, and shoot at a prediction.

Built with [three.js](https://threejs.org). No external art assets — every model
is authored in Blender for this project, and every texture, sky, sea and
explosion is generated procedurally on the GPU.

## Play

<https://ewingtom.github.io/meridian-oth/>

## Run locally

```bash
npm install
npm run dev
```

Then open <http://127.0.0.1:5180/>.

## Controls

| | |
|---|---|
| Left click | Select a unit or contact |
| Right drag | Orbit the camera |
| Scroll | Zoom, from the bridge wing out to a 90 km chart view |
| `M` | Snap between the chart and the sea |
| `Space` | Pause |
| `F` | Follow the selected unit |
| `Shift+F` | Frame-time readout |

Graphics presets — **LOW / MED / HIGH / EXQ** — are in the status bar next to
time compression, and apply live.

## What is being simulated

- **Detection before weapons.** Radar horizon is the 4/3-earth approximation, so
  a sea-skimmer is invisible until it crosses it. Emissions control is a real
  trade: radiate and you see further, but you are also the brightest thing in the
  ocean.
- **Track quality.** A contact is not a target. It becomes one when the error
  ellipse around it is smaller than the basket your missile's seeker can search.
- **Weather as a weapon.** Sea state, visibility and squall cells degrade radar,
  sonar and eyeballs — for both sides. A squall line is a hole in the enemy's
  picture you can steer a task force into.
- **A living theatre.** Orders arrive from higher command; other ships' captains
  call for help, ask permission, and report contacts. Neutral merchant traffic
  and fishing fleets share the water, and shooting one is a decision with
  consequences.

## Structure

```
src/sim/     the simulation — units, sensors, tracks, weapons, weather, AI
src/core/    renderer, ocean, sky, clouds, rain, camera direction
src/view/    scene graph, unit views, effects
src/ui/      HUD and the tactical plot
public/assets/models/   Blender-authored GLB assets
```
