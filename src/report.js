// The joint service report: how every network ran the same timetable,
// presented as operations statistics rather than a dashboard.

import { h, clear } from './dom.js';
import { C, CODE_INFO, SLOT_CODES, LOC, LOC_INFO } from './isa.js';
import { PRESETS } from './workload.js';
import { fmtInt, fmtTime, fmtX, pct, verdict, compareNarrative, limitSentence, bottleneck, FLOOR_INFO } from './analysis.js';

const codeVar = (code) => `var(--st-${CODE_INFO[code].key})`;

export function renderReport(root, app) {
  const { machines, wl, workload } = app.state;
  if (!machines.length) return;
  const base = app.baseline();
  clear(root);
  const preset = PRESETS.find((p) => p.id === wl.preset);

  root.append(
    h('header', { class: 'report-head' },
      h('div', null,
        h('p', { class: 'eyebrow' }, `Service report · No. ${String(wl.seed).padStart(5, '0')}`),
        h('h2', { class: 'section-title' }, 'How each network ran the timetable'),
      ),
      h('div', { class: 'report-meta' },
        h('span', null, 'Timetable ', h('b', null, preset ? preset.name : 'Custom')),
        h('span', null, h('b', null, fmtInt(workload.ops.length)), ' operations'),
        h('span', null, 'Caches ', h('b', null, wl.warm ? 'warm' : 'cold')),
        h('span', null, 'Seed ', h('b', null, String(wl.seed))),
      ),
    ),
  );

  // Journey times.
  const maxNs = Math.max(...machines.map((M) => M.stats.ns));
  const fastest = machines.reduce((a, M) => (M.stats.ns < a.stats.ns ? M : a), machines[0]);
  const times = h('div', { class: 'times' });
  for (const M of machines) {
    const s = M.stats;
    const v = verdict(s);
    let rel;
    if (M === base) rel = h('span', { class: 'badge', 'data-tone': 'base' }, 'Baseline');
    else {
      const r = base.stats.ns / s.ns;
      rel = Math.abs(r - 1) < 0.02
        ? h('span', { class: 'badge', 'data-tone': 'base' }, `Same as ${base.letter}`)
        : h('span', { class: 'badge', 'data-tone': r > 1 ? 'good' : 'severe' }, r > 1 ? `${fmtX(r)} faster than ${base.letter}` : `${fmtX(1 / r)} slower than ${base.letter}`);
    }
    times.append(
      h('div', { class: 'time-row', vars: { '--line': M.color } },
        h('div', { class: 'time-who' },
          h('span', { class: 'bullet' }, M.letter),
          h('div', { style: 'min-width:0' }, h('strong', null, M.name), h('span', null, `${M.cfg.ooo ? 'Dynamic' : 'Fixed order'} · ${M.cfg.width}-wide · ${M.cfg.ghz.toFixed(1)} GHz`)),
        ),
        h('div', { class: 'time-bar', role: 'img', 'aria-label': `${fmtTime(s.ns)}` }, h('i', { style: `width:${Math.max(2, (s.ns / maxNs) * 100)}%` })),
        h('div', { class: 'time-fig' },
          h('strong', null, fmtTime(s.ns)),
          h('span', null, `${fmtInt(s.cycles)} cycles `),
          h('div', { style: 'display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px' }, rel, h('span', { class: 'badge', 'data-tone': v.tone }, v.label), M === fastest && machines.length > 1 ? h('span', { class: 'badge' }, 'Fastest') : null),
        ),
      ),
    );
  }
  root.append(h('section', null, h('h3', null, 'Journey times'), times, h('p', { class: 'field-hint', style: 'margin:8px 0 0' }, 'Time is cycles divided by each network’s clock. Main memory is timed in nanoseconds, so faster clocks wait more cycles for it.')));

  const grid = h('div', { class: 'report-grid' });
  grid.append(statsTable(machines), capacity(machines));
  root.append(grid);
  const grid2 = h('div', { class: 'report-grid' });
  grid2.append(locality(machines, workload), limits(machines));
  root.append(grid2);
  const grid3 = h('div', { class: 'report-grid report-grid-one' });
  grid3.append(why(machines, base, app));
  root.append(grid3);
}

// How loads found their lines in L1, next to the locality the timetable
// itself offers.
function locality(machines, workload) {
  const rows = h('div', { class: 'cap-rows' });
  const P = workload.summary.locality;
  const pn = P.reuse + P.near + P.fresh;
  const seg = (frac, color, title) => (frac > 0.001 ? h('span', { style: `flex:${frac} 1 0;background:${color}`, title: `${title}: ${pct(frac, 1)}` }, frac >= 0.1 ? h('b', null, pct(frac)) : null) : null);
  if (pn) {
    rows.append(
      h('div', { class: 'cap-row' },
        h('span', { class: 'loc-tag', title: 'The timetable itself, before any cache' }, 'T'),
        h('div', { class: 'stack stack-thin', role: 'img', 'aria-label': `Timetable: ${pct(P.reuse / pn)} reuse a word, ${pct(P.near / pn)} a line used before, ${pct(P.fresh / pn)} touch a new line` },
          seg(P.reuse / pn, 'var(--loc-reuse)', 'Reuses a word used before'),
          seg(P.near / pn, 'var(--loc-near)', 'Lands on a line used before'),
          seg(P.fresh / pn, 'var(--rule-2)', 'Touches a new line'),
        ),
      ),
    );
  }
  const notes = [];
  for (const M of machines) {
    const s = M.stats;
    if (!s.locLoads) continue;
    const stack = h('div', { class: 'stack', role: 'img', 'aria-label': [LOC.REUSE, LOC.NEAR, LOC.COLD, LOC.EVICTED].map((k) => `${LOC_INFO[k].label} ${pct(s.loc[k])}`).join(', ') },
      [LOC.REUSE, LOC.NEAR, LOC.COLD, LOC.EVICTED].map((k) => seg(s.loc[k], `var(--loc-${LOC_INFO[k].key})`, LOC_INFO[k].long)),
    );
    rows.append(h('div', { class: 'cap-row' }, h('span', { class: 'bullet bullet-sm', style: `--line:${M.color}` }, M.letter), stack));
    const ev = s.locN[LOC.EVICTED];
    const hits = s.loc[LOC.REUSE] + s.loc[LOC.NEAR];
    notes.push(h('li', null, h('b', null, `${M.name}: `),
      `${pct(hits)} of its load lookups found their line in L1 (${pct(s.loc[LOC.REUSE])} reusing data, ${pct(s.loc[LOC.NEAR])} on a line a neighbor brought in).`,
      ev ? ` ${ev} ${ev === 1 ? 'miss was' : 'misses were'} on lines L1 had pushed out for room: capacity misses, which only a bigger L1 can avoid.` : ' No load missed on a line L1 had pushed out.'));
  }
  if (!rows.children.length) return h('section', null, h('h3', null, 'Where loads found their data'), h('p', { class: 'field-hint' }, 'This timetable has no loads.'));
  const legend = h('div', { class: 'cap-legend' },
    [LOC.REUSE, LOC.NEAR, LOC.COLD, LOC.EVICTED].map((k) => h('span', null, h('i', { style: `background:var(--loc-${LOC_INFO[k].key})` }), LOC_INFO[k].long)),
    h('span', null, h('i', { style: 'background:var(--rule-2)' }), 'Line new to this run (T only)'),
  );
  return h('section', null,
    h('h3', null, 'Where loads found their data'),
    h('p', { class: 'field-hint', style: 'margin:-4px 0 10px' }, 'Each load looks in L1 first, one 64-byte line at a time. T is the timetable on its own: how often an access reuses a word, or lands on a line, used earlier in this run. The lettered rows show how each network’s L1 served its loads. With warm caches, earlier runs have touched most lines, so a line new to this run can still miss as one L1 pushed out.'),
    rows,
    legend,
    h('ul', { class: 'loc-notes' }, notes),
  );
}

function statsTable(machines) {
  const rows = [
    ['Cycles', 'start to last exit', (s) => s.cycles, fmtInt, 'low'],
    ['Estimated time', 'cycles ÷ clock', (s) => s.ns, fmtTime, 'low'],
    ['Vehicles', 'instructions after SIMD packing', (s) => s.N, fmtInt, 'low'],
    ['Vehicles per cycle', 'IPC', (s) => s.ipc, (v) => v.toFixed(2), 'high'],
    ['Operations per cycle', 'work completed per cycle', (s) => s.opc, (v) => v.toFixed(2), 'high'],
    ['ALU occupancy', null, (s) => s.util.alu, (v) => pct(v), null],
    ['FPU occupancy', null, (s) => s.util.fpu, (v) => pct(v), null],
    ['Load/store occupancy', null, (s) => s.util.lsu, (v) => pct(v), null],
    ['L1 hit rate', 'incl. rides on a pending delivery', (s) => s.l1Rate, (v) => (v == null ? '—' : pct(v, 1)), 'high'],
    ['L2 hit rate', null, (s) => s.l2Rate, (v) => (v == null ? '—' : pct(v, 1)), 'high'],
    ['Trips to main memory', null, (s) => s.trips, fmtInt, 'low'],
    ['Average load time', 'cycles', (s) => s.avgLoad, (v) => (v == null ? '—' : v.toFixed(1)), 'low'],
    ['Most loads out at once', 'memory-level parallelism', (s) => s.mlpPeak, fmtInt, null],
    ['Waiting for a register name', 'instruction-cycles, without renaming', (s) => s.nameWait, fmtInt, 'low'],
    ['Rename registers in use', 'most at once', (s, M) => (M.cfg.renameRegs ? s.writersPeak : null), (v) => (v == null ? '—' : fmtInt(v)), null],
    ['Wrong-route branches', null, (s) => s.mispredicts, fmtInt, null],
    ['SIMD lanes filled', 'of all lane capacity used', (s) => s.laneUtil, (v) => (v == null ? '—' : pct(v)), 'high'],
    ['Average aboard', 'instructions in the window', (s) => s.robAvg, (v) => v.toFixed(1), null],
  ];
  const table = h('table', { class: 'stats' });
  table.append(
    h('thead', null,
      h('tr', null, h('th', { scope: 'col' }, 'Operating statistics'), machines.map((M) => h('th', { scope: 'col' }, h('span', { class: 'bullet bullet-sm', style: `--line:${M.color};display:inline-grid` }, M.letter)))),
    ),
  );
  const body = h('tbody');
  for (const [label, sub, get, fmt, better] of rows) {
    const vals = machines.map((M) => get(M.stats, M));
    const nums = vals.filter((v) => v != null);
    if (!nums.length) continue;
    const max = Math.max(...nums);
    let best = null;
    if (better && machines.length > 1 && new Set(nums.map((v) => v.toFixed(4))).size > 1) best = better === 'low' ? Math.min(...nums) : Math.max(...nums);
    body.append(
      h('tr', null,
        h('th', { scope: 'row' }, label, sub ? h('small', null, sub) : null),
        machines.map((M, k) => {
          const v = vals[k];
          const w = v == null || !max ? 0 : Math.max(2, (v / max) * 100);
          return h('td', { class: v != null && v === best ? 'best' : '', style: `--line:${M.color}` }, fmt(v), h('span', { class: 'cell-bar', style: `width:${w}%;max-width:64px` }));
        }),
      ),
    );
  }
  table.append(body);
  return h('section', null, h('h3', null, 'Operating statistics'), h('div', { class: 'table-wrap' }, table));
}

function capacity(machines) {
  const rows = h('div', { class: 'cap-rows' });
  for (const M of machines) {
    const s = M.stats;
    const stack = h('div', { class: 'stack', role: 'img', 'aria-label': s.slots.filter((x) => x.frac > 0.005).map((x) => `${CODE_INFO[x.code].label} ${pct(x.frac)}`).join(', ') });
    for (const x of s.slots) {
      if (x.frac <= 0.001) continue;
      stack.append(h('span', { style: `flex:${x.frac} 1 0;background:${codeVar(x.code)}`, title: `${CODE_INFO[x.code].label}: ${pct(x.frac, 1)}` }, x.frac >= 0.09 ? h('b', null, pct(x.frac)) : null));
    }
    rows.append(h('div', { class: 'cap-row' }, h('span', { class: 'bullet bullet-sm', style: `--line:${M.color}` }, M.letter), stack));
  }
  const legend = h('div', { class: 'cap-legend' },
    SLOT_CODES.map((code) => h('span', null, h('i', { style: `background:${codeVar(code)}` }), CODE_INFO[code].label)),
  );
  return h('section', null,
    h('h3', null, 'Where the capacity went'),
    h('p', { class: 'field-hint', style: 'margin:-4px 0 10px' }, 'Every cycle a network offers one departure slot per unit of width. Each slot either carried an instruction or was lost for a reason.'),
    rows,
    legend,
  );
}

function limits(machines) {
  const box = h('div', { class: 'limits' });
  for (const M of machines) {
    const s = M.stats;
    const f = s.floors;
    const bn = bottleneck(s);
    const scale = Math.max(s.cycles, ...Object.values(f));
    const rows = Object.keys(FLOOR_INFO).map((key) =>
      h('div', { class: 'floor-row' + (key === bn.key ? ' is-binding' : '') },
        h('span', null, FLOOR_INFO[key].label),
        h('span', { class: 'track' }, h('i', { style: `width:${Math.max(0.5, (f[key] / scale) * 100)}%` }), h('b', { class: 'actual', style: `left:${(s.cycles / scale) * 100}%`, title: `This run: ${fmtInt(s.cycles)} cycles` })),
        h('span', null, fmtInt(f[key])),
      ),
    );
    box.append(
      h('div', { class: 'limit' },
        h('div', { class: 'limit-head' }, h('span', { class: 'bullet bullet-sm', style: `--line:${M.color}` }, M.letter), M.name),
        rows,
        h('p', null, limitSentence(M.name, s)),
      ),
    );
  }
  return h('section', null,
    h('h3', null, 'What limits each network'),
    h('p', { class: 'field-hint', style: 'margin:-4px 0 10px' }, 'Each bar is the fewest cycles one constraint alone would allow. The red mark is the actual run. The closer a bar reaches the mark, the more that constraint set the pace.'),
    box,
  );
}

function why(machines, base, app) {
  const box = h('div', { class: 'why' });
  if (machines.length < 2) {
    box.append(h('p', { class: 'why-empty' }, 'Add a second network to compare. Use “Try one change” on a network to clone it with a single difference.'));
  } else {
    const pick = h('div', { class: 'seg seg-sm', role: 'radiogroup', 'aria-label': 'Compare against' },
      machines.map((M) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(M === base), onclick: () => app.setBaseline(M.uid) }, `vs ${M.letter}`)),
    );
    box.append(h('div', { class: 'field-row' }, h('span', { class: 'field-hint' }, 'Explanations are generated from both simulations.'), pick));
    const A = { name: base.name, cfg: base.cfg, trace: base.trace, stats: base.stats };
    for (const M of machines) {
      if (M === base) continue;
      const n = compareNarrative(A, { name: M.name, cfg: M.cfg, trace: M.trace, stats: M.stats });
      box.append(
        h('article', { class: 'why-card' },
          h('header', null, h('span', { class: 'bullet bullet-sm', style: `--line:${M.color}` }, M.letter), h('h4', null, n.headline)),
          n.diff.length
            ? h('div', { class: 'chips', style: 'margin-top:8px' }, n.diff.slice(0, 8).map((d) => h('span', { class: 'chip chip-diff' }, `${d.label}: ${d.from} → ${d.to}`)), n.diff.length > 8 ? h('span', { class: 'chip' }, `+${n.diff.length - 8} more`) : null)
            : h('p', { class: 'field-hint', style: 'margin:6px 0 0' }, 'Identical configuration.'),
          n.notes.length ? h('ul', null, n.notes.slice(0, 5).map((t) => h('li', null, t))) : null,
          h('p', { class: 'limit-line' }, n.limit),
        ),
      );
    }
  }
  return h('section', null, h('h3', null, 'Why the difference'), box);
}
