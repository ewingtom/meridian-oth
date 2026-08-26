import {
  EMCON, EMCON_ORDER, EMCON_INFO, ROE, IDENT, DOMAIN, SIDE, NM, KNOT, FT,
  clamp, tqBand, WEAPONS_QUALITY_TQ, radarHorizon,
} from '../sim/constants.js';
import { QUALITY_TIERS } from '../core/renderer.js';
import { weapon, WEAPONS } from '../sim/weapons.db.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export const fmt = {
  clock(t) {
    const s = Math.floor(t % 60), m = Math.floor((t / 60) % 60), h = Math.floor(t / 3600) % 24;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },
  dur(t) {
    if (t < 60) return `${Math.round(t)}s`;
    const m = Math.floor(t / 60), s = Math.round(t % 60);
    if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  },
  nm(m) { return `${(m / NM).toFixed(m < NM * 10 ? 1 : 0)} nm`; },
  kt(mps) { return `${Math.round(mps / KNOT)} kt`; },
  brg(rad) { return String(Math.round((((rad * 180) / Math.PI) + 360) % 360)).padStart(3, '0'); },
  alt(m) { return m > 900 ? `${Math.round(m / FT / 1000)}k ft` : `${Math.round(m / FT)} ft`; },
};

/**
 * APP-6 track symbols, as inline SVG.
 *
 * The roster and the contact list used ad-hoc Unicode dingbats and the plot drew
 * proper affiliation frames, so the same ship carried two unrelated marks in two
 * panels of the same interface — and one of the dingbats was a filled diamond,
 * which in NTDS means HOSTILE, sitting next to the name of the player's own
 * flagship. One symbol vocabulary now, shared by every surface that draws a
 * track: affiliation is the outline SHAPE, domain is which half of it is drawn.
 *
 *   friend   circle (air: upper half-round, subsurface: lower half-round)
 *   hostile  diamond (air: chevron up, subsurface: chevron down)
 *   neutral  square
 *   unknown  quatrefoil
 */
const IDENT_COLOR = {
  [IDENT.FRIEND]: '#5ec8ff',
  [IDENT.HOSTILE]: '#ff6b6b',
  [IDENT.NEUTRAL]: '#7fe0a8',
  [IDENT.PENDING]: '#ffd166',
  [IDENT.UNKNOWN]: '#ffd166',
};

function app6(identity, domain, opts = {}) {
  const c = opts.color || IDENT_COLOR[identity] || '#ffd166';
  const air = domain === DOMAIN.AIR || domain === DOMAIN.MISSILE;
  const sub = domain === DOMAIN.SUBSURFACE || domain === DOMAIN.TORPEDO;
  const sw = opts.strong ? 1.7 : 1.4;
  let d;
  switch (identity) {
    case IDENT.FRIEND:
      d = air ? 'M2 10 A6 6 0 0 1 14 10 Z'
        : sub ? 'M2 6 A6 6 0 0 0 14 6 Z'
          : 'M8 2 A6 6 0 1 1 7.99 2 Z';
      break;
    case IDENT.HOSTILE:
      d = air ? 'M1.6 10.5 L8 2.5 L14.4 10.5 Z'
        : sub ? 'M1.6 5.5 L8 13.5 L14.4 5.5 Z'
          : 'M8 1.4 L14.6 8 L8 14.6 L1.4 8 Z';
      break;
    case IDENT.NEUTRAL:
      d = air ? 'M2.4 9.6 L2.4 3.2 L13.6 3.2 L13.6 9.6 Z'
        : sub ? 'M2.4 6.4 L2.4 12.8 L13.6 12.8 L13.6 6.4 Z'
          : 'M2.4 2.4 L13.6 2.4 L13.6 13.6 L2.4 13.6 Z';
      break;
    default:
      d = 'M8 1.6 C11 1.6 11 5 8 5 C5 5 5 1.6 8 1.6 Z'
        + 'M14.4 8 C14.4 11 11 11 11 8 C11 5 14.4 5 14.4 8 Z'
        + 'M8 14.4 C5 14.4 5 11 8 11 C11 11 11 14.4 8 14.4 Z'
        + 'M1.6 8 C1.6 5 5 5 5 8 C5 11 1.6 11 1.6 8 Z';
      break;
  }
  // Domain tick inside the frame, so a symbol still reads at 16 px.
  // A short centred tick, not a chord: a line across the full width of a circle
  // reads as a "no entry" sign rather than as a surface-domain mark.
  const tick = sub ? 'M6 9.4 L8 11.4 L10 9.4'
    : air ? 'M6 8.6 L8 6.6 L10 8.6'
      : 'M6 8 L10 8';
  return `<svg class="app6" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="${d}" fill="${c}22" stroke="${c}" stroke-width="${sw}" stroke-linejoin="round"/>
    <path d="${tick}" fill="none" stroke="${c}" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
}

/** Domain of a friendly unit, for symbol selection. */
function unitDomain(u) {
  if (u.isAir) return DOMAIN.AIR;
  if (u.isSub) return DOMAIN.SUBSURFACE;
  return DOMAIN.SURFACE;
}

export class Hud {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.alerts = [];
    this.lastCommsLen = 0;
    this._lastForceSig = '';
    this._lastContactSig = '';
    this.engage = null;
    this._bind();
  }

  _bind() {
    // Time compression
    const tc = $('tc');
    for (const s of [0, 1, 2, 4, 8, 16, 32, 64]) {
      const b = el('button', '', s === 0 ? '❚❚' : `${s}×`);
      b.onclick = () => this.game.setTimeScale(s);
      b.dataset.scale = s;
      tc.appendChild(b);
    }
    // Graphics presets. The render scale is the biggest lever on frame time, so
    // this belongs in the status bar next to time compression rather than buried
    // in a settings screen nobody opens — a player whose frame rate is struggling
    // should be one click from fixing it.
    const gfx = $('gfx');
    for (const q of QUALITY_TIERS) {
      const label = { low: 'LOW', medium: 'MED', high: 'HIGH', exquisite: 'EXQ' }[q];
      const b = el('button', '', label);
      b.title = q[0].toUpperCase() + q.slice(1);
      b.dataset.q = q;
      b.onclick = () => this.game.setQuality(q);
      gfx.appendChild(b);
    }

    $('eng-cancel').onclick = () => this.closeEngage();
    $('eng-fire').onclick = () => this.confirmEngage();
  }

  // ── frame update ──────────────────────────────────────────────────────────
  update(dt) {
    const w = this.world;
    const g = this.game;
    $('clock').textContent = fmt.clock(w.time);
    const m = g.mission;
    const pill = $('phase-pill');
    pill.textContent = m.phase;
    pill.classList.toggle('defend', m.phase === 'DEFEND');
    const next = m.objectives.find(o => !o.done && o.key);
    $('obj-text').textContent = next ? next.text : 'Mission objectives complete';
    // ONE source of truth for visibility, and one unit. There were three figures
    // on screen at once — the bar derived one from visFactor, METOC quoted
    // another from the weather model, and the model itself held a third — in two
    // different units, one of which was written "nm", which is nanometres.
    const visNm = w.weatherSys ? w.weatherSys.state.visNm : (w.weather.visFactor * 26000) / NM;
    const rain = (w.weather.rain || 0) > 0.25 ? ' · RAIN' : '';
    $('env-readout').textContent =
      `SS${Math.round(w.weather.seaState)} · VIS ${Math.round(visNm)} NM · DUCT ${w.sensors.duct.toFixed(2)}×${rain}`;

    for (const b of $('tc').children) b.classList.toggle('on', +b.dataset.scale === g.timeScale);
    for (const b of $('gfx').children) b.classList.toggle('on', b.dataset.q === g.quality);

    this._force();
    this._contacts();
    this._detail();
    this._orders();
    this._comms();
    this._alerts(dt);
    this._signals();
    this._camTag();
    this._hintBar();
    if (this.engage) this._engageSolution();
  }

  /**
   * The decision stack. Signals that need an answer live here as cards with a
   * countdown; the cards are built ONCE and only the timer bar is touched each
   * frame, because rebuilding a card between pointerdown and pointerup eats the
   * click — which is exactly the bug that used to make half the order buttons in
   * this HUD dead.
   */
  _signals() {
    const host = $('signals');
    const sys = this.world.signals;
    if (!sys) return;
    this._sigCards = this._sigCards || new Map();
    const now = this.world.time;
    const live = new Set(sys.active.map(s => s.id));

    for (const [id, card] of this._sigCards) {
      if (live.has(id)) continue;
      if (!card._closing) {
        card._closing = true;
        card.classList.add('out');
        setTimeout(() => { card.remove(); }, 300);
        setTimeout(() => { this._sigCards.delete(id); }, 320);
      }
    }

    for (const sig of sys.active) {
      let card = this._sigCards.get(sig.id);
      if (!card) {
        card = el('div', `sig ${sig.priority.toLowerCase()}`);
        const h = el('div', 'sig-h');
        h.appendChild(el('span', 'from', sig.from));
        h.appendChild(el('span', 'pri', sig.priority));
        card.appendChild(h);
        if (sig.subject) card.appendChild(el('div', 'sig-sub', sig.subject));
        card.appendChild(el('div', 'sig-b', sig.text));
        if (sig.detail) card.appendChild(el('div', 'sig-d', sig.detail));
        const opts = el('div', 'sig-opts');
        for (const c of sig.choices || []) {
          const b = el('button', '', `${c.label}${c.hint ? `<span class="oh">${c.hint}</span>` : ''}`);
          b.onclick = () => {
            this.game.audio.ui('confirm');
            sys.answer(sig, c.key);
          };
          opts.appendChild(b);
        }
        card.appendChild(opts);
        const foot = el('div', 'sig-foot');
        const clock = el('span', 'sig-clock', '');
        foot.appendChild(el('span', 'sig-dtg', fmt.clock(sig.opened)));
        foot.appendChild(clock);
        card.appendChild(foot);
        const bar = el('div', 'sig-timer');
        card.appendChild(bar);
        card._bar = bar;
        card._clock = clock;
        host.appendChild(card);
        this._sigCards.set(sig.id, card);
        this.game.audio.radio(sig.priority);
      }
      if (card._bar && sig.deadline !== null) {
        const total = Math.max(1, sig.deadline - sig.opened);
        const left = Math.max(0, sig.deadline - now);
        const frac = clamp(left / total, 0, 1);
        card._bar.style.width = `${(frac * 100).toFixed(1)}%`;
        // A scored decision that auto-resolves against the player MUST show its
        // clock. Three silent expiries cost a reviewer 270 points and the rank.
        if (card._clock) {
          const mm = Math.floor(left / 60), ss = Math.floor(left % 60);
          const txt = `ANSWER BY ${mm}:${String(ss).padStart(2, '0')}`;
          if (card._clock.textContent !== txt) card._clock.textContent = txt;
          card._clock.classList.toggle('urgent', left < 45);
        }
      }
    }
  }

  _camTag() {
    const c = this.game.cam;
    const tag = $('cam-tag');
    const alt = c.camera.position.y;
    const names = { TACTICAL: 'TACTICAL PLOT', FOLLOW: 'UNIT CAMERA', BRIDGE: 'BRIDGE', MISSILE: 'WEAPON CAMERA' };
    let sub = alt > 1000 ? `${(alt / 1000).toFixed(alt > 10000 ? 0 : 1)} km` : `${Math.round(alt)} m`;
    if (c.mode === 'FOLLOW' && c.followUnit) sub = c.followUnit.name;
    if (c.mode === 'BRIDGE' && c.bridgeUnit) sub = c.bridgeUnit.name;
    // The weapon camera draws its own, richer header; two overlapping labels in
    // the same corner is just noise.
    tag.style.display = c.mode === 'MISSILE' ? 'none' : '';
    tag.innerHTML = `<b>${names[c.mode]}</b> · ${sub}`;
    $('bridge-hud').classList.toggle('on', c.mode === 'BRIDGE');
    const mc = $('missile-cam');
    mc.classList.toggle('on', c.mode === 'MISSILE');
    if (c.mode === 'MISSILE' && c.missile) {
      const o = c.missile;
      $('mc-id').textContent = `${o.def.name} · ${o.id}`;
      const rng = Math.hypot(o.aim.x - o.x, o.aim.z - o.z);
      $('mc-data').innerHTML = [
        `SPEED    ${Math.round(o.speed / KNOT)} kt / M${(o.speed / 340).toFixed(2)}`,
        `ALT      ${fmt.alt(Math.max(0, o.alt))}`,
        `TO GO    ${fmt.nm(rng)}`,
        `PHASE    ${o.phase}${o.seekerActive ? ' · SEEKER ON' : ''}`,
        `MIDCOURSE UPDATES  ${o.midcourseUpdates}`,
        o.acquired ? `<span style="color:#6f6">LOCK — ${o.truth?.name || 'TARGET'}</span>` : '',
      ].filter(Boolean).join('<br/>');
    }
    if (c.mode === 'BRIDGE') this._bridge();
  }

  _bridge() {
    const u = this.game.cam.bridgeUnit;
    if (!u) return;
    $('bi-speed').innerHTML = `${Math.round(u.speedKts)}<small> kt</small>`;
    $('bi-course').innerHTML = `${fmt.brg(u.heading)}<small>°T</small>`;
    const rud = Math.round(((u.ordered.heading - u.heading + Math.PI * 3) % (Math.PI * 2) - Math.PI) * 180 / Math.PI);
    $('bi-rudder').innerHTML = `${rud > 0 ? 'S' : rud < 0 ? 'P' : ''}${String(Math.abs(rud)).padStart(2, '0')}<small>°</small>`;
    const table = this.world.picture(u.side);
    const held = table.list.filter(t => !t.own && !t.faded && t.tq > 0).length;
    $('bi-contacts').textContent = held;

    // Engine telegraph
    const tg = $('telegraph');
    const orders = [['STOP', 0], ['SLOW', 0.22], ['STD', 0.5], ['FULL', 0.78], ['FLANK', 1]];
    if (tg.children.length !== orders.length) {
      tg.innerHTML = '';
      for (const [nm] of orders) tg.appendChild(el('div', '', nm));
    }
    const f = u.ordered.speed / u.cls.maxSpeed;
    let bi = 0, bd = 9;
    orders.forEach(([, v], i) => { const d = Math.abs(v - f); if (d < bd) { bd = d; bi = i; } });
    [...tg.children].forEach((c, i) => c.classList.toggle('on', i === bi));

    this._compass(u);
  }

  _compass(u) {
    const cv = $('compass');
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const hdg = (u.heading * 180 / Math.PI + 360) % 360;
    const pxPerDeg = w / 90;
    ctx.font = '600 20px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    for (let d = -50; d <= 50; d++) {
      const deg = Math.round(hdg + d);
      const x = w / 2 + d * pxPerDeg;
      if (x < -20 || x > w + 20) continue;
      const dd = ((deg % 360) + 360) % 360;
      if (dd % 10 === 0) {
        ctx.strokeStyle = 'rgba(190,225,245,0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, h - 22); ctx.lineTo(x, h); ctx.stroke();
        const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[dd];
        ctx.fillStyle = card ? '#8fe0ff' : 'rgba(205,223,238,0.9)';
        ctx.fillText(card || String(dd).padStart(3, '0'), x, h - 30);
      } else if (dd % 5 === 0) {
        ctx.strokeStyle = 'rgba(190,225,245,0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, h - 12); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    ctx.fillStyle = '#5ec8ff';
    ctx.beginPath();
    ctx.moveTo(w / 2, h - 4); ctx.lineTo(w / 2 - 8, h + 8); ctx.lineTo(w / 2 + 8, h + 8);
    ctx.fill();
  }

  _hintBar() {
    const g = this.game;
    const bar = $('hint-bar');
    let txt = '';
    if (g.pendingOrder === 'MOVE') txt = 'Click the plot to set a waypoint · <b>SHIFT</b> to queue · <b>ESC</b> to cancel';
    else if (g.pendingOrder === 'SEARCH') txt = 'Click the plot to centre a search pattern for this aircraft';
    else if (g.cam.mode === 'BRIDGE') txt = '<b>W/S</b> engine order · <b>A/D</b> rudder · <b>MOUSE</b> look · <b>ESC</b> return to plot';
    else if (g.cam.mode === 'MISSILE') txt = '<b>ESC</b> or <b>V</b> to break off the weapon camera';
    else if (!this._taught) {
      // The control crib retires itself. It is genuinely useful for the first
      // couple of minutes and it is furniture forever after — a permanent
      // tutorial pill pinned over the middle of the sea is the clearest possible
      // signal that nobody looked at the game after the tenth minute.
      txt = g.selection.length
        ? '<b>RMB</b> on the sea to steer · <b>E</b> engage designated track · <b>F</b> follow · <b>B</b> bridge · <b>1-4</b> EMCON'
        : '<b>CLICK</b> a unit or contact · <b>RMB drag</b> orbit · <b>WHEEL</b> zoom · <b>M</b> chart view · <b>SPACE</b> pause';
      // Learned by doing: once the player has selected a unit AND moved the
      // camera AND given one order, they do not need to be told again.
      this._taughtSel = this._taughtSel || g.selection.length > 0;
      this._taughtCam = this._taughtCam || g.cam.mode !== 'TACTICAL' || g.cam.dist < 30000;
      this._taughtOrd = this._taughtOrd || g.world.units.some(u => u.side === SIDE.BLUE && u.waypoints.length);
      if (this._taughtSel && this._taughtCam && this._taughtOrd) this._taught = true;
    }
    bar.innerHTML = txt;
    bar.style.display = txt ? '' : 'none';
  }

  // ── force list ────────────────────────────────────────────────────────────
  //
  // Rows are created ONCE per unit and then updated in place. The obvious
  // implementation — rebuild the list whenever anything changes — destroys and
  // recreates every row several times a second, because speed and heading are in
  // the change signature and a ship at sea is always turning. A DOM node that is
  // replaced between pointerdown and pointerup never fires its click handler, so
  // roughly half of all attempts to select a unit silently did nothing. Rebuild
  // only when the MEMBERSHIP changes; everything else is a text write.
  _force() {
    const w = this.world;
    const units = w.units.filter(u => u.side === SIDE.BLUE && !u.despawned);
    const list = $('force-list');
    const memberSig = units.map(u => u.id).join(',');
    if (memberSig !== this._forceMembers) {
      this._forceMembers = memberSig;
      this._forceRows = new Map();
      list.innerHTML = '';
      for (const u of units) {
        const row = el('div', 'unit-row');
        row.innerHTML = `
          <div class="glyph">${app6(u.side === SIDE.NEUTRAL ? IDENT.NEUTRAL : IDENT.FRIEND, unitDomain(u), { strong: true })}</div>
          <div>
            <div class="nm"></div>
            <div class="sub"></div>
            <div class="hbar"><i></i></div>
          </div>
          <div class="em"></div>`;
        row.onclick = (e) => { if (u.alive) this.game.selectUnit(u, e.shiftKey); };
        row.ondblclick = () => { if (u.alive) this.game.cam.follow(u); };
        list.appendChild(row);
        this._forceRows.set(u, {
          row,
          nm: row.querySelector('.nm'),
          sub: row.querySelector('.sub'),
          bar: row.querySelector('.hbar i'),
          em: row.querySelector('.em'),
        });
      }
    }
    $('force-count').textContent = units.filter(u => u.alive).length;

    for (const u of units) {
      const r = this._forceRows.get(u);
      if (!r) continue;
      const em = EMCON_INFO[u.emcon];
      const hpf = Math.max(0, u.hp / u.maxHp);
      const sel = this.game.selection.includes(u);
      const cls = `unit-row${u.alive ? '' : ' dead'}${sel ? ' sel' : ''}`;
      if (r.row.className !== cls) r.row.className = cls;
      const nm = u.name;
      if (r.nm.textContent !== nm) r.nm.textContent = nm;
      const sub = `${u.hullNo || u.type} · ${u.alive ? `${Math.round(u.speedKts)}kt ${fmt.brg(u.heading)}°` : 'LOST'}`
        + (u.isAir && u.alive ? ` · ${fmt.dur(u.fuel)} fuel` : '')
        + (u.isSub && u.alive ? ` · ${Math.round(-u.alt)} m` : '')
        + (u.damage.fire > 0.15 ? ' · ⚠ FIRE' : '');
      if (r.sub.textContent !== sub) r.sub.textContent = sub;
      const bw = `${hpf * 100}%`;
      if (r.bar.style.width !== bw) r.bar.style.width = bw;
      const bc = hpf < 0.35 ? 'crit' : hpf < 0.72 ? 'hurt' : '';
      if (r.bar.className !== bc) r.bar.className = bc;
      if (r.em.textContent !== em.short) {
        r.em.textContent = em.short;
        r.em.style.color = em.color;
      }
    }
  }

  // ── contacts ──────────────────────────────────────────────────────────────
  // Same in-place discipline as the force list: track rows are keyed by track id
  // and only recreated when the SET of tracks changes, not when their numbers do.
  _contacts() {
    const w = this.world;
    const table = w.picture(SIDE.BLUE);
    const now = w.time;
    let tracks = table.list
      .filter(t => !t.own && t.tq > 0 && !(t.faded && now - t.lastUpdate > 1500))
      .sort((a, b) => {
        const pri = (t) => (t.domain === DOMAIN.MISSILE || t.domain === DOMAIN.TORPEDO ? 0
          : t.identity === IDENT.HOSTILE ? 1 : t.identity === IDENT.UNKNOWN || t.identity === IDENT.PENDING ? 2 : 3);
        return pri(a) - pri(b) || b.tq - a.tq;
      });
    $('contact-count').textContent = tracks.length;

    // Raid collapse.
    //
    // A saturation attack puts thirty-plus vampires on the picture at once, and
    // every one of them prints an identical row: same symbol, same class, same
    // track quality, same age. Thirty-three lines of "MISSILE · TQ2" is not a
    // tactical picture, it is a wall — it pushes every SHIP off the panel and
    // tells the player nothing they cannot read from the count. Show the four
    // nearest, then one line for the rest of the raid.
    const guide = w.blueGuide;
    const rng = (t) => (guide ? Math.hypot(t.x - guide.x, t.z - guide.z) : 0);
    const vamps = tracks.filter(t => t.domain === DOMAIN.MISSILE || t.domain === DOMAIN.TORPEDO);
    let shown = tracks;
    let raid = null;
    if (vamps.length > 5) {
      vamps.sort((a, b) => rng(a) - rng(b));
      const keep = new Set(vamps.slice(0, 4));
      raid = {
        _raid: true, id: `RAID-${vamps.length}`, n: vamps.length - 4,
        nearest: rng(vamps[4]),
        domain: vamps[0].domain,
        tq: Math.max(...vamps.map(t => t.tq)),
      };
      shown = [];
      let placed = false;
      for (const t of tracks) {
        if (vamps.includes(t) && !keep.has(t)) {
          if (!placed) { shown.push(raid); placed = true; }
          continue;
        }
        shown.push(t);
      }
    }
    tracks = shown;

    const list = $('contact-list');
    const sig = tracks.map(t => t.id).join(',');
    if (sig !== this._contactMembers) {
      this._contactMembers = sig;
      this._contactRows = new Map();
      list.innerHTML = '';
      for (const t of tracks) {
        const row = el('div', t._raid ? 'trk-row raid' : 'trk-row');
        row.innerHTML = `<div><div class="id"></div><div class="cl"></div></div><div class="tqchip"></div>`;
        if (!t._raid) {
          row.onclick = () => this.game.selectTrack(t);
          row.ondblclick = () => this.game.cam.jumpTo(t.x, t.z, 26000);
        }
        list.appendChild(row);
        this._contactRows.set(t, {
          row, id: row.querySelector('.id'), cl: row.querySelector('.cl'), tq: row.querySelector('.tqchip'),
        });
      }
    }

    for (const t of tracks) {
      const r = this._contactRows.get(t);
      if (!r) continue;
      if (t._raid) {
        r.row.style.color = 'var(--hostile)';
        const idTxt = `${app6(IDENT.HOSTILE, t.domain)} + ${t.n} MORE INBOUND`;
        if (r.id._sig !== idTxt) { r.id._sig = idTxt; r.id.innerHTML = idTxt; }
        const clTxt = `SATURATION RAID · nearest ${fmt.nm(t.nearest)}`;
        if (r.cl.textContent !== clTxt) r.cl.textContent = clTxt;
        const tqTxt = `TQ${t.tq}`;
        if (r.tq.textContent !== tqTxt) { r.tq.textContent = tqTxt; r.tq.style.color = tqBand(t.tq).color; }
        continue;
      }
      const band = tqBand(t.tq);
      const col = t.identity === IDENT.HOSTILE ? 'var(--hostile)'
        : t.identity === IDENT.NEUTRAL ? 'var(--neutral)'
          : t.identity === IDENT.FRIEND ? 'var(--accent)' : 'var(--unknown)';
      const age = now - t.lastUpdate;
      const cls = `trk-row${this.game.selectedTrack === t ? ' sel' : ''}${age > 120 ? ' stale' : ''}`;
      if (r.row.className !== cls) r.row.className = cls;
      if (r.row.style.color !== col) r.row.style.color = col;
      // The symbol is SVG MARKUP, so it has to go in as HTML. Assigning it with
      // textContent printed the raw source — `&lt;svg class="app6" viewBox=…` —
      // into the primary contact panel, fourteen rows of it, which was the most
      // conspicuous defect in the whole interface.
      const idTxt = `${app6(t.identity, t.domain)} ${t.id} ${t.label || ''}`;
      if (r.id._sig !== idTxt) { r.id._sig = idTxt; r.id.innerHTML = idTxt; }
      const clTxt = `${t.classification}${age > 20 ? ` · ${fmt.dur(age)} old` : ''}`;
      if (r.cl.textContent !== clTxt) r.cl.textContent = clTxt;
      const tqTxt = `TQ${t.tq}`;
      if (r.tq.textContent !== tqTxt) { r.tq.textContent = tqTxt; r.tq.style.color = band.color; }
    }
  }

  // ── track detail ──────────────────────────────────────────────────────────
  //
  // Skeleton built once per designated track, values written in place after that.
  // Rebuilding this panel every frame (which is what happens if you just assign
  // innerHTML) recreates the ENGAGE button under the player's cursor between
  // pressing and releasing the mouse, so the shot never gets fired.
  _detail() {
    const t = this.game.selectedTrack;
    const body = $('detail-body');
    if (!t) {
      $('detail-title').textContent = 'No contact designated';
      $('detail-tq').textContent = '';
      if (body.dataset.state !== 'empty') {
        body.dataset.state = 'empty';
        this._detailRefs = null;
        body.innerHTML = `<div style="color:var(--dimmer);line-height:1.7;font-size:10.5px">
          Select a contact from the picture or click a symbol on the plot.<br/><br/>
          A contact is not a target. It becomes a target when the error ellipse
          around it is smaller than the basket your missile's seeker can search —
          <b style="color:var(--txt)">track quality 4</b> or better.
        </div>`;
      }
      return;
    }

    const now = this.world.time;
    const band = tqBand(t.tq);
    const guide = this.world.blueGuide;
    const rng = guide ? Math.hypot(t.x - guide.x, t.z - guide.z) : 0;
    const brg = guide ? Math.atan2(t.x - guide.x, t.z - guide.z) : 0;
    const age = now - t.lastUpdate;
    const sigmaNm = t.sigma / NM;

    if (body.dataset.state !== t.id) {
      body.dataset.state = t.id;
      body.innerHTML = `
        <div class="kv">
          <div class="k">Identity</div><div class="v" data-f="ident"></div>
          <div class="k">Class</div><div class="v" data-f="cls"></div>
          <div class="k">Emitter</div><div class="v" data-f="emit"></div>
          <div class="k">Bearing</div><div class="v" data-f="brg"></div>
          <div class="k">Course/Spd</div><div class="v" data-f="crs"></div>
          <div class="k">Altitude</div><div class="v" data-f="alt"></div>
          <div class="k">Last update</div><div class="v" data-f="age"></div>
        </div>
        <div class="k">Position uncertainty (1σ)</div>
        <div class="meter tq"><i data-f="bar"></i><span class="thresh" style="left:${clamp((6 - Math.log10(1200) * 1.7) / 6, 0, 1) * 100}%"></span></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--dim)">
          <span data-f="sig"></span><span data-f="wq"></span>
        </div>
        <div class="k" style="margin-top:11px">Kill web — sensors holding this track</div>
        <div class="web-list" data-f="web"></div>
        <div data-f="eng" style="margin-top:9px;color:var(--warn);font-size:10.5px"></div>
      `;
      const q = (n) => body.querySelector(`[data-f="${n}"]`);
      this._detailRefs = {
        ident: q('ident'), cls: q('cls'), emit: q('emit'), brg: q('brg'), crs: q('crs'),
        alt: q('alt'), altRow: q('alt')?.previousElementSibling, age: q('age'), bar: q('bar'),
        sig: q('sig'), wq: q('wq'), web: q('web'), eng: q('eng'), webSig: '',
      };

      const canEngage = t.identity !== IDENT.FRIEND && !t.own;
      const btn = el('button', `act${t.identity === IDENT.NEUTRAL || t.identity === IDENT.PENDING ? '' : ' danger'}`,
        `Engage ${t.id}`);
      btn.disabled = !canEngage;
      btn.onclick = () => this.openEngage(t);
      body.appendChild(btn);
      if (t.identity === IDENT.PENDING || t.identity === IDENT.UNKNOWN) {
        const b2 = el('button', 'act', 'Designate HOSTILE');
        b2.onclick = () => { t.identity = IDENT.HOSTILE; t.identityLocked = true; this.game.audio?.ui('confirm'); body.dataset.state = ''; };
        body.appendChild(b2);
        const b3 = el('button', 'act', 'Designate NEUTRAL');
        b3.onclick = () => { t.identity = IDENT.NEUTRAL; t.identityLocked = true; this.game.audio?.ui('click'); body.dataset.state = ''; };
        body.appendChild(b3);
        // A formation is designated as a formation. Warships in company are one
        // decision, not five, and making the player click through them
        // individually is busywork rather than judgement.
        const group = this._companyOf(t);
        if (group.length > 1) {
          const b5 = el('button', 'act danger', `Designate GROUP hostile (${group.length} contacts in company)`);
          b5.onclick = () => {
            for (const g of group) { g.identity = IDENT.HOSTILE; g.identityLocked = true; }
            this.game.audio?.ui('confirm');
            body.dataset.state = '';
          };
          body.appendChild(b5);
        }
      }
      const b4 = el('button', 'act', 'Centre plot on contact');
      b4.onclick = () => this.game.cam.jumpTo(t.x, t.z, Math.max(14000, this.game.cam.distTarget * 0.6));
      body.appendChild(b4);
    }

    $('detail-title').textContent = `${t.id} · ${t.label || t.classification}`;
    $('detail-tq').innerHTML = `<span style="color:${band.color}">TQ${t.tq} ${band.label}</span>`;

    const r = this._detailRefs;
    if (!r) return;
    const set = (node, txt, colour) => {
      if (!node) return;
      if (node.textContent !== txt) node.textContent = txt;
      if (colour && node.style.color !== colour) node.style.color = colour;
    };
    set(r.ident, t.identity);
    set(r.cls, t.classification);
    set(r.emit, t.fingerprint || '—');
    set(r.brg, `${fmt.brg(brg)}° / ${fmt.nm(rng)}`);
    set(r.crs, t.speedEst > 1 ? `${fmt.brg(t.courseEst)}° ${Math.round(t.speedEst / KNOT)} kt` : 'unresolved');
    if (r.alt) {
      const air = t.domain === DOMAIN.AIR;
      r.alt.style.display = air ? '' : 'none';
      if (r.altRow) r.altRow.style.display = air ? '' : 'none';
      if (air) set(r.alt, fmt.alt(t.alt));
    }
    set(r.age, `${fmt.dur(age)} ago`, age > 90 ? 'var(--danger)' : age > 30 ? 'var(--warn)' : 'var(--good)');
    const tqPct = clamp((6 - Math.log10(Math.max(50, t.sigma)) * 1.7) / 6, 0, 1) * 100;
    if (r.bar) r.bar.style.width = `${tqPct}%`;
    set(r.sig, `±${sigmaNm < 0.6 ? `${Math.round(t.sigma)} m` : `${sigmaNm.toFixed(1)} nm`}`);
    set(r.wq, t.tq >= WEAPONS_QUALITY_TQ ? 'WEAPONS QUALITY' : `NEEDS TQ${WEAPONS_QUALITY_TQ}`,
      t.tq >= WEAPONS_QUALITY_TQ ? 'var(--good)' : 'var(--danger)');

    // The kill web itself. Rebuilt only when the set of contributors changes.
    const webSig = [...t.contributors.keys()].join(',') + t.contributors.size;
    if (r.web && webSig !== r.webSig) {
      r.webSig = webSig;
      r.web.innerHTML = [...t.contributors.entries()].map(([id, c]) => {
        const u = c.unit;
        return `<div class="web-item"><span class="dot${c.link ? '' : ' local'}"></span>
          <b>${u?.name || id}</b> · ${c.kind}${c.link ? '' : ' · <span style="color:var(--warn)">OFF LINK</span>'}</div>`;
      }).join('') || '<div class="web-item" style="color:var(--danger)">NO SENSOR IN CONTACT — running on prediction alone</div>';
    }
    if (r.eng) {
      const txt = t.engagedBy.size ? `${t.engagedBy.size} weapon(s) in flight against this track` : '';
      if (r.eng.textContent !== txt) r.eng.textContent = txt;
    }
  }

  // ── order bar ─────────────────────────────────────────────────────────────
  _orders() {
    const sel = this.game.selection.filter(u => u.alive);
    const body = $('orders-body');
    if (!sel.length) {
      $('orders-title').textContent = 'No unit selected';
      $('orders-sub').textContent = '';
      if (body.dataset.state !== 'empty') {
        body.dataset.state = 'empty';
        body.innerHTML = `<div style="padding:12px 14px;color:var(--dimmer);font-family:var(--mono);font-size:10.5px;line-height:1.7">
          Select a unit from TASK FORCE 44 or click its symbol on the plot to give orders.
          <span style="color:var(--dim)">Drag a box on the plot to select several.</span></div>`;
      }
      return;
    }
    const u = sel[0];
    const sig = sel.map(x => `${x.id}${x.emcon}${x.ordered.roe}${Math.round(x.ordered.speed)}${Math.round(x.hp)}${JSON.stringify(Object.values(x.mags))}${x.dip ? 'D' : ''}`).join('|') + this.game.pendingOrder;
    $('orders-title').textContent = sel.length > 1 ? `${sel.length} UNITS SELECTED` : `${u.name} · ${u.cls.display}`;
    $('orders-sub').textContent = sel.length > 1 ? '' : `${u.hullNo || u.type} · ${Math.round((u.hp / u.maxHp) * 100)}% · ${u.crewLabel || ''}`;
    if (body.dataset.state === sig) return;
    body.dataset.state = sig;
    body.innerHTML = '';

    // EMCON
    const gE = el('div', 'ord-group');
    gE.appendChild(el('div', 'k', 'Emission control'));
    const rowE = el('div', 'btn-row');
    for (const e of EMCON_ORDER) {
      const info = EMCON_INFO[e];
      const b = el('button', `emc-${e}${sel.every(x => x.emcon === e) ? ' on' : ''}`, info.short);
      b.title = `${info.label} — ${info.desc}`;
      b.onclick = () => this.game.orderEmcon(e);
      rowE.appendChild(b);
    }
    gE.appendChild(rowE);
    // Spell the asymmetry out in miles. Against another SHIP, radar and ESM
    // horizons are similar, so the ring diagram alone under-sells it; against an
    // aircraft they are not remotely similar, and that is the whole lesson.
    gE.appendChild(el('div', 'sel-sub', EMCON_INFO[u.emcon].label));
    gE.appendChild(el('div', 'sel-sub', this._emissionLine(u)));
    body.appendChild(gE);

    // Speed
    const gS = el('div', 'ord-group');
    gS.appendChild(el('div', 'k', 'Engine order'));
    const rowS = el('div', 'btn-row');
    const orders = [['STOP', 0], ['SLOW', 0.22], ['STD', 0.5], ['FULL', 0.78], ['FLANK', 1]];
    const f = u.ordered.speed / u.cls.maxSpeed;
    for (const [nm, v] of orders) {
      const b = el('button', Math.abs(f - v) < 0.09 ? 'on' : '', nm);
      b.onclick = () => this.game.orderSpeed(v);
      rowS.appendChild(b);
    }
    gS.appendChild(rowS);
    gS.appendChild(el('div', 'sel-sub', `${Math.round(u.speedKts)} kt / ${Math.round(u.cls.maxSpeed / KNOT)} kt max`));
    body.appendChild(gS);

    // Depth / altitude
    if (u.isSub || u.isAir) {
      const gD = el('div', 'ord-group');
      gD.appendChild(el('div', 'k', u.isSub ? 'Depth' : 'Altitude'));
      const rowD = el('div', 'btn-row');
      const opts = u.isSub
        ? [['PERISCOPE', -18], ['SHALLOW', -60], ['CRUISE', -150], ['DEEP', -300]]
        : [['LOW 1k', 300], ['MED 15k', 4600], ['HIGH 28k', 8500], ['CEILING', u.cls.maxAlt || 11000]];
      for (const [nm, v] of opts) {
        const cur = u.isSub ? u.depthOrdered : u.ordered.alt;
        const b = el('button', Math.abs(cur - v) < (u.isSub ? 12 : 700) ? 'on' : '', nm);
        b.onclick = () => this.game.orderDepth(v);
        rowD.appendChild(b);
      }
      gD.appendChild(rowD);
      gD.appendChild(el('div', 'sel-sub', u.isSub
        ? `${Math.round(-u.alt)} m keel · ${u.deep ? 'DEEP — off the link' : 'shallow — link and ESM available'}`
        : `${fmt.alt(u.alt)} · radar horizon ${fmt.nm(radarHorizon(Math.max(10, u.alt), 24))}`));
      body.appendChild(gD);
    }

    // ROE
    const gR = el('div', 'ord-group');
    gR.appendChild(el('div', 'k', 'Weapons posture'));
    const rowR = el('div', 'btn-row');
    for (const r of [ROE.HOLD, ROE.TIGHT, ROE.FREE]) {
      const b = el('button', sel.every(x => x.ordered.roe === r) ? 'on' : '', r.split(' ')[1]);
      b.title = r;
      b.onclick = () => this.game.orderRoe(r);
      rowR.appendChild(b);
    }
    gR.appendChild(rowR);
    gR.appendChild(el('div', 'sel-sub', u.ordered.roe === ROE.FREE
      ? 'auto-engaging air and subsurface threats' : 'hard kill on order only'));
    body.appendChild(gR);

    // Actions
    const gA = el('div', 'ord-group');
    gA.appendChild(el('div', 'k', 'Orders'));
    const rowA = el('div', 'btn-row');
    const mv = el('button', this.game.pendingOrder === 'MOVE' ? 'on' : '', 'SET COURSE');
    mv.onclick = () => this.game.beginOrder('MOVE');
    rowA.appendChild(mv);
    if (u.isAir) {
      const sp = el('button', this.game.pendingOrder === 'SEARCH' ? 'on' : '', 'SEARCH AREA');
      sp.onclick = () => this.game.beginOrder('SEARCH');
      rowA.appendChild(sp);
    }
    if (!u.isAir && (u.cls.aircraft || []).length) {
      const la = el('button', '', 'LAUNCH HELO');
      la.disabled = this.world.units.some(x => x.alive && x.homeBase === u);
      la.onclick = () => this.game.launchHelo(u);
      rowA.appendChild(la);
    }
    if (u.isAir && u.ammo('SONOBUOY') > 0) {
      const sb = el('button', '', `DROP BUOY  ${u.ammo('SONOBUOY')}`);
      sb.title = 'Lay a passive listening buoy here. It keeps hearing for an hour after you have gone home.';
      sb.onclick = () => this.game.dropBuoy(u);
      rowA.appendChild(sb);
    }
    if (u.isAir && u.cls.helo) {
      const dp = el('button', u.dip ? 'on' : '', u.dip ? 'RAISE SONAR' : 'DIP SONAR');
      dp.title = 'Hold a hover here and put the transducer in the water. The dipping sonar hears nothing while the aircraft is moving.';
      dp.onclick = () => this.game.toggleDip(u);
      rowA.appendChild(dp);
    }
    if (sel.length === 1) {
      const st = el('button', '', 'REJOIN SCREEN');
      st.onclick = () => this.game.rejoinScreen(u);
      rowA.appendChild(st);
    }
    gA.appendChild(rowA);
    const rowA2 = el('div', 'btn-row');
    const fl = el('button', '', 'FOLLOW  ⟨F⟩');
    fl.onclick = () => this.game.cam.follow(u);
    rowA2.appendChild(fl);
    if (!u.isAir && !u.isSub) {
      const br = el('button', '', 'BRIDGE  ⟨B⟩');
      br.onclick = () => this.game.boardUnit(u);
      rowA2.appendChild(br);
    }
    const eg = el('button', '', 'ENGAGE  ⟨E⟩');
    eg.disabled = !this.game.selectedTrack;
    eg.onclick = () => this.openEngage(this.game.selectedTrack);
    rowA2.appendChild(eg);
    gA.appendChild(rowA2);
    body.appendChild(gA);

    // Magazines / sensors
    if (sel.length === 1) {
      const gM = el('div', 'ord-group');
      gM.appendChild(el('div', 'k', 'Magazines'));
      const mag = el('div', 'mag');
      for (const wd of u.cls.weapons || []) {
        const n = u.ammo(wd.id);
        const d = weapon(wd.id);
        const m = el('div', `m${n <= 0 ? ' empty' : ''}`, `${d.name.split(' ').slice(-1)[0] || d.id} <b>${n}</b>`);
        m.title = `${d.name} — ${d.blurb || ''}`;
        mag.appendChild(m);
      }
      gM.appendChild(mag);
      const down = u.sensors.filter(s => !s.ok);
      gM.appendChild(el('div', 'sel-sub', down.length
        ? `⚠ ${down.length} sensor(s) out of action`
        : `${u.sensors.length} sensors online · ${u.fcChannels} FC channels`));
      body.appendChild(gM);
    }
  }

  /**
   * One line of truth about what this ship's emissions are costing it.
   *
   * Two ships' radar and ESM horizons are both cut off by the same curve, so
   * against a surface contact the numbers look almost fair. Put an ESM receiver
   * at 25,000 feet and they are not fair at all: it hears the destroyer's radar
   * from two hundred miles while the destroyer, radiating or not, cannot see it
   * at all if it is passive. That is EMCON in one sentence.
   */
  _emissionLine(u) {
    let best = null;
    for (const s of u.sensors) {
      if (!s.ok || s.type !== 'RADAR' || !s.emits) continue;
      if (!best || (s.refRange * (s.emitPower || 0.5)) > (best.refRange * (best.emitPower || 0.5))) best = s;
    }
    if (!best) return 'no emitters fitted';
    if (!u.radiating) return 'silent — nothing for a hostile ESM operator to hear';
    const h = u.sensorHeight(best);
    const oneWay = best.refRange * 1.65 * (best.emitPower || 0.5);
    const surf = Math.min(oneWay, radarHorizon(h, 30));
    const air = Math.min(oneWay, radarHorizon(h, 7600));
    return `heard by a ship at ${fmt.nm(surf)} · by an aircraft at 25,000 ft at ${fmt.nm(air)}`;
  }

  // ── comms ─────────────────────────────────────────────────────────────────
  _comms() {
    const list = $('comms-list');
    const msgs = this.world.comms;
    if (msgs.length === this.lastCommsLen) return;
    for (let i = this.lastCommsLen; i < msgs.length; i++) {
      const m = msgs[i];
      // Coalesce repeats. A raid produces the same seeker warning fourteen times
      // in a row with identical timestamps, and fourteen identical paragraphs
      // destroy a log whose whole value is that it reads like radio traffic.
      // Key on the SHAPE of the message, not its exact text. "MISSILE SEEKER,
      // bearing 003" and "...bearing 004" are the same event a second apart, and
      // keying on the full string let the top event print twelve times in a row.
      const shape = m.text.replace(/\d+(\.\d+)?/g, '#');
      const prev = this._lastMsgEl;
      if (prev && prev._from === m.from && prev._shape === shape) {
        prev._count = (prev._count || 1) + 1;
        const c = prev.querySelector('.rep');
        if (c) c.textContent = `×${prev._count}`;
        else {
          const b = el('span', 'rep', `×${prev._count}`);
          prev.querySelector('.hd').appendChild(b);
        }
        continue;
      }
      const d = el('div', `msg ${m.priority || 'ROUTINE'}${m.hint ? ' hint' : ''}`);
      d.innerHTML = `<div class="hd">${fmt.clock(m.t)} · <b>${m.from}</b>${m.priority === 'FLASH' ? ' · FLASH' : ''}</div>
        <div class="bd">${m.text}</div>`;
      d._from = m.from; d._text = m.text; d._shape = shape; d._count = 1;
      this._lastMsgEl = d;
      list.appendChild(d);
      // Only genuinely urgent, genuinely SHORT traffic gets the centre-screen
      // banner. Watch-officer advice is FLASH-priority because it matters, but a
      // three-sentence paragraph in a red box across the middle of the plot is
      // worse than useless — it hides the thing it is telling you to look at.
      if (m.priority === 'FLASH' && !m.hint && m.text.length < 110) {
        this.pushAlert(m.text, 'danger', 4.5);
      }
      if (m.hint) this.game.audio?.radio(m.priority);
    }
    while (list.children.length > 90) list.removeChild(list.firstChild);
    this.lastCommsLen = msgs.length;
    // #comms-list IS the scroller — .scroll carries the overflow, not .panel.
    // Scrolling the parent did nothing, so the fleet net log sat frozen on the
    // first message of the mission for the whole game while three thousand
    // pixels of newer traffic piled up below the fold.
    list.scrollTop = list.scrollHeight;
  }

  pushAlert(text, kind = 'info', life = 3.5) {
    // Collapse repeats rather than stacking them; a raid generates the same
    // warning many times a second.
    // Match on the SHAPE of the message, not the exact string. "Missile impact
    // on NEUTRAL VESSEL." and "Missile impact on NEUTRAL VESSEL — target
    // destroyed." are one event, and keying on the full text stacked three
    // near-identical red banners across the middle of the plot.
    const shape = text.replace(/\d+(\.\d+)?/g, '#').slice(0, 34);
    const same = this.alerts.find(a => a.shape === shape);
    if (same) {
      same.life = Math.max(same.life, life);
      same.n = (same.n || 1) + 1;
      if (text.length > same.text.length) same.text = text;
      return;
    }
    this.alerts.push({ text, kind, life, shape, n: 1 });
    if (this.alerts.length > 2) this.alerts.shift();
  }

  _alerts(dt) {
    const box = $('alerts');
    let dirty = false;
    for (const a of this.alerts) { a.life -= dt; if (a.life <= 0) dirty = true; }
    if (dirty) this.alerts = this.alerts.filter(a => a.life > 0);
    const sig = this.alerts.map(a => `${a.text}#${a.n || 1}`).join('|');
    if (sig === this._alertSig) return;
    this._alertSig = sig;
    box.innerHTML = '';
    for (const a of this.alerts) {
      const d = el('div', `alert ${a.kind === 'danger' ? '' : a.kind}`, a.text);
      if ((a.n || 1) > 1) d.appendChild(el('span', 'rep', `×${a.n}`));
      box.appendChild(d);
    }
  }

  // ── engagement dialog ─────────────────────────────────────────────────────
  openEngage(track) {
    if (!track) return;
    const shooters = this.game.eligibleShooters(track);
    if (!shooters.length) {
      this.pushAlert('NO UNIT IN RANGE WITH A SUITABLE WEAPON', 'warn', 3);
      return;
    }
    this.engage = { track, weaponId: null, salvo: 4, seekerPct: 1.0, shooters };
    // Default to the longest-ranged weapon actually available to somebody.
    const opts = this.game.weaponOptions(track, shooters);
    this.engage.options = opts;
    this.engage.weaponId = opts.find(o => o.total > 0)?.id || null;
    $('engage-modal').classList.add('on');
    $('eng-track').textContent = `${track.id} · ${track.label || track.classification}`;
    this._engageBody();
    this.game.audio?.ui('confirm');
  }

  closeEngage() {
    this.engage = null;
    this.game.overlay.engagePreview = null;
    $('engage-modal').classList.remove('on');
  }

  _engageBody() {
    const e = this.engage;
    const body = $('engage-body');
    body.innerHTML = '';
    const wsel = el('div', 'wsel');
    for (const o of e.options) {
      const d = weapon(o.id);
      const row = el('div', `w${o.id === e.weaponId ? ' on' : ''}${o.total <= 0 || !o.inRange ? ' dis' : ''}`);
      row.innerHTML = `<div class="radio"></div>
        <div><div class="nm">${d.name}</div><div class="ds">${d.blurb || ''}</div></div>
        <div class="ct">${o.total}<div class="ds" style="text-align:right">${o.inRange ? `${(d.range / NM).toFixed(0)} nm` : 'OUT OF RANGE'}</div></div>`;
      if (o.total > 0 && o.inRange) row.onclick = () => { e.weaponId = o.id; this._engageBody(); };
      wsel.appendChild(row);
    }
    body.appendChild(wsel);

    const maxSalvo = Math.min(24, e.options.find(o => o.id === e.weaponId)?.total || 1);
    e.salvo = clamp(e.salvo, 1, maxSalvo);
    const s1 = el('div', 'slider-row');
    s1.innerHTML = `<div class="k">Salvo size</div>`;
    const inp = el('input');
    inp.type = 'range'; inp.min = 1; inp.max = maxSalvo; inp.value = e.salvo;
    const out = el('div', 'v'); out.style.textAlign = 'right'; out.textContent = `${e.salvo} rds`;
    inp.oninput = () => { e.salvo = +inp.value; out.textContent = `${e.salvo} rds`; this._engageSolution(); };
    s1.appendChild(inp); s1.appendChild(out);
    body.appendChild(s1);

    const s2 = el('div', 'slider-row');
    s2.innerHTML = `<div class="k">Seeker turn-on</div>`;
    const inp2 = el('input');
    inp2.type = 'range'; inp2.min = 40; inp2.max = 200; inp2.value = Math.round(e.seekerPct * 100);
    const out2 = el('div', 'v'); out2.style.textAlign = 'right';
    inp2.oninput = () => { e.seekerPct = +inp2.value / 100; this._engageSolution(); };
    s2.appendChild(inp2); s2.appendChild(out2);
    body.appendChild(s2);
    this._seekerOut = out2;

    this._solutionBox = el('div', 'solution');
    body.appendChild(this._solutionBox);

    // The alpha-strike button. Deliberately sitting next to the per-weapon
    // controls so the comparison is unavoidable: four rounds of one type, or
    // everything you own arriving in the same ten seconds.
    const alphaCount = this._alphaCount(e.track);
    const alpha = el('button', 'act danger',
      `Alpha strike — commit all ${alphaCount} rounds in range`);
    alpha.disabled = alphaCount <= 0;
    alpha.onclick = () => {
      const res = this.game.alphaStrike(e.track);
      this.closeEngage();
      this.pushAlert(res.fired ? `ALPHA STRIKE — ${res.fired} ROUNDS COMMITTED` : 'NOTHING IN RANGE', 'warn', 4);
    };
    body.appendChild(alpha);
    this._engageSolution();
  }

  /**
   * Live firing solution. This panel is the game's central lesson made numeric:
   * it shows the target's error ellipse GROWN over the missile's time of flight
   * and compares it with the seeker basket. If the grown ellipse is wider than
   * the basket, the salvo is a coin flip no matter how good the missile is.
   */
  _engageSolution() {
    const e = this.engage;
    if (!e || !e.weaponId || !this._solutionBox) return;
    const d = weapon(e.weaponId);
    const t = e.track;
    const now = this.world.time;
    const rng = Math.min(...e.shooters.map(s => Math.hypot(t.x - s.x, t.z - s.z)));
    const tof = rng / d.speed;
    const seekerRange = (d.seekerRange || 25000) * e.seekerPct;
    if (this._seekerOut) this._seekerOut.textContent = `${(seekerRange / NM).toFixed(0)} nm`;

    // Predicted ellipse at intercept: current covariance plus the process noise
    // accumulated over the whole flight.
    const q = t.domain === DOMAIN.SURFACE ? 0.7 : t.domain === DOMAIN.AIR ? 26 : 0.35;
    const grown = Math.sqrt(t.P[0] + (q * Math.pow(tof, 3)) / 3);
    const basket = d.seekerWidth || 12000;
    const custody = t.linked && (now - t.lastUpdate) < 60;
    const midcourse = d.datalink && custody;

    // Effective aim error: mid-course updates keep refreshing it, so the error
    // that matters is the error at the LAST update, not at launch.
    const effective = midcourse ? Math.sqrt(t.P[0] + (q * Math.pow(60, 3)) / 3) : grown;
    const pAcquire = clamp(1 - Math.exp(-Math.pow(basket / Math.max(300, effective * 1.6), 1.6)), 0.02, 0.97);

    // Leakage through the defence.
    //
    // Without this the panel would promise eighteen hits from a twenty-four
    // round salvo and deliver one, because the whole raid dies inside the
    // target's SAM umbrella. The defender's capacity is roughly (fire-control
    // channels) x (engagement cycles available in the terminal window) x (single
    // shot kill probability) — and the terminal window is set by the RADAR
    // HORIZON against this missile's flight profile, which is why a sea-skimmer
    // leaks and a high-diver does not.
    const leak = this._estimateLeakers(t, e.salvo, d);
    const pk = pAcquire * (d.pkTerminal || 0.7);
    const expected = pk * leak.leakers;

    const bad = t.tq < WEAPONS_QUALITY_TQ || pAcquire < 0.4;
    this._solutionBox.className = `solution${bad ? ' bad' : ''}`;
    this._solutionBox.innerHTML = `
      <div class="row"><span class="k">Range to target</span><span class="v">${fmt.nm(rng)}</span></div>
      <div class="row"><span class="k">Time of flight</span><span class="v">${fmt.dur(tof)}</span></div>
      <div class="row"><span class="k">Track quality now</span><span class="v" style="color:${tqBand(t.tq).color}">TQ${t.tq} · ±${(t.sigma / NM).toFixed(1)} nm</span></div>
      <div class="row"><span class="k">Error at intercept</span><span class="v" style="color:${effective > basket ? 'var(--danger)' : 'var(--good)'}">±${(effective / NM).toFixed(1)} nm</span></div>
      <div class="row"><span class="k">Seeker basket</span><span class="v">±${(basket / NM).toFixed(1)} nm</span></div>
      <div class="row"><span class="k">Mid-course guidance</span><span class="v" style="color:${midcourse ? 'var(--good)' : 'var(--warn)'}">${midcourse ? 'AVAILABLE — custody held on link' : d.datalink ? 'UNAVAILABLE — no custody' : 'WEAPON HAS NO DATALINK'}</span></div>
      <div class="row"><span class="k">P(acquire) per round</span><span class="v">${Math.round(pAcquire * 100)}%</span></div>
      <div class="row"><span class="k">Hostile air defence</span><span class="v">${leak.label}</span></div>
      <div class="row"><span class="k">Expected leakers</span><span class="v" style="color:${leak.leakers >= 4 ? 'var(--good)' : leak.leakers >= 1.5 ? 'var(--warn)' : 'var(--danger)'}">${leak.leakers.toFixed(1)} of ${e.salvo}</span></div>
      <div class="row"><span class="k">Expected hits</span><span class="v" style="color:${expected >= 1.5 ? 'var(--good)' : expected >= 0.7 ? 'var(--warn)' : 'var(--danger)'}">${expected.toFixed(1)}</span></div>
      ${leak.leakers < 1.2 && e.salvo >= 4 ? `<div class="warnline">⚠ This raid is smaller than the target's air-defence capacity. ${leak.detail} A salvo that the defender can service one round at a time is a salvo you have thrown away — send more, arrive together, or kill the escorts first.</div>` : ''}
      ${bad ? `<div class="warnline">⚠ ${t.tq < WEAPONS_QUALITY_TQ
        ? `Track quality is below weapons quality. The aim point is a guess with a ${(t.sigma / NM).toFixed(0)} nautical mile error; most of this salvo will search empty water.`
        : 'The target can move outside the seeker basket before the salvo arrives. Get a sensor onto it and hold custody, or close the range.'}</div>`
        : (leak.leakers >= 1.2
          ? `<div class="okline">✔ Solution is sound and the raid is large enough to leak. ${midcourse ? 'Keep a sensor on this track for the whole time of flight — mid-course updates are doing most of the work.' : 'No mid-course link: the basket lands where you aimed it, so do not let him turn.'}</div>`
          : '')}
    `;

    this.game.overlay.engagePreview = { track: t, tof, def: d, shooters: e.shooters };
    $('eng-fire').textContent = `Batteries release — ${e.salvo} × ${d.name.split(' ').pop()}`;
  }

  /**
   * How many rounds of a salvo survive the target's air defence.
   *
   * Deliberately built out of the same three quantities the sim uses, so the
   * number the player is shown is the number they will get: how long the raid is
   * exposed (set by the defender's radar horizon against this missile's altitude),
   * how many engagements that allows (channels x cycles), and how often each one
   * works. Only counts defenders the plot actually HOLDS — an escort you have not
   * found is not in the estimate, which is its own lesson.
   */
  _estimateLeakers(track, salvo, def) {
    const w = this.world;
    const table = w.picture(SIDE.BLUE);
    const now = w.time;
    let channels = 0, best = 0;
    const defenders = [];
    for (const t of table.list) {
      if (t.own || t.faded) continue;
      // Any warship in company defends the group, whether or not the plot has
      // got round to calling it hostile.
      if (t.identity === IDENT.FRIEND || t.identity === IDENT.NEUTRAL) continue;
      if (t.domain !== DOMAIN.SURFACE) continue;
      if (Math.hypot(t.x - track.x, t.z - track.z) > 45000) continue;   // in company
      const u = t.truthRef;
      if (!u || !u.alive) continue;
      const sams = (u.cls.weapons || []).map(x => weapon(x.id)).filter(x => x.category === 'SAM' && u.ammo(x.id) > 0);
      if (!sams.length) continue;
      defenders.push(u);
      channels += u.fcChannels;
      best = Math.max(best, Math.max(...sams.map(x => x.range)));
    }
    if (!channels) {
      return { leakers: salvo, label: 'none held', detail: '' };
    }
    // Terminal window: how long the raid is inside the defender's radar horizon.
    const mast = Math.max(...defenders.map(u => u.cls.mastHeight || 25));
    const alt = Math.max(4, def.terminalAlt ?? def.cruiseAlt ?? 10);
    const horizon = Math.min(best, radarHorizon(mast, alt));
    const speed = def.terminalSpeed || def.speed;
    const window = Math.max(20, (horizon - 3000) / speed) - 15;   // minus reaction time
    // One engagement cycle is flyout plus kill assessment — see DefenseSystem.
    const cycles = Math.max(1, Math.floor(window / 33));
    const pk = 0.64 * (alt < 20 ? 0.74 : 1) * (speed > 600 ? 0.68 : 1)
      * clamp((def.stealth ?? 1) * 0.8 + 0.34, 0.44, 1.0)
      * 2;   // doctrine fires two rounds per leaker until the raid gets big
    const capacity = channels * cycles * pk;
    const leakers = Math.max(0, salvo - capacity);
    return {
      leakers,
      label: `${channels} FC channels held · ~${Math.round(capacity)} rds capacity`,
      detail: `The ${defenders.length} escort(s) you hold can service about ${Math.round(capacity)} rounds in the ${Math.round(horizon / NM)} nm you are visible to them.`,
    };
  }

  /**
   * Contacts steaming in company with this one: within 45 km, on a similar
   * course, at a similar speed. Merchants do not do this; warship formations do.
   */
  _companyOf(t) {
    const table = this.world.picture(SIDE.BLUE);
    const out = [];
    for (const o of table.list) {
      if (o.own || o.faded || o.domain !== DOMAIN.SURFACE) continue;
      if (o.identity === IDENT.FRIEND || o.identity === IDENT.NEUTRAL) continue;
      if (Math.hypot(o.x - t.x, o.z - t.z) > 45000) continue;
      if (Math.abs(o.speedEst - t.speedEst) > 4) continue;
      out.push(o);
    }
    return out;
  }

  /** How many anti-ship rounds the whole force could put on this track now. */
  _alphaCount(track) {
    let n = 0;
    for (const u of this.world.units) {
      if (!u.alive || u.side !== SIDE.BLUE) continue;
      for (const w of u.cls.weapons || []) {
        const d = weapon(w.id);
        if (d.category !== 'ASM') continue;
        if (u.ammo(w.id) <= 0) continue;
        if (Math.hypot(track.x - u.x, track.z - u.z) > d.range * 0.95) continue;
        n += u.ammo(w.id);
      }
    }
    return n;
  }

  confirmEngage() {
    const e = this.engage;
    if (!e || !e.weaponId) return;
    const d = weapon(e.weaponId);
    const res = this.game.fireSalvo(e.track, e.weaponId, e.salvo, (d.seekerRange || 25000) * e.seekerPct);
    this.closeEngage();
    if (res.fired) this.pushAlert(`${res.fired} × ${d.name.toUpperCase()} AWAY`, 'warn', 3);
    else this.pushAlert('UNABLE — ' + (res.reason || 'no rounds').toUpperCase(), 'warn', 3);
  }
}
