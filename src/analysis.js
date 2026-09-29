// Metrics and explanations, all computed from a simulation trace.

import { C, CODE_INFO, SLOT_CODES, LVL, OPS, UNIT_LABEL, UNIT_PLURAL, UNIT_NOUN, LOC, NREG, regName, hex } from './isa.js';
import { describeDiff, formatParam } from './machine.js';
import { HOT_BASE, HOT_BYTES, HEAP_BASE, ARRAY_BASE, ARRAY_STRIDE } from './workload.js';

export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
export const pct = (x, d = 0) => (x == null ? '—' : (x * 100).toFixed(d) + '%');
export const fmtX = (r) => (r >= 10 ? r.toFixed(0) : r >= 1.995 ? r.toFixed(1) : r.toFixed(2)) + '×';
export function fmtTime(ns) {
  if (ns >= 1e6) return (ns / 1e6).toFixed(2) + ' ms';
  if (ns >= 1000) return (ns / 1000).toFixed(ns >= 1e4 ? 1 : 2) + ' µs';
  return ns.toFixed(ns >= 100 ? 0 : 1) + ' ns';
}
const plural = (n, one, many) => (n === 1 ? one : many ?? one + 's');
export const label = (tr, id) => '#' + tr.instrs[id].num;
// The whole cycle a (possibly fractional) display time falls in. Time mode
// converts through nanoseconds, so 61 cycles can come back as 60.999…
export const cycleAt = (x) => Math.floor(x + 1e-6);

// ---------------------------------------------------------------------------
// Lookups into the trace.

// Oldest instruction that has not exited by the end of cycle c.
export function headAt(tr, c) {
  let lo = 0;
  let hi = tr.N - 1;
  if (tr.retireC[hi] <= c) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tr.retireC[mid] > c) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Oldest instruction on the platform that has not departed at cycle c.
export function oldestWaiting(tr, c) {
  const h = headAt(tr, c);
  if (h < 0) return -1;
  for (let id = h; id < tr.N; id++) {
    if (tr.dispC[id] < 0 || tr.dispC[id] > c) return -1;
    if (tr.issueC[id] > c) return id;
  }
  return -1;
}

// On a fixed-order network, the instruction that ready instructions are held
// behind during cycle c (the ref of their ORDER waits), or -1.
export function orderBlocker(tr, c) {
  const first = oldestWaiting(tr, c);
  if (first < 0) return -1;
  for (let id = first; id < tr.N && tr.dispC[id] >= 0 && tr.dispC[id] <= c; id++) {
    if (tr.issueC[id] >= 0 && tr.issueC[id] <= c) continue;
    const w = waitAt(tr, id, c);
    if (w && w[2] === C.ORDER) return w[3];
  }
  return -1;
}

// Wait reason [code, ref] for instruction id during cycle c, or null.
export function waitAt(tr, id, c) {
  const w = tr.waits[id];
  for (let k = 0; k < w.length; k++) if (c >= w[k][0] && c < w[k][1]) return w[k];
  return null;
}

// Among older instructions still aboard when id finished, the last to finish.
export function retireBlocker(tr, id) {
  const done = tr.doneC[id];
  let best = -1;
  for (let j = id - 1; j >= 0; j--) {
    if (tr.retireC[j] <= done) break;
    if (best < 0 || tr.doneC[j] > tr.doneC[best]) best = j;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Registers.

// Assembly-like text for one instruction, with its register names.
export function instrText(tr, id) {
  const ins = tr.instrs[id];
  const v = ins.vector ? 'v' : '';
  const lanes = ins.vector ? ` ×${ins.lanes}` : '';
  const srcs = ins.srcRegs.map(regName);
  if (ins.type === 'load') return `${v}load ${regName(ins.dst)} ← [${srcs.length ? srcs[0] : hex(ins.addr)}]${lanes}`;
  if (ins.type === 'store') {
    // The last source is the value stored; an earlier one supplies the address.
    const where = srcs.length > 1 ? srcs[0] : hex(ins.addr);
    return `${v}store [${where}]${srcs.length ? ' ← ' + srcs[srcs.length - 1] : ''}${lanes}`;
  }
  if (ins.type === 'branch') return `br${srcs.length ? ' if ' + srcs[0] : ''}`;
  return `${v}${OPS[ins.op].short} ${regName(ins.dst)}${srcs.length ? ' ← ' + srcs.join(', ') : ''}${lanes}`;
}

// Register r at cycle c: the writers whose values are still aboard, oldest
// first, ending with the one a newly boarding reader would get.
export function regVersions(tr, r, c) {
  const ws = tr.regWriters[r] || [];
  let lo = 0;
  let hi = ws.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = tr.dispC[ws[mid]];
    if (d >= 0 && d <= c) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (last < 0) return { latest: -1, aboard: [] };
  let first = last;
  while (first > 0 && tr.retireC[ws[first - 1]] > c) first--;
  const aboard = [];
  for (let k = first; k <= last; k++) if (tr.retireC[ws[k]] > c) aboard.push(ws[k]);
  return { latest: ws[last], aboard };
}

// Rename registers in use at cycle c (register writers aboard).
export const writersAt = (tr, c) => (c < 0 ? 0 : c < tr.cycles ? tr.cyc.writers[c] : 0);

// ---------------------------------------------------------------------------
// Caches and locality.

// Display time of a recorded access: a load's lookup finishes L1LAT cycles
// after it departs; a store writes as it exits.
export const accessTime = (tr, e) => (e.store ? e.c : e.c + tr.L1LAT);

// Which part of memory a line belongs to.
export function regionOf(line) {
  const a = line * 64;
  if (a >= HOT_BASE && a < HOT_BASE + HOT_BYTES) return { key: 'hot', order: 0, name: 'Hot data', short: 'Hot' };
  if (a >= HEAP_BASE && a < ARRAY_BASE) return { key: 'heap', order: 1, name: 'Heap', short: 'Heap' };
  const k = Math.floor((a - ARRAY_BASE) / ARRAY_STRIDE);
  return { key: 'array' + k, order: 2 + k, name: `Array ${k + 1}`, short: `Array ${k + 1}` };
}

// Every line this program touches, with its accesses and the spans it spent
// in L1 and L2, for drawing the cache yard. Cached on the trace.
export function yardModel(tr) {
  if (tr.yard) return tr.yard;
  const lines = [...tr.touched].sort((a, b) => a - b);
  const byLine = new Map();
  const model = [];
  for (const ln of lines) {
    const reg = regionOf(ln);
    const m = { line: ln, region: reg, acc: [], l1: [], l2: [] };
    if (tr.initL1.has(ln)) m.l1.push([-Infinity, Infinity, -Infinity]);
    if (tr.initL2.has(ln)) m.l2.push([-Infinity, Infinity]);
    byLine.set(ln, m);
    model.push(m);
  }
  const close = (list, t) => {
    const last = list[list.length - 1];
    if (last && last[1] === Infinity) last[1] = Math.max(last[0], t);
  };
  for (const e of tr.events) {
    const t = accessTime(tr, e);
    if (e.ev1 >= 0 && byLine.has(e.ev1)) close(byLine.get(e.ev1).l1, t);
    if (e.ev2 >= 0 && byLine.has(e.ev2)) close(byLine.get(e.ev2).l2, t);
    const m = byLine.get(e.line);
    if (e.cls >= LOC.COLD) {
      close(m.l1, t);
      m.l1.push([t, Infinity, Math.max(t, e.fill)]);
    }
    if (e.in2) {
      close(m.l2, t);
      m.l2.push([t, Infinity]);
    }
    m.acc.push({ t, e });
  }
  const regions = [];
  for (const m of model) {
    let r = regions[regions.length - 1];
    if (!r || r.key !== m.region.key) {
      r = { key: m.region.key, name: m.region.name, short: m.region.short, order: m.region.order, lines: [] };
      regions.push(r);
    }
    r.lines.push(m);
  }
  regions.sort((a, b) => a.order - b.order);
  tr.yard = { lines: model, byLine, regions };
  return tr.yard;
}

// Where a yard line is at display time t: 'l1', 'arriving', 'l2' or 'mem'.
export function lineWhere(m, t) {
  for (let k = m.l1.length - 1; k >= 0; k--) {
    const [a, b, ready] = m.l1[k];
    if (t >= a && t < b) return t < ready ? 'arriving' : 'l1';
  }
  for (let k = m.l2.length - 1; k >= 0; k--) if (t >= m.l2[k][0] && t < m.l2[k][1]) return 'l2';
  return 'mem';
}

// Accesses made by one instruction (one per line it touches).
export function accessesOf(tr, id) {
  if (!tr.eventsById) {
    tr.eventsById = new Map();
    for (const e of tr.events) {
      if (!tr.eventsById.has(e.id)) tr.eventsById.set(e.id, []);
      tr.eventsById.get(e.id).push(e);
    }
  }
  return tr.eventsById.get(id) || [];
}

const wordsIn = (mask) => {
  const out = [];
  for (let w = 0; w < 8; w++) if (mask & (1 << w)) out.push(w);
  return out;
};

// Why one access found or missed its line in L1, naming the instruction
// responsible: who used the word before, whose neighboring word brought the
// line in, or who pushed the line out. `mode` fits the sentence to what
// happened next: 'hit', 'ride' (the line was still on its way), or 'miss'.
export function localityWhy(tr, e, mode = e.cls >= LOC.COLD ? 'miss' : 'hit') {
  const events = tr.events;
  const k = events.indexOf(e);
  const at = (q) => fmtInt(accessTime(tr, q));
  if (e.cls === LOC.COLD) return { text: 'this is the first time this program touches this 64-byte line' };
  if (e.cls === LOC.EVICTED) {
    for (let j = k - 1; j >= 0; j--) {
      const q = events[j];
      if (q.ev1 === e.line) return { text: `this line was in L1 until cycle ${at(q)}, when ${label(tr, q.id)} brought in a line of its own and L1, being full, pushed this one out`, ref: q.id };
    }
    return { text: 'earlier runs of this code used this line, but L1 had pushed it out for room before this run began' };
  }
  // A hit: find when the line last arrived, then who used this word since.
  let arrived = -1;
  for (let j = k - 1; j >= 0; j--) {
    const q = events[j];
    if (q.line === e.line && q.cls >= LOC.COLD) {
      arrived = j;
      break;
    }
    if (q.ev1 === e.line) break;
  }
  const still = mode === 'ride' ? '' : ', and it is still in L1';
  if (e.cls === LOC.REUSE) {
    for (let j = k - 1; j >= Math.max(0, arrived); j--) {
      const q = events[j];
      if (q.line === e.line && (q.mask & e.mask)) return { text: `${label(tr, q.id)} ${mode === 'ride' ? 'already asked for' : 'used'} this same word at cycle ${at(q)}${still}: temporal locality`, ref: q.id };
    }
    return { text: `earlier runs of this code used this line${still}: temporal locality` };
  }
  if (arrived >= 0) {
    const q = events[arrived];
    const w0 = wordsIn(q.mask)[0];
    const w1 = wordsIn(e.mask)[0];
    const d = Math.abs(w1 - w0) * 8;
    const where = d === 0 ? 'in the same line' : `${d} bytes ${w1 > w0 ? 'before' : 'after'} this one`;
    return { text: `${label(tr, q.id)} ${mode === 'ride' ? 'sent for' : 'brought in'} this 64-byte line at cycle ${at(q)} for a word ${where}, and a line carries all eight words: spatial locality`, ref: q.id };
  }
  return { text: 'a neighboring word brought this line in: spatial locality' };
}

// ---------------------------------------------------------------------------
// Statistics.

export function computeStats(tr) {
  const { N, cycles, cfg, instrs, cyc } = tr;
  const ops = tr.workload.ops.length;
  const cyl = Math.max(1, cycles);
  const s = { cycles, N, ops };
  s.ns = cycles / cfg.ghz;
  s.ipc = N / cyl;
  s.opc = ops / cyl;
  s.util = {
    alu: tr.unitBusy.alu / (cfg.alu * cyl),
    fpu: tr.unitBusy.fpu / (cfg.fpu * cyl),
    lsu: tr.unitBusy.lsu / (cfg.lsu * cyl),
  };
  const m = tr.mem;
  const l1Acc = m.l1Hit + m.shared + m.l1Miss;
  s.l1Acc = l1Acc;
  s.l1Rate = l1Acc ? (m.l1Hit + m.shared) / l1Acc : null;
  const l2Acc = m.l2Hit + m.l2Shared + m.l2Miss;
  s.l2Rate = tr.HAS_L2 && l2Acc ? (m.l2Hit + m.l2Shared) / l2Acc : null;
  s.l2Acc = l2Acc;
  s.trips = m.trips;
  s.shared = m.shared + m.l2Shared;
  s.busWait = m.busWait;

  let loads = 0;
  let loadSum = 0;
  let laneUsed = 0;
  let vecInstrs = 0;
  let vecLanes = 0;
  let vecCap = 0;
  const count = { int: 0, fp: 0, load: 0, store: 0, branch: 0 };
  for (const ins of instrs) {
    count[ins.type]++;
    if (ins.type === 'load') {
      loads++;
      loadSum += tr.doneC[ins.id] - tr.issueC[ins.id];
    }
    laneUsed += ins.lanes;
    if (ins.vector) {
      vecInstrs++;
      vecLanes += ins.lanes;
      vecCap += ins.width;
    }
  }
  s.count = count;
  s.loads = loads;
  s.avgLoad = loads ? loadSum / loads : null;
  s.laneUtil = cfg.simd > 1 ? laneUsed / (N * cfg.simd) : null;
  s.vecInstrs = vecInstrs;
  s.vecOps = vecLanes;
  s.packFill = vecCap ? vecLanes / vecCap : null;
  s.mispredicts = tr.mispredicts.length;

  const total = Math.max(1, cycles * tr.W);
  s.slotTotal = total;
  s.slots = SLOT_CODES.map((code) => ({ code, n: tr.slotTotals[code], frac: tr.slotTotals[code] / total }));
  s.slot = Object.fromEntries(s.slots.map((x) => [x.code, x.frac]));

  let robSum = 0;
  let robPeak = 0;
  let mo = 0;
  let moN = 0;
  let moPeak = 0;
  let gatePeak = 0;
  let stallCycles = 0;
  const unitWait = { alu: 0, fpu: 0, lsu: 0 };
  let orderWait = 0;
  let gatesWait = 0;
  let nameWait = 0;
  let writersPeak = 0;
  let regsHeld = 0;
  for (let c = 0; c < cycles; c++) {
    nameWait += cyc.nName[c];
    if (cyc.writers[c] > writersPeak) writersPeak = cyc.writers[c];
    if (cyc.board[c] === C.REGS) regsHeld++;
    robSum += cyc.rob[c];
    if (cyc.rob[c] > robPeak) robPeak = cyc.rob[c];
    if (cyc.memOut[c] > 0) {
      mo += cyc.memOut[c];
      moN++;
      if (cyc.memOut[c] > moPeak) moPeak = cyc.memOut[c];
    }
    if (cyc.mshr[c] > gatePeak) gatePeak = cyc.mshr[c];
    if (cyc.issued[c] === 0) stallCycles++;
    unitWait.alu += cyc.nUnitAlu[c];
    unitWait.fpu += cyc.nUnitFpu[c];
    unitWait.lsu += cyc.nUnitLsu[c];
    orderWait += cyc.nOrder[c];
    gatesWait += cyc.nGates[c];
  }
  s.robAvg = robSum / cyl;
  s.robPeak = robPeak;
  s.mlp = moN ? mo / moN : 0;
  s.mlpPeak = moPeak;
  // Most cache-line misses in flight at once: each one holds a memory gate.
  s.gatePeak = gatePeak;
  s.memCycles = moN;
  s.stallCycles = stallCycles;
  s.unitWait = unitWait;
  s.orderWait = orderWait;
  s.gatesWait = gatesWait;
  s.nameWait = nameWait;
  s.writersPeak = writersPeak;
  s.regsHeld = regsHeld;

  // How loads found their lines in L1, by kind of locality.
  const ll = tr.loc.load;
  const lTotal = ll[0] + ll[1] + ll[2] + ll[3];
  s.locLoads = lTotal;
  s.loc = [...ll].map((n) => (lTotal ? n / lTotal : 0));
  s.locN = [...ll];
  const st = tr.loc.store;
  s.locStoreN = [...st];

  let maxIssue = -1;
  let overtakes = 0;
  for (let id = 0; id < N; id++) {
    if (tr.issueC[id] < maxIssue) overtakes++;
    if (tr.issueC[id] > maxIssue) maxIssue = tr.issueC[id];
  }
  s.overtakes = overtakes;

  let brLost = 0;
  for (const mp of tr.mispredicts) brLost += mp.starveUntil - mp.starveFrom;
  s.branchLostCycles = Math.max(0, brLost);

  s.floors = computeFloors(tr);
  return s;
}

function computeFloors(tr) {
  const { N, instrs, cfg } = tr;
  const cp = new Float64Array(N);
  let depMax = 0;
  const occ = { alu: 0, fpu: 0, lsu: 0 };
  for (let id = 0; id < N; id++) {
    const ins = instrs[id];
    let start = 0;
    for (const p of ins.src) if (cp[p] > start) start = cp[p];
    cp[id] = start + (tr.doneC[id] - tr.issueC[id]);
    if (cp[id] > depMax) depMax = cp[id];
    occ[ins.unit] += ins.pipe ? 1 : ins.lat;
  }
  const fill = tr.FE + 2;
  return {
    dep: Math.round(depMax + fill),
    issue: Math.ceil(N / tr.W) + fill,
    alu: Math.ceil(occ.alu / cfg.alu),
    fpu: Math.ceil(occ.fpu / cfg.fpu),
    lsu: Math.ceil(occ.lsu / cfg.lsu),
    bandwidth: tr.mem.trips * tr.BUS,
  };
}

export const FLOOR_INFO = {
  dep: { label: 'Dependency chain', text: 'its longest chain of dependent work needs' },
  issue: { label: 'Departure width', text: 'boarding every instruction at its width needs' },
  alu: { label: 'ALU capacity', text: 'pushing every integer and branch instruction through its ALUs needs' },
  fpu: { label: 'FPU capacity', text: 'pushing every floating-point instruction through its FPUs needs' },
  lsu: { label: 'Load/store capacity', text: 'pushing every load and store through its ports needs' },
  bandwidth: { label: 'Memory bandwidth', text: 'delivering every main-memory line needs' },
};

export const LOSS_TEXT = {
  [C.DEP]: 'instructions waiting for results from earlier ones',
  [C.MEM]: 'instructions waiting on data from the caches or main memory',
  [C.UNIT]: 'ready instructions finding every station of their kind busy',
  [C.ORDER]: 'ready instructions held behind a stuck one by the fixed timetable',
  [C.NAME]: 'instructions waiting for older ones to finish with a register name they reuse',
  [C.WINDOW]: 'a full platform, so nothing new could board',
  [C.REGS]: 'running out of rename registers, so nothing new could board',
  [C.BRANCH]: 'recovering from mispredicted branches',
  [C.SUPPLY]: 'the entrance not delivering instructions fast enough',
  [C.DRAIN]: 'the last few instructions finishing',
};

// What holds this machine back, in one sentence.
export function limitSentence(name, stats) {
  const bn = bottleneck(stats);
  if (bn.tightness >= 0.8) {
    return `${name} is limited by its ${FLOOR_INFO[bn.key].label.toLowerCase()}: ${FLOOR_INFO[bn.key].text} at least ${fmtInt(bn.value)} cycles, and the run took ${fmtInt(stats.cycles)}.`;
  }
  const w = bn.worst;
  if (!w || w.frac < 0.05) return `${name} kept its departure slots busy ${pct(stats.slot[C.BUSY])} of the time.`;
  return `${name}’s biggest loss is ${LOSS_TEXT[w.code]}: ${pct(w.frac)} of its departure capacity.`;
}

export function bottleneck(stats) {
  const f = stats.floors;
  let key = 'dep';
  for (const k of Object.keys(f)) if (f[k] > f[key]) key = k;
  const lostOrder = stats.slots
    .filter((x) => x.code !== C.BUSY && x.code !== C.DRAIN)
    .sort((a, b) => b.frac - a.frac);
  return { key, value: f[key], tightness: f[key] / Math.max(1, stats.cycles), worst: lostOrder[0] };
}

// Line-status style verdict for one machine.
export function verdict(stats) {
  const busy = stats.slot[C.BUSY];
  const b = bottleneck(stats);
  const cause = b.worst && b.worst.frac > 0.05 ? CODE_INFO[b.worst.code].label.toLowerCase() : null;
  if (busy >= 0.6) return { tone: 'good', label: 'Good service', cause };
  if (busy >= 0.3) return { tone: 'minor', label: 'Minor delays', cause };
  return { tone: 'severe', label: 'Severe delays', cause };
}

// ---------------------------------------------------------------------------
// Stall episodes: runs of cycles in which nothing departed.

export function findEpisodes(tr) {
  const { cycles, cyc, W } = tr;
  const eps = [];
  let start = -1;
  const close = (end) => {
    const counts = new Float64Array(16);
    for (let c = start; c < end; c++) for (let k = 0; k < W; k++) counts[cyc.slots[c * W + k]]++;
    let code = C.DEP;
    for (const k of [C.DEP, C.MEM, C.UNIT, C.ORDER, C.NAME, C.WINDOW, C.REGS, C.BRANCH, C.SUPPLY, C.DRAIN]) if (counts[k] > counts[code]) code = k;
    eps.push({ start, end, code });
  };
  for (let c = 0; c < cycles; c++) {
    const stalled = cyc.issued[c] === 0 && (cyc.rob[c] > 0 || cyc.feBlock[c] >= 0) && c > tr.FE;
    if (stalled && start < 0) start = c;
    if (!stalled && start >= 0) {
      close(c);
      start = -1;
    }
  }
  if (start >= 0) close(cycles);
  return eps;
}

// ---------------------------------------------------------------------------
// Describing things in words.

export function allUnits(unit, n) {
  const one = UNIT_LABEL[unit] === 'Load/store' ? 'load/store port' : UNIT_LABEL[unit];
  const many = UNIT_PLURAL[unit];
  if (n === 1) return `The only ${one} was`;
  if (n === 2) return `Both ${many} were`;
  return `All ${n} ${many} were`;
}

const unitWork = { alu: 'integer', fpu: 'floating-point', lsu: 'memory' };

function memWhere(tr, id) {
  const lvl = tr.memLvl[id];
  if (lvl === LVL.MEM) return 'main memory';
  if (lvl === LVL.L2) return 'the L2 cache';
  if (lvl === LVL.SHARED_L1 || lvl === LVL.SHARED_L2) return 'a delivery already on its way';
  return 'the L1 cache';
}

// What instruction id is doing during cycle c, as a clause.
export function stateClause(tr, id, c) {
  const ins = tr.instrs[id];
  if (tr.issueC[id] < 0 || tr.issueC[id] > c) {
    const w = waitAt(tr, id, c);
    if (!w) return 'is waiting to depart';
    return 'is ' + waitClause(tr, id, w[2], w[3]);
  }
  if (tr.doneC[id] > c) {
    if (ins.type === 'load' && tr.memLvl[id] !== LVL.L1) return `is fetching data from ${memWhere(tr, id)} (back at cycle ${fmtInt(tr.doneC[id])})`;
    return `is still at the ${UNIT_NOUN[ins.unit]} (done at cycle ${fmtInt(tr.doneC[id])})`;
  }
  const r = tr.retireC[id];
  if (r >= 0 && r <= c) return 'has exited';
  if (r === c + 1) return 'has finished and exits next';
  // Exits wait in program order: name the oldest vehicle ahead still working.
  for (let j = headAt(tr, c); j >= 0 && j < id; j++) {
    if (tr.doneC[j] < 0 || tr.doneC[j] > c) return `has finished, but exits in timetable order behind ${label(tr, j)}, which is not done yet`;
  }
  return `has finished and exits at cycle ${fmtInt(r)}, after the vehicles ahead of it`;
}

export function waitClause(tr, id, code, ref) {
  switch (code) {
    case C.DEP:
      return `waiting for ${regName(tr.instrs[ref].dst)} from ${label(tr, ref)} (${OPS[tr.instrs[ref].op].short})`;
    case C.MEM:
      return `waiting for ${regName(tr.instrs[ref].dst)}: ${label(tr, ref)} is bringing it from ${memWhere(tr, ref)}`;
    case C.NAME: {
      // Without renaming a register holds one value: the older instruction
      // either still has to write this register (WAW) or read it (WAR).
      const r = regName(tr.instrs[id].dst);
      return tr.instrs[ref].dst === tr.instrs[id].dst
        ? `ready, but ${r} is still in use: ${label(tr, ref)} must write ${r} first`
        : `ready, but ${r} is still in use: ${label(tr, ref)} must read the old ${r} first`;
    }
    case C.UNIT: {
      const unit = ['alu', 'fpu', 'lsu'][ref];
      return `ready, but ${allUnits(unit, tr.unitCount[unit]).replace(/^The|^Both|^All/, (m) => m.toLowerCase())} busy`;
    }
    case C.ORDER:
      return `ready, but held behind ${label(tr, ref)} by the fixed timetable`;
    case C.WIDTH:
      return `ready, but all ${tr.W} departure slots were taken`;
    case C.GATES:
      // ref: how many gates the load needed at once (one per missing line).
      if (ref > 1) return `ready, but it needs ${ref} memory gates at once for its cache lines and fewer were free`;
      return `ready, but all ${tr.MSHR} memory ${plural(tr.MSHR, 'gate')} were busy with other misses`;
    default:
      return 'waiting';
  }
}

// The oldest instruction waiting with this code during cycle c: [id, ref].
function firstWaiting(tr, c, code) {
  const first = oldestWaiting(tr, c);
  if (first < 0) return null;
  for (let id = first; id < tr.N && tr.dispC[id] >= 0 && tr.dispC[id] <= c; id++) {
    if (tr.issueC[id] >= 0 && tr.issueC[id] <= c) continue;
    const w = waitAt(tr, id, c);
    if (w && w[2] === code) return [id, w[3]];
  }
  return null;
}

// One-line service status for a machine at cycle c.
export function cycleStatus(tr, c) {
  const { cyc, W } = tr;
  if (c >= tr.cycles) {
    return { tone: 'done', text: `Service complete. All ${fmtInt(tr.N)} vehicles exited in ${fmtInt(tr.cycles)} cycles.` };
  }
  const out = [];
  const iss = cyc.issued[c];
  const fb = cyc.feBlock[c];
  if (fb >= 0) {
    out.push({ sev: iss === 0 ? 3 : 2, text: `Branch ${label(tr, fb)} was mispredicted, so the entrance is closed until it resolves at cycle ${fmtInt(tr.doneC[fb])}.` });
  } else if (cyc.refill[c] >= 0 && iss < W) {
    out.push({ sev: 1, text: `Refilling the entrance after branch ${label(tr, cyc.refill[c])} took the wrong route.` });
  }
  if (cyc.rob[c] >= tr.WIN && iss === 0 && cyc.retired[c] === 0) {
    const h = headAt(tr, c);
    if (h >= 0 && (tr.doneC[h] < 0 || tr.doneC[h] > c)) out.push({ sev: 3, text: `Platform full (${tr.WIN}/${tr.WIN}). ${label(tr, h)} at the head ${stateClause(tr, h, c)}, so nobody can exit and nobody new can board.` });
  }
  if (!tr.OOO && cyc.nOrder[c] > 0) {
    const b = orderBlocker(tr, c);
    if (b >= 0) {
      const k = cyc.nOrder[c];
      out.push({ sev: iss === 0 ? 3 : 2, text: `Fixed timetable: ${label(tr, b)} ${stateClause(tr, b, c)}, so ${k} ready ${plural(k, 'instruction')} behind it must hold.` });
    }
  }
  if (cyc.nName[c] > 0) {
    const x = firstWaiting(tr, c, C.NAME);
    if (x) {
      const k = cyc.nName[c];
      const [xid, ref] = x;
      const r = regName(tr.instrs[xid].dst);
      const waw = tr.instrs[ref].dst === tr.instrs[xid].dst;
      // On a fixed-order network a younger vehicle's clash only matters
      // when it is the one at the front of the line.
      const leads = tr.OOO || xid === oldestWaiting(tr, c);
      out.push({ sev: !leads ? 1 : iss === 0 ? 3 : 2, text: `Register clash: ${label(tr, xid)} is ready, but it writes ${r} and ${label(tr, ref)} ${waw ? `has yet to write ${r} itself` : `has yet to read the value in ${r}`}. Without renaming, ${k} ${plural(k, 'instruction')} ${plural(k, 'waits', 'wait')} for a register name.` });
    }
  }
  if (cyc.board[c] === C.REGS) {
    out.push({ sev: iss === 0 ? 3 : 1, text: `All ${tr.RENAME} rename registers are taken by results still aboard, so the entrance holds new vehicles until older ones exit and free one.` });
  }
  const units = [['fpu', cyc.nUnitFpu], ['alu', cyc.nUnitAlu], ['lsu', cyc.nUnitLsu]];
  for (const [unit, arr] of units) {
    const k = arr[c];
    if (k > 0) out.push({ sev: 2, text: `${allUnits(unit, tr.unitCount[unit])} occupied here, so ${k} ${unitWork[unit]} ${plural(k, 'instruction')} waited.` });
  }
  if (cyc.nGates[c] > 0) {
    const k = cyc.nGates[c];
    const free = tr.MSHR - cyc.mshr[c];
    out.push({
      sev: 2,
      text: free <= 0
        ? `All ${tr.MSHR} memory ${plural(tr.MSHR, 'gate')} were busy with earlier misses, so ${k} ${plural(k, 'load')} waited to leave.`
        : `Only ${free} of ${tr.MSHR} memory gates ${plural(free, 'was', 'were')} free, too few for ${k} ${plural(k, 'load')} that ${plural(k, 'needs', 'need')} several at once.`,
    });
  }
  if (iss === 0 && cyc.nMem[c] > 0) {
    const k = cyc.nMem[c];
    const trips = cyc.memOut[c];
    out.push({ sev: 2, text: `Nothing departed: ${k} ${plural(k, 'instruction')} ${plural(k, 'is', 'are')} waiting on data from the caches or main memory${trips ? ` (${trips} ${plural(trips, 'trip')} under way)` : ''}.` });
  } else if (iss === 0 && cyc.nDep[c] > 0) {
    const b = oldestWaiting(tr, c);
    const k = cyc.nDep[c];
    out.push({ sev: 2, text: `Nothing departed: ${k} waiting ${plural(k, 'instruction')} ${plural(k, 'needs', 'need')} results that are not ready yet${b >= 0 ? `. ${label(tr, b)} ${stateClause(tr, b, c)}` : ''}.` });
  }
  if (cyc.gateQ[c] > 1) {
    out.push({ sev: 1, text: `${cyc.gateQ[c]} misses are queued at the memory line: it starts one 64-byte delivery every ${tr.BUS} ${plural(tr.BUS, 'cycle')}.` });
  }
  if (iss === W) out.push({ sev: 0, text: `Full service: all ${W} departure slots used this cycle.` });
  else if (iss > 0) out.push({ sev: 0, text: `${iss} of ${W} departure slots used; ${cyc.waiting[c]} ${plural(cyc.waiting[c], 'instruction')} waiting on the platform.` });
  if (!out.length) {
    if (cyc.rob[c] === 0 && cyc.fetchPtr[c] < tr.N) out.push({ sev: 1, text: 'The platform is empty while new instructions travel through the entrance.' });
    else if (iss === 0 && cyc.rob[c] > 0 && oldestWaiting(tr, c) < 0) out.push({ sev: 1, text: 'Every instruction aboard has departed; waiting for results to come back so they can exit in order.' });
    else if (iss === 0 && cyc.waiting[c] === 0 && cyc.rob[c] > 0) out.push({ sev: 1, text: 'New arrivals are boarding the platform; they can depart from the next cycle.' });
    else out.push({ sev: 0, text: 'Quiet cycle.' });
  }
  out.sort((a, b) => b.sev - a.sev);
  const top = out[0];
  return { tone: top.sev >= 3 ? 'severe' : top.sev >= 2 ? 'minor' : 'good', text: top.text, more: out.slice(1).map((x) => x.text) };
}

// The whole journey of one instruction, as a list of stops.
export function instrStory(tr, id) {
  const ins = tr.instrs[id];
  const ev = [];
  const f = tr.fetchC[id];
  const d = tr.dispC[id];
  const i = tr.issueC[id];
  const dn = tr.doneC[id];
  const r = tr.retireC[id];
  const totals = { entrance: 0, hold: 0, holdRegs: 0, dep: 0, mem: 0, unit: 0, order: 0, name: 0, width: 0, ride: 0, trip: 0, exitWait: 0 };

  ev.push({ c: f, kind: 'fetch', text: `Entered the network at the entrance, lane ${tr.feLane[id] + 1}.` });
  totals.entrance = Math.min(d, f + tr.FE) - f;
  // Held at the end of the entrance, split by why boarding stopped.
  const HOLD_TEXT = {
    [C.WINDOW]: 'Held at the end of the entrance: the platform was full.',
    [C.REGS]: `Held at the end of the entrance: all ${tr.RENAME} rename registers were taken.`,
    0: 'Waited at the end of the entrance while the vehicles ahead of it boarded.',
  };
  for (let c = f + tr.FE; c < d; ) {
    const why = tr.cyc.board[c] || 0;
    let e = c + 1;
    while (e < d && (tr.cyc.board[e] || 0) === why) e++;
    ev.push({ c, c2: e, kind: 'hold', code: why === C.REGS ? C.REGS : C.WINDOW, text: HOLD_TEXT[why] });
    if (why === C.REGS) totals.holdRegs += e - c;
    else totals.hold += e - c;
    c = e;
  }
  ev.push({ c: d, kind: 'board', text: `Boarded berth ${tr.slot[id] + 1} of ${tr.WIN}.${ins.dst >= 0 && tr.RENAME ? ` Its result will go to ${regName(ins.dst)}; renaming gives it a fresh register for that.` : ''}` });
  for (const [from, to, code, ref] of tr.waits[id]) {
    ev.push({ c: from, c2: to, kind: 'wait', code, ref, text: capitalize(waitClause(tr, id, code, ref)) + '.' });
    const n = to - from;
    if (code === C.DEP) totals.dep += n;
    else if (code === C.MEM || code === C.GATES) totals.mem += n;
    else if (code === C.UNIT) totals.unit += n;
    else if (code === C.ORDER) totals.order += n;
    else if (code === C.NAME) totals.name += n;
    else if (code === C.WIDTH) totals.width += n;
  }
  const unitName = UNIT_NOUN[ins.unit];
  const reads = ins.srcRegs.length ? `, reading ${joinList(ins.srcRegs.map(regName))}` : '';
  ev.push({
    c: i,
    kind: 'depart',
    text: `Departed for ${unitName} ${tr.unitIdx[id] + 1}${reads}${ins.vector ? ` as a SIMD group, ${ins.lanes} of ${ins.width} lanes filled` : ''}.`,
  });
  if (ins.type === 'load') {
    const lvl = tr.memLvl[id];
    const acc = accessesOf(tr, id);
    // The line whose data came back last decides when the load is done.
    const e = acc.reduce((a, b) => (b.fill > a.fill ? b : a), acc[0]);
    const why = localityWhy(tr, e, lvl === LVL.SHARED_L1 ? 'ride' : undefined);
    const span = acc.length > 1 ? ` It spans ${acc.length} lines; this is the one that took longest.` : '';
    if (lvl === LVL.L1) ev.push({ c: i + tr.L1LAT, kind: 'hit', loc: e.cls, ref: why.ref, text: `L1 hit, data back after ${tr.L1LAT} cycles: ${why.text}.${span}` });
    else if (lvl === LVL.SHARED_L1) ev.push({ c: i + tr.L1LAT, c2: dn, kind: 'shared', loc: e.cls, ref: why.ref, text: `Its line was still on its way to L1, so it rode along with that delivery: ${why.text}.${span}` });
    else if (lvl === LVL.L2) ev.push({ c: i + tr.L1LAT, c2: dn, kind: 'l2', loc: e.cls, ref: why.ref, text: `Missed L1: ${why.text}. Found in L2: round trip of ${dn - i} cycles.${span}` });
    else if (lvl === LVL.SHARED_L2) ev.push({ c: i + tr.L1LAT, c2: dn, kind: 'shared', loc: e.cls, ref: why.ref, text: `Missed L1: ${why.text}. L2 was already fetching this line, so it waited for that delivery.${span}` });
    else {
      const gate = tr.gateAt[id];
      const bus = tr.busAt[id];
      ev.push({ c: i + tr.L1LAT, kind: 'miss', loc: e.cls, ref: why.ref, text: `Missed ${tr.HAS_L2 ? 'L1 and L2' : 'L1'}: ${why.text}. Bound for main memory.${span}` });
      if (bus > gate) ev.push({ c: gate, c2: bus, kind: 'queue', code: C.MEM, text: `Queued ${bus - gate} ${plural(bus - gate, 'cycle')} at the memory line for bandwidth.` });
      ev.push({ c: bus, c2: dn, kind: 'trip', text: `Trip to main memory and back: ${tr.MEMLAT} cycles.` });
    }
    totals.trip = dn - i;
  } else {
    totals.ride = dn - i;
  }
  const doneText = ins.mispredict
    ? 'Resolved: the branch had been predicted wrong, so the entrance reopens now.'
    : ins.type === 'store'
      ? 'Address and data ready. The store is written to the cache when it exits.'
      : ins.type === 'branch'
        ? 'Resolved: the branch went the predicted way.'
        : `${ins.type === 'load' ? 'Data' : 'Result'} ready in ${regName(ins.dst)}; instructions waiting for it can use it now.`;
  ev.push({ c: dn, kind: 'done', text: doneText });
  if (r > dn + 1) {
    const b = retireBlocker(tr, id);
    ev.push({
      c: dn + 1,
      c2: r,
      kind: 'exitwait',
      code: C.ORDER,
      ref: b,
      text: b >= 0 ? `Finished, but exits in timetable order: waited for ${label(tr, b)}, which finished at cycle ${fmtInt(tr.doneC[b])}.` : 'Finished; waited for its turn to exit.',
    });
    totals.exitWait = r - dn - 1;
  }
  if (ins.type === 'store') {
    const acc = accessesOf(tr, id);
    const e = acc.find((x) => x.cls >= LOC.COLD) || acc[0];
    const why = localityWhy(tr, e);
    ev.push({ c: r, kind: 'exit', loc: e.cls, ref: why.ref, text: e.cls >= LOC.COLD ? `Exited, writing its data into L1, which had to bring the line in: ${why.text}.` : `Exited, writing its data into L1, where its line already was: ${why.text}.` });
  } else ev.push({ c: r, kind: 'exit', text: ins.dst >= 0 && tr.RENAME ? `Exited at the terminus. ${regName(ins.dst)} now officially holds its result, and the register that held the previous value of ${regName(ins.dst)} is free again.` : 'Exited at the terminus.' });

  // Cycles from entering to exiting. Besides the totals above, one cycle
  // goes to boarding (a vehicle departs the cycle after it boards at the
  // earliest) and one to exiting (the cycle after its result is ready).
  const lifetime = r - f;
  const waitsList = [
    ['dep', totals.dep, 'waiting for results from earlier instructions'],
    ['mem', totals.mem, 'waiting on memory'],
    ['unit', totals.unit, 'waiting for a free station'],
    ['order', totals.order, 'held by the fixed timetable'],
    ['name', totals.name, 'waiting for its register to be free'],
    ['width', totals.width, 'waiting for a departure slot'],
    ['hold', totals.hold, 'held outside the platform'],
    ['holdRegs', totals.holdRegs, 'held outside for want of a rename register'],
    ['exitWait', totals.exitWait, 'waiting to exit in order'],
  ].filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
  const waited = waitsList.reduce((a, x) => a + x[1], 0);
  let why;
  if (!waited) why = 'It never waited: every stop happened as soon as possible.';
  else {
    const parts = waitsList.slice(0, 3).map((x) => `${x[1]} ${plural(x[1], 'cycle')} ${x[2]}`);
    why = `It spent ${waited} of its ${lifetime} cycles waiting: ${joinList(parts)}.`;
  }
  return { events: ev, totals, lifetime, why };
}

export function describeInstr(tr, id) {
  const ins = tr.instrs[id];
  const w = tr.workload;
  const first = w.ops[ins.ops[0]];
  const def = OPS[ins.op];
  let what = def.name;
  if (ins.vector) what = `SIMD ${def.name.toLowerCase()}: ${ins.lanes} ${plural(ins.lanes, 'operation')} (#${ins.ops.join(', #')}) in one vehicle`;
  const where = [];
  if (first.vec) where.push(`element ${first.vec.elem + 1}${ins.vector && ins.lanes > 1 ? '–' + (first.vec.elem + ins.lanes) : ''} of loop ${first.vec.loop + 1}, which can be vectorized`);
  if (ins.lines) {
    const reg = regionOf(ins.lines[0]);
    const verb = ins.type === 'load' ? 'reads' : 'writes';
    where.push(ins.vector
      ? `it ${verb} ${ins.lanes} words of ${reg.name.toLowerCase()}, starting at ${hex(ins.addr)}, across ${ins.lines.length} ${plural(ins.lines.length, 'line')}`
      : `it ${verb} the 8-byte word at ${hex(ins.addr)} in ${reg.name.toLowerCase()}`);
  }
  if (ins.type === 'load' && first.src.length) {
    // A load's source is its address. Only a load feeding a load is a
    // pointer chase; otherwise an ordinary calculation produced it.
    const srcs = [...new Set(first.src.map((s) => tr.map[s]))];
    const names = joinList(srcs.map((j) => `${label(tr, j)} (${OPS[tr.instrs[j].op].short})`));
    where.push(srcs.some((j) => tr.instrs[j].type === 'load')
      ? `its address comes from an earlier load, ${names}, so it cannot start until that one returns`
      : `its address is calculated by ${names}, so it waits for that result`);
  }
  if (ins.mispredict) where.push('the branch predictor guesses this one wrong');
  const regs = [];
  if (ins.srcRegs.length) regs.push(`reads ${joinList(ins.srcRegs.map(regName))}`);
  if (ins.dst >= 0) regs.push(`writes its result to ${regName(ins.dst)}`);
  return { what, where, regs: regs.length ? capitalize(joinList(regs)) + '.' : '' };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Comparing two machines on the same workload.

export function compareNarrative(A, B) {
  const sa = A.stats;
  const sb = B.stats;
  const ta = A.trace;
  const tb = B.trace;
  const diff = describeDiff(A.cfg, B.cfg);
  const tRatio = sa.ns / sb.ns;
  let headline;
  if (Math.abs(tRatio - 1) < 0.02) headline = `${B.name} finishes in about the same time as ${A.name}.`;
  else if (tRatio > 1) headline = `${B.name} finishes ${fmtX(tRatio)} faster than ${A.name}.`;
  else headline = `${B.name} takes ${fmtX(1 / tRatio)} as long as ${A.name}.`;

  const notes = [];
  const add = (weight, text) => notes.push({ weight, text });
  const keys = new Set(diff.map((d) => d.key));
  const slotPct = (s, code) => s.slot[code] || 0;

  if (keys.has('ghz')) {
    const cr = sa.cycles / sb.cycles;
    add(Math.abs(Math.log(tRatio)) + 0.01, `At ${formatParam('ghz', B.cfg.ghz)} each cycle lasts ${(1 / B.cfg.ghz).toFixed(2)} ns instead of ${(1 / A.cfg.ghz).toFixed(2)} ns, but main memory is now ${tb.MEMLAT} cycles away instead of ${ta.MEMLAT}. ${B.name} used ${fmtInt(sb.cycles)} cycles to ${A.name}’s ${fmtInt(sa.cycles)}${Math.abs(cr - 1) > 0.02 ? '' : ', about the same'}.`);
  }
  if (keys.has('l1KB') || keys.has('l2KB')) {
    const saved = sa.trips - sb.trips;
    const which = keys.has('l2KB') && keys.has('l1KB') ? 'caches' : keys.has('l2KB') ? 'L2' : 'L1';
    const bigger = (keys.has('l2KB') ? B.cfg.l2KB > A.cfg.l2KB : B.cfg.l1KB > A.cfg.l1KB) ? 'larger' : 'smaller';
    if (saved >= 2) add(saved * tb.MEMLAT / Math.max(1, sb.cycles), `The ${bigger} ${which} avoided ${saved} long ${plural(saved, 'trip')} to main memory (${tb.MEMLAT} cycles each).`);
    else if (saved <= -2) add(-saved * tb.MEMLAT / Math.max(1, sb.cycles), `The ${bigger} ${which} forced ${-saved} extra ${plural(-saved, 'trip')} to main memory.`);
    else if (keys.has('l1KB') && Math.abs((sb.l1Rate || 0) - (sa.l1Rate || 0)) > 0.02) add(0.2, `L1 hit rate moved from ${pct(sa.l1Rate)} to ${pct(sb.l1Rate)}, but main-memory trips stayed about the same (${sa.trips} vs ${sb.trips}).`);
    else add(0.05, `The ${bigger} ${which} changed almost nothing: this timetable ${sa.trips === 0 ? 'already fits in the caches' : 'touches data that does not fit either way'}.`);
    // In L1 terms: lines pushed out for room and missed again later.
    const ea = sa.locN[LOC.EVICTED];
    const eb = sb.locN[LOC.EVICTED];
    const ca = sa.locN[LOC.COLD];
    const cb = sb.locN[LOC.COLD];
    if (keys.has('l1KB') && ea !== eb) add(0.1 + Math.abs(ea - eb) / Math.max(1, sa.locLoads), `Loads that missed L1 on a line it had pushed out for room went from ${ea} to ${eb}.${ca === cb ? (cb ? ` First-use misses stayed at ${cb}: no cache size avoids those.` : '') : ` First-use misses went from ${ca} to ${cb}.`}`);
  }
  if (keys.has('renameRegs')) {
    if (!A.cfg.renameRegs && B.cfg.renameRegs) {
      const gained = tRatio > 1.02;
      add(Math.max(0.15, slotPct(sa, C.NAME)), !sa.nameWait
        ? `Renaming changed nothing here: ${A.name} never had to wait to reuse a register name.`
        : gained
          ? `Renaming gave every result a fresh register, so nothing waited to reuse a register name. Without it, ${A.name}’s instructions spent ${fmtInt(sa.nameWait)} instruction-${plural(sa.nameWait, 'cycle')} waiting for older ones to finish with their register.`
          : `Renaming removed ${fmtInt(sa.nameWait)} instruction-${plural(sa.nameWait, 'cycle')} of waiting for register names, but ${B.cfg.ooo ? 'other waits took their place' : 'on a fixed-order network those instructions were held behind older ones anyway'}, so it saved no time.`);
    } else if (A.cfg.renameRegs && !B.cfg.renameRegs) {
      add(Math.max(0.15, slotPct(sb, C.NAME)), sb.nameWait
        ? `Without renaming each register holds one value at a time, so instructions spent ${fmtInt(sb.nameWait)} instruction-${plural(sb.nameWait, 'cycle')} waiting for older ones to finish with a register name they reuse (${pct(slotPct(sb, C.NAME))} of departure capacity). Loops suffer most: every pass reuses the same names.`
        : 'Without renaming, instructions still never had to wait for a register name here.');
    } else {
      add(0.1 + Math.abs(sa.regsHeld - sb.regsHeld) / Math.max(1, sa.cycles), `With ${B.cfg.renameRegs} rename registers, boarding stopped for want of one in ${fmtInt(sb.regsHeld)} ${plural(sb.regsHeld, 'cycle')} (was ${fmtInt(sa.regsHeld)} with ${A.cfg.renameRegs}). At most ${sb.writersPeak} were in use at once.`);
    }
  }
  if (keys.has('ooo')) {
    if (B.cfg.ooo) {
      const held = sa.orderWait;
      if (sb.overtakes < 3) add(0.3, `Dynamic routing found almost nothing to reorder: ${sb.overtakes === 0 ? 'no instruction' : `only ${sb.overtakes} ${plural(sb.overtakes, 'instruction')}`} could depart ahead of an older one, because each one needs the result before it.`);
      else add(Math.max(0.3, slotPct(sa, C.ORDER)), `With dynamic routing, ${fmtInt(sb.overtakes)} instructions departed ahead of an older one that was stuck. Under the fixed timetable, ready instructions spent ${fmtInt(held)} instruction-${plural(held, 'cycle')} held in line.`);
      if (sb.gatePeak > sa.gatePeak) add(0.2, `Up to ${sb.gatePeak} cache misses were in flight at once, versus ${sa.gatePeak} with fixed order.`);
    } else {
      add(Math.max(0.3, slotPct(sb, C.ORDER)), `Without dynamic routing, ready instructions spent ${fmtInt(sb.orderWait)} instruction-${plural(sb.orderWait, 'cycle')} held behind stuck ones.`);
    }
  }
  for (const [key, unit] of [['alu', 'alu'], ['fpu', 'fpu'], ['lsu', 'lsu']]) {
    if (!keys.has(key)) continue;
    const wa = sa.unitWait[unit];
    const wb = sb.unitWait[unit];
    const name = key === 'lsu' ? 'load/store port' : UNIT_LABEL[unit];
    const more = B.cfg[key] > A.cfg[key];
    if (more && wa - wb > 5) add((wa - wb) / Math.max(1, sa.cycles * ta.W), `More ${UNIT_PLURAL[unit]} shortened the queues: time spent waiting for a free ${name} fell from ${fmtInt(wa)} to ${fmtInt(wb)} instruction-cycles.`);
    else if (more) add(0.04, `The extra ${name} did little (${pct(sb.util[unit])} busy): instructions were rarely waiting for one.`);
    else if (wb - wa > 5) add((wb - wa) / Math.max(1, sb.cycles * tb.W), `With fewer ${UNIT_PLURAL[unit]}, instructions waited ${fmtInt(wb)} instruction-cycles for a free ${name} (was ${fmtInt(wa)}).`);
  }
  if (keys.has('simd')) {
    if (sb.vecInstrs === 0 && sa.vecInstrs === 0) add(0.04, 'Wider SIMD lanes did nothing here: none of this timetable is vectorizable.');
    else if (B.cfg.simd > A.cfg.simd) add(Math.max(0.1, (sa.N - sb.N) / Math.max(1, sa.N)), `SIMD ×${B.cfg.simd} packed ${fmtInt(sb.vecOps)} operations into ${fmtInt(sb.vecInstrs)} vehicles (${pct(sb.packFill)} of lanes filled), so ${B.name} needed ${fmtInt(sa.N - sb.N)} fewer departures (${fmtInt(sb.N)} instead of ${fmtInt(sa.N)}).`);
    else add(Math.max(0.1, (sb.N - sa.N) / Math.max(1, sb.N)), `Narrower SIMD means ${fmtInt(sb.N - sa.N)} more departures to carry the same work.`);
  }
  if (keys.has('width')) {
    const moved = Math.abs(sb.ipc - sa.ipc) / Math.max(sa.ipc, sb.ipc) > 0.03;
    add(
      0.15 + Math.abs(sb.ipc - sa.ipc) / Math.max(sa.ipc, sb.ipc),
      moved
        ? `A ${B.cfg.width}-wide network can board and depart up to ${B.cfg.width} instructions a cycle. Instructions per cycle went from ${sa.ipc.toFixed(2)} to ${sb.ipc.toFixed(2)}.`
        : `A ${B.cfg.width}-wide network could depart up to ${B.cfg.width} instructions a cycle, but it rarely had that many ready: instructions per cycle stayed near ${sb.ipc.toFixed(2)}.`,
    );
  }
  if (keys.has('window')) {
    add(0.1 + Math.abs(slotPct(sa, C.WINDOW) - slotPct(sb, C.WINDOW)), `With ${B.cfg.window} berths the network could look further ahead: on average ${sb.robAvg.toFixed(1)} instructions were aboard, versus ${sa.robAvg.toFixed(1)}. Platform-full time went from ${pct(slotPct(sa, C.WINDOW))} to ${pct(slotPct(sb, C.WINDOW))} of capacity.`);
  }
  if (keys.has('feDepth') && sa.mispredicts) {
    add(0.1 + Math.abs(slotPct(sa, C.BRANCH) - slotPct(sb, C.BRANCH)), `Each wrong-route branch costs a ${B.cfg.feDepth}-stop refill instead of ${A.cfg.feDepth}. Recovery used ${pct(slotPct(sb, C.BRANCH))} of capacity (was ${pct(slotPct(sa, C.BRANCH))}).`);
  }
  if (keys.has('memNs')) {
    add(0.1 + Math.abs(slotPct(sa, C.MEM) - slotPct(sb, C.MEM)), `Main memory is ${tb.MEMLAT} cycles away instead of ${ta.MEMLAT}. Average load time went from ${sa.avgLoad?.toFixed(1) ?? '—'} to ${sb.avgLoad?.toFixed(1) ?? '—'} cycles.`);
  }
  if (keys.has('memGBs')) {
    add(0.05 + Math.abs(sa.busWait - sb.busWait) / Math.max(1, sa.cycles), `The memory line starts a delivery every ${tb.BUS} ${plural(tb.BUS, 'cycle')} instead of ${ta.BUS}. Misses spent ${fmtInt(sb.busWait)} cycles queueing for bandwidth (was ${fmtInt(sa.busWait)}).`);
  }
  if (keys.has('mshr')) {
    add(0.05 + Math.abs(sa.gatesWait - sb.gatesWait) / Math.max(1, sa.cycles), `With ${B.cfg.mshr} memory ${plural(B.cfg.mshr, 'gate')}, up to ${sb.gatePeak} misses were outstanding at once (was ${sa.gatePeak}). Loads waiting for a gate: ${fmtInt(sb.gatesWait)} instruction-cycles (was ${fmtInt(sa.gatesWait)}).`);
  }

  notes.sort((a, b) => b.weight - a.weight);
  const limit = limitSentence(B.name, sb);
  if (Math.abs(tRatio - 1) < 0.03 && diff.length) notes.unshift({ weight: 9, text: `The change made little difference. ${limit}` });
  return { headline, diff, notes: notes.map((n) => n.text), limit };
}

// A short paragraph about one machine on its own.
export function machineSummary(M) {
  const s = M.stats;
  return `${M.name} ran ${fmtInt(s.N)} ${plural(s.N, 'vehicle')} in ${fmtInt(s.cycles)} cycles, using ${pct(s.slot[C.BUSY])} of its departure capacity. ${limitSentence('It', s).replace(/^It’s/, 'Its')}`;
}
