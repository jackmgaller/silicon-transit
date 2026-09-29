// Workload generator: a reproducible "timetable" of scalar operations.
// Every machine runs exactly this list; SIMD machines may pack groups of it
// into wider vehicles, but the work (and each operation's number) is shared.

import { makeRng } from './rng.js';
import { OPS, CLASS_OPS, VEC_OPS, hex } from './isa.js';

export const HOT_BASE = 0x00010000;
export const HOT_BYTES = 2048;
export const HEAP_BASE = 0x01000000;
export const ARRAY_BASE = 0x10000000;
export const ARRAY_STRIDE = 0x01000000;

export const PRESETS = [
  {
    id: 'independent',
    name: 'Independent Arithmetic',
    blurb: 'Plenty of unrelated math. Wide machines with many stations pull ahead.',
    params: { size: 220, mix: { int: 55, fp: 40, mem: 5, branch: 0 }, dependency: 0.06, locality: 0.92, vector: 0, predictability: 0.96 },
  },
  {
    id: 'chain',
    name: 'Dependency Chain',
    blurb: 'Every step needs the one before it. Extra hardware has nothing to do.',
    params: { size: 150, mix: { int: 50, fp: 45, mem: 5, branch: 0 }, dependency: 1, locality: 0.92, vector: 0, predictability: 0.96 },
  },
  {
    id: 'array',
    name: 'Array Processing',
    blurb: 'Loops that stream through arrays. Caches, overlap and SIMD all matter.',
    params: { size: 220, mix: { int: 15, fp: 35, mem: 45, branch: 5 }, dependency: 0.3, locality: 0.7, vector: 0.55, predictability: 0.94 },
  },
  {
    id: 'pointer',
    name: 'Pointer Chasing',
    blurb: 'Each load needs the address the previous load returned. Memory latency rules.',
    params: { size: 110, mix: { int: 25, fp: 0, mem: 70, branch: 5 }, dependency: 1, locality: 0.08, vector: 0, predictability: 0.9 },
  },
  {
    id: 'branchy',
    name: 'Branch Heavy',
    blurb: 'Decisions everywhere, and a third of them go the unexpected way.',
    params: { size: 200, mix: { int: 50, fp: 5, mem: 15, branch: 30 }, dependency: 0.35, locality: 0.85, vector: 0, predictability: 0.7 },
  },
  {
    id: 'simd',
    name: 'SIMD Friendly',
    blurb: 'The same math on long rows of data. Wide SIMD lanes carry it in bulk.',
    params: { size: 240, mix: { int: 5, fp: 55, mem: 40, branch: 0 }, dependency: 0.2, locality: 0.85, vector: 0.95, predictability: 0.96 },
  },
];

export const DEFAULT_WORKLOAD = { preset: 'array', seed: 2718, warm: true, ...PRESETS[2].params };

export function presetParams(id, base = {}) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[2];
  return { ...base, ...p.params, mix: { ...p.params.mix }, preset: p.id };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalizeWorkloadParams(p) {
  const mix = {
    int: Math.max(0, +p.mix?.int || 0),
    fp: Math.max(0, +p.mix?.fp || 0),
    mem: Math.max(0, +p.mix?.mem || 0),
    branch: Math.max(0, +p.mix?.branch || 0),
  };
  if (mix.int + mix.fp + mix.mem + mix.branch <= 0) mix.int = 1;
  return {
    size: clamp(Math.round(+p.size || 200), 24, 1000),
    mix,
    dependency: clamp(+p.dependency || 0, 0, 1),
    locality: clamp(+p.locality || 0, 0, 1),
    vector: clamp(+p.vector || 0, 0, 1),
    predictability: clamp(p.predictability == null ? 0.95 : +p.predictability, 0.5, 1),
    warm: p.warm !== false,
    seed: (Math.abs(Math.round(+p.seed || 1)) % 1000000) || 1,
    preset: p.preset || 'custom',
  };
}

function pickWeighted(rng, table) {
  return table[rng.weighted(table.map((t) => t[1]))][0];
}

function mergeStreams(streams) {
  const total = streams.reduce((a, s) => a + s.length, 0);
  const out = new Uint32Array(total);
  const pos = streams.map(() => 0);
  for (let o = 0; o < total; o++) {
    let best = -1;
    let bestT = Infinity;
    for (let k = 0; k < streams.length; k++) {
      const p = pos[k];
      if (p < streams[k].length) {
        const t = (p + 0.5) / streams[k].length;
        if (t < bestT) {
          bestT = t;
          best = k;
        }
      }
    }
    out[o] = streams[best][pos[best]++];
  }
  return out;
}

export function generateWorkload(params) {
  const P = normalizeWorkloadParams(params);
  const N = P.size;
  const rK = makeRng(P.seed, 'kinds');
  const rD = makeRng(P.seed, 'deps');
  const rA = makeRng(P.seed, 'addr');
  const rB = makeRng(P.seed, 'branch');
  const rV = makeRng(P.seed, 'vector');
  const rT = makeRng(P.seed, 'value-type');
  const rW = makeRng(P.seed, 'warm');

  const loc = P.locality;
  const heapBytes = Math.max(4096, 64 * Math.round(Math.pow(2, 22 - 10 * loc) / 64));
  const arrayBytes = Math.max(4096, 64 * Math.round(Math.pow(2, 23 - 11 * loc) / 64));
  const pHot = 0.5 * loc * loc;
  const pSeq = 0.45 * loc;

  const mixSum = P.mix.int + P.mix.fp + P.mix.mem + P.mix.branch;
  const share = {
    int: P.mix.int / mixSum,
    fp: P.mix.fp / mixSum,
    mem: P.mix.mem / mixSum,
    branch: P.mix.branch / mixSum,
  };
  const target = { int: share.int * N, fp: share.fp * N, mem: share.mem * N, branch: share.branch * N };
  const made = { int: 0, fp: 0, mem: 0, branch: 0 };
  const fpLoadShare = share.fp + share.int > 0 ? share.fp / (share.fp + share.int) : 0.5;

  const ops = [];
  const loops = [];
  const arrays = [];
  const prodAll = [];
  const prodI = [];
  const prodF = [];
  const heap = { off: rA.int(0, heapBytes / 8 - 1) * 8 };

  const vecTarget = N * P.vector;
  let vecMade = 0;

  function pickClass(rng, allowBranch) {
    const classes = allowBranch ? ['int', 'fp', 'mem', 'branch'] : ['int', 'fp', 'mem'];
    let w = classes.map((c) => Math.max(0, target[c] - made[c]));
    if (w.every((x) => x <= 1e-9)) w = classes.map((c) => share[c]);
    if (w.every((x) => x <= 1e-9)) w = classes.map((c) => (c === 'int' ? 1 : 0));
    return classes[rng.weighted(w)];
  }

  function scalarAddr(rng, st) {
    const u = rng.next();
    if (u < pHot) return HOT_BASE + rng.int(0, HOT_BYTES / 8 - 1) * 8;
    if (u < pHot + pSeq) {
      st.off = (st.off + 8) % heapBytes;
      return HEAP_BASE + st.off;
    }
    st.off = rng.int(0, heapBytes / 8 - 1) * 8;
    return HEAP_BASE + st.off;
  }

  function addProducer(i, vt) {
    prodAll.push(i);
    (vt === 'f' ? prodF : prodI).push(i);
  }

  function pickArray() {
    if (arrays.length && rV.next() < loc * 0.7) return arrays[rV.int(0, arrays.length - 1)];
    const a = {
      id: arrays.length,
      base: ARRAY_BASE + arrays.length * ARRAY_STRIDE,
      bytes: arrayBytes,
      cursor: 0,
      start: 0,
    };
    a.cursor = a.start = rV.int(0, arrayBytes / 8 - 1);
    arrays.push(a);
    return a;
  }

  function emitScalarBlock(len) {
    for (let k = 0; k < len && ops.length < N; k++) {
      const cls = pickClass(rK, true);
      const op = pickWeighted(rK, CLASS_OPS[cls]);
      const def = OPS[op];
      const i = ops.length;
      const src = [];
      const nSrc = def.type === 'load' || def.type === 'branch' ? 1 : 2;
      for (let j = 0; j < nSrc; j++) {
        if (rD.next() < P.dependency) {
          let pool = prodAll;
          if (j > 0) {
            const typed = def.cls === 'fp' ? prodF : prodI;
            if (typed.length) pool = typed;
          }
          const back = 1 + rD.geometric((1 - P.dependency) * 0.8);
          if (pool.length >= back) {
            const s = pool[pool.length - back];
            if (!src.includes(s)) src.push(s);
          }
        }
      }
      const o = { i, op, cls, type: def.type, src, addr: null, mispredict: false, vec: null, vt: null };
      if (def.type === 'load' || def.type === 'store') o.addr = scalarAddr(rA, heap);
      if (def.type === 'branch') o.mispredict = rB.next() > P.predictability;
      if (def.type === 'load') o.vt = rT.next() < fpLoadShare ? 'f' : 'i';
      else if (def.cls === 'fp') o.vt = 'f';
      else if (def.cls === 'int') o.vt = 'i';
      ops.push(o);
      made[cls]++;
      if (o.vt) addProducer(i, o.vt);
    }
  }

  function emitVectorLoop(maxOps) {
    let ws = [Math.max(0, target.int - made.int), Math.max(0, target.fp - made.fp), Math.max(0, target.mem - made.mem)];
    if (ws[0] + ws[1] + ws[2] <= 1e-9) ws = [share.int, share.fp, share.mem];
    if (ws[0] + ws[1] + ws[2] <= 1e-9) return false;
    const S = rV.int(3, 6);
    const classes = [];
    for (let s = 0; s < S; s++) classes.push(['int', 'fp', 'mem'][rV.weighted(ws)]);
    const nMem = classes.filter((c) => c === 'mem').length;
    const nStore = nMem >= 2 ? 1 : 0;
    const nLoad = nMem - nStore;
    const computes = classes.filter((c) => c !== 'mem');
    const tpl = [];
    for (let k = 0; k < nLoad; k++) tpl.push({ op: 'load', cls: 'mem', deps: [], arr: pickArray() });
    for (const cc of computes) {
      const op = pickWeighted(rV, VEC_OPS[cc]);
      const deps = [];
      if (tpl.length) {
        deps.push(tpl.length - 1);
        if (tpl.length > 1 && rV.next() < 0.6) deps.push(rV.int(0, tpl.length - 2));
      }
      tpl.push({ op, cls: cc, deps, arr: null });
    }
    for (let k = 0; k < nStore; k++) tpl.push({ op: 'store', cls: 'mem', deps: tpl.length ? [tpl.length - 1] : [], arr: pickArray() });

    const per = tpl.length;
    const L = Math.min(rV.int(6, 20), Math.floor(maxOps / per));
    if (L < 2) return false;
    const loopId = loops.length;
    const start = ops.length;
    const loadVt = computes.includes('fp') ? 'f' : 'i';
    for (let e = 0; e < L; e++) {
      const base = ops.length;
      for (let s = 0; s < per; s++) {
        const t = tpl[s];
        const def = OPS[t.op];
        const o = {
          i: ops.length,
          op: t.op,
          cls: t.cls,
          type: def.type,
          src: t.deps.map((d) => base + d),
          addr: null,
          mispredict: false,
          vec: { loop: loopId, elem: e, slot: s },
          vt: null,
        };
        if (t.arr) o.addr = t.arr.base + (((t.arr.cursor + e) * 8) % t.arr.bytes);
        if (def.type === 'load') o.vt = loadVt;
        else if (def.cls === 'fp') o.vt = 'f';
        else if (def.cls === 'int') o.vt = 'i';
        ops.push(o);
        made[t.cls]++;
        if (o.vt) addProducer(o.i, o.vt);
      }
    }
    for (const a of new Set(tpl.filter((t) => t.arr).map((t) => t.arr))) a.cursor += L;
    loops.push({ id: loopId, start, elems: L, slots: per, ops: tpl.map((t) => t.op) });
    vecMade += L * per;
    return true;
  }

  let guard = 0;
  while (ops.length < N && guard++ < 10000) {
    const remaining = N - ops.length;
    const frac = ops.length ? vecMade / ops.length : 0;
    let did = false;
    if (P.vector > 0.001 && vecMade + 2 <= vecTarget && frac <= P.vector) {
      did = emitVectorLoop(Math.min(remaining, Math.ceil(vecTarget - vecMade) + 4));
    }
    if (!did) emitScalarBlock(Math.min(remaining, rK.int(5, 12)));
  }

  // Warm-up history: what the caches would hold if this code had been running
  // for a while. Heap lines are drawn from the same access pattern; arrays
  // replay the part of their sweep just before the timed region.
  const scalarMem = ops.filter((o) => o.addr != null && !o.vec).length;
  const streams = [];
  if (scalarMem > 0) {
    // A sweep first, so a heap small enough to fit is fully resident, then
    // a stretch of history drawn from the real access pattern.
    const heapLines = heapBytes / 64;
    const sweep = heapLines <= 32768 ? heapLines : 0;
    const H = Math.min(60000, Math.max(1024, Math.round(3 * heapLines)));
    const st = { off: rW.int(0, heapBytes / 8 - 1) * 8 };
    const hs = new Uint32Array(sweep + H + HOT_BYTES / 64);
    let k = 0;
    for (let j = 0; j < sweep; j++) hs[k++] = (HEAP_BASE >>> 6) + j;
    for (let j = 0; j < HOT_BYTES / 64; j++) hs[k++] = (HOT_BASE >>> 6) + j;
    for (let j = 0; j < H; j++) hs[k++] = scalarAddr(rW, st) >>> 6;
    streams.push(hs);
  }
  if (arrays.length) {
    const per = Math.floor(40000 / arrays.length);
    for (const a of arrays) {
      const lines = a.bytes / 64;
      const K = Math.min(lines, per);
      const startLine = Math.floor((a.start * 8) / 64);
      const s = new Uint32Array(K);
      for (let j = 0; j < K; j++) s[j] = (a.base >>> 6) + ((((startLine - K + j) % lines) + lines) % lines);
      streams.push(s);
    }
  }
  const warmLines = streams.length ? mergeStreams(streams) : new Uint32Array(0);

  const counts = { int: 0, fp: 0, load: 0, store: 0, branch: 0 };
  let mispredicts = 0;
  for (const o of ops) {
    counts[o.type]++;
    if (o.mispredict) mispredicts++;
  }

  return {
    params: P,
    ops,
    loops,
    arrays: arrays.map((a) => ({ id: a.id, base: a.base, bytes: a.bytes })),
    warmLines,
    summary: {
      N: ops.length,
      counts,
      vecOps: vecMade,
      loops: loops.length,
      arrays: arrays.length,
      heapBytes,
      arrayBytes,
      scalarMem,
      mispredicts,
    },
  };
}

// A short assembly-like description of one scalar operation.
export function opLabel(o) {
  const def = OPS[o.op];
  const refs = (list) => list.map((s) => '#' + s).join(', ');
  if (def.type === 'load') return `load ${o.src.length ? '[via #' + o.src[0] + ']' : '[' + hex(o.addr) + ']'}`;
  if (def.type === 'store') return `store [${hex(o.addr)}]${o.src.length ? ' ← ' + refs(o.src) : ''}`;
  if (def.type === 'branch') return `br${o.src.length ? ' if #' + o.src[0] : ''}`;
  return `${def.short}${o.src.length ? ' ← ' + refs(o.src) : ''}`;
}

export function formatBytes(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(b % 1048576 ? 1 : 0) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
