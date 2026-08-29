import { AO_HALF } from '../sim/constants.js';
import {
  BLUE_CATALOGUE, RED_CATALOGUE, RED_OTHER, POSTURES,
  layoutBlue, layoutRed, countsOf,
} from '../sim/forces.db.js';

/**
 * The pre-mission setup screen.
 *
 * Three columns, and the middle one is a chart. Composition is a list of
 * counters, because "two frigates" is a number and a number wants a stepper —
 * but POSITION is not expressible as a number anyone wants to type, and where
 * things start relative to each other decides what the engagement feels like.
 *
 * EVERY HULL IS INDIVIDUALLY PLACEABLE. The first version moved whole groups,
 * on the reasoning that dragging fifteen ships one at a time is data entry
 * rather than decision-making. That was wrong about what the decision IS:
 * sending the carrier off on her own, or stripping the screen down one side, is
 * exactly the sort of choice a player should be able to make — including when
 * it is a bad one. So a hull the player picks up is DETACHED: it starts where
 * it was put and holds no formation station, because otherwise the station
 * keeper would quietly steer it back into the screen over the first few minutes
 * and silently undo the decision.
 *
 * Dragging the group anchor still moves everything that is STILL in formation,
 * because moving a task force is also a thing people want to do, and re-form
 * puts the strays back.
 *
 * The chart zooms, because it has to. The area of operations is 680 km across
 * and a screen station is 22 km, so at a fit-the-whole-map scale a task force
 * is a smudge twenty pixels wide.
 */

const HANDLE = 46;      // course handle distance, px

export class SetupScreen {
  constructor(spec, { onBegin, onBack, onRandomise }) {
    this.spec = spec;
    this.onBegin = onBegin;
    this.onBack = onBack;
    this.onRandomise = onRandomise;
    this.canvas = document.getElementById('setup-map');
    this.ctx = this.canvas.getContext('2d');
    this.drag = null;
    this.hover = null;
    this.view = null;                 // { cx, cz, ppm } — set on first resize
    this._wireMap();
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas);
    }
    document.getElementById('btn-setup-go').onclick = () => this.onBegin(this.spec);
    document.getElementById('btn-setup-back').onclick = () => this.onBack();
    document.getElementById('btn-setup-random').onclick = () => this.onRandomise();
    const rf = document.getElementById('btn-setup-reform');
    if (rf) rf.onclick = () => this.reform();
    const zf = document.getElementById('btn-setup-fit');
    if (zf) zf.onclick = () => { this.view = null; this.resize(); };
  }

  setSpec(spec) { this.spec = spec; this.view = null; this.render(); }

  // ── layout ────────────────────────────────────────────────────────────────

  render() {
    this._columns();
    this._posture();
    this._tally();
    this.resize();
  }

  resize() {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Measured mid-transition this returns something like 64 by 3, which is a
    // real number and a useless one. The observer will call again.
    if (r.width < 120 || r.height < 120) return;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = r.width; this._h = r.height;
    if (!this.view) {
      this.view = { cx: 0, cz: 0, ppm: Math.min(r.width, r.height) / (AO_HALF * 2.05) };
    }
    this.draw();
  }

  toPx(x, z) {
    const v = this.view;
    return { px: this._w / 2 + (x - v.cx) * v.ppm, py: this._h / 2 - (z - v.cz) * v.ppm };
  }

  toWorld(px, py) {
    const v = this.view;
    return { x: v.cx + (px - this._w / 2) / v.ppm, z: v.cz - (py - this._h / 2) / v.ppm };
  }

  // ── composition ───────────────────────────────────────────────────────────

  /** Add or remove hulls of a class, leaving everything else where it is. */
  _setCount(side, cls, n) {
    const grp = side === 'blue' ? this.spec.blue : this.spec.red.sag;
    const units = grp.units;
    const mine = units.filter(u => u.cls === cls);
    if (n < mine.length) {
      // Take the ones the player has NOT deliberately placed first: removing a
      // hull somebody just dragged somewhere is the wrong one to take.
      const order = [...mine].sort((a, b) => (a.detached ? 1 : 0) - (b.detached ? 1 : 0));
      for (const u of order.slice(0, mine.length - n)) units.splice(units.indexOf(u), 1);
    } else if (n > mine.length) {
      // New hulls land on the next free station for their role.
      const counts = [...countsOf(units)].map(([c, k]) => ({ cls: c, n: k }));
      const idx = counts.findIndex(c => c.cls === cls);
      if (idx >= 0) counts[idx].n = n; else counts.push({ cls, n });
      const laid = side === 'blue' ? layoutBlue(counts, grp) : layoutRed(counts, grp);
      const want = laid.filter(u => u.cls === cls);
      for (let i = mine.length; i < n; i++) if (want[i]) units.push({ ...want[i] });
    }
    // The guide is whichever escort comes first, and adding or removing can
    // change which one that is.
    if (side === 'blue') {
      let seen = false;
      for (const u of units) {
        const meta = BLUE_CATALOGUE.find(c => c.cls === u.cls);
        u.guide = !seen && !!meta && meta.role === 'ESCORT';
        if (u.guide) seen = true;
      }
    }
  }

  /** Put every stray back in the screen. */
  reform() {
    for (const [side, grp] of [['blue', this.spec.blue], ['red', this.spec.red.sag]]) {
      const counts = [...countsOf(grp.units)].map(([c, n]) => ({ cls: c, n }));
      grp.units = side === 'blue' ? layoutBlue(counts, grp) : layoutRed(counts, grp);
    }
    this._tally();
    this.draw();
  }

  _stepper(get, set, min, max) {
    const wrap = document.createElement('div');
    wrap.className = 'setup-stepper';
    const dec = document.createElement('button'); dec.textContent = '−';
    const val = document.createElement('span'); val.className = 'v';
    const inc = document.createElement('button'); inc.textContent = '+';
    const paint = () => {
      const n = get();
      val.textContent = n;
      val.classList.toggle('zero', n === 0);
      dec.disabled = n <= min;
      inc.disabled = n >= max;
    };
    dec.onclick = () => { set(Math.max(min, get() - 1)); paint(); this._tally(); this.draw(); };
    inc.onclick = () => { set(Math.min(max, get() + 1)); paint(); this._tally(); this.draw(); };
    wrap.append(dec, val, inc);
    paint();
    return wrap;
  }

  _row(parent, label, hint, stepper) {
    const row = document.createElement('div');
    row.className = 'setup-row';
    const l = document.createElement('div');
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = label;
    const h = document.createElement('div'); h.className = 'hint'; h.textContent = hint;
    l.append(nm, h);
    row.append(l, stepper);
    parent.appendChild(row);
  }

  _columns() {
    const blue = document.getElementById('setup-blue');
    const red = document.getElementById('setup-red');
    blue.innerHTML = ''; red.innerHTML = '';

    const bh = document.createElement('div');
    bh.className = 'setup-sec'; bh.textContent = 'Task Force 44 — your ships';
    blue.appendChild(bh);
    for (const c of BLUE_CATALOGUE) {
      this._row(blue, c.label, c.hint, this._stepper(
        () => countsOf(this.spec.blue.units).get(c.cls) || 0,
        (v) => this._setCount('blue', c.cls, v), 0, c.max));
    }

    const nh = document.createElement('div');
    nh.className = 'setup-sec'; nh.textContent = 'Civilian traffic';
    blue.appendChild(nh);
    this._row(blue, 'Merchant shipping',
      'They run the lanes whether you are there or not. Sorting a freighter from a warship at forty miles is most of this job.',
      this._stepper(() => this.spec.neutral.merchants, (v) => { this.spec.neutral.merchants = v; }, 0, 14));
    this._row(blue, 'Fishing vessels',
      'Working a bank on your track, with gear in the water. Slow, small, and exactly where you do not want them.',
      this._stepper(() => this.spec.neutral.trawlers, (v) => { this.spec.neutral.trawlers = v; }, 0, 7));

    const rh = document.createElement('div');
    rh.className = 'setup-sec red'; rh.textContent = 'Volsk surface action group';
    red.appendChild(rh);
    for (const c of RED_CATALOGUE) {
      this._row(red, c.label, c.hint, this._stepper(
        () => countsOf(this.spec.red.sag.units).get(c.cls) || 0,
        (v) => this._setCount('red', c.cls, v), 0, c.max));
    }
    const oh = document.createElement('div');
    oh.className = 'setup-sec red'; oh.textContent = 'Everything else they have';
    red.appendChild(oh);
    for (const c of RED_OTHER) {
      this._row(red, c.label, c.hint, this._stepper(
        () => this.spec.red[c.key] || 0, (v) => { this.spec.red[c.key] = v; }, 0, c.max));
    }
  }

  _posture() {
    const box = document.getElementById('setup-posture');
    box.innerHTML = '';
    for (const p of POSTURES) {
      const b = document.createElement('button');
      b.className = `posture-opt${this.spec.posture === p.id ? ' on' : ''}`;
      b.innerHTML = `<div class="pl">${p.label}</div><div class="pb">${p.blurb}</div>`;
      b.onclick = () => { this.spec.posture = p.id; this._posture(); };
      box.appendChild(b);
    }
  }

  _tally() {
    const s = this.spec;
    const blue = s.blue.units.length;
    const redSag = s.red.sag.units.length;
    const other = (s.red.subs || 0) + (s.red.mpa || 0) + (s.red.bombers || 0);
    const stray = s.blue.units.filter(u => u.detached).length
      + s.red.sag.units.filter(u => u.detached).length;
    const sep = Math.hypot(s.red.sag.x - s.blue.x, s.red.sag.z - s.blue.z) / 1000;
    const warn = [];
    if (blue === 0) warn.push('You have no ships.');
    if (redSag + other === 0) warn.push('There is nobody to fight.');
    const el = document.getElementById('setup-tally');
    el.innerHTML = `<b>${blue}</b> blue hulls · <b>${redSag}</b> in the SAG · <b>${other}</b> other red<br>`
      + `separation <b>${Math.round(sep)} km</b>`
      + (stray ? ` · <b>${stray}</b> detached` : '')
      + (warn.length ? `<br><span class="warn">${warn.join(' ')}</span>` : '');
    document.getElementById('btn-setup-go').disabled = warn.length > 0;
  }

  // ── the chart ─────────────────────────────────────────────────────────────

  _hulls() {
    const out = [];
    for (const u of this.spec.blue.units) out.push({ u, side: 'blue', colour: '#5ec8ff' });
    for (const u of this.spec.red.sag.units) out.push({ u, side: 'red', colour: '#ff6b62' });
    return out;
  }

  _groupOf(side) { return side === 'blue' ? this.spec.blue : this.spec.red.sag; }

  draw() {
    const g = this.ctx;
    if (!this._w || !this.view) return;
    g.clearRect(0, 0, this._w, this._h);
    const v = this.view;
    g.font = '9px ui-monospace, monospace';

    // Grid at whatever spacing puts lines 60-200 px apart, so it stays useful
    // from a whole-ocean view down to a single screen.
    let step = 100000;
    while (step * v.ppm > 200) step /= 2;
    while (step * v.ppm < 60) step *= 2;
    g.strokeStyle = 'rgba(122,178,214,0.08)'; g.lineWidth = 1;
    const w0 = this.toWorld(0, this._h), w1 = this.toWorld(this._w, 0);
    for (let x = Math.ceil(w0.x / step) * step; x <= w1.x; x += step) {
      const a = this.toPx(x, 0);
      g.beginPath(); g.moveTo(a.px, 0); g.lineTo(a.px, this._h); g.stroke();
    }
    for (let z = Math.ceil(w0.z / step) * step; z <= w1.z; z += step) {
      const a = this.toPx(0, z);
      g.beginPath(); g.moveTo(0, a.py); g.lineTo(this._w, a.py); g.stroke();
    }

    // The operating area, the land in it, and the place the landing force has
    // to reach.
    const tl = this.toPx(-AO_HALF, AO_HALF), br = this.toPx(AO_HALF, -AO_HALF);
    g.strokeStyle = 'rgba(122,178,214,0.22)';
    g.strokeRect(tl.px, tl.py, br.px - tl.px, br.py - tl.py);
    for (const i of ISLANDS) {
      const p = this.toPx(i.x, i.z);
      g.fillStyle = 'rgba(150,170,150,0.30)';
      g.beginPath(); g.arc(p.px, p.py, Math.max(2, i.radius * v.ppm), 0, 7); g.fill();
    }
    const obj = this.toPx(30000, 20000);
    g.strokeStyle = 'rgba(120,230,170,0.75)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(obj.px, obj.py, 7, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(obj.px - 11, obj.py); g.lineTo(obj.px + 11, obj.py);
    g.moveTo(obj.px, obj.py - 11); g.lineTo(obj.px, obj.py + 11); g.stroke();
    g.fillStyle = 'rgba(120,230,170,0.8)';
    g.fillText('POINT OSCAR', obj.px + 12, obj.py + 3);

    // Separation between the two group anchors.
    const pb = this.toPx(this.spec.blue.x, this.spec.blue.z);
    const pr = this.toPx(this.spec.red.sag.x, this.spec.red.sag.z);
    g.setLineDash([3, 4]); g.strokeStyle = 'rgba(200,220,240,0.18)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pb.px, pb.py); g.lineTo(pr.px, pr.py); g.stroke();
    g.setLineDash([]);

    // Group anchors: drag one and everything still in formation comes with it.
    for (const side of ['blue', 'red']) {
      const grp = this._groupOf(side);
      const colour = side === 'blue' ? '#5ec8ff' : '#ff6b62';
      const p = this.toPx(grp.x, grp.z);
      const hx = p.px + Math.sin(grp.course) * HANDLE;
      const hy = p.py - Math.cos(grp.course) * HANDLE;
      g.strokeStyle = colour; g.globalAlpha = 0.45; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(p.px, p.py); g.lineTo(hx, hy); g.stroke();
      g.globalAlpha = 1;
      g.beginPath(); g.arc(hx, hy, 4.5, 0, 7); g.fillStyle = colour; g.fill();
      g.globalAlpha = 0.5; g.setLineDash([2, 3]); g.lineWidth = 1;
      g.beginPath(); g.arc(p.px, p.py, 13, 0, 7); g.strokeStyle = colour; g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
    }

    // The hulls themselves.
    for (const h of this._hulls()) {
      const p = this.toPx(h.u.x, h.u.z);
      const hot = this.hover === h.u || (this.drag && this.drag.unit === h.u);
      const r = h.u.guide ? 6.5 : 5;
      g.beginPath(); g.arc(p.px, p.py, r, 0, 7);
      g.fillStyle = h.u.detached ? `${h.colour}33` : `${h.colour}88`;
      g.fill();
      g.strokeStyle = hot ? '#ffffff' : h.colour;
      g.lineWidth = h.u.guide ? 2 : 1.3;
      g.stroke();
      if (h.u.detached) {
        // A broken ring, so a hull that is not in the screen says so at a glance.
        g.beginPath(); g.arc(p.px, p.py, r + 3.5, 0, 7);
        g.strokeStyle = h.colour; g.globalAlpha = 0.55; g.lineWidth = 1;
        g.setLineDash([2, 2]); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      }
      if (hot || v.ppm > 0.0012) {
        g.fillStyle = hot ? '#ffffff' : `${h.colour}cc`;
        g.fillText(SHORT[h.u.cls] || h.u.cls, p.px + r + 4, p.py + 3);
      }
    }

    // Scale bar, because every distance on this screen matters.
    const bx = 14, by = this._h - 16;
    g.strokeStyle = 'rgba(200,220,240,0.5)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(bx, by); g.lineTo(bx + step * v.ppm, by);
    g.moveTo(bx, by - 4); g.lineTo(bx, by + 4);
    g.moveTo(bx + step * v.ppm, by - 4); g.lineTo(bx + step * v.ppm, by + 4);
    g.stroke();
    g.fillStyle = 'rgba(200,220,240,0.6)';
    g.fillText(`${Math.round(step / 1000)} km`, bx + step * v.ppm + 6, by + 3);
  }

  // ── interaction ───────────────────────────────────────────────────────────

  _hit(px, py) {
    // Hulls first: they are what the player is usually reaching for.
    for (const h of this._hulls()) {
      const p = this.toPx(h.u.x, h.u.z);
      if (Math.hypot(px - p.px, py - p.py) < 9) return { kind: 'hull', unit: h.u, side: h.side };
    }
    for (const side of ['blue', 'red']) {
      const grp = this._groupOf(side);
      const p = this.toPx(grp.x, grp.z);
      const hx = p.px + Math.sin(grp.course) * HANDLE;
      const hy = p.py - Math.cos(grp.course) * HANDLE;
      if (Math.hypot(px - hx, py - hy) < 12) return { kind: 'course', side };
      if (Math.hypot(px - p.px, py - p.py) < 15) return { kind: 'group', side };
    }
    return null;
  }

  _wireMap() {
    const c = this.canvas;
    const at = (ev) => {
      const r = c.getBoundingClientRect();
      return { px: ev.clientX - r.left, py: ev.clientY - r.top };
    };

    c.addEventListener('pointerdown', (ev) => {
      if (!this.view) return;
      const { px, py } = at(ev);
      const hit = this._hit(px, py);
      const w = this.toWorld(px, py);
      if (hit && hit.kind === 'hull') {
        this.drag = { kind: 'hull', unit: hit.unit, dx: hit.unit.x - w.x, dz: hit.unit.z - w.z };
      } else if (hit && hit.kind === 'course') {
        this.drag = { kind: 'course', side: hit.side };
      } else if (hit && hit.kind === 'group') {
        this.drag = { kind: 'group', side: hit.side, lastX: w.x, lastZ: w.z };
      } else {
        this.drag = { kind: 'pan', lastPx: px, lastPy: py };
      }
      c.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });

    c.addEventListener('pointermove', (ev) => {
      if (!this.view) return;
      const { px, py } = at(ev);
      if (!this.drag) {
        const hit = this._hit(px, py);
        const was = this.hover;
        this.hover = hit && hit.kind === 'hull' ? hit.unit : null;
        c.style.cursor = hit ? 'move' : 'grab';
        if (was !== this.hover) this.draw();
        return;
      }
      const d = this.drag;
      if (d.kind === 'pan') {
        this.view.cx -= (px - d.lastPx) / this.view.ppm;
        this.view.cz += (py - d.lastPy) / this.view.ppm;
        d.lastPx = px; d.lastPy = py;
      } else if (d.kind === 'hull') {
        const w = this.toWorld(px, py);
        d.unit.x = clampAO(w.x + d.dx);
        d.unit.z = clampAO(w.z + d.dz);
        // Picked up means taken out of the screen. See the note at the top.
        d.unit.detached = true;
      } else if (d.kind === 'course') {
        const grp = this._groupOf(d.side);
        const p = this.toPx(grp.x, grp.z);
        grp.course = Math.atan2(px - p.px, -(py - p.py));
      } else if (d.kind === 'group') {
        const grp = this._groupOf(d.side);
        const w = this.toWorld(px, py);
        const dx = w.x - d.lastX, dz = w.z - d.lastZ;
        d.lastX = w.x; d.lastZ = w.z;
        grp.x = clampAO(grp.x + dx); grp.z = clampAO(grp.z + dz);
        for (const u of grp.units) {
          if (u.detached) continue;
          u.x = clampAO(u.x + dx); u.z = clampAO(u.z + dz);
        }
      }
      this._tally();
      this.draw();
    });

    const end = (ev) => {
      if (!this.drag) return;
      this.drag = null;
      try { c.releasePointerCapture(ev.pointerId); } catch (e) { /* already gone */ }
      this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    // Zoom about the cursor, so whatever is under the pointer stays under it.
    c.addEventListener('wheel', (ev) => {
      if (!this.view) return;
      ev.preventDefault();
      const { px, py } = at(ev);
      const before = this.toWorld(px, py);
      const k = Math.exp(-ev.deltaY * 0.0016);
      const fit = Math.min(this._w, this._h) / (AO_HALF * 2.05);
      this.view.ppm = Math.max(fit * 0.9, Math.min(fit * 90, this.view.ppm * k));
      const after = this.toWorld(px, py);
      this.view.cx += before.x - after.x;
      this.view.cz += before.z - after.z;
      this.draw();
    }, { passive: false });
  }
}

function clampAO(v) {
  const lim = AO_HALF * 0.97;
  return Math.max(-lim, Math.min(lim, v));
}

/** Short tags, so a crowded screen still reads. */
const SHORT = {
  DDG_FLIGHT_IIA: 'DDG', FFG_CONSTELLATION: 'FFG', CVN_FORD: 'CVN',
  LPD: 'LPD', AOE: 'AOE', SSN_VIRGINIA: 'SSN',
  CG_SLAVA: 'CG', DDG_UDALOY: 'DD', FFG_STEREGUSHCHY: 'FF',
};

/** Drawn for orientation only — the real ones come from the scenario. */
const ISLANDS = [
  { x: 34000, z: 6000, radius: 5200 },
  { x: 12000, z: 26000, radius: 1500 },
  { x: 58000, z: 30000, radius: 3100 },
  { x: -8000, z: 44000, radius: 900 },
];
