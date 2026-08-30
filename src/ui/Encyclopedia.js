/**
 * Recognition manual.
 *
 * Every platform and weapon in this game already carries a written note about
 * what it is FOR — the doctrine, not the datasheet. Until now those notes were
 * reachable only as hover tooltips on a moving map, which is a reference book
 * nobody can read.
 *
 * The numbers here are not typed out a second time. Detection ranges are run
 * through the same radarHorizon() and fourth-root RCS scaling that Sensors.js
 * uses in the loop, against two named reference targets, so what the manual
 * prints is what the sim will actually do. If someone retunes a radar, this
 * page changes with it.
 */

import { PLATFORMS } from '../sim/platforms.db.js';
import { WEAPONS } from '../sim/weapons.db.js';
import { LOADOUTS } from '../sim/airwing.db.js';
import { radarHorizon } from '../sim/constants.js';

// Mirrors of the two constants Sensors.js keeps private. Referenced, not guessed.
const REF_RCS_SURFACE = 10000, REF_RCS_AIR = 5;

const RED = new Set(['CG_SLAVA', 'DDG_UDALOY', 'FFG_STEREGUSHCHY', 'SSGN_AKULA', 'MPA_BEAR', 'BOMBER_BACKFIRE']);
const NEUTRAL = new Set(['MERCHANT', 'TRAWLER']);

const sideOf = (id) => RED.has(id) ? 'RED' : NEUTRAL.has(id) ? 'NEUTRAL' : 'BLUE';

// The two targets every sensor line is measured against. A warship-sized
// contact and a sea-skimming missile: the whole tactical problem in two rows.
const REF_SHIP = { name: 'warship', rcs: 4200, height: 30 };
const REF_SKIMMER = { name: 'sea-skimmer', rcs: 0.05, alt: 6 };

const kt = (ms) => `${Math.round(ms * 1.94384)} kt`;
const nm = (m) => `${(m / 1852).toFixed(m < 18520 ? 1 : 0)} nm`;
const km = (m) => `${Math.round(m / 1000)} km`;
const rng = (m) => `${nm(m)}  ·  ${km(m)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TABS = [
  { id: 'SURFACE', label: 'Surface' },
  { id: 'SUB', label: 'Submarines' },
  { id: 'AIR', label: 'Aircraft' },
  { id: 'WEAPON', label: 'Weapons' },
];

export class Encyclopedia {
  constructor() {
    this.el = document.getElementById('screen-enc');
    this.tabsEl = document.getElementById('enc-tabs');
    this.listEl = document.getElementById('enc-list');
    this.detailEl = document.getElementById('enc-detail');
    this.tab = 'SURFACE';
    this.sel = null;
    this._built = false;
  }

  /** Prepares the page. The caller drives the screen transition. */
  open(entryId = null) {
    if (!this._built) { this._buildTabs(); this._built = true; }
    if (entryId) {
      const t = this._tabOf(entryId);
      if (t) { this.tab = t; this.sel = entryId; }
    }
    this._render();
  }

  _tabOf(id) {
    if (WEAPONS[id]) return 'WEAPON';
    const p = PLATFORMS[id];
    if (!p) return null;
    return p.domain === 'AIR' ? 'AIR' : p.domain === 'SUBSURFACE' ? 'SUB' : 'SURFACE';
  }

  _buildTabs() {
    this.tabsEl.innerHTML = TABS
      .map((t) => `<button class="ghost" data-tab="${t.id}">${t.label}</button>`).join('');
    this.tabsEl.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { this.tab = b.dataset.tab; this.sel = null; this._render(); };
    });
  }

  /** Entries in the current tab, in a deliberate order: ours, theirs, then civil. */
  _entries() {
    if (this.tab === 'WEAPON') {
      const order = ['ASM', 'SAM', 'TORPEDO', 'CIWS', 'GUN', 'DECOY', 'SONOBUOY'];
      return Object.values(WEAPONS)
        .sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category))
          || (a.side === b.side ? 0 : a.side === 'BLUE' ? -1 : 1))
        .map((w) => ({ id: w.id, name: w.name, sub: `${w.category} · ${w.side}`, side: w.side }));
    }
    const want = this.tab === 'AIR' ? 'AIR' : this.tab === 'SUB' ? 'SUBSURFACE' : 'SURFACE';
    const rank = { BLUE: 0, RED: 1, NEUTRAL: 2 };
    return Object.values(PLATFORMS)
      .filter((p) => p.domain === want)
      .map((p) => ({ id: p.id, name: p.display, sub: `${p.type} · ${sideOf(p.id)}`, side: sideOf(p.id) }))
      .sort((a, b) => rank[a.side] - rank[b.side]);
  }

  _render() {
    this.tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const list = this._entries();
    if (!this.sel || !list.some((e) => e.id === this.sel)) this.sel = list[0]?.id ?? null;

    this.listEl.innerHTML = list.map((e) => `
      <button class="enc-item${e.id === this.sel ? ' on' : ''}" data-id="${e.id}">
        <div class="n">${esc(e.name)}</div><div class="t">${esc(e.sub)}</div>
      </button>`).join('');
    this.listEl.querySelectorAll('.enc-item').forEach((b) => {
      b.onclick = () => { this.sel = b.dataset.id; this._render(); };
    });

    this.detailEl.innerHTML = WEAPONS[this.sel] ? this._weaponBody(WEAPONS[this.sel])
      : PLATFORMS[this.sel] ? this._platformBody(PLATFORMS[this.sel]) : '';
    this.detailEl.scrollTop = 0;
    // Every weapon named on a platform page is a link into the weapons tab.
    this.detailEl.querySelectorAll('[data-jump]').forEach((a) => {
      a.onclick = () => {
        const t = this._tabOf(a.dataset.jump);
        if (t) { this.tab = t; this.sel = a.dataset.jump; this._render(); }
      };
    });
  }

  // ── platform page ───────────────────────────────────────────────────────
  _platformBody(p) {
    const kv = (k, v) => v == null ? '' : `<div class="enc-kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const isAir = p.domain === 'AIR';

    const chars = [
      kv('Length', p.length ? `${p.length} m` : null),
      kv(isAir ? 'Wingspan' : 'Beam', p.beam ? `${p.beam} m` : null),
      kv('Draft', p.draft ? `${p.draft} m` : null),
      kv(isAir ? 'Empty weight' : 'Displacement', p.displacement ? `${p.displacement.toLocaleString()} t` : null),
      kv('Max speed', p.maxSpeed ? kt(p.maxSpeed) : null),
      kv('Crew', p.crew ?? null),
      kv('Hull points', p.hp ?? null),
      kv('Radar cross-section', p.rcs ? `${p.rcs.toLocaleString()} m²` : null),
      kv('Acoustic index', p.acoustic || null),
      kv(isAir ? 'Cruise altitude' : 'Sensor height', isAir ? (p.cruiseAlt ? `${p.cruiseAlt.toLocaleString()} m` : null) : (p.mastHeight ? `${p.mastHeight} m` : null)),
      kv('Fire-control channels', p.fireControlChannels ?? null),
      kv('Endurance', p.endurance ? `${(p.endurance / 3600).toFixed(1)} h` : null),
    ].join('');

    const sensors = (p.sensors || []).map((s) => this._sensorLine(s, p)).join('');

    const weapons = (p.weapons || []).map((w) => {
      const d = WEAPONS[w.id];
      return `<div class="enc-line">
        <span class="lb" data-jump="${w.id}" style="cursor:pointer;text-decoration:underline dotted">${esc(d?.name || w.id)}</span>
        <span style="float:right">×${w.count}</span>
        <div class="sub">${esc(w.launcher || '')}${d ? ` — ${esc(d.category)}, ${rng(d.range || 0)}` : ''}</div>
      </div>`;
    }).join('');

    const air = (p.aircraft || []).map((a) => {
      const d = PLATFORMS[a.type];
      return `<div class="enc-line">
        <span class="lb" data-jump="${a.type}" style="cursor:pointer;text-decoration:underline dotted">${esc(d?.display || a.type)}</span>
        <span style="float:right">×${a.count}</span></div>`;
    }).join('');

    const lo = LOADOUTS[p.id];
    const loadouts = lo ? Object.values(lo).map((l) => `
      <div class="enc-line">
        <span class="lb">${esc(l.name)}</span>
        <span style="float:right">${Math.round(l.prep / 60)} min to prepare · ${Math.round(l.cooldown / 60)} min turnaround</span>
        <div class="sub" style="margin-top:4px">${esc(l.blurb)}</div>
        <div class="sub" style="margin-top:3px">${l.weapons.map((w) => `${esc(WEAPONS[w.id]?.name || w.id)} ×${w.count}`).join('  ·  ')}</div>
      </div>`).join('') : '';

    return `
      <h3>${esc(p.display)}</h3>
      <div class="cls">${esc(p.type)} · ${sideOf(p.id)}${p.hvu ? ' · HIGH VALUE UNIT' : ''}</div>
      <div class="role">${esc(p.role || '')}</div>
      <div class="enc-sec">Characteristics</div><div class="enc-grid">${chars}</div>
      ${sensors ? `<div class="enc-sec">Sensors</div>${sensors}` : ''}
      ${weapons ? `<div class="enc-sec">Armament</div>${weapons}` : ''}
      ${air ? `<div class="enc-sec">Air detachment</div>${air}` : ''}
      ${loadouts ? `<div class="enc-sec">Loadouts</div>${loadouts}` : ''}`;
  }

  /**
   * One sensor, measured rather than described. For a radar we run the same two
   * limits the sim runs — transmitter power scaled by the fourth root of RCS,
   * and the 4/3-earth horizon — and print whichever binds. At sea the horizon
   * almost always binds, and seeing a 320 km radar reduced to 39 km on the page
   * is the lesson the whole game is built around.
   */
  _sensorLine(s, p) {
    // Unit.sensorHeight(): an airborne sensor sits at the aircraft's altitude,
    // not on a mast. Getting this wrong understates a Hornet's radar by an order
    // of magnitude, and the jump from a 39 km horizon to a 400 km one is the
    // entire reason the task force flies.
    const h = p.domain === 'AIR' ? Math.max(10, p.cruiseAlt ?? 9000)
      : (s.height ?? p.mastHeight ?? 20);
    const bits = [];

    if (s.type === 'RADAR') {
      const ship = Math.min(s.refRange * Math.pow(REF_SHIP.rcs / REF_RCS_SURFACE, 0.25),
        radarHorizon(h, REF_SHIP.height));
      bits.push(`vs ${REF_SHIP.name}: <b>${rng(ship)}</b>`);
      if (s.refAir || s.domains?.includes('MISSILE')) {
        const ref = s.refAir || s.refRange * 0.6;
        const skim = Math.min(ref * Math.pow(REF_SKIMMER.rcs / REF_RCS_AIR, 0.25),
          radarHorizon(h, REF_SKIMMER.alt));
        bits.push(`vs ${REF_SKIMMER.name}: <b>${rng(skim)}</b>`);
      }
      bits.push('emits');
    } else if (s.type === 'ESM') {
      bits.push(`passive · sensitivity ${s.sensitivity}`);
      bits.push(`horizon to a masthead emitter: <b>${rng(radarHorizon(h, 30))}</b>`);
    } else if (s.type === 'SONAR') {
      if (s.passiveRange) bits.push(`passive: <b>${rng(s.passiveRange)}</b>`);
      if (s.activeRange) bits.push(`active: <b>${rng(s.activeRange)}</b> (emits)`);
      bits.push(s.towed
        ? 'streamed BELOW the layer — the reason it exists'
        : (p.domain === 'SUBSURFACE' ? "at the boat's own depth" : 'hull-mounted, above the layer'));
    } else if (s.type === 'VISUAL') {
      bits.push(`<b>${rng(Math.min(s.refRange, radarHorizon(h, REF_SHIP.height)))}</b> in clear weather`);
    }

    return `<div class="enc-line"><span class="lb">${esc(s.name)}</span>
      <span style="float:right;color:var(--muted);font-size:9.5px;letter-spacing:.12em">${s.type}</span>
      <div class="sub">${bits.join('  ·  ')}</div></div>`;
  }

  // ── weapon page ─────────────────────────────────────────────────────────
  _weaponBody(w) {
    const kv = (k, v) => v == null ? '' : `<div class="enc-kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const mach = w.speed ? (w.speed / 340) : 0;
    const speed = w.speed ? (mach >= 0.95 ? `Mach ${mach.toFixed(1)}` : `${kt(w.speed)} (Mach ${mach.toFixed(2)})`) : null;

    const chars = [
      kv('Range', w.range ? rng(w.range) : null),
      kv('Speed', speed),
      kv('Seeker acquisition', w.seekerRange ? rng(w.seekerRange) : null),
      kv('Warhead', w.warhead ? `${w.warhead} kg` : null),
      kv('Single-shot Pk', w.pkSingle != null ? `${Math.round(w.pkSingle * 100)}%` : (w.pkTerminal != null ? `${Math.round(w.pkTerminal * 100)}% terminal` : null)),
      kv('Cruise altitude', w.cruiseAlt != null ? `${w.cruiseAlt} m` : null),
      kv('Terminal altitude', w.terminalAlt != null ? `${w.terminalAlt} m` : null),
      kv('Engagement ceiling', w.maxAlt ? `${w.maxAlt.toLocaleString()} m` : null),
      kv('Rate of fire', w.rate ? `${w.rate}/s` : null),
      kv('Fire-control load', w.cyclesToFire != null ? `${w.cyclesToFire} cycles` : null),
    ].join('');

    // The flags that decide how a shot actually plays out, in plain words.
    const traits = [
      [w.vls, 'VLS — fires from a cell, no launcher to train'],
      [w.quadPacked, 'Quad-packed — four rounds to one cell'],
      [w.fireAndForget, 'Fire-and-forget — no illuminator held on the target'],
      [w.needsIllum, 'Needs illumination — ties up a fire-control channel to impact'],
      [w.datalink, 'Datalinked — the shot can be updated in flight'],
      [w.discriminates, 'Discriminates — picks its target out of a formation'],
      [w.stealth != null && w.stealth < 0.4, 'Low observable — the defender sees it late'],
      [w.wakeHoming, 'Wake-homing — follows the disturbance, ignores decoys'],
    ].filter(([on]) => on).map(([, t]) => `<div class="enc-line">${esc(t)}</div>`).join('');

    return `
      <h3>${esc(w.name)}</h3>
      <div class="cls">${esc(w.category)} · ${esc(w.side)}</div>
      <div class="role">${esc(w.blurb || '')}</div>
      <div class="enc-sec">Performance</div><div class="enc-grid">${chars}</div>
      ${traits ? `<div class="enc-sec">Characteristics</div>${traits}` : ''}
      ${this._carriedBy(w.id)}`;
  }

  /** Who actually shoots it — the fastest way to understand what a weapon is for. */
  _carriedBy(id) {
    const rows = Object.values(PLATFORMS)
      .filter((p) => (p.weapons || []).some((w) => w.id === id))
      .map((p) => `<div class="enc-line"><span class="lb" data-jump="${p.id}" style="cursor:pointer;text-decoration:underline dotted">${esc(p.display)}</span>
        <span style="float:right">×${(p.weapons.find((w) => w.id === id) || {}).count}</span></div>`);

    for (const [type, sets] of Object.entries(LOADOUTS)) {
      for (const l of Object.values(sets)) {
        if (!l.weapons.some((w) => w.id === id)) continue;
        rows.push(`<div class="enc-line"><span class="lb" data-jump="${type}" style="cursor:pointer;text-decoration:underline dotted">${esc(PLATFORMS[type]?.display || type)}</span>
          <span style="float:right">${esc(l.name)} ×${l.weapons.find((w) => w.id === id).count}</span></div>`);
      }
    }
    return rows.length ? `<div class="enc-sec">Carried by</div>${rows.join('')}` : '';
  }
}
