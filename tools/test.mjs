// Checks simulator invariants across every preset workload and fleet machine,
// then prints a results table. Run: node tools/test.mjs
import { PRESETS, generateWorkload, presetParams } from '../src/workload.js';
import { FLEET, EXPERIMENTS, normalizeCfg } from '../src/machine.js';
import { simulate } from '../src/sim.js';
import { computeStats, findEpisodes, cycleStatus, instrStory, compareNarrative, bottleneck, yardModel, localityWhy, accessTime } from '../src/analysis.js';
import { C, LOC, NREG } from '../src/isa.js';
import { PREDICTORS, countWrong } from '../src/predictor.js';

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
  checkRegisters(tr, tag);
  checkCaches(tr, tag);
  checkBranches(tr, tag);
}

// Every wrong guess closes the entrance once, and the trace's wrong guesses
// are the ones this network's predictor made.
function checkBranches(tr, tag) {
  const wrong = tr.instrs.filter((ins) => ins.mispredict).length;
  if (tr.mispredicts.length !== wrong) fail(`${tag}: ${tr.mispredicts.length} entrance holds for ${wrong} wrong guesses`);
  if (wrong !== countWrong(tr.workload, tr.cfg.predictor)) fail(`${tag}: ${wrong} wrong guesses, predictor says ${countWrong(tr.workload, tr.cfg.predictor)}`);
  if (tr.cfg.predictor === 'perfect' && wrong) fail(`${tag}: perfect predictor guessed wrong`);
  for (const ins of tr.instrs) if (ins.type !== 'branch' && ins.mispredict) fail(`${tag} #${ins.id}: non-branch mispredicted`);
}

// Register names: every source is read from the register its producer wrote,
// and nothing in between overwrote it. Without renaming, a write waits for
// the previous writer and for every older reader of the value it replaces.
// With renaming, register writers aboard never exceed the spare registers.
function checkRegisters(tr, tag) {
  const { N, instrs } = tr;
  const writerAt = new Int32Array(NREG).fill(-1);
  const last = [];
  for (let id = 0; id < N; id++) {
    const ins = instrs[id];
    for (let k = 0; k < ins.src.length; k++) {
      const p = ins.src[k];
      const r = instrs[p].dst;
      if (r < 0 || r >= NREG) fail(`${tag} #${id}: source ${p} has no register (${r})`);
      else if (ins.srcRegs[k] !== r) fail(`${tag} #${id}: reads r${ins.srcRegs[k]} but #${p} wrote r${r}`);
      else if (writerAt[r] !== p) fail(`${tag} #${id}: r${r} was overwritten by #${writerAt[r]} before it read #${p}'s value`);
    }
    if (ins.type === 'store' || ins.type === 'branch') {
      if (ins.dst !== -1) fail(`${tag} #${id}: ${ins.type} writes a register`);
    } else if (ins.dst < 0 || ins.dst >= NREG) fail(`${tag} #${id}: register ${ins.dst} out of range`);
    if (ins.dst >= 0) {
      if (ins.prevW !== writerAt[ins.dst]) fail(`${tag} #${id}: prevW ${ins.prevW} vs ${writerAt[ins.dst]}`);
      writerAt[ins.dst] = id;
    }
  }
  if (!tr.RENAME) {
    for (let id = 0; id < N; id++) {
      const w = instrs[id].prevW;
      if (w < 0) continue;
      if (tr.doneC[w] > tr.issueC[id]) fail(`${tag} #${id}: wrote r${instrs[id].dst} before #${w} did (WAW)`);
      for (const y of tr.consumers[w]) if (y !== id && tr.issueC[y] > tr.issueC[id]) fail(`${tag} #${id}: overwrote r${instrs[id].dst} before #${y} read it (WAR)`);
    }
  } else {
    for (let c = 0; c < tr.cycles; c++) if (tr.cyc.writers[c] > tr.RENAME) fail(`${tag}: ${tr.cyc.writers[c]} rename registers in use > ${tr.RENAME}`);
    for (let c = 0; c < tr.cycles; c++) if (tr.cyc.nName[c]) fail(`${tag}: name wait while renaming`);
  }
}

// Cache records: one per line an access touches, misses split into first
// uses and lines pushed out, load outcomes matching the hit counters, and
// every line's time in L1 and L2 well formed.
function checkCaches(tr, tag) {
  const perId = new Map();
  for (const e of tr.events) perId.set(e.id, (perId.get(e.id) || 0) + 1);
  for (const ins of tr.instrs) {
    const want = ins.lines ? ins.lines.length : 0;
    if ((perId.get(ins.id) || 0) !== want) fail(`${tag} #${ins.id}: ${perId.get(ins.id) || 0} cache records for ${want} lines`);
  }
  const hist = tr.workload.params.warm ? new Set(tr.workload.warmLines) : new Set();
  const seenRun = new Set();
  for (const e of tr.events) {
    const before = seenRun.has(e.line) || hist.has(e.line);
    if (e.cls === LOC.COLD && before) fail(`${tag} #${e.id}: first-use miss on a line used before`);
    if (e.cls === LOC.EVICTED && !before) fail(`${tag} #${e.id}: pushed-out miss on a line never used`);
    seenRun.add(e.line);
  }
  const L = tr.loc.load;
  if (L[LOC.REUSE] + L[LOC.NEAR] !== tr.mem.l1Hit + tr.mem.shared) fail(`${tag}: load hits ${L[0] + L[1]} vs ${tr.mem.l1Hit + tr.mem.shared}`);
  if (L[LOC.COLD] + L[LOC.EVICTED] !== tr.mem.l1Miss) fail(`${tag}: load misses ${L[2] + L[3]} vs ${tr.mem.l1Miss}`);
  const yard = yardModel(tr);
  if (yard.lines.length !== tr.touched.size) fail(`${tag}: yard has ${yard.lines.length} of ${tr.touched.size} lines`);
  for (const m of yard.lines) {
    for (const iv of m.l1) if (!(iv[0] <= iv[1]) || !(iv[2] >= iv[0])) fail(`${tag}: bad L1 span ${iv} for line ${m.line}`);
    for (let k = 1; k < m.l1.length; k++) if (m.l1[k][0] < m.l1[k - 1][1]) fail(`${tag}: overlapping L1 spans for line ${m.line}`);
    for (let k = 1; k < m.acc.length; k++) if (m.acc[k].t < m.acc[k - 1].t - 1e-9 && !m.acc[k].e.store && !m.acc[k - 1].e.store) fail(`${tag}: yard accesses out of order`);
    // An access that hit must find its line in L1 at that moment.
    for (const x of m.acc) {
      if (x.e.cls >= LOC.COLD) continue;
      const inL1 = m.l1.some((iv) => x.t >= iv[0] && x.t < iv[1]);
      if (!inL1 && !x.e.store) fail(`${tag}: hit on line ${m.line} at ${x.t} while the yard shows it out of L1`);
    }
  }
  for (let k = 0; k < tr.events.length; k += 5) localityWhy(tr, tr.events[k]);
}

const rows = [];
const t0 = performance.now();
for (const p of PRESETS) {
  const wl = generateWorkload(presetParams(p.id, { seed: 2718, warm: true }));
  const wl2 = generateWorkload(presetParams(p.id, { seed: 2718, warm: true }));
  if (JSON.stringify(wl.ops) !== JSON.stringify(wl2.ops)) fail(`${p.id}: workload not deterministic`);
  const row = { preset: p.id, ops: wl.ops.length, s: wl.summary, wl };
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

// Random timetables across the whole range of every slider.
{
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let k = 0; k < 60; k++) {
    const params = {
      size: 40 + Math.floor(rnd() * 960),
      mix: { int: rnd() * 60, fp: rnd() * 60, mem: rnd() * 70, branch: rnd() * 30 },
      dependency: rnd(),
      spatial: rnd(),
      temporal: rnd(),
      vector: rnd(),
      predictability: 0.5 + rnd() * 0.5,
      seed: 1 + Math.floor(rnd() * 99999),
      warm: rnd() < 0.7,
    };
    const wl = generateWorkload(params);
    for (const m of [FLEET[0], FLEET[2], FLEET[4]]) {
      const cfg = normalizeCfg({ ...m.cfg, renameRegs: k % 3 === 0 ? 0 : m.cfg.renameRegs, predictor: PREDICTORS[k % PREDICTORS.length].id });
      check(simulate(wl, cfg), `random${k}/${m.id}`);
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
  console.log(`${pad(row.preset, 12)} counts ${JSON.stringify(s.counts)} vec ${s.vecOps} loops ${s.loops} arrays ${s.arrays} heap ${s.heapBytes} arr ${s.arrayBytes} wrong ${PREDICTORS.map((p) => p.id + ':' + countWrong(row.wl, p.id)).join(' ')}`);
}
console.log(failures ? `\n${failures} FAILURES` : '\nall invariants hold');
process.exit(failures ? 1 : 0);
