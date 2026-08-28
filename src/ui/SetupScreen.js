import { AO_HALF, D2R } from '../sim/constants.js';
import {
  BLUE_CATALOGUE, RED_CATALOGUE, RED_OTHER, POSTURES, hullCount,
} from '../sim/forces.db.js';

/**
 * The pre-mission setup screen.
 *
 * Three columns, and the middle one is a chart. That is the whole design
 * argument: composition is a list of counters, because "two frigates" is a
 * number and a number wants a stepper — but POSITION is not expressible as a
 * number anyone wants to type. Where the enemy starts relative to you, and on
 * what bearing, is the single decision that determines what the engagement
 * feels like, and the only honest interface for it is a map you drag things on.
 *
 * Groups move, individual hulls do not. Dragging fifteen ships one at a time is
 * data entry, not decision-making, and the screen stations are a doctrine
 * problem the game already solves better than a player poking at pixels would.
 * So the player says "this many, here, on this course" and the formation falls
 * out of it.
 */

const R = 8;            // marker radius, px
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
    this._wireMap();
    // The chart follows its own box rather than being told when to measure.
    // Screen transitions, window resizes and the column layout settling all
    // change that box, and each of them used to need its own call.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas);
    }
    document.getElementById('btn-setup-go').onclick = () => this.onBegin(this.spec);
    document.getElementById('btn-setup-back').onclick = () => this.onBack();
    document.getElementById('btn-setup-random').onclick = () => this.onRandomise();
  }

  setSpec(spec) { this.spec = spec; this.render(); }

  // ── layout ────────────────────────────────────────────────────────────────

  render() {
    // The lists need no layout, so they are built synchronously and are correct
    // immediately. Only the chart needs the screen to have a size first.
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
    // real number and a useless one — the first version accepted it and drew a
    // chart three pixels tall. A ResizeObserver in the constructor is what
    // actually keeps this correct; this guard only stops the nonsense frames.
    if (r.width < 120 || r.height < 120) return;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = r.width; this._h = r.height;
    // Fit the whole area of operations, north up.
    this._scale = Math.min(r.width, r.height) / (AO_HALF * 2.05);
    this._cx = r.width / 2; this._cy = r.height / 2;
    this.draw();
  }

  toPx(x, z) {
    return { px: this._cx + x * this._scale, py: this._cy - z * this._scale };
  }

  toWorld(px, py) {
    return { x: (px - this._cx) / this._scale, z: -(py - this._cy) / this._scale };
  }

  // ── composition columns ───────────────────────────────────────────────────

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

  /** Count of a class in a composition list, creating the entry on demand. */
  _entry(list, cls) {
    let e = list.find(x => x.cls === cls);
    if (!e) { e = { cls, n: 0 }; list.push(e); }
    return e;
  }

  _columns() {
    const blue = document.getElementById('setup-blue');
    const red = document.getElementById('setup-red');
    blue.innerHTML = ''; red.innerHTML = '';

    const bh = document.createElement('div');
    bh.className = 'setup-sec'; bh.textContent = 'Task Force 44 — your ships';
    blue.appendChild(bh);
    for (const c of BLUE_CATALOGUE) {
      const e = this._entry(this.spec.blue.ships, c.cls);
      this._row(blue, c.label, c.hint,
        this._stepper(() => e.n, (v) => { e.n = v; }, 0, c.max));
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
      const e = this._entry(this.spec.red.sag.ships, c.cls);
      this._row(red, c.label, c.hint,
        this._stepper(() => e.n, (v) => { e.n = v; }, 0, c.max));
    }
    const oh = document.createElement('div');
    oh.className = 'setup-sec red'; oh.textContent = 'Everything else they have';
    red.appendChild(oh);
    for (const c of RED_OTHER) {
      this._row(red, c.label, c.hint,
        this._stepper(() => this.spec.red[c.key] || 0, (v) => { this.spec.red[c.key] = v; }, 0, c.max));
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
    const blue = hullCount(s.blue.ships);
    const redSag = hullCount(s.red.sag.ships);
    const other = (s.red.subs || 0) + (s.red.mpa || 0) + (s.red.bombers || 0);
    const sep = Math.hypot(s.red.sag.x - s.blue.x, s.red.sag.z - s.blue.z) / 1000;
    const warn = [];
    if (blue === 0) warn.push('You have no ships.');
    if (redSag + other === 0) warn.push('There is nobody to fight.');
    const el = document.getElementById('setup-tally');
    el.innerHTML = `<b>${blue}</b> blue hulls · <b>${redSag}</b> in the SAG · <b>${other}</b> other red<br>`
      + `separation <b>${Math.round(sep)} km</b>`
      + (warn.length ? `<br><span class="warn">${warn.join(' ')}</span>` : '');
    document.getElementById('btn-setup-go').disabled = warn.length > 0;
  }

  // ── the chart ─────────────────────────────────────────────────────────────

  _groups() {
    return [
      { key: 'blue', x: this.spec.blue.x, z: this.spec.blue.z, course: this.spec.blue.course,
        colour: '#5ec8ff', label: 'TF-44', n: hullCount(this.spec.blue.ships) },
      { key: 'red', x: this.spec.red.sag.x, z: this.spec.red.sag.z, course: this.spec.red.sag.course,
        colour: '#ff6b62', label: 'SAG', n: hullCount(this.spec.red.sag.ships) },
    ];
  }

  draw() {
    const g = this.ctx;
    if (!this._w) return;
    g.clearRect(0, 0, this._w, this._h);

    // Grid at 100 km, because that is the unit this game is actually played in:
    // a mast sees 21 nautical miles and a Slava shoots four hundred.
    g.strokeStyle = 'rgba(122,178,214,0.09)'; g.lineWidth = 1;
    for (let v = -300000; v <= 300000; v += 100000) {
      const a = this.toPx(v, -AO_HALF), b = this.toPx(v, AO_HALF);
      g.beginPath(); g.moveTo(a.px, a.py); g.lineTo(b.px, b.py); g.stroke();
      const c = this.toPx(-AO_HALF, v), d = this.toPx(AO_HALF, v);
      g.beginPath(); g.moveTo(c.px, c.py); g.lineTo(d.px, d.py); g.stroke();
    }
    // The operating area itself.
    const tl = this.toPx(-AO_HALF, AO_HALF), br = this.toPx(AO_HALF, -AO_HALF);
    g.strokeStyle = 'rgba(122,178,214,0.22)';
    g.strokeRect(tl.px, tl.py, br.px - tl.px, br.py - tl.py);

    g.font = '9px ui-monospace, monospace';
    g.fillStyle = 'rgba(122,178,214,0.45)';
    g.fillText('N', this._cx - 3, tl.py + 12);

    // Land, and the place the landing force has to reach.
    for (const i of ISLANDS) {
      const p = this.toPx(i.x, i.z);
      g.fillStyle = 'rgba(150,170,150,0.30)';
      g.beginPath(); g.arc(p.px, p.py, Math.max(2, i.radius * this._scale * 3), 0, 7); g.fill();
    }
    const obj = this.toPx(30000, 20000);
    g.strokeStyle = 'rgba(120,230,170,0.75)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(obj.px, obj.py, 7, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(obj.px - 11, obj.py); g.lineTo(obj.px + 11, obj.py);
    g.moveTo(obj.px, obj.py - 11); g.lineTo(obj.px, obj.py + 11); g.stroke();
    g.fillStyle = 'rgba(120,230,170,0.8)';
    g.fillText('POINT OSCAR', obj.px + 12, obj.py + 3);

    // The two groups the player can move.
    for (const grp of this._groups()) {
      const p = this.toPx(grp.x, grp.z);
      const hx = p.px + Math.sin(grp.course) * HANDLE;
      const hy = p.py - Math.cos(grp.course) * HANDLE;
      g.strokeStyle = grp.colour; g.lineWidth = 1.4;
      g.globalAlpha = 0.55;
      g.beginPath(); g.moveTo(p.px, p.py); g.lineTo(hx, hy); g.stroke();
      g.globalAlpha = 1;
      // Arrowhead on the course handle.
      g.beginPath(); g.arc(hx, hy, 4.5, 0, 7); g.fillStyle = grp.colour; g.fill();
      // The group itself.
      g.beginPath(); g.arc(p.px, p.py, R, 0, 7);
      g.fillStyle = `${grp.colour}22`; g.fill();
      g.strokeStyle = grp.colour; g.lineWidth = 1.6; g.stroke();
      g.fillStyle = grp.colour;
      g.font = '10px ui-monospace, monospace';
      g.fillText(`${grp.label} ×${grp.n}`, p.px + R + 5, p.py + 3.5);
    }

    // How far apart they are, which is the number that decides the shape of the
    // whole engagement — inside 300 km the SAG can shoot first.
    const b = this._groups()[0], r = this._groups()[1];
    const pb = this.toPx(b.x, b.z), pr = this.toPx(r.x, r.z);
    g.setLineDash([3, 4]); g.strokeStyle = 'rgba(200,220,240,0.22)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pb.px, pb.py); g.lineTo(pr.px, pr.py); g.stroke();
    g.setLineDash([]);
    const km = Math.round(Math.hypot(r.x - b.x, r.z - b.z) / 1000);
    g.fillStyle = 'rgba(200,220,240,0.5)';
    g.fillText(`${km} km`, (pb.px + pr.px) / 2 + 6, (pb.py + pr.py) / 2 - 4);
  }

  // ── dragging ──────────────────────────────────────────────────────────────

  _wireMap() {
    const c = this.canvas;
    const at = (ev) => {
      const r = c.getBoundingClientRect();
      return { px: ev.clientX - r.left, py: ev.clientY - r.top };
    };
    c.addEventListener('pointerdown', (ev) => {
      const { px, py } = at(ev);
      for (const grp of this._groups()) {
        const p = this.toPx(grp.x, grp.z);
        const hx = p.px + Math.sin(grp.course) * HANDLE;
        const hy = p.py - Math.cos(grp.course) * HANDLE;
        if (Math.hypot(px - hx, py - hy) < 12) { this.drag = { key: grp.key, mode: 'course' }; break; }
        if (Math.hypot(px - p.px, py - p.py) < R + 8) { this.drag = { key: grp.key, mode: 'move' }; break; }
      }
      if (this.drag) { c.setPointerCapture(ev.pointerId); ev.preventDefault(); }
    });
    c.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      const { px, py } = at(ev);
      const target = this.drag.key === 'blue' ? this.spec.blue : this.spec.red.sag;
      if (this.drag.mode === 'move') {
        const w = this.toWorld(px, py);
        // Keep them in the area of operations; outside it there is no sea, no
        // sensor model and nothing to do.
        const lim = AO_HALF * 0.97;
        target.x = Math.max(-lim, Math.min(lim, w.x));
        target.z = Math.max(-lim, Math.min(lim, w.z));
      } else {
        const p = this.toPx(target.x, target.z);
        target.course = Math.atan2(px - p.px, -(py - p.py));
      }
      this._tally();
      this.draw();
    });
    const end = (ev) => {
      if (!this.drag) return;
      this.drag = null;
      try { c.releasePointerCapture(ev.pointerId); } catch (e) { /* already gone */ }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
}

/** Drawn for orientation only — the real ones come from the scenario. */
const ISLANDS = [
  { x: 34000, z: 6000, radius: 5200 },
  { x: 12000, z: 26000, radius: 1500 },
  { x: 58000, z: 30000, radius: 3100 },
  { x: -8000, z: 44000, radius: 900 },
];
