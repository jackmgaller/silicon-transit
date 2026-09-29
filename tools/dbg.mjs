// Debug dump of one simulation. Run: node tools/dbg.mjs <preset> <machine> [count]
import { generateWorkload, presetParams } from '../src/workload.js';
import { FLEET, normalizeCfg } from '../src/machine.js';
import { simulate } from '../src/sim.js';
import { computeStats } from '../src/analysis.js';
import { CODE_INFO } from '../src/isa.js';

const [, , preset = 'independent', mid = 'express', n = '30', from = '0'] = process.argv;
const wl = generateWorkload(presetParams(preset, { seed: 2718, warm: true }));
const cfg = normalizeCfg(FLEET.find((m) => m.id === mid).cfg);
const tr = simulate(wl, cfg);
const st = computeStats(tr);
console.log('cycles', tr.cycles, 'N', tr.N, 'floors', st.floors, 'mlpPeak', st.mlpPeak, 'trips', st.trips);
console.log('slots', st.slots.map((s) => CODE_INFO[s.code].key + ':' + (s.frac * 100).toFixed(1)).join(' '));
for (let id = +from; id < Math.min(tr.N, +from + +n); id++) {
  const ins = tr.instrs[id];
  console.log(
    String(id).padStart(3),
    ins.op.padEnd(5),
    ('src[' + ins.src.join(',') + ']').padEnd(14),
    'f', tr.fetchC[id], 'd', tr.dispC[id], 'i', tr.issueC[id], 'dn', tr.doneC[id], 'r', tr.retireC[id],
    ins.type === 'load' ? 'lvl' + tr.memLvl[id] : '',
    JSON.stringify(tr.waits[id]),
  );
}
