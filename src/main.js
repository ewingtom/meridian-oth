import * as THREE from 'three';
import './ui/styles.css';
import { RenderPipeline } from './core/renderer.js';
import { CameraDirector, CAM } from './core/CameraDirector.js';
import { SceneView } from './view/SceneView.js';
import { TacticalOverlay } from './ui/TacticalOverlay.js';
import { Hud, fmt } from './ui/Hud.js';
import { GameAudio } from './audio/GameAudio.js';
import { buildScenario, Mission } from './sim/Scenario.js';
import { weapon } from './sim/weapons.db.js';
import {
  EMCON, EMCON_ORDER, ROE, SIDE, IDENT, DOMAIN, NM, KNOT, clamp, angDiff,
  WEAPONS_QUALITY_TQ,
} from './sim/constants.js';

const $ = (id) => document.getElementById(id);

class Game {
  constructor() {
    this.canvas = $('gl');
    this.pipeline = new RenderPipeline(this.canvas);
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 400000);
    this.cam = new CameraDirector(this.camera, this.canvas);

    this.world = buildScenario();
    this.mission = new Mission(this.world);
    this.world.mission = this.mission;

    this.view = new SceneView(this.pipeline, this.cam, this.world);
    // The bridge camera places its eye from the ship's own geometry rather than
    // from class numbers — see UnitView._measureBridgeEye.
    this.cam.bridgeEyeFor = (u) => this.view.views.get(u)?.bridgeEye || null;
    // The wheelhouse, once SceneView has built one for this ship.
    this.cam.bridgeRoomFor = (u) => (this.view._bridgeUnit === u ? this.view._bridge : null);
    this.pipeline.setup(this.view.scene, this.camera);
    // Remembered across sessions: a player who had to drop to Medium to get a
    // smooth frame should not have to do it again every time they load.
    this.quality = 'high';
    try {
      const saved = localStorage.getItem('oth.quality');
      if (saved) this.quality = saved;
    } catch (e) { /* private mode */ }
    this.pipeline.setQuality(this.quality);
    this.view.setQuality(this.quality);
    this.quality = this.pipeline._quality;   // setQuality validates and may clamp
    document.body.classList.toggle(
      'cheap-ui', this.quality === 'low' || this.quality === 'medium',
    );
    this.view.setSeaState(this.world.weather.seaState);

    this.overlay = new TacticalOverlay($('overlay'), this.cam, this.world);
    this.audio = new GameAudio();
    this.hud = new Hud(this);

    this.selection = [];
    this.selectedTrack = null;
    this.pendingOrder = null;
    this.timeScale = 4;
    this.lastScale = 4;
    this.running = false;
    this.keys = new Set();
    this.autoMissileCam = true;

    this.cam.focus.set(this.world.blueGuide.x, this.world.blueGuide.z);
    this.cam.focusTarget.copy(this.cam.focus);
    this.cam.distTarget = 52000;
    this.cam.dist = 52000;

    this._wireWorld();
    this._wireInput();
    this._wireScreens();
    this._clock = new THREE.Clock();
    this._perf = [];
    // Off by default — it is a diagnostic, and an art review quite rightly
    // called it out for printing over the middle of every frame in the shipped
    // build. Shift+F brings it back when a frame rate needs explaining.
    this._perfOn = false;
  }

  // ── world event → presentation ────────────────────────────────────────────
  _wireWorld() {
    this.world.on((ev) => {
      const cam = this.cam;
      const dist = (x, z) => Math.hypot(x - cam.focus.x, z - cam.focus.y);
      switch (ev.type) {
        case 'LAUNCH': {
          const o = ev.ord, u = ev.unit;
          if (u) {
            this.view.launchCloud(u.x, u.z, u.isAir ? u.alt : 12, o.heading,
              o.category === 'ASM' ? 1.5 : 1);
          }
          this.audio.launch(o.category, dist(o.x, o.z));
          // Sea Power's signature move: when the player's own anti-ship missiles
          // leave the rails, ride one out. It is spectacle, and it is also the
          // clearest possible lesson in what a long-range shot actually involves.
          if (this.autoMissileCam && o.side === SIDE.BLUE && o.category === 'ASM'
            && !this._rodeSalvo?.has(o.salvoId)) {
            this._rodeSalvo = this._rodeSalvo || new Set();
            this._rodeSalvo.add(o.salvoId);
            if (this.timeScale <= 8) this.cam.rideMissile(o);
          }
          break;
        }
        case 'HIT': {
          // A 450 kg warhead going off inside a frigate is not a modest event.
          // Scale with the actual charge rather than a two-bucket guess.
          const wh = ev.ord.def.warhead || 200;
          const big = wh > 300 || ev.torpedo;
          const sc = Math.min(4.2, 1.15 * Math.pow(wh / 200, 0.45)) * (ev.torpedo ? 1.6 : 1);
          this.view.boom(ev.x, ev.z, ev.torpedo ? 1 : 10, {
            scale: sc, underwater: !!ev.torpedo,
          });
          this.audio.boom(big, dist(ev.x, ev.z));
          if (ev.target && !ev.torpedo) {
            this.view.markDamage(ev.target, ev.ord.x ?? ev.x, ev.ord.z ?? ev.z);
          }
          const d = dist(ev.x, ev.z);
          if (d < 6000) this.cam.shake(clamp(1.4 - d / 6000, 0, 1.4));
          if (ev.target.side === SIDE.BLUE) this.hud.pushAlert(`${ev.target.name} HIT`, 'danger', 4);
          break;
        }
        case 'INTERCEPT': {
          if (ev.success) {
            this.view.boom(ev.x, ev.z, Math.max(20, ev.alt), { scale: 0.65, airburst: true });
            this.audio.boom(false, dist(ev.x, ev.z));
          }
          break;
        }
        case 'CIWS_KILL': {
          this.view.boom(ev.x, ev.z, Math.max(8, ev.alt), { scale: 0.4, airburst: true });
          this.audio.ciws(dist(ev.x, ev.z));
          break;
        }
        case 'CIWS_FIRE': {
          const u = ev.unit, o = ev.ord;
          if (Math.hypot(u.x - cam.focus.x, u.z - cam.focus.y) < 14000) {
            const dir = new THREE.Vector3(o.x - u.x, 0, o.z - u.z).normalize();
            this.view.fx.ciwsBurst(
              new THREE.Vector3(cam.rx(u.x), 22, cam.rz(u.z)), dir,
              Math.hypot(o.x - u.x, o.z - u.z), { rounds: 5 },
            );
            this.audio.ciws(dist(u.x, u.z));
          }
          break;
        }
        case 'DECOY': {
          this.view.fx.launchCloud(
            new THREE.Vector3(cam.rx(ev.x), 14, cam.rz(ev.z)),
            new THREE.Vector3(0, 1, 0), { scale: 1.6, color: 0xd8dde2, hot: 0xfff0d0 },
          );
          break;
        }
        case 'SUNK': {
          const u = ev.unit;
          if (!u.despawned) {
            this.view.boom(u.x, u.z, 14, { scale: 3.2 });
            this.audio.boom(true, dist(u.x, u.z));
          }
          break;
        }
        case 'SEEKER_ON': {
          if (ev.ord.side === SIDE.RED) this.hud.pushAlert('HOSTILE SEEKER ACTIVE', 'danger', 3);
          break;
        }
        case 'RED_STRIKE': {
          this.hud.pushAlert(`VAMPIRE VAMPIRE VAMPIRE — ${ev.count} INBOUND`, 'danger', 8);
          this.audio.klaxon();
          if (this.timeScale > 4) this.setTimeScale(2);
          break;
        }
        case 'CONTACT': {
          this.audio.blip();
          break;
        }
        case 'SIGNAL_OPENED': {
          // A SCORED DECISION NEEDS REAL SECONDS TO ANSWER IN.
          //
          // Deadlines are held in SIM time — a signal typically allows four
          // minutes. At 64x compression those four minutes are three and a half
          // real seconds, so the player watched decisions expire against them
          // faster than the card could be read, and the debrief then marked them
          // down for it. An art review found exactly that pattern.
          //
          // Time compression is the player's tool for skipping the empty ocean;
          // the moment something actually asks them a question, the empty ocean
          // is over. Drop to a scale where the window is a real minute or more.
          if (ev.scored && this.timeScale > 8) {
            this.setTimeScale(4);
            this.hud.pushAlert('TIME COMPRESSION REDUCED — DECISION PENDING', 'info', 3);
          }
          break;
        }
        case 'ILLUM': case 'SEEKER': case 'TORPEDO': {
          this.audio.klaxon();
          break;
        }
        case 'NEUTRAL_HIT': {
          this.hud.pushAlert('NEUTRAL VESSEL STRUCK', 'danger', 8);
          break;
        }
        case 'MISSION_END': {
          this.showDebrief(ev);
          break;
        }
        default: break;
      }
    });
  }

  // ── input ─────────────────────────────────────────────────────────────────
  _wireInput() {
    const c = this.canvas;
    let dragging = null, lastX = 0, lastY = 0, downX = 0, downY = 0, moved = 0;

    c.addEventListener('contextmenu', e => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      // Pointer capture is a nicety, not a requirement — it keeps a drag alive if
      // the pointer leaves the canvas. It THROWS for a pointer id the browser
      // does not consider active, and because it was the first statement in this
      // handler, that throw aborted the whole thing: no drag state was set, so
      // the matching pointerup did nothing and the click was swallowed. Losing
      // capture is survivable; losing every click is not.
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
      lastX = e.clientX; lastY = e.clientY; downX = e.clientX; downY = e.clientY; moved = 0;
      if (e.button === 2) dragging = 'orbit';
      else if (e.button === 1) dragging = 'pan';
      else if (e.shiftKey) {
        // Shift is the box-select modifier now — see below.
        dragging = 'select';
        this.overlay.dragBox = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      } else {
        // LEFT-DRAG PANS THE PLOT.
        //
        // Panning used to be middle-drag only, which on a laptop trackpad is no
        // button at all — so on the machine this is played on there was no way
        // to move the view except the arrow keys. Dragging the map with the
        // primary button is what every map application does, and a plot is a
        // map. A left press that does not move is still a click, so selection
        // is unaffected; box-select moves to shift-drag.
        dragging = 'pan';
      }
    });

    window.addEventListener('pointermove', (e) => {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (dragging === 'orbit') this.cam.orbit(dx, dy);
      else if (dragging === 'pan') this.cam.pan(dx, dy);
      else if (dragging === 'select' && this.overlay.dragBox) {
        this.overlay.dragBox.x1 = e.clientX;
        this.overlay.dragBox.y1 = e.clientY;
      }
      if (this.cam.mode === CAM.BRIDGE && !dragging && document.pointerLockElement === c) {
        this.cam.orbit(e.movementX * 2.2, e.movementY * 2.2);
      }
      // Hover feedback
      const hit = this.overlay.pick(e.clientX, e.clientY);
      c.style.cursor = this.pendingOrder ? 'crosshair' : (hit ? 'pointer' : 'default');
    });

    window.addEventListener('pointerup', (e) => {
      const wasDrag = dragging;
      const box = this.overlay.dragBox;
      dragging = null;
      this.overlay.dragBox = null;
      if (wasDrag === 'pan' && e.button === 0) {
        if (moved <= 8) this._click(e, false);   // a press that didn't move is a click
        return;
      }
      if (wasDrag === 'select') {
        if (moved > 8 && box) {
          const hits = this.overlay.pickInBox(box.x0, box.y0, box.x1, box.y1)
            .filter(h => h.unit && h.unit.side === SIDE.BLUE && h.unit.alive);
          if (hits.length) { this.selection = hits.map(h => h.unit); this.selectedTrack = null; this.audio.ui('click'); }
          return;
        }
        this._click(e, false);
      } else if (wasDrag === 'orbit' && moved < 6) {
        this._click(e, true);
      }
    });

    // Double-click the plot to go there.
    //
    // The roster and the contact panel have always done this — double a row and
    // the camera follows that ship or jumps to that track. But the plot IS the
    // primary display, and the symbol on it is the same object as the row: if
    // one responds to a double-click and the other ignores it, the interface is
    // teaching two different rules for the same act.
    c.addEventListener('dblclick', (e) => {
      if (this.cam.mode === CAM.BRIDGE) return;
      if (this.pendingOrder) return;          // mid-order; the click means a waypoint
      e.preventDefault();
      const hit = this.overlay.pick(e.clientX, e.clientY);

      // A round in flight: ride it. This is the single best-looking thing the
      // game does, and until now the only way to reach it was to know that V was
      // the key for it. Double-clicking the thing you want to watch is what
      // everyone tries first.
      if (hit?.ord && hit.ord.alive) {
        if (this.cam.rideMissile(hit.ord)) {
          this.autoMissileCam = false;   // an explicit choice outranks the director
          this.audio.ui('confirm');
          return;
        }
      }
      // A unit we own: chase it, exactly as the roster does.
      if (hit?.unit && hit.unit.alive) {
        this.selectUnit(hit.unit, false);
        this.cam.follow(hit.unit);
        this.audio.ui('confirm');
        return;
      }
      // A contact: close on its position, exactly as the contact panel does.
      if (hit?.track) {
        this.selectTrack(hit.track);
        this.cam.jumpTo(hit.track.x, hit.track.z, 26000);
        this.audio.ui('confirm');
        return;
      }
      // Empty water: step the camera in toward that point rather than doing
      // nothing. Every map in every strategy game does this, and a plot that
      // ignores a double-click on open sea feels broken even when it isn't.
      const sea = this.cam.screenToSea(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      );
      if (sea) {
        this.cam.jumpTo(sea.x, sea.z, Math.max(900, this.cam.distTarget * 0.42));
        this.audio.ui('click');
      }
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.zoom(e.deltaY);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this._key(e);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.pipeline.resize();
      this.overlay.resize();
    });

    window.addEventListener('blur', () => this.keys.clear());
  }

  _click(e, right) {
    if (this.cam.mode === CAM.BRIDGE) return;
    const sea = this.cam.screenToSea(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );

    if (!right && this.pendingOrder) {
      if (!sea) return;
      if (this.pendingOrder === 'MOVE') {
        for (const u of this.selection) u.orderWaypoint(sea.x, sea.z, { append: e.shiftKey });
        this.audio.ui('confirm');
      } else if (this.pendingOrder === 'SEARCH') {
        for (const u of this.selection) {
          if (!u.isAir) continue;
          u.setSearchPattern(sea.x, sea.z, 300000, 190000, 0, 58000);
          u.setEmcon(EMCON.RESTRICTED);
        }
        this.world.comms.push({
          t: this.world.time, from: this.selection[0]?.name || 'AIR', priority: 'ROUTINE',
          text: 'Commencing expanding ladder search. Surface-search radar to intermittent sweeps.',
        });
        this.audio.ui('confirm');
      }
      /*
       * The order mode STAYS ARMED until it is cancelled.
       *
       * It used to clear itself after one click unless shift was held, which
       * made a second waypoint order silently impossible: the mode was gone, so
       * the next click fell through to the selection branch, and a click on open
       * sea there clears the selection. Directing a unit to one point and then
       * to another — the most ordinary thing anyone does with this — dropped the
       * selection and left the first waypoint standing.
       *
       * The HUD has always told the player "SHIFT to queue, ESC to cancel",
       * which describes a mode that persists. This makes the code agree with it:
       * shift means queue, escape means cancel, and clicking means order.
       */
      return;
    }

    const hit = this.overlay.pick(e.clientX, e.clientY);
    if (right) {
      // Right-click on the sea = steer there; on a hostile track = designate it.
      if (hit && hit.track && !hit.track.own && hit.track.identity !== IDENT.FRIEND) {
        this.selectTrack(hit.track);
        return;
      }
      if (sea && this.selection.length) {
        for (const u of this.selection) u.orderWaypoint(sea.x, sea.z, { append: e.shiftKey });
        this.audio.ui('click');
        // A right-click is a complete order in itself, so it also ends an armed
        // mode rather than leaving the crosshair up afterwards.
        this.pendingOrder = null;
      }
      return;
    }

    if (hit) {
      if (hit.unit && hit.unit.side === SIDE.BLUE) this.selectUnit(hit.unit, e.shiftKey);
      else if (hit.track) this.selectTrack(hit.track);
      return;
    }
    if (!e.shiftKey) { this.selection = []; this.selectedTrack = null; }
  }

  _key(e) {
    const k = e.code;
    if (k === 'Escape') {
      if (this.hud.engage) { this.hud.closeEngage(); return; }
      if (this.pendingOrder) { this.pendingOrder = null; return; }
      if (this.cam.mode === CAM.MISSILE) { this.cam.exitMissile(); return; }
      if (this.cam.mode === CAM.BRIDGE) { document.exitPointerLock?.(); this.cam.setTactical(); return; }
      this.selection = []; this.selectedTrack = null;
      return;
    }
    if (k === 'Space') { e.preventDefault(); this.setTimeScale(this.timeScale === 0 ? this.lastScale || 4 : 0); return; }
    if (k === 'KeyM') {
      // Three stops: the sea, the chart, and the whole theatre.
      //
      // The theatre stop frames every unit the player actually holds — their own
      // force plus every live contact — so "show me everything" is one key rather
      // than scrolling the plot around with the arrows trying to find the edges
      // of a fight that is six hundred kilometres across.
      const d = this.cam.dist;
      if (d < 30000) {
        this.cam.distTarget = 90000;
      } else if (d < 200000) {
        const pts = [];
        for (const u of this.world.units) {
          if (!u.alive || u.despawned) continue;
          if (u.side === SIDE.BLUE) pts.push({ x: u.x, z: u.z });
        }
        const table = this.world.picture(SIDE.BLUE);
        if (table) for (const t of table.list) if (!t.faded) pts.push({ x: t.x, z: t.z });
        const obj = this.world.scenario?.objectivePoint;
        if (obj) pts.push({ x: obj.x, z: obj.z });
        this.cam.frameAll(pts);
        this.hud.pushAlert('THEATRE VIEW', 'info', 1.8);
      } else {
        this.cam.distTarget = 3000;
      }
      return;
    }
    if (k === 'KeyF') {
      // Shift+F toggles the frame-time readout; plain F still follows.
      if (e.shiftKey) {
        this._perfOn = !this._perfOn;
        $('perf').classList.toggle('on', this._perfOn);
        return;
      }
      if (this.selection[0]) this.cam.follow(this.selection[0]);
      return;
    }
    if (k === 'KeyB') { if (this.selection[0]) this.boardUnit(this.selection[0]); return; }
    if (k === 'KeyE') { if (this.selectedTrack) this.hud.openEngage(this.selectedTrack); return; }
    if (k === 'KeyV') {
      if (this.cam.mode === CAM.MISSILE) this.cam.exitMissile();
      else {
        const o = this.world.weapons.find(x => x.alive && x.side === SIDE.BLUE && x.category === 'ASM')
          || this.world.weapons.find(x => x.alive && x.category === 'ASM');
        if (o) this.cam.rideMissile(o);
      }
      return;
    }
    if (k === 'KeyT') { this.overlay.showWeb = !this.overlay.showWeb; return; }
    if (k === 'KeyR') { this.overlay.showRings = !this.overlay.showRings; return; }
    if (k === 'KeyL') { this.overlay.showLabels = !this.overlay.showLabels; return; }
    if (k === 'KeyG') { this.beginOrder('MOVE'); return; }
    if (k === 'Tab') {
      e.preventDefault();
      const blue = this.world.units.filter(u => u.alive && u.side === SIDE.BLUE);
      const i = blue.indexOf(this.selection[0]);
      const n = blue[(i + 1) % blue.length];
      if (n) { this.selectUnit(n, false); this.cam.jumpTo(n.x, n.z); }
      return;
    }
    if (k.startsWith('Digit')) {
      const n = +k.slice(5);
      if (n >= 1 && n <= 4 && this.selection.length) { this.orderEmcon(EMCON_ORDER[n - 1]); return; }
    }
    if (this.cam.mode === CAM.BRIDGE) {
      const u = this.cam.bridgeUnit;
      if (!u) return;
      if (k === 'KeyW') u.ordered.speed = clamp(u.ordered.speed + u.cls.maxSpeed * 0.22, 0, u.maxSpeedNow);
      if (k === 'KeyS') u.ordered.speed = clamp(u.ordered.speed - u.cls.maxSpeed * 0.22, 0, u.maxSpeedNow);
    }
  }

  // ── orders ────────────────────────────────────────────────────────────────
  selectUnit(u, add) {
    if (add) {
      if (this.selection.includes(u)) this.selection = this.selection.filter(x => x !== u);
      else this.selection.push(u);
    } else this.selection = [u];
    this.audio.ui('click');
  }

  selectTrack(t) {
    this.selectedTrack = t;
    this.overlay.selectedTrack = t;
    this.audio.ui('click');
  }

  beginOrder(kind) { this.pendingOrder = this.pendingOrder === kind ? null : kind; }

  orderEmcon(e) {
    for (const u of this.selection) {
      if (u.setEmcon(e)) {
        this.world.comms.push({
          t: this.world.time, from: u.name, priority: 'ROUTINE',
          text: `Setting ${e === EMCON.SILENT ? 'EMCON ALPHA' : e === EMCON.PASSIVE ? 'EMCON BRAVO' : e === EMCON.RESTRICTED ? 'EMCON CHARLIE' : 'EMCON DELTA'}.`,
        });
      }
    }
    this.audio.ui('confirm');
  }

  orderSpeed(frac) {
    for (const u of this.selection) u.ordered.speed = u.cls.maxSpeed * frac;
    this.audio.ui('click');
  }

  orderDepth(v) {
    for (const u of this.selection) {
      if (u.isSub) u.depthOrdered = v;
      else if (u.isAir) u.ordered.alt = clamp(v, 200, u.cls.maxAlt);
    }
    this.audio.ui('click');
  }

  orderRoe(r) {
    for (const u of this.selection) u.ordered.roe = r;
    this.audio.ui('confirm');
  }

  rejoinScreen(u) {
    const guide = this.world.blueGuide;
    if (!guide || u === guide || !guide.alive) return;
    const i = this.world.units.filter(x => x.side === SIDE.BLUE && x.isSurface).indexOf(u);
    const slots = [[-35, 22000], [35, 22000], [180, 12000], [155, 6500], [-155, 7200], [0, 26000]];
    const s = slots[i % slots.length];
    u.station = { guide, relBearing: s[0] * Math.PI / 180, range: s[1] };
    u.waypoints.length = 0; u.patrol = null;
    this.audio.ui('confirm');
  }

  launchHelo(parent) {
    const u = this.world.launchAircraft(parent, 'MH60R');
    if (u) {
      u.setOrbit(parent.x + 12000, parent.z + 12000, 8000);
      this.selection = [u];
      this.audio.ui('confirm');
    }
  }

  dropBuoy(u) {
    const b = this.world.dropSonobuoy(u);
    if (b) this.audio.ui('confirm');
    else this.audio.ui('deny');
  }

  toggleDip(u) {
    if (!u?.cls?.helo) return;
    if (u.dip) {
      u.dip = null;
      u.setOrbit(u.x, u.z, 6000);
      this.hud.pushAlert(`${u.name} — sonar raised, resuming patrol`, 'info', 4);
    } else {
      u.setDip(u.x, u.z);
      this.hud.pushAlert(`${u.name} — dipping on this datum`, 'info', 4);
    }
    this.audio.ui('confirm');
  }

  boardUnit(u) {
    if (!u || u.isAir || u.isSub) return;
    this.cam.board(u);
    this.canvas.requestPointerLock?.();
  }

  eligibleShooters(track) {
    return this.world.units.filter(u =>
      u.alive && u.side === SIDE.BLUE &&
      (u.cls.weapons || []).some(w => {
        const d = weapon(w.id);
        const ok = track.domain === DOMAIN.SUBSURFACE
          ? d.category === 'TORPEDO'
          : (track.domain === DOMAIN.AIR || track.domain === DOMAIN.MISSILE)
            ? d.category === 'SAM'
            : d.category === 'ASM';
        return ok && u.ammo(w.id) > 0;
      }));
  }

  weaponOptions(track, shooters) {
    const cats = track.domain === DOMAIN.SUBSURFACE ? ['TORPEDO']
      : (track.domain === DOMAIN.AIR || track.domain === DOMAIN.MISSILE) ? ['SAM'] : ['ASM'];
    const ids = new Set();
    for (const s of shooters) for (const w of s.cls.weapons || []) {
      if (cats.includes(weapon(w.id).category)) ids.add(w.id);
    }
    return [...ids].map(id => {
      const d = weapon(id);
      let total = 0, inRange = false;
      for (const s of shooters) {
        const n = s.ammo(id);
        if (n <= 0) continue;
        const r = Math.hypot(track.x - s.x, track.z - s.z);
        if (r < d.range * 0.95) { total += n; inRange = true; }
      }
      return { id, total, inRange, range: d.range };
    }).sort((a, b) => b.range - a.range);
  }

  fireSalvo(track, weaponId, count, seekerRange) {
    const d = weapon(weaponId);
    const shooters = this.eligibleShooters(track)
      .filter(s => s.ammo(weaponId) > 0 && Math.hypot(track.x - s.x, track.z - s.z) < d.range * 0.95)
      .sort((a, b) => b.ammo(weaponId) - a.ammo(weaponId));
    if (!shooters.length) return { fired: 0, reason: 'no shooter in range' };

    // Spread the salvo across every shooter that can reach, so no single ship
    // empties its cells and the rounds arrive from more than one bearing.
    let remaining = count;
    const per = [];
    for (const s of shooters) per.push({ s, n: 0 });
    let idx = 0, guard = 0;
    while (remaining > 0 && guard++ < 500) {
      const p = per[idx % per.length];
      if (p.s.ammo(weaponId) > p.n) { p.n++; remaining--; }
      idx++;
      if (per.every(q => q.s.ammo(weaponId) <= q.n)) break;
    }
    // Coordinated time on top, computed ONCE across the whole raid. Working it
    // out per shooter (which is what happens if you let world.engage derive it)
    // means each ship's rounds arrive when they personally get there — the
    // Poseidon's two missiles turn up nine minutes ahead of the destroyers' six
    // and are shot down on their own. Arriving together is the entire point.
    const now = this.world.time;
    let slowest = 0;
    for (const p of per) {
      if (p.n <= 0) continue;
      slowest = Math.max(slowest, Math.hypot(track.x - p.s.x, track.z - p.s.z) / d.speed);
    }
    const arrival = now + slowest + 45;
    let fired = 0;
    for (const p of per) {
      if (p.n <= 0) continue;
      const r = this.world.engage([p.s], track, weaponId, p.n, {
        seekerActivateRange: seekerRange, timeOnTop: arrival,
      });
      fired += r.fired;
    }
    if (fired) this._rodeSalvo = new Set();
    return { fired };
  }

  /**
   * Alpha strike: commit every anti-ship weapon that can reach, from every ship
   * that has one, on a single shared time-on-top.
   *
   * This exists because the arithmetic of the defence demands it. A modern
   * surface action group can service twenty-odd subsonic rounds in the two
   * minutes they are inside its horizon; beating it is not a matter of aiming
   * better, it is a matter of sending more than it can service, all arriving at
   * once. Doing that one weapon type at a time — which is all the per-weapon
   * dialog can do — hands the defender three separate small raids to defeat in
   * sequence. This is the button that turns the lesson into an action.
   */
  alphaStrike(track) {
    if (!track) return { fired: 0 };
    const now = this.world.time;
    const cats = track.domain === DOMAIN.SUBSURFACE ? ['TORPEDO'] : ['ASM'];
    const plan = [];
    let slowest = 0;
    for (const u of this.world.units) {
      if (!u.alive || u.side !== SIDE.BLUE) continue;
      for (const w of u.cls.weapons || []) {
        const d = weapon(w.id);
        if (!cats.includes(d.category)) continue;
        const n = u.ammo(w.id);
        if (n <= 0) continue;
        const r = Math.hypot(track.x - u.x, track.z - u.z);
        if (r > d.range * 0.95) continue;
        plan.push({ u, id: w.id, n, tof: r / d.speed });
        slowest = Math.max(slowest, r / d.speed);
      }
    }
    if (!plan.length) return { fired: 0, reason: 'nothing in range' };
    const arrival = now + slowest + 45;
    let fired = 0;
    const kinds = new Set();
    for (const p of plan) {
      const res = this.world.engage([p.u], track, p.id, p.n, { timeOnTop: arrival });
      fired += res.fired;
      if (res.fired) kinds.add(weapon(p.id).name);
    }
    if (fired) {
      this._rodeSalvo = new Set();
      this.world.comms.push({
        t: now, from: 'TF-44 CO', priority: 'FLASH',
        text: `ALPHA STRIKE. ${fired} rounds committed on ${track.id} — ${[...kinds].join(', ')}. Every round arrives together in ${Math.round(slowest / 60)} minutes. Hold that track.`,
      });
    }
    return { fired };
  }

  setTimeScale(s) {
    if (s !== 0) this.lastScale = s;
    this.timeScale = s;
    this.audio.ui('click');
  }

  // ── screens ───────────────────────────────────────────────────────────────
  /**
   * Screens cross-fade rather than cut. `.hidden` drives the opacity transition
   * and `.gone` takes the element out of the layout once the fade has finished,
   * so a faded-out screen still cannot eat clicks meant for the one behind it.
   */
  _hideScreen(id) {
    const e = $(id);
    e.classList.add('hidden');
    clearTimeout(e._goneT);
    e._goneT = setTimeout(() => e.classList.add('gone'), 600);
  }

  _showScreen(id) {
    const e = $(id);
    clearTimeout(e._goneT);
    e.classList.remove('gone');
    // One frame with `gone` removed but `hidden` still set, so the browser has a
    // starting opacity to transition FROM. Without it the fade never plays.
    requestAnimationFrame(() => requestAnimationFrame(() => e.classList.remove('hidden')));
  }

  _wireScreens() {
    $('btn-start').onclick = () => {
      this.audio.unlock();
      this._hideScreen('screen-menu');
      this._fillBrief();
      this._wireScroll('brief-body');
      this._showScreen('screen-brief');
    };
    $('btn-howto').onclick = () => { this._fillHelp(); this._wireScroll('help-body'); this._showScreen('screen-help'); };
    $('btn-help-close').onclick = () => this._hideScreen('screen-help');
    this._attractShot();
    $('btn-brief-go').onclick = () => {
      this._hideScreen('screen-brief');
      $('hud').style.display = '';
      $('perf').classList.toggle('on', !!this._perfOn);
      $('hud').classList.add('entering');
      setTimeout(() => $('hud').classList.remove('entering'), 900);
      this._attract = null;
      this.running = true;
      this.audio.unlock();
      this._openingShot();
    };
    $('btn-db-again').onclick = () => { $('hud').style.opacity = ''; location.reload(); };
    $('btn-db-menu').onclick = () => location.reload();
  }

  /**
   * Wire the "scroll for more" marker under a long text panel: it shows only
   * while there is more below, and retires itself the moment the reader reaches
   * the end.
   */
  _wireScroll(id) {
    const body = $(id);
    const tag = body.parentElement.querySelector('.scroll-more');
    if (!tag) return;
    const sync = () => {
      const more = body.scrollHeight - body.clientHeight - body.scrollTop > 12;
      tag.classList.toggle('at-end', !more);
    };
    body.onscroll = sync;
    setTimeout(sync, 30);
    sync();
  }

  _fillBrief() {
    const s = this.world.scenario;
    $('brief-sub').textContent = s.subtitle.toUpperCase();
    const oob = this.world.units.filter(u => u.side === SIDE.BLUE)
      .map(u => `<div style="display:flex;justify-content:space-between"><span>${u.hullNo ? u.hullNo + '  ' : ''}${u.name}</span><span style="color:var(--dim)">${u.cls.display}</span></div>`).join('');
    $('brief-body').innerHTML = `
      <div class="stamp">SECRET // OPERATION NORTH ANCHOR // TASK FORCE 44 // ${fmt.clock(this.world.time)}Z</div>
      <h3>SITUATION</h3>
      ${s.briefing.map(p => `<p>${p}</p>`).join('')}
      <h3 style="margin-top:22px">ORDER OF BATTLE — TASK FORCE 44</h3>
      <div style="font-size:11px;line-height:1.9;color:var(--txt)">${oob}</div>
      <h3 style="margin-top:22px">COMMANDER'S INTENT</h3>
      <p>Find the surface action group before it finds you. Build a firing solution out of
      whatever sensors you can put over the horizon, keep custody of it while your missiles
      are in the air, and get GRANITE BAY to POINT OSCAR.</p>
      <p style="color:var(--dim);font-size:11px">Positive identification before launch. There is neutral
      traffic all over this water, and a seeker cannot tell a frigate from a container ship.</p>
    `;
  }

  _fillHelp() {
    $('help-body').innerHTML = `
      <h3>CAMERA</h3>
      <div class="legend">
        <div><b>Left-drag</b> pan the plot</div><div><b>Wheel</b> zoom · sea level to 260 km</div>
        <div><b>Right-drag</b> orbit</div><div><b>M</b> cycle sea → chart → whole theatre</div>
        <div><b>F</b> follow selected unit</div><div><b>B</b> take the bridge (ships only)</div>
        <div><b>V</b> ride a weapon</div><div><b>Tab</b> cycle own units</div>
      </div>
      <h3 style="margin-top:20px">COMMAND</h3>
      <div class="legend">
        <div><b>Click</b> select unit or contact</div><div><b>Double-click</b> go to it — ship, contact or missile</div>
        <div><b>Shift + drag</b> box-select several</div><div><b>Double-click sea</b> zoom in there</div>
        <div><b>Right-click sea</b> steer there</div><div><b>Shift + click</b> queue waypoints</div>
        <div><b>1 2 3 4</b> EMCON alpha → delta</div><div><b>E</b> engage designated track</div>
        <div><b>G</b> set course mode</div><div><b>Space</b> pause · number keys on the bar for time</div>
        <div><b>T</b> toggle kill web</div><div><b>R</b> toggle sensor rings</div>
      </div>
      <h3 style="margin-top:20px">DOCTRINE — THE FOUR THINGS THAT DECIDE THIS FIGHT</h3>
      <p><b style="color:var(--accent)">1 · The horizon, not the radar.</b> A mast at 30 m sees another ship at
      21 nautical miles no matter how good the radar is. An aircraft at 28,000 feet sees the same ship at
      205. If you cannot find the enemy, the answer is almost always altitude.</p>
      <p><b style="color:var(--accent)">2 · Radiating is a decision, not a setting.</b> Your SPY radar is a
      beacon: a hostile ESM receiver holds you at roughly 1.6 times the range at which you can see him.
      EMCON ALPHA makes you invisible and blind; EMCON DELTA makes you omniscient and obvious.</p>
      <p><b style="color:var(--accent)">3 · Track quality is permission to shoot.</b> Every contact carries
      an error ellipse. Below TQ4 that ellipse is wider than a missile seeker's search basket, and the
      salvo will fly to a patch of empty ocean. Cross-fix passive bearings, or get a sensor closer.</p>
      <p><b style="color:var(--accent)">4 · Custody wins engagements.</b> A missile fired at 300 nautical
      miles is in the air for eleven minutes. If the sensor holding the track drops off, the target moves
      out of the basket. Keep something looking at him until impact.</p>
    `;
  }

  showDebrief(ev) {
    const g = ev.grade;
    const w = this.world;
    $('db-title').textContent = ev.status === 'SUCCESS' ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED';
    $('db-sub').textContent = ev.reason.toUpperCase();
    const rows = g.pts.map(p => `<div class="score-row">
      <div><div class="lbl">${p.label}</div><div class="det">${p.detail || ''}</div></div>
      <div class="pt${p.value < 0 ? ' neg' : ''}">${p.value > 0 ? '+' : ''}${p.value}</div></div>`).join('');
    const lessons = [];
    const s = w.stats;
    if (s.timeToFirstWeaponsQuality !== null) {
      lessons.push(`It took <b>${Math.round(s.timeToFirstWeaponsQuality / 60)} minutes</b> to develop a weapons-quality track. Every minute of that was a minute the Volna was closing on your amphibious group.`);
    } else {
      lessons.push('You never developed a weapons-quality track. Detection is not targeting — a contact you cannot localise to within a seeker basket is a contact you cannot shoot.');
    }
    if (s.asmFired) {
      const eff = s.asmHit / s.asmFired;
      lessons.push(eff > 0.5
        ? `<b>${Math.round(eff * 100)}%</b> of your anti-ship missiles found a target. That is what maintained custody looks like.`
        : `Only <b>${Math.round(eff * 100)}%</b> of your anti-ship missiles found a target. The rest searched empty water: the track went stale between launch and arrival, or the aim point was never good enough to begin with.`);
    }
    const ourNeutrals = s.neutralLosses.filter(l => l.by === SIDE.BLUE);
    const theirNeutrals = s.neutralLosses.filter(l => l.by !== SIDE.BLUE);
    if (ourNeutrals.length) {
      lessons.push(`<b>${ourNeutrals.length}</b> neutral ${ourNeutrals.length === 1 ? 'vessel was' : 'vessels were'} destroyed by our own ordnance. An active seeker takes the largest return inside its basket, and a loaded merchant is a far larger return than a warship — positive identification before launch is not a formality.`);
    }
    if (theirNeutrals.length) {
      lessons.push(`The Volsk salvos destroyed <b>${theirNeutrals.length}</b> neutral merchant ${theirNeutrals.length === 1 ? 'vessel that was' : 'vessels that were'} nowhere near this action. Their seekers made the same choice ours would have. It is worth remembering which way that cuts: a shipping lane is cover.`);
    }
    if (s.blueLosses.length) lessons.push(`You lost ${s.blueLosses.length} ${s.blueLosses.length === 1 ? 'unit' : 'units'}. Check whether they were radiating when the strike came in.`);
    $('db-body').innerHTML = `
      <div class="rank ${ev.status === 'SUCCESS' ? 'good' : 'bad'}">${g.rank}</div>
      <div class="rank-pts">${g.total > 0 ? '+' : ''}${g.total} POINTS</div>
      ${rows}
      <h3 style="margin-top:22px">AFTER ACTION</h3>
      ${lessons.map(l => `<p>${l}</p>`).join('')}
    `;
    // Stop the world FIRST. The debrief used to fade in over a HUD that had
    // already reset itself to 04:10:00 with an empty roster, so two application
    // states were on screen at once for about a second.
    this.running = false;
    $('hud').style.opacity = '0.25';
    this._wireScroll('db-body');
    this._showScreen('screen-debrief');
  }

  // ── main loop ─────────────────────────────────────────────────────────────
  /**
   * Development capture: render one frame at an explicit resolution and hand
   * back a composited PNG of the 3-D view plus the tactical overlay. Used to
   * judge the art at full size instead of a scaled-down browser pane.
   */
  grab(w = 1920, h = 1080, withHud = true) {
    const prevW = window.innerWidth, prevH = window.innerHeight;
    const r = this.pipeline.renderer;
    // The dynamic-resolution controller would otherwise resize the framebuffer
    // out from under the capture.
    const prevDyn = this.pipeline.dynamicResolution;
    this.pipeline.dynamicResolution = false;
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    this.pipeline.composer?.setSize(w, h);
    if (this.pipeline.bloomPass) this.pipeline.bloomPass.setSize(w * 0.5, h * 0.5);
    if (this.pipeline.ssaoPass) this.pipeline.ssaoPass.setSize(w * 0.5, h * 0.5);
    if (this.pipeline.fxaaPass) this.pipeline.fxaaPass.material.uniforms.resolution.value.set(1 / w, 1 / h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Camera FIRST, then the world. The camera's update can rebase the floating
    // origin, and every mesh position is computed relative to it — doing them in
    // the other order renders one frame in which the camera has moved to the new
    // origin and the hulls are still placed against the old one, which puts the
    // subject a kilometre off frame.
    this.cam.update(0.0001, this.view.ocean, this.view.elapsed);
    this.view.update(0.0001, this.world, this.selection);
    this.pipeline.render(this.view.elapsed);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const c = out.getContext('2d');
    // Render, then read the canvas IN THE SAME TASK.
    //
    // The drawing buffer is only guaranteed to hold its contents until the end
    // of the current task, so the render and the drawImage have to be adjacent —
    // capture on a later tick comes back empty. Reading an offscreen target
    // instead does NOT work here: with post-processing on, the composer renders
    // into its own buffers and straight to the screen, ignoring any target bound
    // beforehand, so the readback finds a buffer nothing ever wrote to.
    this.pipeline.render(this.view.elapsed);
    c.drawImage(this.canvas, 0, 0, w, h);
    if (withHud) {
      const ov = this.overlay;
      const sw = ov.w, sh = ov.h;
      ov.w = w; ov.h = h; ov.dpr = 1;
      ov.canvas.width = w; ov.canvas.height = h;
      ov.draw(0.0001);
      c.drawImage(ov.canvas, 0, 0);
      ov.w = sw; ov.h = sh;
      ov.resize();
    }
    const url = out.toDataURL('image/png');
    this.pipeline.dynamicResolution = prevDyn;
    this.pipeline._lastFrameT = 0;
    r.setSize(prevW, prevH, false);
    this.pipeline.resize();
    this.camera.aspect = prevW / prevH;
    this.camera.updateProjectionMatrix();
    return url;
  }

  /**
   * The establishing shot.
   *
   * Dropping the player straight onto a top-down plot the instant the briefing
   * closes throws away the one moment the game has to say what it is. Instead
   * the camera starts high and wide over the task force and eases down and in
   * over four seconds, so the first thing the player sees is their formation on
   * a real ocean — and it hands over to the normal tactical camera at exactly
   * the altitude the tactical camera would have been at anyway, so there is no
   * cut at the end of it either.
   */
  /**
   * Attract mode.
   *
   * The main menu was a title over a black rectangle. Every naval game worth
   * comparing this one to opens on its own ocean — the menu IS a shot of the
   * game — and there was a fully rendered sea sitting behind ours the whole
   * time under a scrim that was 97% opaque. This puts the camera on a slow
   * beauty pass around the flagship and lets the sim run at a crawl underneath,
   * so the water moves, the wake streams and the light changes while the player
   * reads the blurb.
   */
  _attractShot() {
    const g = this.world.blueGuide;
    if (!g) return;
    const cam = this.cam;
    cam.setTactical({ x: g.x, z: g.z });
    cam.focus.set(g.x, g.z);
    cam.focusTarget.copy(cam.focus);
    cam.dist = cam.distTarget = 300;
    cam.pitch = cam.pitchTarget = 0.085;
    cam.yaw = cam.yawTarget = g.heading + Math.PI * 0.62;
    this._attract = { yaw: cam.yaw };
  }

  _stepAttract(dt) {
    const a = this._attract;
    if (!a) return;
    const g = this.world.blueGuide;
    if (!g) return;
    const cam = this.cam;
    // A slow drift, well under a degree a second — enough that the frame is
    // alive, slow enough that nobody notices it as motion.
    a.yaw += dt * 0.021;
    cam.yaw = cam.yawTarget = a.yaw;
    // Aim off the ship, not at it. The title block owns the middle of the frame,
    // so the camera looks at a point three hundred metres abeam and the
    // hull falls into the lower left third where there is nothing over it.
    const ox = Math.sin(a.yaw + Math.PI / 2) * 300;
    const oz = Math.cos(a.yaw + Math.PI / 2) * 300;
    cam.focusTarget.set(g.x + ox, g.z + oz);
    cam.distTarget = 300;
    cam.pitchTarget = 0.085;
    // The world still has to tick or the sea is a photograph. One tenth speed:
    // the swell breathes, the wake streams, nothing decisive happens.
    this.world.step(dt * 0.1, 1);
  }

  _openingShot() {
    const g = this.world.blueGuide;
    if (!g) return;
    const cam = this.cam;
    cam.setTactical({ x: g.x, z: g.z });
    cam.focus.set(g.x, g.z);
    cam.focusTarget.copy(cam.focus);
    cam.dist = 1700;
    cam.distTarget = 1700;
    cam.pitch = cam.pitchTarget = 0.22;
    cam.yaw = cam.yawTarget = g.heading + Math.PI * 0.78;
    this._openT = 0;
    this._opening = { fromDist: 1700, toDist: 42000, fromYaw: cam.yaw, dur: 5.5 };
  }

  _stepOpening(dt) {
    const o = this._opening;
    if (!o) return;
    this._openT += dt;
    const t = Math.min(1, this._openT / o.dur);
    // Ease out cubic: quick lift off the deck, long settle into the plot.
    const e = 1 - Math.pow(1 - t, 3);
    const cam = this.cam;
    cam.dist = cam.distTarget = o.fromDist + (o.toDist - o.fromDist) * e;
    cam.yaw = cam.yawTarget = o.fromYaw + 0.55 * e;
    const g = this.world.blueGuide;
    if (g) { cam.focusTarget.set(g.x, g.z); }
    if (t >= 1) this._opening = null;
  }

  /**
   * Development: park the camera at an explicit pose and hold it there. The main
   * loop re-poses the camera every frame from the director, so a manually placed
   * camera snaps back before the next capture — freezing the director is the only
   * way to frame a specific shot.
   */
  freezeCamera(pos, look, fov = 45) {
    if (!this._camFrozen) {
      this._camFrozen = this.cam.update.bind(this.cam);
      this.cam.update = () => {};
    }
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.camera.lookAt(look[0], look[1], look[2]);
    this.camera.fov = fov;
    this.camera.near = 0.5;
    this.camera.far = 400000;
    this.camera.updateProjectionMatrix();
  }

  unfreezeCamera() {
    if (this._camFrozen) { this.cam.update = this._camFrozen; this._camFrozen = null; }
  }

  frame() {
    // The render loop must never die. A single exception anywhere in the sim
    // used to take requestAnimationFrame with it, leaving a frozen picture that
    // looks exactly like a pause — the game appears to be running, the HUD is
    // there, and nothing moves. Catch, report once per kind, and keep going.
    try {
      this._frameBody();
    } catch (err) {
      const key = String(err && err.message);
      this._errSeen = this._errSeen || new Set();
      if (!this._errSeen.has(key)) {
        this._errSeen.add(key);
        // eslint-disable-next-line no-console
        console.error('[frame]', err);
        this.hud?.pushAlert('SIMULATION FAULT — see console', 'warn', 6);
      }
    }
    requestAnimationFrame(() => this.frame());
  }

  _frameBody() {
    const dtRaw = this._clock.getDelta();
    const dt = Math.min(0.05, dtRaw);
    this._perfTick(dtRaw);

    // Split the frame into its three real costs so a slow frame can be
    // attributed instead of guessed at. Without this a 200 ms frame is just a
    // number — sim, scene-graph/overlay/HUD, and draw are completely different
    // problems with completely different fixes.
    const _t0 = performance.now();
    if (this.running) {
      this.world.step(dt, this.timeScale);
      this.mission.step();
      this._stepOpening(dt);
      this._bridgeControls(dt);
      this._edgePan(dt);
    } else {
      this._stepAttract(dt);
    }
    const _t1 = performance.now();

    this.cam.update(dt, this.view.ocean, this.view.elapsed);
    this.view.update(dt, this.world, this.selection);
    this.overlay.selection = this.selection;
    this.overlay.selectedTrack = this.selectedTrack;
    this.overlay.draw(dt);
    if (this.running) this.hud.update(dt);
    const _t2 = performance.now();

    this.audio.setContext(this.cam.mode, this.camera.position.y);
    // Ambient occlusion is measured in metres, so tell the pipeline what scale
    // the shot is at — bridge wing, ship's length, or whole task force.
    this.pipeline.setSubjectDistance(
      this.cam.mode === 'BRIDGE' ? 26
        : this.cam.mode === 'MISSILE' ? 22
          : Math.max(30, this.cam.dist));
    this.pipeline.render(this.view.elapsed);
    const _t3 = performance.now();
    this._simMs = _t1 - _t0;
    this._viewMs = _t2 - _t1;
    this._drawMs = _t3 - _t2;

    // Cull dead selections
    if (this.selection.some(u => !u.alive)) this.selection = this.selection.filter(u => u.alive);
    if (this.selectedTrack && this.selectedTrack.faded && this.world.time - this.selectedTrack.lastUpdate > 2400) {
      this.selectedTrack = null;
    }
  }

  /**
   * Frame-time readout.
   *
   * Reports the MEDIAN of the last two seconds, not the mean: a single 200 ms
   * hitch from a shader compile or an env-map refresh drags a mean far enough to
   * hide a real regression, and the median is what the frame actually feels
   * like. Also shows the dynamic resolution scale, because a renderer that is
   * holding 60 by quietly dropping to 60% of native is not the same as one
   * holding 60 at native and the difference has to be visible.
   */
  _perfTick(dtRaw) {
    const p = this._perf;
    p.push(dtRaw * 1000);
    if (p.length > 120) p.shift();
    this._perfT = (this._perfT || 0) + dtRaw;
    if (this._perfT < 0.4) return;
    if (!this._perfOn) {
      const off = $('perf');
      if (off) off.classList.remove('on');
      this._perfT = 0;
      return;
    }
    this._perfT = 0;
    const box0 = $('perf');
    if (box0 && box0.classList.contains('on') !== !!this._perfOn) {
      box0.classList.toggle('on', !!this._perfOn);
    }
    const sorted = p.slice().sort((a, b) => a - b);
    const ms = sorted[sorted.length >> 1] || 0;
    const fps = ms > 0 ? Math.round(1000 / ms) : 0;
    const box = $('perf');
    $('perf-fps').textContent = String(fps);
    $('perf-ms').textContent = ms.toFixed(1);
    $('perf-sim').textContent = (this._simMs ?? 0).toFixed(0);
    // View and draw reported together as "draw": the useful split for tuning is
    // simulation versus everything downstream of it.
    $('perf-gpu').textContent = ((this._viewMs ?? 0) + (this._drawMs ?? 0)).toFixed(0);
    const scale = this.pipeline._dynScale ?? 1;
    $('perf-res').textContent = scale < 0.995 ? `${Math.round(scale * 100)}% res` : 'native';
    box.classList.toggle('warn', fps < 55 && fps >= 40);
    box.classList.toggle('bad', fps < 40);
  }

  /** Switch graphics preset live. */
  setQuality(q) {
    this.pipeline.setQuality(q);
    this.quality = this.pipeline._quality;
    this.view.setQuality(this.quality);
    // Interface compositing is a real part of the frame budget — see the
    // cheap-ui block in styles.css. Below High, drop the backdrop blurs.
    document.body.classList.toggle(
      'cheap-ui', this.quality === 'low' || this.quality === 'medium',
    );
    try { localStorage.setItem('oth.quality', this.quality); } catch (e) { /* private mode */ }
    this.hud?.pushAlert(`Graphics: ${this.quality.toUpperCase()}`, 'info', 2.2);
  }

  _bridgeControls(dt) {
    if (this.cam.mode !== CAM.BRIDGE) return;
    const u = this.cam.bridgeUnit;
    if (!u?.alive) { this.cam.setTactical(); return; }
    const k = this.keys;
    let rud = 0;
    if (k.has('KeyA')) rud -= 1;
    if (k.has('KeyD')) rud += 1;
    if (rud !== 0) {
      u.waypoints.length = 0; u.patrol = null; u.station = null;
      u.ordered.heading = (u.ordered.heading + rud * 0.55 * dt * this.timeScale) % (Math.PI * 2);
    }
  }

  _edgePan(dt) {
    const k = this.keys;
    if (this.cam.mode === CAM.BRIDGE) return;
    let vx = 0, vz = 0;
    const sp = this.cam.dist * 0.85 * dt;
    if (k.has('ArrowUp')) vz += sp;
    if (k.has('ArrowDown')) vz -= sp;
    // Left and right were the wrong way round: pressing Right walked the view
    // left. The sign here has to match the mouse-pan convention a few lines up
    // in CameraDirector.pan(), which negates dx because dragging the map moves
    // the world WITH the pointer — the opposite sense to a key that moves the
    // CAMERA.
    if (k.has('ArrowLeft')) vx += sp;
    if (k.has('ArrowRight')) vx -= sp;
    if (vx || vz) this.cam.panBy(vx, vz);
  }
}

// ── boot ──────────────────────────────────────────────────────────────────
async function boot() {
  const bar = $('load-bar'), lbl = $('load-lbl');
  const step = (p, t) => { bar.style.width = `${p}%`; lbl.textContent = t; };
  step(12, 'BUILDING OPERATING AREA');
  await new Promise(r => setTimeout(r, 30));

  const game = new Game();
  window.GAME = game;
  // Development capture helper (see Game.grab). Kept on the window so a full
  // reload after a shader edit does not lose the framing harness.
  window.SHOT = async (n, o = {}) => {
    if (!game.running) {
      document.getElementById('btn-start')?.click();
      document.getElementById('btn-brief-go')?.click();
    }
    const c = game.cam;
    if (o.dist !== undefined) { c.distTarget = o.dist; c.dist = o.dist; }
    if (o.pitch !== undefined) { c.pitchTarget = o.pitch; c.pitch = o.pitch; }
    if (o.yaw !== undefined) { c.yaw = c.yawTarget = o.yaw; }
    if (o.focus) { c.focus.set(o.focus[0], o.focus[1]); c.focusTarget.set(o.focus[0], o.focus[1]); }
    if (o.ts !== undefined) game.setTimeScale(o.ts);
    await new Promise(r => setTimeout(r, o.wait ?? 2200));
    const u = game.grab(o.w || 1920, o.h || 1080, !!o.hud);
    await fetch('http://127.0.0.1:5199/shot?n=' + n, { method: 'POST', body: u });
    return 'saved ' + n;
  };
  // Capture the DOM interface as an image.
  //
  // The 3-D capture path renders the WebGL canvas directly, which misses the
  // entire HUD — every panel, the contact list, the decision cards, the type.
  // There is no screenshot API available here, so the interface is serialised
  // into an SVG foreignObject with the stylesheet inlined and rasterised through
  // an Image. It is not pixel-identical to the browser's own compositor
  // (backdrop-filter and blur do not survive), but layout, type and colour do,
  // which is what a design review needs to see.
  window.SHOTUI = async (n, o = {}) => {
    const w = o.w || window.innerWidth, h = o.h || window.innerHeight;
    let css = '';
    for (const sheet of document.styleSheets) {
      try { for (const r of sheet.cssRules) css += r.cssText + '\n'; } catch (e) { /* cross-origin */ }
    }
    // Strip what foreignObject cannot rasterise, so it fails soft rather than blank.
    css = css.replace(/backdrop-filter:[^;}]*;?/g, '').replace(/-webkit-backdrop-filter:[^;}]*;?/g, '');
    // CSS animations do not run in a static rasterisation, so anything that
    // fades IN from opacity 0 stays at zero. That is why the fleet-net log came
    // back as an empty panel: .msg is opacity:0 with a fade-in animation, and in
    // a still frame the animation never plays.
    css = css.replace(/animation:[^;}]*;?/g, '').replace(/opacity:\s*0;/g, 'opacity:1;');
    const target = o.sel ? document.querySelector(o.sel) : document.getElementById('app');
    const clone = target.cloneNode(true);
    if (o.sel) clone.style.cssText += ';position:relative;inset:auto;';
    const glCanvas = clone.querySelector('#gl');
    if (glCanvas) glCanvas.remove();
    // position:fixed does not survive a foreignObject rasterisation — the
    // element has no fixed-position containing block inside the SVG and Chrome
    // drops it entirely, which is why the menu (absolute) captured and the
    // briefing (fixed) came back as an empty layer over the sea.
    clone.style.cssText += ';position:relative;width:100%;height:100%;';
    for (const e of clone.querySelectorAll('.screen, #loading')) {
      e.style.position = 'absolute';
      e.style.inset = '0';
    }
    // Scroll containers do not survive the rasterisation: foreignObject lays the
    // clone out fresh, with no scroll position and (in practice) no clipping, so
    // a panel scrolled to its newest message came back either blank or spilling
    // hundreds of pixels past its own border. Freeze each scroller to the height
    // and offset it actually has on screen.
    const liveScrollers = target.querySelectorAll('.scroll');
    const cloneScrollers = clone.querySelectorAll('.scroll');
    for (let i = 0; i < cloneScrollers.length; i++) {
      const live = liveScrollers[i], cs = cloneScrollers[i];
      if (!live) continue;
      cs.style.height = `${live.clientHeight}px`;
      cs.style.maxHeight = `${live.clientHeight}px`;
      cs.style.overflow = 'hidden';
      // Drop the rows that are scrolled off the top outright. Offsetting them
      // with a transform (or a margin) does not survive the rasterisation — the
      // fleet-net log, three thousand pixels deep and scrolled to its newest
      // message, came back as an empty panel every time. Deleting what is above
      // the fold leaves the visible rows where the flow puts them, which is
      // exactly where they are on screen.
      const top = live.scrollTop;
      if (top > 1) {
        const kids = [...live.children];
        let cut = 0;
        for (let k = 0; k < kids.length; k++) {
          if (kids[k].offsetTop + kids[k].offsetHeight > top) { cut = k; break; }
        }
        for (let k = 0; k < cut && cs.firstChild; k++) cs.removeChild(cs.firstChild);
      }
    }

    // cloneNode does not copy a canvas's pixels, so every canvas-drawn element
    // of the interface — the bridge compass strip above all — came back blank.
    // Swap each one for an <img> of its current contents.
    const liveCanvases = target.querySelectorAll('canvas');
    const cloneCanvases = clone.querySelectorAll('canvas');
    for (let i = 0; i < cloneCanvases.length; i++) {
      const live = liveCanvases[i], cc = cloneCanvases[i];
      if (!live || !live.width || !live.height) continue;
      let data;
      try { data = live.toDataURL('image/png'); } catch (e) { continue; }
      const im = document.createElement('img');
      im.setAttribute('src', data);
      im.setAttribute('width', String(cc.getAttribute('width') || live.clientWidth));
      im.setAttribute('height', String(cc.getAttribute('height') || live.clientHeight));
      im.style.cssText = cc.style.cssText + ';max-width:100%;height:auto;display:block';
      im.className = cc.className;
      cc.replaceWith(im);
    }

    const html = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
      + `<foreignObject width="100%" height="100%">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px">`
      + `<style>${css.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</style>`
      + html + `</div></foreignObject></svg>`;
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const c = out.getContext('2d');
    // The 3-D frame first, then the interface over it.
    if (o.world !== false) {
      game.cam.update(0.0001, game.view.ocean, game.view.elapsed);
      game.view.update(0.0001, game.world, game.selection);
      game.pipeline.render(game.view.elapsed);
      c.drawImage(game.canvas, 0, 0, w, h);
      const ov = game.overlay;
      // The overlay only redraws when the frame loop asks it to, and the frame
      // loop is not running during a capture — without this the tactical plot
      // comes back as an empty sea with no symbology on it at all.
      ov.selection = game.selection;
      ov.selectedTrack = game.selectedTrack;
      ov.draw(0.0001);
      c.drawImage(ov.canvas, 0, 0, w, h);
    } else {
      c.fillStyle = '#04080c'; c.fillRect(0, 0, w, h);
    }
    c.drawImage(img, 0, 0);
    await fetch('http://127.0.0.1:5199/shot?n=' + n, { method: 'POST', body: out.toDataURL('image/png') });
    return 'saved ' + n;
  };

  // Headless sim driver. requestAnimationFrame does not fire when the browser
  // pane is not the front-most surface, which freezes the world at t0 and makes
  // every capture a picture of the first frame. This advances the simulation and
  // the view explicitly, so a capture harness never depends on the compositor.
  window.TICK = (seconds, scale = 1, sub = 0.05) => {
    let done = 0;
    while (done < seconds) {
      const dt = Math.min(sub, seconds - done);
      game.world.step(dt, scale);
      game.mission.step();
      game.cam.update(dt, game.view.ocean, game.view.elapsed);
      game.view.update(dt, game.world, game.selection);
      done += dt;
    }
    return Math.round(game.world.time);
  };
  step(48, 'GENERATING SEA STATE');
  await new Promise(r => setTimeout(r, 30));

  // Warm the shaders and the glTF cache with one hidden frame before the player
  // ever sees the plot, so the first real frame is not a compile hitch.
  step(72, 'COMPILING SHADERS');
  game.view.update(0.016, game.world, []);
  game.cam.update(0.016, game.view.ocean, 0);
  game.pipeline.render(0);
  game.pipeline.validateShaders(game.view.scene);
  await new Promise(r => setTimeout(r, 120));
  step(94, 'ESTABLISHING LINK 16');
  await new Promise(r => setTimeout(r, 120));
  step(100, 'READY');
  $('loading').classList.add('hidden');
  game.frame();

  // ?skip jumps straight into the operation. Used by the automated checks, and
  // convenient when iterating on something forty minutes into a mission.
  if (/[?&]skip/.test(location.search)) {
    for (const id of ['screen-menu', 'screen-brief']) {
      $(id).classList.add('hidden', 'gone');
    }
    $('hud').style.display = '';
    game.running = true;
  }
}

boot();
