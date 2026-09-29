// App state and wiring. One workload, several networks, one shared clock.

import { DEFAULT_WORKLOAD, generateWorkload, presetParams } from './workload.js';
import { FLEET, LETTERS, LINE_COLORS, MAX_MACHINES, EXPERIMENTS, normalizeCfg } from './machine.js';
import { simulate } from './sim.js';
import { computeStats, findEpisodes, cycleStatus, fmtInt, fmtTime, stateClause, cycleAt, instrText, regVersions, lineWhere } from './analysis.js';
import { C, CODE_INFO, LOC, OPS, regName, hex } from './isa.js';
import { readPalette } from './palette.js';
import { h, svg, showMenu, closeMenu } from './dom.js';
import { Planner } from './planner.js';
import { buildCard, updateCard, buildDrawer } from './fleet.js';
import { Inspector } from './inspector.js';
import { renderReport } from './report.js';
import { Scrubber } from './scrubber.js';
import { renderLegend, renderGuide } from './guide.js';
import { Sound } from './audio.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  wl: { ...DEFAULT_WORKLOAD, mix: { ...DEFAULT_WORKLOAD.mix } },
  workload: null,
  machines: [],
  nextUid: 1,
  baseUid: null,
  focus: null,
  sel: null,
  t: 0,
  tMax: 1,
  playing: false,
  speed: 10,
  sync: 'cycle',
  stepTo: null,
  dirty: true,
};

const $ = (id) => document.getElementById(id);
const els = {
  fleet: $('fleet'),
  fleetAdd: $('fleet-add'),
  report: $('report'),
  play: $('tp-play'),
  num: $('tp-num'),
  sub: $('tp-sub'),
  unit: $('tp-unit'),
  speed: $('tp-speed'),
  sync: $('tp-sync'),
  tooltip: $('tooltip'),
  guide: $('guide'),
  sound: $('tp-sound'),
};

const app = {
  state,
  maxMachines: MAX_MACHINES,

  baseline() {
    return state.machines.find((M) => M.uid === state.baseUid) || state.machines[0];
  },
  machineByUid(uid) {
    return state.machines.find((M) => M.uid === uid) || null;
  },
  localCycle(M, t = state.t) {
    return state.sync === 'cycle' ? t : t * M.cfg.ghz;
  },
  toGlobal(M, c) {
    return state.sync === 'cycle' ? c : c / M.cfg.ghz;
  },
  consumersOf(M, id) {
    return M.view.consumersOf(id);
  },

  // ---------------------------------------------------------------- Workload
  applyPreset(id) {
    const p = presetParams(id);
    state.wl = { ...state.wl, ...p, mix: { ...p.mix } };
    regenerate();
  },
  setWorkload(key, v) {
    state.wl = { ...state.wl, [key]: v };
    if (['mix', 'dependency', 'spatial', 'temporal', 'vector', 'predictability'].includes(key)) state.wl.preset = 'custom';
    scheduleRegenerate();
  },

  // ---------------------------------------------------------------- Networks
  addMachine(cfg, name, after) {
    if (state.machines.length >= MAX_MACHINES) return null;
    const used = new Set(state.machines.map((M) => M.letter));
    const li = LETTERS.findIndex((l) => !used.has(l));
    const M = { uid: state.nextUid++, letter: LETTERS[li], color: LINE_COLORS[li], name, cfg: normalizeCfg(cfg), version: 0 };
    const card = buildCard(M, app);
    const idx = after ? state.machines.indexOf(after) + 1 : state.machines.length;
    state.machines.splice(idx, 0, M);
    const next = state.machines[idx + 1];
    if (next) els.fleet.insertBefore(card, next.el.root);
    else els.fleet.append(card);
    resim(M);
    applySelection();
    sizeViews();
    refreshAll();
    return M;
  },
  removeMachine(M) {
    if (state.machines.length <= 1) return;
    closeMenu();
    state.machines = state.machines.filter((x) => x !== M);
    M.el.root.remove();
    if (hoverState && hoverState.M === M) {
      hoverState = null;
      els.tooltip.hidden = true;
    }
    if (state.sel && state.sel.uid === M.uid) state.sel = null;
    if (state.baseUid === M.uid) state.baseUid = null;
    if (state.focus === M.uid) state.focus = state.machines[0].uid;
    applySelection();
    refreshAll();
  },
  cloneMachine(M, ex) {
    if (state.machines.length >= MAX_MACHINES) return;
    const cfg = ex ? ex.apply(M.cfg) : { ...M.cfg };
    const name = ex ? `${M.name} · ${ex.tag(M.cfg)}` : `${M.name} copy`;
    const N = app.addMachine(cfg, name, M);
    if (N) {
      app.setFocus(N.uid);
      requestAnimationFrame(() => N.el.root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' }));
    }
  },
  renameMachine(M, name) {
    M.name = name.trim() || `Network ${M.letter}`;
    scheduleReport();
  },
  setMachineParam(M, key, v) {
    // Keep following the same work if this network's instructions renumber
    // (for example when SIMD packing changes).
    const sel = state.sel && state.sel.uid === M.uid ? M.trace.instrs[state.sel.id].ops[0] : null;
    M.cfg = normalizeCfg({ ...M.cfg, [key]: v });
    resim(M);
    if (sel != null) state.sel = { uid: M.uid, id: M.trace.map[sel] };
    applySelection();
    refreshAll();
  },
  toggleDrawer(M) {
    const open = M.el.drawer.hidden;
    M.el.drawer.hidden = !open;
    M.el.adjust.setAttribute('aria-expanded', String(open));
    if (open) buildDrawer(M, app);
  },
  openExperiments(M, anchor) {
    const full = state.machines.length >= MAX_MACHINES;
    showMenu(
      anchor,
      full ? 'Remove a network to add another' : `Clone ${M.letter} with one change`,
      EXPERIMENTS.map((ex) => ({ label: ex.label(M.cfg), note: ex.ok(M.cfg) ? ex.tag(M.cfg) : 'at limit', disabled: full || !ex.ok(M.cfg), run: () => app.cloneMachine(M, ex) })),
    );
  },
  setBaseline(uid) {
    state.baseUid = uid;
    refreshAll();
  },
  setFocus(uid) {
    if (state.focus === uid) return;
    state.focus = uid;
    for (const M of state.machines) M.el.root.classList.toggle('is-focus', M.uid === uid && state.machines.length > 1);
    state.dirty = true;
  },

  // --------------------------------------------------------------- Selection
  select(uid, id) {
    state.sel = uid == null || id == null || id < 0 ? null : { uid, id };
    if (state.sel) app.setFocus(uid);
    applySelection();
    inspector.update(true);
    state.dirty = true;
  },

  // ---------------------------------------------------------------- Timeline
  jumpToLocal(M, c) {
    setPlaying(false);
    state.stepTo = null;
    state.t = clampT(app.toGlobal(M, c));
    state.dirty = true;
  },
};

// --------------------------------------------------------------- Simulation

function resim(M) {
  // A hovered cache line or register belongs to the old run.
  if (hoverState && hoverState.M === M && hoverState.kind !== 'vehicle') {
    hoverState = null;
    els.tooltip.hidden = true;
  }
  M.trace = simulate(state.workload, M.cfg);
  M.stats = computeStats(M.trace);
  M.episodes = findEpisodes(M.trace);
  M.version++;
  M.lastStatusC = null;
  M.view.setMachine(M);
}

function regenerate() {
  state.workload = generateWorkload(state.wl);
  for (const M of state.machines) resim(M);
  // A new timetable is different work, so any followed instruction is gone.
  state.sel = null;
  hoverState = null;
  els.tooltip.hidden = true;
  applySelection();
  refreshAll();
}

let regenTimer = 0;
function scheduleRegenerate() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenerate, 50);
}

let reportTimer = 0;
function scheduleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    renderReport(els.report, app);
    inspector.update(true);
  }, 200);
}

function timelineMax() {
  let m = 1;
  for (const M of state.machines) m = Math.max(m, state.sync === 'cycle' ? M.trace.cycles : M.trace.cycles / M.cfg.ghz);
  return m;
}

function clampT(t) {
  return Math.max(0, Math.min(state.tMax, t));
}

function refreshAll() {
  state.tMax = timelineMax();
  state.t = clampT(state.t);
  planner.update();
  for (const M of state.machines) updateCard(M, app);
  for (const M of state.machines) M.el.root.classList.toggle('is-focus', M.uid === state.focus && state.machines.length > 1);
  renderAddBar();
  renderReport(els.report, app);
  scrubber.setData(state.machines, state.tMax, state.sync);
  inspector.update(true);
  state.dirty = true;
}

function applySelection() {
  const sel = state.sel;
  let ops = null;
  if (sel) {
    const M = app.machineByUid(sel.uid);
    ops = M ? M.trace.instrs[sel.id].ops : null;
  }
  for (const M of state.machines) {
    M.view.selected = sel && sel.uid === M.uid ? sel.id : -1;
    M.view.journey = null;
    if (ops && sel.uid !== M.uid) {
      const linked = new Set();
      for (const o of ops) linked.add(M.trace.map[o]);
      M.view.linked = linked;
    } else M.view.linked = null;
  }
}

function renderAddBar() {
  const bar = els.fleetAdd;
  bar.textContent = '';
  const full = state.machines.length >= MAX_MACHINES;
  const btn = h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', disabled: full },
    svg('<svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'),
    full ? `Up to ${MAX_MACHINES} networks at once` : 'Add a network',
  );
  btn.addEventListener('click', () =>
    showMenu(btn, 'Add from the fleet', FLEET.map((f) => ({ label: f.name, note: f.tagline, run: () => {
      const M = app.addMachine(f.cfg, f.name);
      if (M) requestAnimationFrame(() => M.el.root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' }));
    } }))),
  );
  bar.append(btn);
}

// ----------------------------------------------------------------- Playback

function unitsPerCycle() {
  if (state.sync === 'cycle') return 1;
  return 1 / Math.max(...state.machines.map((M) => M.cfg.ghz));
}

function setPlaying(on) {
  if (on && state.t >= state.tMax - 1e-9) state.t = 0;
  if (on !== state.playing) sound.play(on);
  state.playing = on;
  els.play.classList.toggle('is-playing', on);
  els.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  state.dirty = true;
}

function step(dir, n = 1) {
  setPlaying(false);
  const u = unitsPerCycle();
  const from = state.stepTo != null ? state.stepTo : state.t;
  // Snap to the grid of whole steps (cycles, or the fastest network's cycles
  // in time mode) so repeated steps land exactly on cycle boundaries.
  const k = from / u;
  const snapped = (dir > 0 ? Math.floor(k + 1e-6) : Math.ceil(k - 1e-6)) * u;
  state.stepTo = clampT(snapped + dir * n * u);
  if (reduceMotion) {
    state.t = state.stepTo;
    state.stepTo = null;
  }
  state.dirty = true;
}

function nextStall() {
  setPlaying(false);
  state.stepTo = null;
  // The focused network's next stall; if it has none left, the earliest
  // upcoming stall on any network.
  const find = (M) => {
    const c = app.localCycle(M);
    const ep = M.episodes.find((e) => e.start > c + 0.01);
    return ep ? { M, ep, g: app.toGlobal(M, ep.start) } : null;
  };
  const F = app.machineByUid(state.focus);
  let best = F ? find(F) : null;
  if (!best) {
    for (const M of state.machines) {
      const r = find(M);
      if (r && (!best || r.g < best.g)) best = r;
    }
  }
  if (!best) {
    flashStatus('No stalls ahead on this network.');
    return;
  }
  state.t = clampT(best.g);
  app.setFocus(best.M.uid);
  const len = best.ep.end - best.ep.start;
  best.M.stallNote = `Stall: nothing departs for ${len} ${len === 1 ? 'cycle' : 'cycles'} (${CODE_INFO[best.ep.code].label.toLowerCase()}).`;
  best.M.lastStatusC = null;
  sound.stall(best.ep.code === C.BRANCH ? 'branch' : 'mem');
  state.dirty = true;
  best.M.el.root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
}

function flashStatus(text) {
  const M = app.machineByUid(state.focus) || state.machines[0];
  M.stallNote = text;
  M.lastStatusC = null;
  state.dirty = true;
}

// ------------------------------------------------------------------ Drawing

const TONE_LABEL = { good: 'Good service', minor: 'Minor delays', severe: 'Severe delays', done: 'Complete' };

function updateStatus(M, lc) {
  const tr = M.trace;
  const c = cycleAt(lc);
  const key = `${c}:${M.version}`;
  if (M.lastStatusC === key) return;
  M.lastStatusC = key;
  const st = cycleStatus(tr, Math.max(0, c));
  M.el.pill.dataset.tone = st.tone;
  M.el.pill.textContent = TONE_LABEL[st.tone];
  M.el.text.textContent = M.stallNote ? `${M.stallNote} ${st.text}` : st.text;
  M.stallNote = null;
  if (c >= tr.cycles) M.el.clock.textContent = `${fmtInt(tr.cycles)} cycles · ${fmtTime(tr.cycles / M.cfg.ghz)}`;
  else M.el.clock.textContent = `cycle ${fmtInt(Math.max(0, c))} · ${fmtTime(Math.max(0, c) / M.cfg.ghz)}`;
}

function drawAll() {
  // Continuous motion while playing at speed; eased hops when stepping or slow.
  const linear = state.playing && state.speed >= 5;
  for (const M of state.machines) {
    const lc = app.localCycle(M);
    M.view.draw(lc, { linear });
    updateStatus(M, lc);
  }
  scrubber.draw(state.t, state.focus);
  if (state.sync === 'cycle') {
    els.unit.textContent = 'Cycle';
    els.num.textContent = fmtInt(cycleAt(state.t));
    els.sub.textContent = `of ${fmtInt(state.tMax)}`;
  } else {
    els.unit.textContent = 'Time';
    els.num.textContent = fmtTime(state.t);
    els.sub.textContent = `of ${fmtTime(state.tMax)}`;
  }
  inspector.update();
  if (hoverState) showTooltip(hoverState);
}

// Sound follows time only while it runs forward by itself: playing, or
// stepping ahead. Scrubs and jumps resync quietly.
function listen(moving) {
  const n = state.machines.length;
  const perSec = state.playing ? state.speed * unitsPerCycle() : 1 / 0.26;
  state.machines.forEach((M, i) => {
    sound.follow(M, app.localCycle(M), {
      moving,
      focus: n === 1 || M.uid === state.focus,
      pan: n === 1 ? 0 : -0.45 + (0.9 * i) / (n - 1),
      rate: state.sync === 'cycle' ? perSec : perSec * M.cfg.ghz,
      crowd: n,
    });
  });
}

function setSound(on) {
  sound.setOn(on);
  showSound(on);
}

function showSound(on) {
  els.sound.setAttribute('aria-pressed', String(on));
  els.sound.setAttribute('aria-label', on ? 'Mute sound' : 'Turn sound on');
  els.sound.title = on ? 'Mute sound (M)' : 'Turn sound on (M)';
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // Decided before this frame's move, so the last step of a hop (or the
  // final cycle of a run) is still heard.
  const moving = state.playing || (state.stepTo != null && state.stepTo > state.t);
  if (state.playing) {
    state.t = Math.min(state.tMax, state.t + dt * state.speed * unitsPerCycle());
    if (state.t >= state.tMax) setPlaying(false);
    state.dirty = true;
  } else if (state.stepTo != null) {
    const u = unitsPerCycle();
    const d = state.stepTo - state.t;
    const rate = (u / 0.26) * Math.max(1, Math.abs(d) / u / 2);
    const mv = Math.sign(d) * Math.min(Math.abs(d), dt * rate);
    state.t += mv;
    if (Math.abs(state.stepTo - state.t) < 1e-7) {
      state.t = state.stepTo;
      state.stepTo = null;
    }
    state.dirty = true;
  }
  if (state.dirty) {
    state.dirty = false;
    drawAll();
  }
  listen(moving);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------ Canvas input

let hoverState = null;

function canvasPoint(M, e) {
  const r = M.el.canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / M.view.scale, y: (e.clientY - r.top) / M.view.scale };
}

let tooltipKey = '';
function showTooltip(hs) {
  const { M, x, y } = hs;
  const tr = M.trace;
  const lc = app.localCycle(M);
  const c = Math.max(0, cycleAt(lc));
  const key = `${M.uid}:${M.version}:${hs.kind}:${hs.id ?? hs.reg ?? hs.line?.line}:${c}:${x}:${y}`;
  if (key === tooltipKey && !els.tooltip.hidden) return;
  tooltipKey = key;
  let parts = null;
  if (hs.kind === 'vehicle') {
    const id = hs.id;
    if (id < 0 || id >= tr.N) {
      els.tooltip.hidden = true;
      tooltipKey = '';
      return;
    }
    let what;
    if (c < tr.fetchC[id]) what = `Next up. Enters at cycle ${fmtInt(tr.fetchC[id])}.`;
    else if (c >= tr.retireC[id]) what = `Exited at cycle ${fmtInt(tr.retireC[id])}.`;
    else if (c < tr.dispC[id]) what = 'In the entrance.';
    else what = `It ${stateClause(tr, id, c)}.`;
    parts = [`#${tr.instrs[id].num} ${instrText(tr, id)}`, what, 'Click to follow its journey.'];
  } else if (hs.kind === 'reg') parts = regTooltip(tr, hs.reg, c);
  else parts = lineTooltip(tr, hs.line, lc);
  els.tooltip.innerHTML = '';
  els.tooltip.append(h('b', null, parts[0]), ...parts.slice(1).map((t) => h('span', { class: 'tt-sub' }, t)));
  els.tooltip.hidden = false;
  const tw = els.tooltip.offsetWidth;
  const th = els.tooltip.offsetHeight;
  let left = x + 14;
  let top = y + 16;
  if (left + tw > window.innerWidth - 8) left = x - tw - 14;
  if (top + th > window.innerHeight - 90) top = y - th - 12;
  els.tooltip.style.left = left + 'px';
  els.tooltip.style.top = top + 'px';
}

const plural = (n, one, many) => (n === 1 ? one : many ?? one + 's');

function regTooltip(tr, r, c) {
  const name = regName(r);
  const { latest, aboard } = regVersions(tr, r, c);
  if (latest < 0) return [name, 'No instruction in this program has written it yet.'];
  const ins = tr.instrs[latest];
  const dn = tr.doneC[latest];
  const ready = dn >= 0 && dn <= c;
  const out = [name, `Holds the result of #${ins.num} (${OPS[ins.op].short}), ${ready ? `ready since cycle ${fmtInt(dn)}` : dn >= 0 ? `still on its way: ready at cycle ${fmtInt(dn)}` : 'which has not departed yet'}.`];
  const older = aboard.filter((w) => w !== latest);
  if (tr.RENAME && older.length) out.push(`Renaming still holds ${older.length} older ${plural(older.length, 'value')} of ${name} in spare registers (from ${older.slice(-3).map((w) => '#' + tr.instrs[w].num).join(', ')}${older.length > 3 ? ', …' : ''}); each is freed when the value after it exits.`);
  if (!tr.RENAME) out.push(`No renaming: ${name} holds one value at a time, so a new writer waits until older ones are done with it.`);
  out.push(`Click to inspect #${ins.num}.`);
  return out;
}

function lineTooltip(tr, m, T) {
  if (m.members) return groupTooltip(tr, m, T);
  const where = lineWhere(m, T);
  let span = null;
  for (const iv of m.l1) if (T >= iv[0] && T < iv[1]) span = iv;
  const whereText = {
    l1: span && span[0] > -Infinity ? `In L1 since cycle ${fmtInt(Math.max(0, Math.ceil(span[2])))}.` : 'In L1, left there by earlier runs of this code.',
    arriving: span ? `On its way into L1: it arrives at cycle ${fmtInt(span[2])}.` : 'On its way into L1.',
    l2: 'In L2, but not in L1.',
    mem: tr.HAS_L2 ? 'Only in main memory: in neither cache.' : 'Only in main memory.',
  }[where];
  const past = m.acc.filter((x) => x.t <= T);
  let used = 0;
  const n = [0, 0, 0, 0];
  for (const x of past) {
    used |= x.e.mask;
    n[x.e.cls]++;
  }
  let words = 0;
  for (let w = 0; w < 8; w++) if (used & (1 << w)) words++;
  const out = [`Line ${hex(m.line * 64)} · ${m.region.name}`, whereText];
  if (past.length) {
    const kindText = ['reused', 'neighbor', 'missed (first use)', 'missed (pushed out earlier)'];
    const kinds = [LOC.REUSE, LOC.NEAR, LOC.COLD, LOC.EVICTED].filter((k) => n[k]).map((k) => `${n[k]} ${kindText[k]}`);
    out.push(`${past.length} ${plural(past.length, 'access', 'accesses')} so far (${kinds.join(', ')}), using ${words} of its 8 words.`);
    out.push('Click to inspect the latest one.');
  } else {
    const next = m.acc[0];
    out.push(next ? `First used at cycle ${fmtInt(next.t)}. Click to inspect that access.` : 'Not used yet.');
  }
  return out;
}

// A yard car carrying several lines, on timetables too big for one per line.
function groupTooltip(tr, g, T) {
  const n = g.members.length;
  const at = { l1: 0, arriving: 0, l2: 0, mem: 0 };
  let used = 0;
  for (const m of g.members) {
    at[lineWhere(m, T)]++;
    if (m.acc.length && m.acc[0].t <= T) used++;
  }
  const whereText = [
    at.l1 && `${at.l1} in L1`,
    at.arriving && `${at.arriving} on the way into L1`,
    at.l2 && `${at.l2} in L2 only`,
    at.mem && `${at.mem} only in main memory`,
  ].filter(Boolean).join(', ');
  const past = g.acc.filter((x) => x.t <= T);
  const out = [
    `Lines ${hex(g.line * 64)}–${hex(g.last * 64)} · ${g.region.name}`,
    `This timetable touches too many lines to show one per car, so this car carries ${n} neighboring lines, ${n > 8 ? `up to ${Math.ceil(n / 8)} per seat` : 'one per seat'}. ${whereText[0].toUpperCase()}${whereText.slice(1)}.`,
  ];
  if (past.length) {
    out.push(`${past.length} ${plural(past.length, 'access', 'accesses')} so far, to ${used} of its ${n} lines.`);
    out.push('Click to inspect the latest one.');
  } else {
    out.push(`First used at cycle ${fmtInt(g.acc[0].t)}. Click to inspect that access.`);
  }
  return out;
}

function wireCanvas(M) {
  const cv = M.el.canvas;
  const setHover = (id, line, reg) => {
    if (id !== M.view.hover || line !== M.view.hoverLine || reg !== M.view.hoverReg) {
      M.view.hover = id;
      M.view.hoverLine = line;
      M.view.hoverReg = reg;
      state.dirty = true;
    }
  };
  cv.addEventListener('pointermove', (e) => {
    const p = canvasPoint(M, e);
    const id = M.view.hit(p.x, p.y);
    const line = id < 0 ? M.view.hitLine(p.x, p.y) : null;
    const reg = id < 0 && !line ? M.view.hitReg(p.x, p.y) : -1;
    setHover(id, line, reg);
    cv.classList.toggle('is-pointing', id >= 0 || !!line || reg >= 0);
    if (id >= 0) hoverState = { M, kind: 'vehicle', id, x: e.clientX, y: e.clientY };
    else if (line) hoverState = { M, kind: 'line', line, x: e.clientX, y: e.clientY };
    else if (reg >= 0) hoverState = { M, kind: 'reg', reg, x: e.clientX, y: e.clientY };
    else hoverState = null;
    if (hoverState) showTooltip(hoverState);
    else els.tooltip.hidden = true;
  });
  cv.addEventListener('pointerleave', () => {
    setHover(-1, null, -1);
    hoverState = null;
    els.tooltip.hidden = true;
  });
  cv.addEventListener('click', (e) => {
    const p = canvasPoint(M, e);
    const id = M.view.hit(p.x, p.y);
    if (id >= 0) return app.select(M.uid, id);
    const line = M.view.hitLine(p.x, p.y);
    if (line) {
      // The latest access to this line so far, or else the first one.
      const T = app.localCycle(M);
      const past = line.acc.filter((x) => x.t <= T);
      const pick = past.length ? past[past.length - 1] : line.acc[0];
      return app.select(pick ? M.uid : null, pick ? pick.e.id : -1);
    }
    const reg = M.view.hitReg(p.x, p.y);
    if (reg >= 0) {
      const { latest } = regVersions(M.trace, reg, Math.max(0, cycleAt(app.localCycle(M))));
      if (latest >= 0) return app.select(M.uid, latest);
    }
    app.select(null);
  });
}

function sizeViews() {
  for (const M of state.machines) {
    if (!M.wired) {
      wireCanvas(M);
      M.wired = true;
    }
    const w = Math.max(600, M.el.stage.clientWidth);
    M.view.resize(w);
  }
  state.dirty = true;
}

// --------------------------------------------------------------------- Boot

readPalette();
const sound = new Sound();
const planner = new Planner($('planner'), app);
const inspector = new Inspector($('inspector'), app);
const scrubber = new Scrubber($('tp-canvas'), (t) => {
  setPlaying(false);
  state.stepTo = null;
  state.t = clampT(t);
  state.dirty = true;
});
renderLegend($('legend'));
renderGuide($('guide-body'));

state.workload = generateWorkload(state.wl);
app.addMachine(FLEET[0].cfg, FLEET[0].name);
app.addMachine(FLEET[1].cfg, FLEET[1].name);
state.focus = state.machines[0].uid;

els.play.addEventListener('click', () => setPlaying(!state.playing));
$('tp-back').addEventListener('click', () => step(-1));
$('tp-fwd').addEventListener('click', () => step(1));
$('tp-restart').addEventListener('click', () => {
  setPlaying(false);
  state.stepTo = null;
  state.t = 0;
  state.dirty = true;
});
$('tp-stall').addEventListener('click', nextStall);
showSound(sound.on);
els.sound.addEventListener('click', () => setSound(!sound.on));
els.speed.value = String(state.speed);
els.speed.classList.add('select');
els.speed.addEventListener('change', () => {
  state.speed = +els.speed.value;
});
for (const b of els.sync.children) {
  b.addEventListener('click', () => {
    if (state.sync === b.dataset.v) return;
    // Keep the playhead on the same moment when switching units.
    const M = app.machineByUid(state.focus) || state.machines[0];
    const lc = app.localCycle(M);
    state.stepTo = null;
    state.sync = b.dataset.v;
    for (const x of els.sync.children) x.setAttribute('aria-checked', String(x === b));
    state.tMax = timelineMax();
    state.t = clampT(app.toGlobal(M, lc));
    for (const X of state.machines) X.lastStatusC = null;
    refreshAll();
  });
}
$('guide-open').addEventListener('click', () => openGuide(true));
$('guide-close').addEventListener('click', () => openGuide(false));
els.guide.addEventListener('click', (e) => {
  if (e.target === els.guide) openGuide(false);
});

function openGuide(on) {
  els.guide.hidden = !on;
  if (on) $('guide-close').focus();
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
  if (e.key === 'Escape') {
    closeMenu();
    if (!els.guide.hidden) openGuide(false);
    else if (state.sel) app.select(null);
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' && tag !== 'button') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.key === 'ArrowRight' && tag !== 'button') {
    e.preventDefault();
    step(1, e.shiftKey ? 10 : 1);
  } else if (e.key === 'ArrowLeft' && tag !== 'button') {
    e.preventDefault();
    step(-1, e.shiftKey ? 10 : 1);
  } else if (e.key === 'n' || e.key === 'N') {
    nextStall();
  } else if (e.key === 'm' || e.key === 'M') {
    setSound(!sound.on);
  } else if (e.key === 'Home') {
    state.t = 0;
    state.stepTo = null;
    setPlaying(false);
  } else if (e.key === ']' || e.key === '[') {
    const opts = [...els.speed.options].map((o) => +o.value);
    const i = opts.indexOf(state.speed);
    state.speed = opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === ']' ? 1 : -1)))];
    els.speed.value = String(state.speed);
  }
});

const ro = new ResizeObserver(() => {
  sizeViews();
  scrubber.resize();
  scrubber.cache = null;
  state.dirty = true;
});
ro.observe(els.fleet);
ro.observe($('tp-scrub'));

document.fonts?.ready.then(() => {
  readPalette();
  for (const M of state.machines) M.view.invalidate();
  scrubber.cache = null;
  planner.update();
  state.dirty = true;
});

// Debug handle for the console.
window.siliconTransit = {
  app,
  state,
  pause: () => setPlaying(false),
  play: () => setPlaying(true),
  seek: (t) => {
    state.t = clampT(t);
    state.stepTo = null;
    drawAll();
  },
  draw: () => drawAll(),
};

sizeViews();
refreshAll();
// Open in motion: a few cycles in, playing, unless the viewer prefers stillness.
state.t = 24;
setPlaying(!reduceMotion);
requestAnimationFrame(frame);
