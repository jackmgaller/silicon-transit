// Inspector: one instruction's identity, dependencies and whole journey,
// written from the trace as a route with stops.

import { h, svg, clear } from './dom.js';
import { C, CODE_INFO, TYPE_LABEL, OPS, LOC_INFO, regName } from './isa.js';
import { instrStory, describeInstr, stateClause, fmtInt, cycleAt, instrText } from './analysis.js';

const ICON_X = '<svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

const typeVar = (t) => `var(--op-${t})`;
const codeVar = (code) => `var(--st-${CODE_INFO[code].key})`;

export class Inspector {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.key = null;
    this.story = null;
  }

  update(force) {
    const app = this.app;
    const sel = app.state.sel;
    const shell = document.getElementById('shell');
    if (!sel) {
      this.root.hidden = true;
      shell.classList.remove('has-inspector');
      this.key = null;
      return;
    }
    const M = app.machineByUid(sel.uid);
    if (!M) return;
    const tr = M.trace;
    const id = sel.id;
    const key = `${M.uid}:${id}:${M.version}`;
    const c = cycleAt(app.localCycle(M));
    if (key !== this.key) {
      this.key = key;
      this.story = instrStory(tr, id);
      force = true;
    }
    if (!force && c === this.lastC) return;
    this.lastC = c;
    this.root.hidden = false;
    shell.classList.add('has-inspector');
    this.render(M, tr, id, c);
  }

  render(M, tr, id, c) {
    const app = this.app;
    const ins = tr.instrs[id];
    const story = this.story;
    const desc = describeInstr(tr, id);
    const root = clear(this.root);
    const ref = (pid, T = tr, machine = M) => {
      const pi = T.instrs[pid];
      return h('button', { type: 'button', class: 'ref', title: 'Inspect this instruction', onclick: () => app.select(machine.uid, pid) },
        h('span', { class: 'cap', vars: { '--c': typeVar(pi.type) }, style: `background:${typeVar(pi.type)}` }, ''),
        h('span', null, `#${pi.num} ${OPS[pi.op].short}${pi.vector ? '×' + pi.lanes : ''}`),
        pi.dst >= 0 ? h('small', { class: 'ref-reg' }, regName(pi.dst)) : null,
      );
    };

    const label = instrText(tr, id);
    root.append(
      h('div', { class: 'insp-head' },
        h('span', { class: 'insp-vehicle', style: `--c:${typeVar(ins.type)}` }, '#' + ins.num),
        h('div', { class: 'insp-title' },
          h('h2', null, label),
          h('p', null, `${TYPE_LABEL[ins.type]} · on network ${M.letter}, ${M.name}`),
        ),
        h('button', { class: 'btn btn-round', type: 'button', 'aria-label': 'Close inspector', onclick: () => app.select(null) }, svg(ICON_X)),
      ),
    );

    root.append(
      h('div', { class: 'insp-block' },
        h('h3', null, 'What it is'),
        h('p', { style: 'margin:0' }, desc.what + (desc.where.length ? '. ' + capitalize(desc.where.join('; ')) + '.' : '.')),
        desc.regs ? h('p', { class: 'insp-regs' }, desc.regs) : null,
      ),
    );

    let now;
    if (c < tr.fetchC[id]) now = `Not in the network yet. It enters at cycle ${fmtInt(tr.fetchC[id])}.`;
    else if (c >= tr.retireC[id]) now = `Exited at cycle ${fmtInt(tr.retireC[id])}, ${fmtInt(tr.retireC[id] - tr.fetchC[id])} cycles after entering.`;
    else if (c < tr.dispC[id]) now = c >= tr.fetchC[id] + tr.FE ? 'Held at the end of the entrance: the platform is full.' : `Travelling through the entrance, stop ${c - tr.fetchC[id] + 1} of ${tr.FE}.`;
    else now = `#${ins.num} ${stateClause(tr, id, c)}.`;
    root.append(h('div', { class: 'insp-block' }, h('h3', null, `Cycle ${fmtInt(Math.max(0, c))}`), h('div', { class: 'insp-now' }, now)));

    const consumers = app.consumersOf(M, id);
    if (ins.src.length || consumers.length) {
      root.append(
        h('div', { class: 'insp-block' },
          h('h3', null, 'Connections'),
          ins.src.length ? h('div', { class: 'ref-list' }, h('span', { class: 'field-hint', style: 'align-self:center' }, 'Needs results from'), ins.src.map((p) => ref(p))) : h('span', { class: 'field-hint' }, 'Needs no earlier results.'),
          consumers.length ? h('div', { class: 'ref-list' }, h('span', { class: 'field-hint', style: 'align-self:center' }, 'Feeds'), consumers.slice(0, 12).map((q) => ref(q)), consumers.length > 12 ? h('span', { class: 'field-hint' }, `+${consumers.length - 12} more`) : null) : null,
        ),
      );
    }

    // Journey bar: the lifetime split by what was happening.
    const segs = [];
    const T = story.totals;
    const add = (n, color, name) => {
      if (n > 0) segs.push({ n, color, name });
    };
    add(T.entrance + 1, 'var(--line-entrance)', 'Entrance');
    add(T.hold, codeVar(C.WINDOW), 'Held outside');
    add(T.holdRegs, codeVar(C.REGS), 'No spare register');
    add(T.dep, codeVar(C.DEP), 'Connection');
    add(T.mem, codeVar(C.MEM), 'Memory');
    add(T.unit, codeVar(C.UNIT), 'Station full');
    add(T.order, codeVar(C.ORDER), 'Held in order');
    add(T.name, codeVar(C.NAME), 'Register in use');
    add(T.width, codeVar(C.WIDTH), 'Slots full');
    add(T.ride, typeVar(ins.type), 'At station');
    add(T.trip, typeVar('load'), 'Memory trip');
    add(T.exitWait, 'var(--ink-3)', 'Waiting to exit');
    add(1, 'var(--line-return)', 'Exit');
    const total = segs.reduce((a, s) => a + s.n, 0) || 1;
    root.append(
      h('div', { class: 'insp-block' },
        h('h3', null, `Journey · ${story.lifetime} cycles`),
        h('div', { class: 'journey-bar', role: 'img', 'aria-label': segs.map((s) => `${s.name} ${s.n} cycles`).join(', ') },
          segs.map((s) => h('span', { style: `flex:${s.n} 1 0;background:${s.color}`, title: `${s.name}: ${s.n} ${s.n === 1 ? 'cycle' : 'cycles'}` })),
        ),
        h('div', { class: 'journey-keys' }, segs.map((s) => h('span', null, h('span', { class: 'dot', style: `--c:${s.color};background:${s.color}` }), ` ${s.name} ${s.n}`))),
        h('div', { class: 'insp-why' }, story.why),
      ),
    );

    // Route timeline.
    const list = h('ol', { class: 'route' });
    const evs = story.events;
    evs.forEach((ev, k) => {
      const next = evs[k + 1];
      const end = ev.c2 != null ? ev.c2 : next ? next.c : ev.c + 1;
      const isNow = c >= ev.c && c < Math.max(end, ev.c + 1);
      const color = ev.code != null ? codeVar(ev.code) : ev.loc != null ? `var(--loc-${LOC_INFO[ev.loc].key})` : ev.kind === 'depart' || ev.kind === 'trip' || ev.kind === 'l2' ? typeVar(ins.type === 'load' ? 'load' : ins.type) : 'var(--rule-2)';
      const when = ev.c2 != null && ev.c2 - ev.c > 1 ? `cycles ${fmtInt(ev.c)}–${fmtInt(ev.c2 - 1)} · ${ev.c2 - ev.c}` : `cycle ${fmtInt(ev.c)}`;
      const jump = h('button', { type: 'button', class: 'linkish', title: 'Jump the timeline here', onclick: () => app.jumpToLocal(M, ev.c) }, when);
      const textEl = h('span', null, ev.text);
      // Unit and gate waits carry a count in ref, not an instruction.
      if (ev.ref != null && ev.ref >= 0 && ev.kind !== 'exitwait' && ev.code !== C.UNIT && ev.code !== C.GATES) {
        textEl.append(' ', h('button', { type: 'button', class: 'linkish', onclick: () => app.select(M.uid, ev.ref) }, `Inspect #${tr.instrs[ev.ref].num}`));
      } else if (ev.kind === 'exitwait' && ev.ref >= 0) {
        textEl.append(' ', h('button', { type: 'button', class: 'linkish', onclick: () => app.select(M.uid, ev.ref) }, `Inspect #${tr.instrs[ev.ref].num}`));
      }
      list.append(h('li', { class: (ev.kind === 'wait' || ev.kind === 'hold' || ev.kind === 'exitwait' || ev.kind === 'queue' ? 'is-wait' : '') + (isNow ? ' is-now' : ''), style: `--k:${color}` }, h('span', { class: 'when' }, jump), textEl));
    });
    root.append(h('div', { class: 'insp-block' }, h('h3', null, 'Route'), list));

    // The same work on the other networks.
    const others = app.state.machines.filter((o) => o !== M);
    if (others.length) {
      const box = h('div', { class: 'elsewhere' });
      for (const O of others) {
        const oid = O.trace.map[ins.ops[0]];
        if (oid == null || oid < 0) continue;
        const ot = O.trace;
        const oi = ot.instrs[oid];
        const delta = ot.retireC[oid] / O.cfg.ghz - tr.retireC[id] / M.cfg.ghz;
        const sameClock = O.cfg.ghz === M.cfg.ghz;
        const dCycles = ot.retireC[oid] - tr.retireC[id];
        const cmp = sameClock
          ? dCycles === 0 ? 'the same cycle' : `${Math.abs(dCycles)} cycles ${dCycles < 0 ? 'sooner' : 'later'}`
          : Math.abs(delta) < 0.05 ? 'at the same moment' : `${Math.abs(delta).toFixed(1)} ns ${delta < 0 ? 'sooner' : 'later'}`;
        box.append(
          h('button', { type: 'button', onclick: () => app.select(O.uid, oid) },
            h('span', { class: 'bullet bullet-sm', style: `--line:${O.color}` }, O.letter),
            h('span', null,
              h('b', null, `#${oi.num}${oi.vector ? ` (SIMD ×${oi.lanes})` : ''}`),
              ` on ${O.name}: departed cycle ${fmtInt(ot.issueC[oid])}, exited cycle ${fmtInt(ot.retireC[oid])}, ${cmp}.`,
            ),
          ),
        );
      }
      root.append(h('div', { class: 'insp-block' }, h('h3', null, 'Same work on other networks'), box));
    }
    // Keep the current stop in view, scrolling only the inspector itself.
    const nowEl = list.querySelector('.is-now');
    if (nowEl && !this.root.matches(':hover')) {
      const box = this.root.getBoundingClientRect();
      const r = nowEl.getBoundingClientRect();
      if (r.bottom > box.bottom - 12) this.root.scrollTop += r.bottom - box.bottom + 40;
      else if (r.top < box.top + 12) this.root.scrollTop -= box.top - r.top + 40;
    }
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

