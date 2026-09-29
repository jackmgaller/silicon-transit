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
    params: { size: 220, mix: { int: 55, fp: 40, mem: 5, branch: 0 }, dependency: 0.06, spatial: 0.9, temporal: 0.92, vector: 0, predictability: 0.96 },
  },
  {
    id: 'chain',
    name: 'Dependency Chain',
    blurb: 'Every step needs the one before it. Extra hardware has nothing to do.',
    params: { size: 150, mix: { int: 50, fp: 45, mem: 5, branch: 0 }, dependency: 1, spatial: 0.9, temporal: 0.92, vector: 0, predictability: 0.96 },
  },
  {
    id: 'array',
    name: 'Array Processing',
    blurb: 'Loops that stream through arrays. Caches, overlap and SIMD all matter.',
    params: { size: 220, mix: { int: 15, fp: 35, mem: 45, branch: 5 }, dependency: 0.3, spatial: 0.85, temporal: 0.6, vector: 0.55, predictability: 0.94 },
  },
  {
    id: 'pointer',
    name: 'Pointer Chasing',
    blurb: 'Each load needs the address the previous load returned. Memory latency rules.',
    params: { size: 110, mix: { int: 25, fp: 0, mem: 70, branch: 5 }, dependency: 1, spatial: 0.05, temporal: 0.08, vector: 0, predictability: 0.9 },
  },
  {
    id: 'branchy',
    name: 'Branch Heavy',
    blurb: 'Decisions everywhere, and a third of them go the unexpected way.',
    params: { size: 200, mix: { int: 50, fp: 5, mem: 15, branch: 30 }, dependency: 0.35, spatial: 0.8, temporal: 0.85, vector: 0, predictability: 0.7 },
  },
  {
    id: 'simd',
    name: 'SIMD Friendly',
    blurb: 'The same math on long rows of data. Wide SIMD lanes carry it in bulk.',
    params: { size: 240, mix: { int: 5, fp: 55, mem: 40, branch: 0 }, dependency: 0.2, spatial: 0.95, temporal: 0.75, vector: 0.95, predictability: 0.96 },
  },
];

// Kinds of branch site. Predictability sets how many are data-dependent
// (no predictor can learn those) and how often the rest break their habit.
export const SITE_KINDS = {
  loop: { label: 'loop', plural: 'loops', many: 'loop branches' },
  pattern: { label: 'pattern', plural: 'patterns', many: 'branches with a repeating pattern' },
  biased: { label: 'one-way', plural: 'one-way', many: 'branches that nearly always go the same way' },
  follow: { label: 'follower', plural: 'followers', many: 'branches that follow the branch before them' },
  random: { label: 'data-dependent', plural: 'data-dependent', many: 'data-dependent branches' },
};

export const DEFAULT_WORKLOAD = { preset: 'array', seed: 2718, warm: true, ...PRESETS[2].params };

export function presetParams(id, base = {}) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[2];
  return { ...base, ...p.params, mix: { ...p.params.mix }, preset: p.id };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A pointer chase at this size runs ~700k cycles and keeps ~55 MB of trace
// per network, which is about as far as a browser tab should be pushed.
export const MAX_SIZE = 10000;

export function normalizeWorkloadParams(p) {
  const mix = {
    int: Math.max(0, +p.mix?.int || 0),
    fp: Math.max(0, +p.mix?.fp || 0),
    mem: Math.max(0, +p.mix?.mem || 0),
    branch: Math.max(0, +p.mix?.branch || 0),
  };
  if (mix.int + mix.fp + mix.mem + mix.branch <= 0) mix.int = 1;
  // Older timetables had one locality knob; it sets both kinds.
  const loc = p.locality == null ? 0.5 : +p.locality;
  return {
    size: clamp(Math.round(+p.size || 200), 24, MAX_SIZE),
    mix,
    dependency: clamp(+p.dependency || 0, 0, 1),
    spatial: clamp(p.spatial == null ? loc : +p.spatial || 0, 0, 1),
    temporal: clamp(p.temporal == null ? loc : +p.temporal || 0, 0, 1),
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
  const rS = makeRng(P.seed, 'branch-sites');
  const rV = makeRng(P.seed, 'vector');
  const rT = makeRng(P.seed, 'value-type');
  const rW = makeRng(P.seed, 'warm');

  // Temporal locality: how soon data is used again. It shrinks the working
  // set, sends more accesses to a small hot region and re-reads recently
  // used words. Spatial locality: how often the next access lands next door.
  // It makes scalar accesses walk to the neighboring word and arrays run in
  // order rather than a line apart.
  const S = P.spatial;
  const T = P.temporal;
  const heapBytes = Math.max(4096, 64 * Math.round(Math.pow(2, 22 - 10 * T) / 64));
  const arrayBytes = Math.max(4096, 64 * Math.round(Math.pow(2, 23 - 11 * T) / 64));
  const pReuse = 0.4 * T;
  const pHot = 0.5 * T * T;
  const pSeq = 0.7 * S;
  const pRevisit = T;

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

  // Branch sites: the handful of places in the code the branches come from.
  // Each dynamic branch belongs to one, usually the next one along, as when
  // the same code runs again, and goes the way its site's habit says.
  const nSites = Math.max(1, Math.min(16, Math.ceil(target.branch / 6)));
  const flip = 0.005 + 0.1 * (1 - P.predictability);
  const shareRandom = Math.min(1, 2 * (1 - P.predictability));
  const nRandom = Math.floor(nSites * shareRandom) + (rS.next() < (nSites * shareRandom) % 1 ? 1 : 0);
  const sites = [];
  for (let k = 0; k < nSites; k++) {
    const kind = k < nRandom ? 'random' : ['biased', 'loop', 'pattern', 'follow'][rS.weighted([0.5, 0.3, 0.1, 0.1])];
    const site = { id: k, kind, back: kind === 'loop', pos: 0 };
    if (kind === 'random') site.p = 0.35 + 0.3 * rS.next();
    else if (kind === 'biased') site.way = rS.next() < 0.5;
    else if (kind === 'loop') site.period = rS.int(4, 16);
    else if (kind === 'pattern') {
      const len = rS.int(2, 4);
      do site.pattern = Array.from({ length: len }, () => rS.next() < 0.5);
      while (site.pattern.every((t) => t === site.pattern[0]));
    } else site.invert = rS.next() < 0.3;
    sites.push(site);
  }
  // Shuffle so data-dependent sites are not always the first ones.
  for (let k = sites.length - 1; k > 0; k--) {
    const j = rS.int(0, k);
    [sites[k], sites[j]] = [sites[j], sites[k]];
  }
  sites.forEach((st, k) => (st.id = k));
  let prevSite = sites.length - 1;
  let lastTaken = false;
  function nextBranch(rng) {
    const s = rng.next() < 0.7 ? (prevSite + 1) % sites.length : rng.int(0, sites.length - 1);
    const st = sites[s];
    let t;
    if (st.kind === 'random') t = rng.next() < st.p;
    else {
      if (st.kind === 'biased') t = st.way;
      else if (st.kind === 'loop') t = st.pos < st.period - 1;
      else if (st.kind === 'pattern') t = st.pattern[st.pos % st.pattern.length];
      else t = st.invert ? !lastTaken : lastTaken;
      st.pos = (st.pos + 1) % (st.kind === 'loop' ? st.period : st.kind === 'pattern' ? st.pattern.length : 1);
      if (rng.next() < flip) t = !t;
    }
    prevSite = s;
    lastTaken = t;
    return [s, t];
  }
  // Warm-up history: the branches earlier runs of this code went through,
  // so a warm predictor has already learned each site's habit.
  const nWarm = Math.min(4096, 128 * nSites);
  const warmBranches = { site: new Uint8Array(nWarm), taken: new Uint8Array(nWarm) };
  if (target.branch > 0) {
    for (let k = 0; k < nWarm; k++) {
      const [s, t] = nextBranch(rB);
      warmBranches.site[k] = s;
      warmBranches.taken[k] = t ? 1 : 0;
    }
  }

  const ops = [];
  const loops = [];
  const arrays = [];
  const prodAll = [];
  const prodI = [];
  const prodF = [];
  const heap = { off: rA.int(0, heapBytes / 8 - 1) * 8, recent: [] };

  const vecTarget = N * P.vector;
  let vecMade = 0;

  function pickClass(rng, allowBranch) {
    const classes = allowBranch ? ['int', 'fp', 'mem', 'branch'] : ['int', 'fp', 'mem'];
    let w = classes.map((c) => Math.max(0, target[c] - made[c]));
    if (w.every((x) => x <= 1e-9)) w = classes.map((c) => share[c]);
    if (w.every((x) => x <= 1e-9)) w = classes.map((c) => (c === 'int' ? 1 : 0));
    return classes[rng.weighted(w)];
  }

  // One scalar access: re-read a word used a moment ago, touch the small hot
  // region, walk on to the next word, or land anywhere in the heap.
  function scalarAddr(rng, st) {
    let addr;
    if (st.recent.length && rng.next() < pReuse) {
      const back = Math.min(st.recent.length - 1, rng.geometric(0.45));
      addr = st.recent[st.recent.length - 1 - back];
    } else if (rng.next() < pHot) {
      addr = HOT_BASE + rng.int(0, HOT_BYTES / 8 - 1) * 8;
    } else {
      if (rng.next() < pSeq) st.off = (st.off + 8) % heapBytes;
      else st.off = rng.int(0, heapBytes / 8 - 1) * 8;
      addr = HEAP_BASE + st.off;
    }
    st.recent.push(addr);
    if (st.recent.length > 12) st.recent.shift();
    return addr;
  }

  function addProducer(i, vt) {
    prodAll.push(i);
    (vt === 'f' ? prodF : prodI).push(i);
  }

  // Arrays are read in order (8-byte steps, eight elements per line) or,
  // with less spatial locality, a whole line apart (like walking down a
  // column of a matrix).
  // A program works on a handful of arrays; longer timetables run more
  // loops over the same ones rather than inventing new ones.
  const MAX_ARRAYS = 6;
  function pickArray(avoid) {
    const free = arrays.filter((a) => !avoid.has(a));
    if (arrays.length >= MAX_ARRAYS) {
      const pool = free.length ? free : arrays;
      return pool[rV.int(0, pool.length - 1)];
    }
    if (free.length && rV.next() < 0.5) return free[rV.int(0, free.length - 1)];
    const a = {
      id: arrays.length,
      base: ARRAY_BASE + arrays.length * ARRAY_STRIDE,
      bytes: arrayBytes,
      stride: rV.next() < S ? 8 : 64,
      cursor: 0,
      start: 0,
      segs: [],
    };
    a.cursor = a.start = rV.int(0, arrayBytes / a.stride - 1);
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
      const o = { i, op, cls, type: def.type, src, addr: null, site: -1, taken: false, vec: null, vt: null };
      if (def.type === 'load' || def.type === 'store') o.addr = scalarAddr(rA, heap);
      if (def.type === 'branch') [o.site, o.taken] = nextBranch(rB);
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
    // Each load in the body reads a different array.
    const loaded = new Set();
    for (let k = 0; k < nLoad; k++) {
      const arr = pickArray(loaded);
      loaded.add(arr);
      tpl.push({ op: 'load', cls: 'mem', deps: [], arr });
    }
    for (const cc of computes) {
      const op = pickWeighted(rV, VEC_OPS[cc]);
      const deps = [];
      if (tpl.length) {
        deps.push(tpl.length - 1);
        if (tpl.length > 1 && rV.next() < 0.6) deps.push(rV.int(0, tpl.length - 2));
      }
      tpl.push({ op, cls: cc, deps, arr: null });
    }
    for (let k = 0; k < nStore; k++) tpl.push({ op: 'store', cls: 'mem', deps: tpl.length ? [tpl.length - 1] : [], arr: pickArray(new Set()) });

    const per = tpl.length;
    const L = Math.min(rV.int(6, 20), Math.floor(maxOps / per));
    if (L < 2) return false;
    const loopId = loops.length;
    const start = ops.length;
    const loadVt = computes.includes('fp') ? 'f' : 'i';
    // Each array either carries on from where it stopped or, with temporal
    // locality, goes back over a stretch an earlier loop already read.
    const from = new Map();
    for (const a of new Set(tpl.filter((t) => t.arr).map((t) => t.arr))) {
      if (a.segs.length && rV.next() < pRevisit) from.set(a, a.segs[rV.int(0, a.segs.length - 1)]);
      else {
        from.set(a, a.cursor);
        a.segs.push(a.cursor);
        a.cursor += L;
      }
    }
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
          site: -1,
          taken: false,
          vec: { loop: loopId, elem: e, slot: s },
          vt: null,
        };
        if (t.arr) o.addr = t.arr.base + (((from.get(t.arr) + e) * t.arr.stride) % t.arr.bytes);
        if (def.type === 'load') o.vt = loadVt;
        else if (def.cls === 'fp') o.vt = 'f';
        else if (def.cls === 'int') o.vt = 'i';
        ops.push(o);
        made[t.cls]++;
        if (o.vt) addProducer(o.i, o.vt);
      }
    }
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
    const st = { off: rW.int(0, heapBytes / 8 - 1) * 8, recent: [] };
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
      const startLine = Math.floor((a.start * a.stride) / 64);
      const s = new Uint32Array(K);
      for (let j = 0; j < K; j++) s[j] = (a.base >>> 6) + ((((startLine - K + j) % lines) + lines) % lines);
      streams.push(s);
    }
  }
  const warmLines = streams.length ? mergeStreams(streams) : new Uint32Array(0);

  // The program's own locality, whatever the caches: does each access, in
  // program order, reuse a word used before, land on a line used before,
  // or touch a new line?
  const seenWord = new Set();
  const seenLine = new Set();
  const locality = { reuse: 0, near: 0, fresh: 0 };
  for (const o of ops) {
    if (o.addr == null) continue;
    if (seenWord.has(o.addr >>> 3)) locality.reuse++;
    else if (seenLine.has(o.addr >>> 6)) locality.near++;
    else locality.fresh++;
    seenWord.add(o.addr >>> 3);
    seenLine.add(o.addr >>> 6);
  }

  const counts = { int: 0, fp: 0, load: 0, store: 0, branch: 0 };
  const siteKinds = Object.fromEntries(Object.keys(SITE_KINDS).map((k) => [k, 0]));
  const siteSeen = new Set();
  for (const o of ops) {
    counts[o.type]++;
    if (o.type === 'branch' && !siteSeen.has(o.site)) {
      siteSeen.add(o.site);
      siteKinds[sites[o.site].kind]++;
    }
  }

  return {
    params: P,
    ops,
    loops,
    arrays: arrays.map((a) => ({ id: a.id, base: a.base, bytes: a.bytes, stride: a.stride })),
    warmLines,
    branchSites: sites.map(({ pos, ...st }) => st),
    warmBranches,
    summary: {
      N: ops.length,
      counts,
      vecOps: vecMade,
      loops: loops.length,
      arrays: arrays.length,
      inOrderArrays: arrays.filter((a) => a.stride === 8).length,
      heapBytes,
      arrayBytes,
      scalarMem,
      branchSites: siteSeen.size,
      siteKinds,
      locality,
      lines: seenLine.size,
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
