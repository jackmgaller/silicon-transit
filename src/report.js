// The joint service report: how every network ran the same timetable,
// presented as operations statistics rather than a dashboard.

import { h, clear } from './dom.js';
import { C, CODE_INFO, SLOT_CODES } from './isa.js';
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
  grid2.append(limits(machines), why(machines, base, app));
  root.append(grid2);
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
    const vals = machines.map((M) => get(M.stats));
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
