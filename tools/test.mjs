// Checks simulator invariants across every preset workload and fleet machine,
// then prints a results table. Run: node tools/test.mjs
import { PRESETS, generateWorkload, presetParams } from '../src/workload.js';
import { FLEET, EXPERIMENTS, normalizeCfg } from '../src/machine.js';
import { simulate } from '../src/sim.js';
import { computeStats, findEpisodes, cycleStatus, instrStory, compareNarrative, bottleneck } from '../src/analysis.js';
import { C } from '../src/isa.js';

let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures < 40) console.log('  FAIL', msg);
};

function check(tr, tag) {
  const { N, W, FE, WIN, instrs, cyc } = tr;
  if (tr.truncated) fail(`${tag}: truncated`);
  const perCycleIssue = new Map();
  const perCycleRetire = new Map();
  const unitUse = new Map();
  for (let id = 0; id < N; id++) {
    const ins = instrs[id];
    const f = tr.fetchC[id], d = tr.dispC[id], i = tr.issueC[id], dn = tr.doneC[id], r = tr.retireC[id];
    if (!(f >= 0 && d >= f + FE && i > d && dn > i && r > dn)) fail(`${tag} #${id}: order f${f} d${d} i${i} dn${dn} r${r}`);
    if (id > 0) {
      if (tr.fetchC[id] < tr.fetchC[id - 1]) fail(`${tag} #${id}: fetch out of order`);
      if (tr.dispC[id] < tr.dispC[id - 1]) fail(`${tag} #${id}: dispatch out of order`);
      if (r < tr.retireC[id - 1]) fail(`${tag} #${id}: retire out of order`);
      if (!tr.OOO && i < tr.issueC[id - 1]) fail(`${tag} #${id}: in-order machine issued out of order`);
    }
    for (const p of ins.src) {
      if (p >= id) fail(`${tag} #${id}: forward dependency ${p}`);
      if (i < tr.doneC[p]) fail(`${tag} #${id}: issued at ${i} before producer ${p} done at ${tr.doneC[p]}`);
    }
    perCycleIssue.set(i, (perCycleIssue.get(i) || 0) + 1);
    perCycleRetire.set(r, (perCycleRetire.get(r) || 0) + 1);
    const key = ins.unit + tr.unitIdx[id];
    const busyTo = ins.pipe ? i + 1 : i + ins.lat;
    if (!unitUse.has(key)) unitUse.set(key, []);
    unitUse.get(key).push([i, busyTo]);
    if (ins.type !== 'load' && dn !== i + ins.lat) fail(`${tag} #${id}: latency mismatch`);
  }
  for (const [c, n] of perCycleIssue) if (n > W) fail(`${tag}: ${n} issued in cycle ${c} > width ${W}`);
  for (const [c, n] of perCycleRetire) if (n > W) fail(`${tag}: ${n} retired in cycle ${c} > width ${W}`);
  for (const [key, spans] of unitUse) {
    spans.sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < spans.length; k++) if (spans[k][0] < spans[k - 1][1]) fail(`${tag}: unit ${key} double-booked at ${spans[k][0]}`);
  }
  let slotSum = 0;
  for (let c = 0; c < tr.cycles; c++) {
    if (cyc.rob[c] > WIN) fail(`${tag}: rob ${cyc.rob[c]} > ${WIN}`);
    if (cyc.mshr[c] > tr.MSHR) fail(`${tag}: mshr overflow`);
    slotSum += W;
  }
  let tot = 0;
  for (const v of tr.slotTotals) tot += v;
  if (tot !== slotSum) fail(`${tag}: slot accounting ${tot} vs ${slotSum}`);
  // Scalar-op coverage: every workload op mapped exactly once.
  const seen = new Uint8Array(tr.workload.ops.length);
  for (const ins of instrs) for (const o of ins.ops) seen[o]++;
  for (let k = 0; k < seen.length; k++) if (seen[k] !== 1) fail(`${tag}: op ${k} covered ${seen[k]} times`);
}

const rows = [];
const t0 = performance.now();
for (const p of PRESETS) {
  const wl = generateWorkload(presetParams(p.id, { seed: 2718, warm: true }));
  const wl2 = generateWorkload(presetParams(p.id, { seed: 2718, warm: true }));
  if (JSON.stringify(wl.ops) !== JSON.stringify(wl2.ops)) fail(`${p.id}: workload not deterministic`);
  const row = { preset: p.id, ops: wl.ops.length, s: wl.summary };
  for (const m of FLEET) {
    const cfg = normalizeCfg(m.cfg);
    const tr = simulate(wl, cfg);
    const tr2 = simulate(wl, cfg);
    if (tr.cycles !== tr2.cycles || tr.retireC.some((v, k) => v !== tr2.retireC[k])) fail(`${p.id}/${m.id}: sim not deterministic`);
    check(tr, `${p.id}/${m.id}`);
    const st = computeStats(tr);
    const eps = findEpisodes(tr);
    // Exercise the explainers.
    for (let c = 0; c < tr.cycles; c += Math.max(1, Math.floor(tr.cycles / 50))) cycleStatus(tr, c);
    for (let id = 0; id < tr.N; id += 7) instrStory(tr, id);
    row[m.id] = { cycles: tr.cycles, ns: st.ns, ipc: st.ipc, l1: st.l1Rate, l2: st.l2Rate, trips: st.trips, eps: eps.length, busy: st.slot[C.BUSY], bn: bottleneck(st).key, st, tr, cfg, name: m.name };
  }
  rows.push(row);
}
const t1 = performance.now();

// Experiments on every preset against Local and Express.
for (const row of rows) {
  for (const base of ['local', 'express']) {
    const A = row[base];
    const wl = A.tr.workload;
    for (const ex of EXPERIMENTS) {
      if (!ex.ok(A.cfg)) continue;
      const cfg = normalizeCfg(ex.apply(A.cfg));
      const tr = simulate(wl, cfg);
      check(tr, `${row.preset}/${base}+${ex.id}`);
      const B = { name: 'B', cfg, trace: tr, stats: computeStats(tr) };
      compareNarrative({ name: 'A', cfg: A.cfg, trace: A.tr, stats: A.st }, B);
    }
  }
}

console.log(`\nsim time ${(t1 - t0).toFixed(0)} ms for ${rows.length * FLEET.length * 2} runs\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('preset', 12) + pad('ops', 5) + FLEET.map((m) => pad(m.id, 32)).join(''));
for (const row of rows) {
  let line = pad(row.preset, 12) + pad(row.ops, 5);
  for (const m of FLEET) {
    const r = row[m.id];
    line += pad(`${r.cycles}c ${r.ns.toFixed(0)}ns ipc${r.ipc.toFixed(2)} ${r.bn} L1${r.l1 == null ? '-' : Math.round(r.l1 * 100)} tr${r.trips}`, 32);
  }
  console.log(line);
}
for (const row of rows) {
  const s = row.s;
  console.log(`${pad(row.preset, 12)} counts ${JSON.stringify(s.counts)} vec ${s.vecOps} loops ${s.loops} arrays ${s.arrays} heap ${s.heapBytes} arr ${s.arrayBytes} mp ${s.mispredicts}`);
}
console.log(failures ? `\n${failures} FAILURES` : '\nall invariants hold');
process.exit(failures ? 1 : 0);
