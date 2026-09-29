// The workload ("timetable") planner: presets, sliders, the service-mix bar
// and a strip preview of the generated program.

import { h, svg, clear } from './dom.js';
import { PRESETS, SITE_KINDS, formatBytes } from './workload.js';
import { PAL } from './palette.js';

const ICONS = {
  independent: '<svg viewBox="0 0 20 20"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  chain: '<svg viewBox="0 0 20 20"><path d="M4 10h12" stroke="currentColor" stroke-width="2"/><circle cx="4" cy="10" r="2.5" fill="currentColor"/><circle cx="10" cy="10" r="2.5" fill="currentColor"/><circle cx="16" cy="10" r="2.5" fill="currentColor"/></svg>',
  array: '<svg viewBox="0 0 20 20"><g fill="currentColor"><rect x="3" y="4" width="3.5" height="3.5" rx="1"/><rect x="8.25" y="4" width="3.5" height="3.5" rx="1"/><rect x="13.5" y="4" width="3.5" height="3.5" rx="1"/><rect x="3" y="12.5" width="3.5" height="3.5" rx="1"/><rect x="8.25" y="12.5" width="3.5" height="3.5" rx="1"/><rect x="13.5" y="12.5" width="3.5" height="3.5" rx="1"/></g></svg>',
  pointer: '<svg viewBox="0 0 20 20"><path d="M4 14c1-6 5-6 6 0M10 14c1-6 5-6 6 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4" cy="14" r="2" fill="currentColor"/><circle cx="10" cy="14" r="2" fill="currentColor"/><circle cx="16" cy="14" r="2" fill="currentColor"/></svg>',
  branchy: '<svg viewBox="0 0 20 20"><path d="M10 17v-6l-5-5M10 11l5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="5" cy="5" r="2" fill="currentColor"/><circle cx="15" cy="5" r="2" fill="currentColor"/></svg>',
  simd: '<svg viewBox="0 0 20 20"><g fill="currentColor"><rect x="3" y="3.5" width="14" height="2.4" rx="1.2"/><rect x="3" y="7.3" width="14" height="2.4" rx="1.2"/><rect x="3" y="11.1" width="14" height="2.4" rx="1.2"/><rect x="3" y="14.9" width="14" height="2.4" rx="1.2"/></g></svg>',
};

const MIX_KEYS = [
  ['int', 'Integer', '--op-int'],
  ['fp', 'Float', '--op-fp'],
  ['mem', 'Memory', '--op-load'],
  ['branch', 'Branch', '--op-branch'],
];

const pct = (v) => Math.round(v * 100) + '%';

// What the generated accesses actually do, in program order.
function localityLine(s) {
  const L = s.locality;
  const n = L.reuse + L.near + L.fresh;
  if (!n) return '';
  return ` Of its ${n} memory accesses, ${pct(L.reuse / n)} reuse a word and ${pct(L.near / n)} a line used before.`;
}

export class Planner {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.build();
  }

  build() {
    const app = this.app;
    const root = clear(this.root);
    this.presetBtns = new Map();
    // Three sections that stack in the sidebar and sit side by side when the
    // planner spans the page.
    const secA = h('div', { class: 'pl-sec' });
    const secB = h('div', { class: 'pl-sec' });
    const secC = h('div', { class: 'pl-sec' });
    root.append(secA, secB, secC);
    secA.append(
      h('div', { class: 'planner-head' },
        h('p', { class: 'eyebrow' }, 'Timetable'),
        h('h2', { class: 'section-title' }, 'Workload planner'),
        h('p', null, 'Generate one program. Every network below runs exactly this work.'),
      ),
    );
    const presets = h('div', { class: 'presets', role: 'group', 'aria-label': 'Service patterns' });
    for (const p of PRESETS) {
      const b = h('button', { type: 'button', class: 'preset', 'aria-pressed': 'false', title: p.blurb, onclick: () => app.applyPreset(p.id) },
        h('span', { class: 'preset-icon' }, svg(ICONS[p.id])),
        h('span', null, p.name),
      );
      this.presetBtns.set(p.id, b);
      presets.append(b);
    }
    this.blurb = h('p', { class: 'preset-blurb' });
    secA.append(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Service patterns'), presets), this.blurb);

    this.sliders = {};
    const slider = (key, label, min, max, step, fmt, line, hintFn) => {
      const input = h('input', { type: 'range', class: 'range', id: 'wl-' + key, min, max, step, vars: { '--line': `var(${line})` } });
      const val = h('span', { class: 'field-value' });
      const hint = h('span', { class: 'field-hint' });
      input.addEventListener('input', () => {
        const v = +input.value;
        this.paintRange(input);
        val.textContent = fmt(v);
        app.setWorkload(key, v);
      });
      this.sliders[key] = { input, val, fmt, hint, hintFn };
      return h('div', { class: 'field' },
        h('label', { class: 'field-row', for: 'wl-' + key }, h('span', { class: 'field-label' }, label), val),
        input,
        hint,
      );
    };
    secA.append(slider('size', 'Workload size', 40, 800, 10, (v) => `${v} operations`, '--ink', null));
    secB.append(this.buildMix());
    secB.append(slider('dependency', 'Dependency density', 0, 1, 0.01, pct, '--st-dep', (v) =>
      v < 0.15 ? 'Mostly independent work.' : v < 0.5 ? 'Some operations wait for earlier results.' : v < 0.95 ? 'Most operations wait for a recent result.' : 'One long chain: each step needs the one before.'));
    secB.append(slider('spatial', 'Spatial locality', 0, 1, 0.01, pct, '--loc-near', (v, s) =>
      `${v < 0.3 ? 'Scattered: most accesses land far from the last one.' : v < 0.7 ? 'Some accesses walk on to the next word.' : 'Mostly neighboring words, so one 64-byte line serves several accesses.'}${s.arrays ? ` ${s.inOrderArrays} of ${s.arrays} ${s.arrays === 1 ? 'array is' : 'arrays are'} read in order, the rest a line apart.` : ''}`));
    secB.append(slider('temporal', 'Temporal locality', 0, 1, 0.01, pct, '--loc-reuse', (v, s) =>
      `${v < 0.3 ? 'Little reuse: data is rarely touched again.' : v < 0.7 ? 'Some data is used again soon.' : 'Heavy reuse of a small working set.'} Heap ≈ ${formatBytes(s.heapBytes)}${s.arrays ? `, arrays ≈ ${formatBytes(s.arrayBytes)} each` : ''}.${localityLine(s)}`));
    secB.append(slider('vector', 'Vectorizability', 0, 1, 0.01, pct, '--op-fp', (v, s) =>
      v <= 0.001 ? 'No loops that SIMD lanes could pack.' : `${s.vecOps} operations sit in ${s.loops} ${s.loops === 1 ? 'loop' : 'loops'} that SIMD lanes can pack.`));
    secC.append(slider('predictability', 'Branch predictability', 0.5, 1, 0.01, pct, '--op-branch', (v, s) => branchLine(s, app.state.machines)));

    const seedInput = h('input', { type: 'number', class: 'field-input', id: 'wl-seed', min: 1, max: 999999, inputmode: 'numeric' });
    seedInput.addEventListener('change', () => app.setWorkload('seed', Math.max(1, Math.round(+seedInput.value || 1))));
    this.seedInput = seedInput;
    const shuffle = h('button', { type: 'button', class: 'btn', onclick: () => app.setWorkload('seed', 1 + Math.floor(Math.random() * 99999)) }, 'Shuffle');
    this.warmSeg = h('div', { class: 'seg seg-sm', role: 'radiogroup', 'aria-label': 'Caches and predictors at start' },
      [['warm', 'Warm'], ['cold', 'Cold']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => app.setWorkload('warm', v === 'warm') }, l)),
    );
    secC.append(
      h('div', { class: 'split' },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'wl-seed' }, 'Seed'), seedInput),
        shuffle,
      ),
      h('div', { class: 'field' },
        h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Caches and predictors'), this.warmSeg),
        h('span', { class: 'field-hint' }, 'Warm caches and predictors hold what earlier runs of this code left behind. Cold ones start empty and learn as they go.'),
      ),
    );

    this.strip = h('canvas', { 'aria-label': 'Program preview' });
    this.facts = h('p', { class: 'program-facts' });
    secC.append(h('div', { class: 'program' }, h('span', { class: 'field-label' }, 'The program, in order'), this.strip, this.facts));
  }

  buildMix() {
    const bar = h('div', { class: 'mixbar' });
    this.mixSegs = MIX_KEYS.map(([, , v]) => h('div', { class: 'seg-fill', vars: { background: `var(${v})` } }));
    bar.append(...this.mixSegs);
    this.handles = [0, 1, 2].map((k) => {
      const hd = h('button', { type: 'button', class: 'mix-handle', 'aria-label': `Boundary between ${MIX_KEYS[k][1]} and ${MIX_KEYS[k + 1][1]}` });
      hd.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        hd.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const r = bar.getBoundingClientRect();
          this.moveBoundary(k, ((ev.clientX - r.left) / r.width) * 100);
        };
        const up = () => {
          hd.removeEventListener('pointermove', move);
          hd.removeEventListener('pointerup', up);
        };
        hd.addEventListener('pointermove', move);
        hd.addEventListener('pointerup', up);
      });
      hd.addEventListener('keydown', (e) => {
        const b = this.bounds();
        if (e.key === 'ArrowLeft') this.moveBoundary(k, b[k] - 1);
        else if (e.key === 'ArrowRight') this.moveBoundary(k, b[k] + 1);
        else return;
        e.preventDefault();
      });
      bar.append(hd);
      return hd;
    });
    this.mixKeys = MIX_KEYS.map(([, label, v]) => {
      const b = h('b');
      const el = h('span', { class: 'mix-key' }, h('span', null, h('i', { vars: { background: `var(${v})` } }), label), b);
      return { el, b };
    });
    this.mixBar = bar;
    return h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Service mix'),
      bar,
      h('div', { class: 'mix-legend' }, this.mixKeys.map((k) => k.el)),
    );
  }

  mixPercents() {
    const m = this.app.state.wl.mix;
    const total = m.int + m.fp + m.mem + m.branch || 1;
    return MIX_KEYS.map(([k]) => (m[k] / total) * 100);
  }

  bounds() {
    const p = this.mixPercents();
    return [p[0], p[0] + p[1], p[0] + p[1] + p[2]];
  }

  moveBoundary(k, pos) {
    const b = this.bounds();
    const lo = k === 0 ? 0 : b[k - 1];
    const hi = k === 2 ? 100 : b[k + 1];
    b[k] = Math.round(Math.max(lo, Math.min(hi, pos)));
    const vals = [b[0], b[1] - b[0], b[2] - b[1], 100 - b[2]].map((v) => Math.max(0, Math.round(v)));
    this.app.setWorkload('mix', { int: vals[0], fp: vals[1], mem: vals[2], branch: vals[3] });
  }

  paintRange(input) {
    const f = ((+input.value - +input.min) / (+input.max - +input.min)) * 100;
    input.style.setProperty('--fill', f + '%');
  }

  update() {
    const { wl, workload } = this.app.state;
    const s = workload.summary;
    for (const [id, b] of this.presetBtns) b.setAttribute('aria-pressed', String(wl.preset === id));
    const preset = PRESETS.find((p) => p.id === wl.preset);
    this.blurb.textContent = preset ? preset.blurb : 'Custom timetable. Pick a pattern above to start from a preset.';
    for (const [key, sl] of Object.entries(this.sliders)) {
      if (document.activeElement !== sl.input) sl.input.value = wl[key];
      this.paintRange(sl.input);
      sl.val.textContent = sl.fmt(+sl.input.value);
      if (sl.hintFn) sl.hint.textContent = sl.hintFn(wl[key], s);
    }
    if (document.activeElement !== this.seedInput) this.seedInput.value = wl.seed;
    for (const b of this.warmSeg.children) b.setAttribute('aria-checked', String((b.dataset.v === 'warm') === wl.warm));
    const p = this.mixPercents();
    let acc = 0;
    p.forEach((v, k) => {
      this.mixSegs[k].style.flex = `${Math.max(0.0001, v)} 1 0`;
      this.mixKeys[k].b.textContent = Math.round(v) + '%';
      acc += v;
      if (k < 3) this.handles[k].style.left = acc + '%';
    });
    this.drawStrip();
    const c = s.counts;
    this.facts.textContent = `${s.N} operations: ${c.int} integer, ${c.fp} floating point, ${c.load} loads, ${c.store} stores, ${c.branch} branches.${s.vecOps ? ` ${s.vecOps} sit in vectorizable loops.` : ''}`;
  }

  drawStrip() {
    const cv = this.strip;
    const w = cv.clientWidth || 260;
    const hgt = 46;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hgt * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, hgt);
    const { ops, loops } = this.app.state.workload;
    // Triangles mark the branches the baseline network guesses wrong.
    const base = this.app.baseline();
    const wrong = new Set();
    if (base?.trace) for (const ins of base.trace.instrs) if (ins.mispredict) wrong.add(ins.ops[0]);
    const n = ops.length;
    const x0 = 6;
    const span = w - 12;
    const bw = span / n;
    for (const L of loops) {
      const a = x0 + L.start * bw;
      const b = x0 + (L.start + L.elems * L.slots) * bw;
      ctx.fillStyle = PAL.type.fp + '22';
      ctx.fillRect(a, 6, b - a, 28);
      ctx.fillStyle = PAL.type.fp;
      ctx.fillRect(a, 37, b - a, 2.5);
    }
    for (const o of ops) {
      const x = x0 + o.i * bw;
      ctx.fillStyle = PAL.type[o.type];
      const tall = o.type === 'load' || o.type === 'store' ? 22 : 16;
      ctx.fillRect(x, 32 - tall, Math.max(0.8, bw - (bw > 3 ? 0.8 : 0)), tall);
      if (wrong.has(o.i)) {
        ctx.fillStyle = PAL.ink;
        ctx.beginPath();
        ctx.moveTo(x + bw / 2 - 3, 3);
        ctx.lineTo(x + bw / 2 + 3, 3);
        ctx.lineTo(x + bw / 2, 8);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.fillStyle = PAL.ink3;
    ctx.font = `700 8px ${PAL.fontUi}`;
    ctx.textBaseline = 'bottom';
    ctx.fillText('first', x0, hgt - 0.5);
    ctx.textAlign = 'right';
    ctx.fillText('last', w - 6, hgt - 0.5);
    if (loops.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = PAL.type.fp;
      ctx.fillText('vectorizable loops', w / 2, hgt - 0.5);
    }
  }
}

// Where the branches come from, and how many each network guesses wrong.
function branchLine(s, machines) {
  const n = s.counts.branch;
  if (!n) return 'This timetable has no branches.';
  const kinds = Object.entries(s.siteKinds).filter(([, k]) => k).map(([kind, k]) => `${k} ${k === 1 ? SITE_KINDS[kind].label : SITE_KINDS[kind].plural}`);
  const wrong = machines.filter((M) => M.trace).map((M) => `${M.letter} ${M.trace.mispredicts.length}`);
  return `${n} branches from ${s.branchSites} ${s.branchSites === 1 ? 'place' : 'places'} in the code (${kinds.join(', ')}).${wrong.length ? ` Guessed wrong: ${wrong.join(', ')}.` : ''}`;
}
