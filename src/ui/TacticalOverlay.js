import * as THREE from 'three';
import {
  IDENT, DOMAIN, SIDE, NM, KNOT, clamp, tqBand, radarHorizon, EMCON_INFO,
  WEAPONS_QUALITY_TQ, AO_HALF,
} from '../sim/constants.js';

/**
 * The tactical plot.
 *
 * Drawn as a 2-D canvas on top of the 3-D scene, with every symbol projected
 * from its real world position — so the plot and the seascape are the same
 * thing seen at two different zoom levels rather than two separate screens.
 *
 * The symbology follows APP-6 closely enough to be legible to anyone who has
 * seen a real plot: the FRAME tells you what side it is on (circle friend,
 * diamond hostile, square neutral, quatrefoil unknown) and the FILL tells you
 * what it is. The thing that is not standard, and is the whole point of this
 * game, is the ellipse: every uncertain track is drawn with its actual Kalman
 * error ellipse, at true scale, so "I do not know where he is" is a shape on
 * the screen rather than a number in a panel.
 */

export const COLORS = {
  friend: '#5ec8ff',
  friendDim: 'rgba(94,200,255,0.55)',
  hostile: '#ff5f56',
  hostileDim: 'rgba(255,95,86,0.5)',
  neutral: '#5fdc8b',
  unknown: '#ffd23f',
  pending: '#c9d3dc',
  missile: '#ff8a3d',
  torpedo: '#ff4fd8',
  web: 'rgba(120,220,255,0.30)',
  webHot: 'rgba(160,255,200,0.75)',
  grid: 'rgba(140,190,220,0.10)',
  text: '#dbe7f0',
};

function identColor(t) {
  switch (t.identity) {
    case IDENT.FRIEND: return COLORS.friend;
    case IDENT.HOSTILE: return COLORS.hostile;
    case IDENT.NEUTRAL: return COLORS.neutral;
    case IDENT.UNKNOWN: return COLORS.unknown;
    default: return COLORS.pending;
  }
}

export class TacticalOverlay {
  constructor(canvas, cam, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = cam;
    this.world = world;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.hoverTrack = null;
    this.hoverUnit = null;
    this.selection = [];
    this.selectedTrack = null;
    this.showWeb = true;
    this.showRings = true;
    this.showEllipses = true;
    this.showLabels = true;
    this.engagePreview = null;
    this.dragBox = null;
    this.orderPreview = null;
    this.pickables = [];
    this.time = 0;
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w; this.h = h;
  }

  /** Project a sim-space point to screen pixels. Returns null if behind camera. */
  project(x, z, y = 0) {
    const rx = this.cam.rx(x), rz = this.cam.rz(z);
    const v = new THREE.Vector3(rx, y - this.cam.drop(rx, rz), rz);
    v.project(this.cam.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h, depth: v.z };
  }

  /** Metres per screen pixel at the plot centre — the plot's working scale. */
  get metresPerPixel() {
    const a = this.project(this.cam.focus.x, this.cam.focus.y);
    const b = this.project(this.cam.focus.x + 1000, this.cam.focus.y);
    if (!a || !b) return 100;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return d > 0.001 ? 1000 / d : 100;
  }

  draw(dt) {
    const ctx = this.ctx;
    this.time += dt;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.pickables.length = 0;

    const chart = this.cam.chartness;
    const mpp = this.metresPerPixel;

    // On the bridge you are looking out of a window, not at a plot. Dropping the
    // full symbology is most of what makes the first-person view feel like a
    // different job rather than the same screen with a lower camera.
    if (this.cam.mode === 'BRIDGE') { this._drawBridgeMarks(ctx); return; }

    // The plot is a PLOT. Once the camera comes down to look at a ship — or
    // rides a missile — the same symbology stops being information and becomes
    // an obstruction: a radar horizon ring belonging to an aircraft at nine
    // thousand metres projects as a two-hundred-kilometre disc that fills most
    // of the frame, and kill-web lines and bearing cuts run across the sea in
    // front of the subject. Cinematic modes keep only the small contact marks.
    const cinematic = this.cam.mode === 'MISSILE' || chart < 0.12;

    if (chart > 0.05) this._drawGrid(ctx, chart, mpp);
    if (!cinematic) {
      this._drawIntelBox(ctx, chart);
      this._drawObjective(ctx);
      this._drawOrders(ctx);
      this._drawBuoys(ctx, mpp);
      this._drawGeography(ctx, mpp);
      this._drawWeather(ctx, mpp);
      this._drawSignalPins(ctx);
      if (this.showRings) this._drawSensorRings(ctx, mpp);
      if (this.showWeb) this._drawKillWeb(ctx);
      this._drawBearingCuts(ctx);
    }
    this._drawTracks(ctx, chart, mpp);
    this._drawOrdnance(ctx, mpp);
    if (!cinematic) this._drawEngagePreview(ctx, mpp);
    this._drawDragBox(ctx);
    if (!cinematic) this._drawScaleBar(ctx, mpp);
  }

  /**
   * Geography: the land, and the shipping lanes.
   *
   * Both belong on a tactical display for the same reason — they explain
   * contacts. A large slow return sitting exactly on the NORTHERN APPROACH is
   * almost certainly a merchant, and a headland between you and a bearing means
   * the reason you are not holding anything there may be geometry rather than
   * an absence of ships.
   */
  _drawGeography(ctx, mpp) {
    const w = this.world;
    ctx.save();
    // ── shipping lanes ────────────────────────────────────────────────────
    if (w.lanes && this.cam.chartness > 0.15) {
      ctx.setLineDash([12, 10]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(140,170,190,${0.16 * this.cam.chartness})`;
      ctx.font = '8.5px ui-monospace, monospace';
      ctx.fillStyle = `rgba(150,180,200,${0.4 * this.cam.chartness})`;
      for (const ln of w.lanes) {
        const a = this.project(ln.a.x, ln.a.z, 0);
        const b = this.project(ln.b.x, ln.b.z, 0);
        if (!a || !b) continue;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
        ctx.textAlign = 'center';
        ctx.fillText(ln.name, 0, -4);
        ctx.restore();
      }
      ctx.setLineDash([]);
    }
    // ── land ──────────────────────────────────────────────────────────────
    for (const isl of (w.scenario?.islands || [])) {
      const p = this.project(isl.x, isl.z, 0);
      if (!p) continue;
      const r = isl.radius / mpp;
      if (r < 2) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120,132,104,0.20)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(178,190,150,0.45)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (r > 12) {
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(200,210,170,0.72)';
        ctx.textAlign = 'center';
        ctx.fillText(isl.name, p.x, p.y - r - 5);
      }
    }
    ctx.restore();
  }

  /**
   * Squall cells on the plot. A body of rain is a hole in everybody's radar
   * picture, so it belongs on the tactical display next to the sensor rings —
   * it is terrain, and steering into it is a move.
   */
  _drawWeather(ctx, mpp) {
    const ws = this.world.weatherSys;
    if (!ws || !ws.squalls.length) return;
    ctx.save();
    for (const c of ws.squalls) {
      const p = this.project(c.x, c.z, 0);
      if (!p) continue;
      const r = c.r / mpp;
      // NaN SLIPS THROUGH A RANGE CHECK. `NaN < 5` is false and `NaN > 3000` is
      // false, so a non-finite radius passed both guards and went into
      // createRadialGradient, which throws — taking down the ENTIRE tactical
      // plot render for that frame, not just the squall. Test for finite
      // explicitly; a range check is not a validity check.
      if (!Number.isFinite(r) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (r < 5 || r > 3000) continue;
      const g = ctx.createRadialGradient(p.x, p.y, r * 0.2, p.x, p.y, r);
      g.addColorStop(0, `rgba(120,150,175,${0.16 * c.strength})`);
      g.addColorStop(1, 'rgba(120,150,175,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.setLineDash([3, 6]);
      ctx.strokeStyle = `rgba(150,180,200,${0.22 * c.strength})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      if (r > 34) {
        ctx.font = '8px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(160,190,208,0.55)';
        ctx.textAlign = 'center';
        ctx.fillText('SQUALL', p.x, p.y + 3);
      }
    }
    ctx.restore();
  }

  /**
   * Where the thing you have been asked about actually IS. A decision card that
   * says "a neutral is inside the screen" is abstract; a pulsing ring on the plot
   * with a line to the card's subject is a place you can look at and reason about.
   */
  _drawSignalPins(ctx) {
    const sys = this.world.signals;
    if (!sys || !sys.active.length) return;
    const t = this.time;
    ctx.save();
    for (const sig of sys.active) {
      if (!sig.pin) continue;
      const p = this.project(sig.pin.x, sig.pin.z, 0);
      if (!p) continue;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.6);
      const col = sig.priority === 'FLASH' ? '255,110,96' : '255,209,102';
      for (let i = 0; i < 2; i++) {
        const r = 12 + i * 9 + pulse * 7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},${(0.5 - i * 0.2) * (0.45 + 0.55 * pulse)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y); ctx.lineTo(p.x + 7, p.y);
      ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x, p.y + 7);
      ctx.strokeStyle = `rgba(${col},0.9)`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillStyle = `rgba(${col},0.95)`;
      ctx.textAlign = 'center';
      ctx.fillText(sig.subject || sig.kind, p.x, p.y - 26);
    }
    // The cued intel box, when CTF-40 has given you one.
    const box = sys.standing.intelBox;
    if (box) {
      const c = this.project(box.x, box.z, 0);
      if (c) {
        const rPix = box.r / this.metresPerPixel;
        if (rPix > 4 && rPix < 4000) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, rPix, 0, Math.PI * 2);
          ctx.setLineDash([7, 5]);
          ctx.strokeStyle = 'rgba(255,209,102,0.42)';
          ctx.lineWidth = 1.3;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = '9px ui-monospace, monospace';
          ctx.fillStyle = 'rgba(255,209,102,0.8)';
          ctx.textAlign = 'center';
          ctx.fillText('CUED DATUM · NATIONAL', c.x, c.y - rPix - 6);
        }
      }
    }
    ctx.restore();
  }

  /**
   * Sonobuoy field. Drawn small and quiet — a laid barrier should read as
   * texture on the plot, not as a fleet of contacts — with a listening circle
   * that fades as the buoy's battery runs down, so the player can see the hole
   * opening in the barrier before a submarine walks through it.
   */
  _drawBuoys(ctx, mpp) {
    const buoys = this.world.buoys;
    if (!buoys || !buoys.length) return;
    const now = this.world.time;
    ctx.save();
    for (const b of buoys) {
      const p = this.project(b.x, b.z, 0);
      if (!p) continue;
      const life = Math.max(0, Math.min(1, (b.expiresAt - now) / Math.max(1, b.expiresAt - b.droppedAt)));
      const rPix = b.range / mpp;
      if (rPix > 6 && rPix < 3000) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, rPix, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(120,214,255,${0.05 + 0.10 * life})`;
        ctx.setLineDash([2, 6]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(150,226,255,${0.35 + 0.5 * life})`;
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Bridge view marks: a thin caret on the horizon for each contact the ship's
   * own sensors are holding, with bearing and range. This is the bridge-wing
   * equivalent of a lookout's call — not the CIC picture.
   */
  _drawBridgeMarks(ctx) {
    const u = this.cam.bridgeUnit;
    if (!u) return;
    const table = this.world.picture(u.side);
    if (!table) return;
    const now = this.world.time;
    ctx.save();
    ctx.font = '500 10px ui-monospace, Menlo, monospace';
    for (const t of table.list) {
      if (t.faded || t.tq < 1) continue;
      if (t.truthId === u.id) continue;
      const isOwn = t.own;
      const alt = t.domain === DOMAIN.AIR ? Math.max(0, t.alt) : 0;
      const p = this.project(t.x, t.z, alt);
      if (!p || p.x < 0 || p.x > this.w) continue;
      const rng = Math.hypot(t.x - u.x, t.z - u.z);
      if (rng > 90000) continue;
      const col = identColor(t);
      const a = clamp(1 - (now - t.lastUpdate) / 120, 0.25, 1);
      ctx.globalAlpha = a * (isOwn ? 0.5 : 0.9);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y - 12); ctx.lineTo(p.x, p.y - 4); ctx.lineTo(p.x + 7, p.y - 12);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = 'center';
      ctx.fillText(`${isOwn ? (t.label || '') : t.id}  ${(rng / NM).toFixed(1)}nm`, p.x, p.y - 17);
    }
    ctx.restore();
  }

  // ── background furniture ──────────────────────────────────────────────────
  _drawGrid(ctx, chart, mpp) {
    // A lat/long-ish graticule that snaps to a sensible spacing for the zoom.
    const targetPx = 140;
    const raw = targetPx * mpp;
    const steps = [10 * NM, 25 * NM, 50 * NM, 100 * NM, 200 * NM];
    let step = steps[steps.length - 1];
    for (const s of steps) { if (s > raw * 0.6) { step = s; break; } }
    const fx = this.cam.focus.x, fz = this.cam.focus.y;
    const half = Math.min(14, Math.ceil((Math.max(this.w, this.h) * mpp) / step) + 2);
    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.globalAlpha = chart * 0.9;
    ctx.beginPath();
    for (let i = -half; i <= half; i++) {
      const gx = Math.round(fx / step) * step + i * step;
      const a = this.project(gx, fz - half * step);
      const b = this.project(gx, fz + half * step);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      const gz = Math.round(fz / step) * step + i * step;
      const c = this.project(fx - half * step, gz);
      const d = this.project(fx + half * step, gz);
      if (c && d) { ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); }
    }
    ctx.stroke();

    // Grid reference labels. A graticule with no numbers on it is decoration;
    // with numbers it is a chart you can pass a position over the net from.
    ctx.globalAlpha = chart * 0.75;
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.fillStyle = COLORS.gridLabel || 'rgba(140,175,200,0.65)';
    for (let i = -half; i <= half; i++) {
      const gx = Math.round(fx / step) * step + i * step;
      const p = this.project(gx, fz);
      if (p && p.x > 40 && p.x < this.w - 40) {
        ctx.textAlign = 'center';
        // Hemisphere letters, not a sign. A chart reference west of the origin
        // reads 450W; it does not read minus-450-east, which is what this
        // printed and what an art review quoted straight back.
        const e = gx / NM;
        ctx.fillText(`${Math.abs(e).toFixed(0)}${e < 0 ? 'W' : 'E'}`, p.x, 14);
      }
      const gz = Math.round(fz / step) * step + i * step;
      const q = this.project(fx, gz);
      if (q && q.y > 30 && q.y < this.h - 30) {
        ctx.textAlign = 'left';
        // World +z runs south, so a positive grid value is southing.
        const n = -gz / NM;
        ctx.fillText(`${Math.abs(n).toFixed(0)}${n < 0 ? 'S' : 'N'}`, 6, q.y - 3);
      }
    }
    ctx.restore();

    this._drawCompass(ctx, chart);
  }

  /**
   * Compass rose, north-up, in the corner of the plot. The plot rotates with the
   * camera, so without one there is nothing on screen that says which way north
   * is — and every bearing in the radio traffic is a true bearing.
   */
  _drawCompass(ctx, chart) {
    const r = 26;
    // Clear of the floating panels: inboard of the right-hand column and above
    // the order bar, so it is on the sea rather than under an instrument.
    const cx = this.w - r - 346, cy = this.h - r - 116;
    // Screen-space direction of true north: project two points and take the delta.
    const a = this.project(this.cam.focus.x, this.cam.focus.y);
    const b = this.project(this.cam.focus.x, this.cam.focus.y + 8000);
    if (!a || !b) return;
    const ang = Math.atan2(b.x - a.x, -(b.y - a.y));
    ctx.save();
    ctx.globalAlpha = 0.35 + chart * 0.4;
    ctx.translate(cx, cy);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(140,175,200,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2 + ang;
      const long = i % 3 === 0;
      ctx.beginPath();
      ctx.moveTo(Math.sin(t) * (r - (long ? 8 : 4)), -Math.cos(t) * (r - (long ? 8 : 4)));
      ctx.lineTo(Math.sin(t) * r, -Math.cos(t) * r);
      ctx.strokeStyle = `rgba(140,175,200,${long ? 0.7 : 0.35})`;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(Math.sin(ang) * (r - 6), -Math.cos(ang) * (r - 6));
    ctx.lineTo(Math.sin(ang + 2.5) * 6, -Math.cos(ang + 2.5) * 6);
    ctx.lineTo(Math.sin(ang - 2.5) * 6, -Math.cos(ang - 2.5) * 6);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,200,255,0.85)';
    ctx.fill();
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(180,215,235,0.9)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', Math.sin(ang) * (r + 9), -Math.cos(ang) * (r + 9));
    ctx.restore();
  }

  _drawIntelBox(ctx, chart) {
    const b = this.world.scenario.intelBox;
    if (!b) return;
    const mission = this.world.mission;
    if (mission && mission.objectives[1].done) return;   // stop nagging once you have him
    const pts = [
      this.project(b.x - b.w / 2, b.z - b.h / 2),
      this.project(b.x + b.w / 2, b.z - b.h / 2),
      this.project(b.x + b.w / 2, b.z + b.h / 2),
      this.project(b.x - b.w / 2, b.z + b.h / 2),
    ];
    if (pts.some(p => !p)) return;
    ctx.save();
    ctx.setLineDash([9, 7]);
    ctx.lineDashOffset = -this.time * 12;
    ctx.strokeStyle = 'rgba(255,120,90,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,110,80,0.045)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,150,120,0.85)';
    ctx.font = '600 11px ui-monospace, Menlo, monospace';
    ctx.fillText('INTEL — PROBABLE SAG OPERATING AREA (5.5 HRS OLD)', pts[0].x + 8, pts[0].y + 18);
    ctx.restore();
  }

  _drawObjective(ctx) {
    const o = this.world.scenario.objectivePoint;
    const p = this.project(o.x, o.z);
    if (!p) return;
    const r = Math.max(8, o.radius / this.metresPerPixel);
    ctx.save();
    ctx.strokeStyle = 'rgba(120,255,190,0.6)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(p.x - 7, p.y); ctx.lineTo(p.x + 7, p.y);
    ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x, p.y + 7);
    ctx.stroke();
    ctx.fillStyle = 'rgba(150,255,205,0.9)';
    ctx.font = '600 11px ui-monospace, Menlo, monospace';
    ctx.fillText(o.name, p.x + 11, p.y - 9);
    ctx.restore();
  }

  _drawOrders(ctx) {
    for (const u of this.selection) {
      if (!u.alive) continue;
      const start = this.project(u.x, u.z, u.isAir ? u.alt : 0);
      if (!start) continue;
      ctx.save();
      ctx.strokeStyle = 'rgba(120,220,255,0.55)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([6, 5]);
      let prev = start;
      for (const wp of u.waypoints) {
        const p = this.project(wp.x, wp.z);
        if (!p) break;
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([6, 5]);
        prev = p;
      }
      if (u.patrol) this._drawPatrol(ctx, u);
      ctx.restore();
    }
    if (this.orderPreview) {
      const { from, to, kind } = this.orderPreview;
      const a = this.project(from.x, from.z);
      const b = this.project(to.x, to.z);
      if (a && b) {
        ctx.save();
        ctx.strokeStyle = kind === 'ATTACK' ? 'rgba(255,110,90,0.8)' : 'rgba(140,240,255,0.8)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([8, 6]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.setLineDash([]);
        const d = Math.hypot(to.x - from.x, to.z - from.z);
        const brg = ((Math.atan2(to.x - from.x, to.z - from.z) * 180 / Math.PI) + 360) % 360;
        ctx.fillStyle = '#dbe7f0';
        ctx.font = '600 11px ui-monospace, Menlo, monospace';
        ctx.fillText(`${String(Math.round(brg)).padStart(3, '0')}° / ${(d / NM).toFixed(0)} nm`, b.x + 10, b.y - 8);
        ctx.restore();
      }
    }
  }

  _drawPatrol(ctx, u) {
    const p = u.patrol;
    if (p.type === 'ORBIT') {
      const c = this.project(p.x, p.z);
      if (!c) return;
      const r = p.radius / this.metresPerPixel;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
    } else if (p.type === 'LADDER' && p.legs) {
      ctx.beginPath();
      let first = true;
      for (const l of p.legs) {
        const q = this.project(l.x, l.z);
        if (!q) continue;
        if (first) { ctx.moveTo(q.x, q.y); first = false; } else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    } else if (p.type === 'BARRIER') {
      const a = this.project(p.ax, p.az), b = this.project(p.bx, p.bz);
      if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
  }

  /**
   * Sensor rings for the selected unit — and this is the single most useful
   * teaching diagram in the game. Two circles: what I can SEE, and where I can
   * BE SEEN. Under EMCON DELTA the second is much bigger than the first, and
   * the player can watch that happen the instant they change posture.
   */
  _drawSensorRings(ctx, mpp) {
    for (const u of this.selection) {
      if (!u.alive || u.side !== SIDE.BLUE) continue;
      const c = this.project(u.x, u.z, 0);
      if (!c) continue;

      // Detection horizon against a typical warship
      let detect = 0, esmSeen = 0, esmHear = 0;
      for (const s of u.sensors) {
        if (!s.ok) continue;
        if (s.type === 'RADAR' && u.radiating) {
          const hs = u.sensorHeight(s);
          const r = Math.min(s.refRange * Math.pow(6800 / 10000, 0.25), radarHorizon(hs, 24));
          detect = Math.max(detect, r);
          esmSeen = Math.max(esmSeen, Math.min(s.refRange * 1.65 * (s.emitPower || 0.5), radarHorizon(hs, 30)));
        } else if (s.type === 'ESM') {
          const hs = u.sensorHeight(s);
          esmHear = Math.max(esmHear, Math.min(260000 * (s.sensitivity || 1), radarHorizon(hs, 34)));
        } else if (s.type === 'SONAR' && s.passiveRange) {
          const r = s.passiveRange * u.sonarSelfNoiseFactor;
          if (r / mpp > 6) this._ring(ctx, c, r / mpp, 'rgba(120,255,220,0.22)', [3, 4], 'PASSIVE SONAR');
        }
      }
      if (esmHear / mpp > 8) this._ring(ctx, c, esmHear / mpp, 'rgba(150,215,255,0.40)', [2, 6], 'OWN ESM HORIZON');
      if (detect / mpp > 6) this._ring(ctx, c, detect / mpp, 'rgba(110,230,255,0.62)', null, 'OWN RADAR HORIZON');
      if (esmSeen / mpp > 6) this._ring(ctx, c, esmSeen / mpp, 'rgba(255,95,80,0.70)', [7, 5], 'HOSTILE ESM HOLDS US HERE');
    }
  }

  _ring(ctx, c, r, color, dash, label) {
    if (r > 22000) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    if (label && r > 46) {
      ctx.font = '600 9px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      const w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(6,12,18,0.62)';
      ctx.fillRect(c.x - w / 2 - 4, c.y - r - 13, w + 8, 12);
      ctx.fillStyle = color;
      ctx.fillText(label, c.x, c.y - r - 4);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  /**
   * The kill web. Lines from every unit currently contributing sensor data to a
   * track, plus a heavier line from any shooter with a weapon in flight against
   * it. This is normally an abstraction in a briefing slide; here it is drawn
   * live, and when a contributor drops off you watch the line go out.
   */
  _drawKillWeb(ctx) {
    const table = this.world.picture(SIDE.BLUE);
    if (!table) return;
    const now = this.world.time;
    ctx.save();
    for (const t of table.list) {
      if (t.own || t.faded) continue;
      if (t.identity === IDENT.FRIEND) continue;
      if (!t.contributors.size) continue;
      const focus = this.selectedTrack && this.selectedTrack.id === t.id;
      if (!focus && t.identity !== IDENT.HOSTILE && t.tq < 2) continue;
      const tp = this.project(t.x, t.z, t.domain === DOMAIN.AIR ? t.alt : 0);
      if (!tp) continue;
      for (const [uid, c] of t.contributors) {
        const u = c.unit;
        if (!u || !u.alive || u.side !== SIDE.BLUE) continue;
        const up = this.project(u.x, u.z, u.isAir ? u.alt : 0);
        if (!up) continue;
        const age = now - c.t;
        const a = clamp(1 - age / 90, 0, 1);
        ctx.strokeStyle = c.link
          ? `rgba(120,235,255,${0.10 + a * (focus ? 0.6 : 0.28)})`
          : `rgba(255,205,110,${0.08 + a * (focus ? 0.5 : 0.2)})`;
        ctx.lineWidth = focus ? 1.6 : 1;
        ctx.setLineDash(c.link ? [] : [3, 4]);
        ctx.beginPath(); ctx.moveTo(up.x, up.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Weapons in flight: the other half of the web.
    for (const o of this.world.weapons) {
      if (!o.alive || o.side !== SIDE.BLUE || o.category !== 'ASM') continue;
      const a = this.project(o.x, o.z, o.alt);
      const b = this.project(o.aim.x, o.aim.z, 0);
      if (!a || !b) continue;
      ctx.strokeStyle = 'rgba(255,150,70,0.30)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /** Lines of bearing from passive cuts — the raw material of a passive fix. */
  _drawBearingCuts(ctx) {
    const table = this.world.picture(SIDE.BLUE);
    if (!table) return;
    const now = this.world.time;
    ctx.save();
    for (const t of table.list) {
      if (t.own || t.faded || !t.bearingCuts.length) continue;
      if (t.tq >= 4 && this.selectedTrack?.id !== t.id) continue;
      for (const b of t.bearingCuts) {
        const age = now - b.t;
        const a = clamp(1 - age / 45, 0, 1);
        if (a <= 0.02) continue;
        const p0 = this.project(b.x, b.z);
        const p1 = this.project(b.x + Math.sin(b.b) * b.range, b.z + Math.cos(b.b) * b.range);
        if (!p0 || !p1) continue;
        ctx.strokeStyle = b.kind === 'SONAR'
          ? `rgba(120,255,220,${a * 0.35})` : `rgba(255,220,120,${a * 0.4})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ── track symbology ───────────────────────────────────────────────────────
  _drawTracks(ctx, chart, mpp) {
    const table = this.world.picture(SIDE.BLUE);
    if (!table) return;
    const now = this.world.time;
    const list = table.list;

    // Error ellipses first, underneath everything.
    if (this.showEllipses) {
      for (const t of list) {
        if (t.own || t.faded || !t.ellipse) continue;
        if (t.tq >= 5) continue;
        const p = this.project(t.x, t.z, 0);
        if (!p) continue;
        const rMaj = (t.ellipse.major * 2) / mpp;
        const rMin = (t.ellipse.minor * 2) / mpp;
        if (rMaj < 3 || rMaj > 6000) continue;
        const col = identColor(t);
        ctx.save();
        ctx.translate(p.x, p.y);
        // The ellipse is expressed in world XZ; screen Y runs opposite world Z.
        ctx.rotate(-t.ellipse.angle);
        ctx.beginPath();
        ctx.ellipse(0, 0, rMaj, rMin, 0, 0, Math.PI * 2);
        ctx.strokeStyle = col.replace(')', ',0.34)').replace('rgb', 'rgba').startsWith('#')
          ? this._alpha(col, 0.32) : col;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = this._alpha(col, 0.05);
        ctx.fill();
        ctx.restore();
      }
    }

    for (const t of list) {
      if (t.faded && now - t.lastUpdate > 900) continue;
      const isAir = t.domain === DOMAIN.AIR;
      const alt = isAir ? Math.max(0, t.alt) : 0;
      const p = this.project(t.x, t.z, alt);
      if (!p) continue;
      if (p.x < -80 || p.x > this.w + 80 || p.y < -80 || p.y > this.h + 80) continue;
      if (t.domain === DOMAIN.MISSILE || t.domain === DOMAIN.TORPEDO) continue;  // drawn with ordnance

      const unit = t.own ? t.truthRef : null;
      // Fade symbols out when we are down at sea level looking at real hulls.
      const near = clamp((this.cam.dist - 900) / 2600, 0, 1);
      const alpha = t.faded ? 0.4 : (0.35 + 0.65 * near);
      if (alpha < 0.06) continue;

      const size = clamp(9 + chart * 3, 8, 13);
      const col = identColor(t);
      ctx.save();
      ctx.globalAlpha = alpha;

      // Air symbols float above the surface with a drop line, exactly as on a
      // real plot, so an aircraft never gets confused with the ship beneath it.
      if (isAir && alt > 100) {
        const base = this.project(t.x, t.z, 0);
        if (base) {
          ctx.strokeStyle = this._alpha(col, 0.35);
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(base.x, base.y); ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      this._frame(ctx, p.x, p.y, size, t, col);

      // Velocity leader — length proportional to a 6-minute run, the classic
      // "where will he be" stick.
      const spd = t.own && unit ? unit.speed : t.speedEst;
      const crs = t.own && unit ? unit.heading : t.courseEst;
      if (spd > 1.2) {
        // Project the END of the leader through the same camera as everything
        // else. Drawing it in screen space from the world heading only happens
        // to be right when the plot is north-up and level; the moment the player
        // orbits, every course vector on the display points somewhere the
        // contact is not going — which is worse than having no vector at all.
        const RUN = 360;                       // six minutes at present speed
        const q = this.project(t.x + Math.sin(crs) * spd * RUN,
                               t.z + Math.cos(crs) * spd * RUN, alt);
        if (q) {
          const dx = q.x - p.x, dy = q.y - p.y;
          const len = Math.hypot(dx, dy);
          if (len > 1) {
            // Clamp the drawn length so a fast contact at a close zoom does not
            // throw a leader across the whole screen, but keep the direction.
            const k = Math.min(1, clamp(len, 8, 120) / len);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + dx * k, p.y + dy * k);
            ctx.stroke();
            // Speed ticks: one per ten knots, the way a manoeuvring board does it.
            const ticks = Math.min(4, Math.floor((spd / KNOT) / 10));
            for (let i = 1; i <= ticks; i++) {
              const f = (i / (ticks + 1));
              const tx = p.x + dx * k * f, ty = p.y + dy * k * f;
              const nx = -dy / len * 2.6, ny = dx / len * 2.6;
              ctx.beginPath();
              ctx.moveTo(tx - nx, ty - ny); ctx.lineTo(tx + nx, ty + ny);
              ctx.stroke();
            }
          }
        }
      }

      if (this.showLabels && (near > 0.2 || chart > 0.2)) this._label(ctx, p, t, unit, col, size, mpp);

      if (this.selectedTrack?.id === t.id || (unit && this.selection.includes(unit))) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 3]);
        ctx.lineDashOffset = -this.time * 14;
        ctx.beginPath(); ctx.arc(p.x, p.y, size + 7, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

      this.pickables.push({ x: p.x, y: p.y, r: size + 8, track: t, unit });
    }
  }

  /** APP-6 style affiliation frame plus a domain glyph. */
  _frame(ctx, x, y, s, t, col) {
    ctx.strokeStyle = col;
    ctx.lineWidth = t.own ? 2 : 1.7;
    ctx.fillStyle = this._alpha(col, t.own ? 0.18 : 0.12);
    ctx.beginPath();
    const sub = t.domain === DOMAIN.SUBSURFACE;
    const air = t.domain === DOMAIN.AIR;
    const half = s * 0.5;
    switch (t.identity) {
      case IDENT.FRIEND:
        if (air) { ctx.arc(x, y + half * 0.4, s * 0.72, Math.PI, 0); ctx.closePath(); }
        else if (sub) { ctx.arc(x, y - half * 0.4, s * 0.72, 0, Math.PI); ctx.closePath(); }
        else ctx.arc(x, y, s * 0.7, 0, Math.PI * 2);
        break;
      case IDENT.HOSTILE: {
        const d = s * 0.92;
        if (air) { ctx.moveTo(x - d * 0.8, y + d * 0.35); ctx.lineTo(x, y - d * 0.75); ctx.lineTo(x + d * 0.8, y + d * 0.35); ctx.closePath(); }
        else if (sub) { ctx.moveTo(x - d * 0.8, y - d * 0.35); ctx.lineTo(x, y + d * 0.75); ctx.lineTo(x + d * 0.8, y - d * 0.35); ctx.closePath(); }
        else { ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath(); }
        break;
      }
      case IDENT.NEUTRAL: {
        const d = s * 0.68;
        ctx.rect(x - d, y - d, d * 2, d * 2);
        break;
      }
      default: {
        // Quatrefoil for unknown / pending — deliberately fussy so it reads as
        // "we have not solved this yet".
        const r = s * 0.44;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          ctx.moveTo(x + Math.cos(a) * r + r, y + Math.sin(a) * r);
          ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r, 0, Math.PI * 2);
        }
        break;
      }
    }
    ctx.fill();
    ctx.stroke();

    // Domain glyph
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    if (sub) {
      ctx.moveTo(x - 3, y + 1); ctx.lineTo(x, y + 4.5); ctx.lineTo(x + 3, y + 1);
    } else if (air) {
      ctx.moveTo(x - 3, y + 2); ctx.lineTo(x, y - 2); ctx.lineTo(x + 3, y + 2);
    } else {
      ctx.moveTo(x - 3.5, y); ctx.lineTo(x + 3.5, y);
    }
    ctx.stroke();

    // Track-quality pips: how good is this belief, at a glance.
    if (!t.own && t.tq > 0) {
      const band = tqBand(t.tq);
      ctx.fillStyle = band.color;
      for (let i = 0; i < t.tq; i++) {
        ctx.fillRect(x - s - 4, y - s + i * 3.1, 2.2, 2.2);
      }
    }
    if (!t.own && t.engagedBy.size) {
      ctx.strokeStyle = COLORS.missile;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, s + 3.5, -0.6, 0.6);
      ctx.arc(x, y, s + 3.5, Math.PI - 0.6, Math.PI + 0.6);
      ctx.stroke();
    }
  }

  _label(ctx, p, t, unit, col, size, mpp) {
    const now = this.world.time;
    const lines = [];
    if (t.own && unit) {
      lines.push(unit.name);
      const em = EMCON_INFO[unit.emcon];
      const dipping = unit.dip && unit.dippingUntil > this.world.time - 2;
      const post = dipping ? '  DIPPING' : unit.dip ? '  →DATUM' : '';
      lines.push(`${Math.round(unit.speedKts)}kt  ${em.short}${post}${unit.damage.fire > 0.1 ? '  ⚠DMG' : ''}`);
    } else {
      const band = tqBand(t.tq);
      lines.push(`${t.id}  ${t.label || t.classification}`);
      const age = Math.round(now - t.lastUpdate);
      lines.push(`TQ${t.tq} ${band.label}${age > 12 ? `  +${age > 90 ? `${Math.round(age / 60)}m` : `${age}s`}` : ''}`);
      if (t.tq <= 3 && t.sigma < 1e6) lines.push(`±${(t.sigma / NM).toFixed(1)} nm`);
    }
    ctx.font = '500 10.5px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    const x = p.x + size + 8;
    let y = p.y - 4;
    ctx.fillStyle = 'rgba(6,12,18,0.62)';
    const wmax = Math.max(...lines.map(l => ctx.measureText(l).width));
    ctx.fillRect(x - 3, y - 10, wmax + 6, lines.length * 12 + 4);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillStyle = i === 0 ? col : 'rgba(210,226,238,0.82)';
      ctx.fillText(lines[i], x, y);
      y += 12;
    }
  }

  // ── ordnance ──────────────────────────────────────────────────────────────
  _drawOrdnance(ctx, mpp) {
    const now = this.world.time;
    const table = this.world.picture(SIDE.BLUE);
    ctx.save();
    for (const o of this.world.weapons) {
      if (!o.alive) continue;
      // Hostile rounds are only drawn if the fleet actually HOLDS them. This is
      // the difference between a game and a diagram: you defend what you detect.
      let known = o.side === SIDE.BLUE;
      if (!known && table) {
        const t = table.find(o.id);
        known = !!(t && !t.faded && (now - t.lastUpdate) < 25);
      }
      if (!known) continue;
      const p = this.project(o.x, o.z, Math.max(0, o.alt));
      if (!p) continue;
      const hostile = o.side !== SIDE.BLUE;
      const col = o.category === 'TORPEDO' ? COLORS.torpedo : (hostile ? COLORS.hostile : COLORS.missile);
      const s = o.category === 'SAM' ? 3.4 : 4.6;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(o.heading - Math.PI);
      ctx.beginPath();
      ctx.moveTo(0, s * 1.5); ctx.lineTo(-s * 0.75, -s); ctx.lineTo(s * 0.75, -s); ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
      ctx.restore();

      // A round in flight is a thing the player wants to LOOK at, so it has to be
      // clickable like everything else on the plot. The hit radius is deliberately
      // generous — a missile symbol is a few pixels of arrowhead crossing the
      // screen at five hundred knots, and asking for pixel accuracy on that is
      // asking for a target nobody can hit.
      this.pickables.push({ x: p.x, y: p.y, r: Math.max(15, s + 10), ord: o, track: null, unit: null });

      if (o.category === 'ASM' || o.category === 'TORPEDO') {
        const lead = clamp((o.speed * 120) / mpp, 6, 90);
        ctx.strokeStyle = this._alpha(col, 0.7);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.sin(o.heading) * lead, p.y - Math.cos(o.heading) * lead);
        ctx.stroke();
        if (hostile) {
          const pulse = 0.5 + 0.5 * Math.sin(this.time * 8);
          ctx.strokeStyle = `rgba(255,80,70,${0.35 + pulse * 0.5})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(p.x, p.y, 10 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
        }
        if (o.seekerActive && o.side === SIDE.BLUE) {
          // Draw the seeker basket: the fan the missile can actually see. When it
          // is smaller than the target's error ellipse, you are about to find out
          // why custody matters.
          const r = (o.def.seekerRange || 25000) / mpp;
          const hw = Math.atan2(o.def.seekerWidth || 10000, o.def.seekerRange || 25000);
          if (r > 6 && r < 4000) {
            ctx.strokeStyle = 'rgba(255,190,90,0.5)';
            ctx.fillStyle = 'rgba(255,190,90,0.06)';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.arc(p.x, p.y, r, -o.heading + Math.PI / 2 - hw, -o.heading + Math.PI / 2 + hw);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          }
        }
      }
    }
    ctx.restore();
  }

  _drawEngagePreview(ctx, mpp) {
    const e = this.engagePreview;
    if (!e) return;
    const t = e.track;
    const p = this.project(t.x, t.z, 0);
    if (!p) return;
    ctx.save();
    // The predicted intercept point: where the salvo is actually aimed, which is
    // not where the target is now.
    const aim = t.predictAt(e.tof);
    const ap = this.project(aim.x, aim.z, 0);
    if (ap) {
      ctx.strokeStyle = 'rgba(255,170,60,0.85)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ap.x, ap.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ap.x, ap.y, 6, 0, Math.PI * 2); ctx.stroke();
      // Growth of the error ellipse over the missile's time of flight — the
      // reason a 40-minute-old track cannot be shot at.
      const grow = Math.sqrt(t.P[0] + (t.domain === DOMAIN.SURFACE ? 0.7 : 26) * Math.pow(e.tof, 3) / 3);
      const r = (grow * 2) / mpp;
      if (r > 3 && r < 4000) {
        ctx.strokeStyle = 'rgba(255,120,60,0.55)';
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.arc(ap.x, ap.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      const basket = (e.def.seekerWidth || 12000) / mpp;
      if (basket > 3 && basket < 4000) {
        ctx.strokeStyle = 'rgba(120,255,180,0.5)';
        ctx.beginPath(); ctx.arc(ap.x, ap.y, basket, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#ffcf7a';
      ctx.font = '600 11px ui-monospace, Menlo, monospace';
      ctx.fillText(`PREDICTED INTERCEPT  T+${Math.round(e.tof / 60)}:${String(Math.round(e.tof % 60)).padStart(2, '0')}`, ap.x + 10, ap.y + 16);
    }
    for (const s of e.shooters) {
      const sp = this.project(s.x, s.z, 0);
      if (!sp) continue;
      ctx.strokeStyle = 'rgba(255,140,60,0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    ctx.restore();
  }

  _drawDragBox(ctx) {
    const b = this.dragBox;
    if (!b) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(140,235,255,0.9)';
    ctx.fillStyle = 'rgba(140,235,255,0.08)';
    ctx.lineWidth = 1;
    const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
    const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  _drawScaleBar(ctx, mpp) {
    const targetPx = 160;
    const raw = targetPx * mpp / NM;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    let n = nice[nice.length - 1];
    for (const v of nice) if (v >= raw * 0.55) { n = v; break; }
    const px = (n * NM) / mpp;
    // Clear of the floating left column and the order bar.
    const x = 310, y = this.h - 118;
    ctx.save();
    ctx.strokeStyle = 'rgba(200,225,240,0.75)';
    ctx.fillStyle = 'rgba(200,225,240,0.9)';
    ctx.lineWidth = 1.4;
    // A DIVIDED bar: five alternating segments, which is how a chart scale is
    // drawn and what lets you read an intermediate distance off it.
    ctx.beginPath();
    ctx.moveTo(x, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 6);
    ctx.stroke();
    for (let i = 0; i < 5; i++) {
      if (i % 2) continue;
      ctx.fillRect(x + (px * i) / 5, y - 4, px / 5, 4);
    }
    ctx.beginPath();
    for (let i = 1; i < 5; i++) {
      ctx.moveTo(x + (px * i) / 5, y); ctx.lineTo(x + (px * i) / 5, y - 4);
    }
    ctx.stroke();
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0', x - 3, y - 9);
    ctx.fillText(`${n} NM`, x + px - 10, y - 9);
    ctx.restore();
  }

  _alpha(hex, a) {
    if (hex.startsWith('rgba')) return hex;
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  /** Hit test in screen space. */
  pick(sx, sy) {
    let best = null, bestD = 1e9;
    for (const p of this.pickables) {
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < p.r && d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  pickInBox(x0, y0, x1, y1) {
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    return this.pickables.filter(p => p.x >= xa && p.x <= xb && p.y >= ya && p.y <= yb);
  }
}
