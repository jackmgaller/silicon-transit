// The cycle-level simulator. It runs a workload on one machine and records a
// complete trace: when each instruction was fetched, boarded, departed,
// finished and exited, why it waited in between, and per-cycle occupancy.
// Everything on screen is read from this trace.

import { OPS, C, LVL } from './isa.js';
import { Cache } from './cache.js';
import { memCycles, busCycles } from './machine.js';

// ---------------------------------------------------------------------------
// Lowering: turn the workload's scalar operations into this machine's
// instruction stream. SIMD machines pack vectorizable loop elements into
// vehicles that are `simd` lanes wide.

export function lower(workload, cfg) {
  const ops = workload.ops;
  const W = cfg.simd;
  const instrs = [];
  const map = new Int32Array(ops.length).fill(-1);

  const make = (laneOps, lanes, width, src, lines) => {
    const first = ops[laneOps[0]];
    const def = OPS[first.op];
    return {
      id: instrs.length,
      op: first.op,
      type: def.type,
      unit: def.unit,
      lat: def.lat,
      pipe: def.pipe,
      ops: laneOps,
      lanes,
      width,
      vector: width > 1,
      src,
      lines,
      addr: first.addr,
      mispredict: first.mispredict,
      loop: first.vec ? first.vec.loop : -1,
      num: laneOps[0],
    };
  };

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.vec && W > 1) {
      const loop = workload.loops[op.vec.loop];
      const { elems, slots, start } = loop;
      for (let c0 = 0; c0 < elems; c0 += W) {
        const lanes = Math.min(W, elems - c0);
        for (let s = 0; s < slots; s++) {
          const laneOps = [];
          for (let e = c0; e < c0 + lanes; e++) laneOps.push(start + e * slots + s);
          const id = instrs.length;
          const srcSet = new Set();
          for (const li of laneOps) {
            for (const si of ops[li].src) {
              const m = map[si];
              if (m >= 0 && m !== id) srcSet.add(m);
            }
          }
          let lines = null;
          if (ops[laneOps[0]].addr != null) {
            const ls = new Set();
            for (const li of laneOps) ls.add(ops[li].addr >>> 6);
            lines = [...ls];
          }
          instrs.push(make(laneOps, lanes, W, [...srcSet].sort((a, b) => a - b), lines));
          for (const li of laneOps) map[li] = id;
        }
      }
      i = start + elems * slots;
    } else {
      const id = instrs.length;
      const src = [...new Set(op.src.map((s) => map[s]).filter((m) => m >= 0))].sort((a, b) => a - b);
      instrs.push(make([i], 1, 1, src, op.addr != null ? [op.addr >>> 6] : null));
      map[i] = id;
      i++;
    }
  }
  return { instrs, map };
}

// Growable typed array for per-cycle records.
class Grow {
  constructor(T, n = 2048) {
    this.T = T;
    this.a = new T(n);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.T(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

export function simulate(workload, cfg) {
  const { instrs, map } = lower(workload, cfg);
  const N = instrs.length;
  const W = cfg.width | 0;
  const FE = cfg.feDepth | 0;
  const WIN = cfg.window | 0;
  const OOO = !!cfg.ooo;
  const L1LAT = Math.max(1, cfg.l1Lat | 0);
  const HAS_L2 = cfg.l2KB > 0;
  const L2LAT = HAS_L2 ? Math.max(cfg.l2Lat | 0, L1LAT + 2) : L1LAT;
  const MEMLAT = memCycles(cfg);
  const BUS = busCycles(cfg);
  const MSHR = Math.max(1, cfg.mshr | 0);
  const unitCount = { alu: cfg.alu | 0, fpu: cfg.fpu | 0, lsu: cfg.lsu | 0 };

  // Per-instruction record.
  const fetchC = new Int32Array(N).fill(-1);
  const dispC = new Int32Array(N).fill(-1);
  const issueC = new Int32Array(N).fill(-1);
  const doneC = new Int32Array(N).fill(-1);
  const retireC = new Int32Array(N).fill(-1);
  const slot = new Int32Array(N).fill(-1);
  const unitIdx = new Int8Array(N).fill(-1);
  const feLane = new Int8Array(N);
  const memLvl = new Int8Array(N).fill(-1);
  const gateAt = new Int32Array(N).fill(-1);
  const busAt = new Int32Array(N).fill(-1);
  const waits = new Array(N);
  const wCode = new Int8Array(N).fill(-1);
  const wRef = new Int32Array(N).fill(-1);
  const wFrom = new Int32Array(N).fill(-1);
  const root = new Int8Array(N).fill(-1);
  for (let k = 0; k < N; k++) waits[k] = [];

  // Caches, warmed with the workload's history if requested.
  const l1 = new Cache(cfg.l1KB * 1024, 8);
  const l2 = HAS_L2 ? new Cache(cfg.l2KB * 1024, 16) : null;
  if (workload.params.warm && workload.warmLines) {
    const wl = workload.warmLines;
    for (let k = 0; k < wl.length; k++) {
      if (l2) l2.access(wl[k]);
      l1.access(wl[k]);
    }
  }
  const l1Fill = new Map();
  const l2Fill = new Map();
  const mshrUntil = new Int32Array(MSHR);
  let busFree = 0;

  const unitFree = { alu: new Int32Array(unitCount.alu), fpu: new Int32Array(unitCount.fpu), lsu: new Int32Array(unitCount.lsu) };
  const unitBusy = { alu: 0, fpu: 0, lsu: 0 };
  const mem = { l1Hit: 0, l1Miss: 0, shared: 0, l2Hit: 0, l2Miss: 0, l2Shared: 0, trips: 0, busWait: 0 };
  const slotTotals = new Float64Array(16);
  const mispredicts = [];

  // Front-end, platform (reorder buffer) and retirement state.
  let fetchPtr = 0;
  let feHead = 0;
  const feCap = W * (FE + 1);
  let blockBr = -1;
  let brFrom = Infinity;
  let brUntil = -1;
  // Start of the current run of branch-recovery cycles. A wrong-route branch
  // fetched while the entrance is still refilling after the previous one
  // extends that run instead of starting a new one.
  let slotFrom = Infinity;
  let refillBr = -1;
  // Gates the last refused load needed at once (its wait reason's ref).
  let gatesNeeded = 0;
  const rob = new Int32Array(WIN);
  let robHead = 0;
  let robLen = 0;
  let retired = 0;
  const memActive = [];
  const lost = [];

  const cy = {
    issued: new Grow(Uint8Array),
    retired: new Grow(Uint8Array),
    rob: new Grow(Uint16Array),
    waiting: new Grow(Uint16Array),
    fetchPtr: new Grow(Int32Array),
    feHead: new Grow(Int32Array),
    mshr: new Grow(Uint8Array),
    gateQ: new Grow(Uint16Array),
    memOut: new Grow(Uint16Array),
    feBlock: new Grow(Int32Array),
    refill: new Grow(Int32Array),
    slots: new Grow(Uint8Array),
    busyAlu: new Grow(Uint8Array),
    busyFpu: new Grow(Uint8Array),
    busyLsu: new Grow(Uint8Array),
    nDep: new Grow(Uint16Array),
    nMem: new Grow(Uint16Array),
    nUnitAlu: new Grow(Uint16Array),
    nUnitFpu: new Grow(Uint16Array),
    nUnitLsu: new Grow(Uint16Array),
    nOrder: new Grow(Uint16Array),
    nWidth: new Grow(Uint16Array),
    nGates: new Grow(Uint16Array),
    nReady: new Grow(Uint16Array),
  };

  const closeWait = (id, c) => {
    if (wCode[id] >= 0) {
      waits[id].push([wFrom[id], c, wCode[id], wRef[id]]);
      wCode[id] = -1;
    }
  };
  const setWait = (id, code, ref, c) => {
    if (wCode[id] === code && wRef[id] === ref) return;
    closeWait(id, c);
    wCode[id] = code;
    wRef[id] = ref;
    wFrom[id] = c;
  };

  // A load departs: look up each line it touches, reserve memory gates and
  // bandwidth, and fix the cycle its data arrives. Returns false if it needs
  // a memory gate and none is free.
  function loadAccess(id, ins, c) {
    const lines = ins.lines;
    let needNew = 0;
    for (let q = 0; q < lines.length; q++) if (!l1.has(lines[q])) needNew++;
    if (needNew > 0) {
      let free = 0;
      for (let m = 0; m < MSHR; m++) if (mshrUntil[m] <= c) free++;
      if (free < Math.min(needNew, MSHR)) {
        gatesNeeded = Math.min(needNew, MSHR);
        return false;
      }
    }
    let worstDone = -1;
    let worstLvl = 0;
    let worstGate = -1;
    let worstBus = -1;
    for (let q = 0; q < lines.length; q++) {
      const ln = lines[q];
      let done;
      let lvl;
      let gA = -1;
      let bA = -1;
      if (l1.touch(ln)) {
        const f = l1Fill.get(ln);
        if (f !== undefined && f > c + L1LAT) {
          done = f;
          lvl = LVL.SHARED_L1;
          mem.shared++;
        } else {
          done = c + L1LAT;
          lvl = LVL.L1;
          mem.l1Hit++;
        }
      } else {
        mem.l1Miss++;
        l1.insert(ln);
        if (l2 && l2.touch(ln)) {
          const f2 = l2Fill.get(ln);
          if (f2 !== undefined && f2 > c + L2LAT) {
            done = f2;
            lvl = LVL.SHARED_L2;
            mem.l2Shared++;
          } else {
            done = c + L2LAT;
            lvl = LVL.L2;
            mem.l2Hit++;
          }
        } else {
          if (l2) {
            mem.l2Miss++;
            l2.insert(ln);
          }
          gA = c + L2LAT;
          bA = Math.max(gA, busFree);
          busFree = bA + BUS;
          mem.busWait += bA - gA;
          done = bA + MEMLAT;
          lvl = LVL.MEM;
          mem.trips++;
          if (l2) l2Fill.set(ln, done);
        }
        l1Fill.set(ln, done);
        let best = -1;
        for (let m = 0; m < MSHR; m++) {
          if (mshrUntil[m] <= c) {
            best = m;
            break;
          }
        }
        if (best < 0) {
          best = 0;
          for (let m = 1; m < MSHR; m++) if (mshrUntil[m] < mshrUntil[best]) best = m;
        }
        mshrUntil[best] = Math.max(mshrUntil[best], done);
      }
      if (done > worstDone) {
        worstDone = done;
        worstLvl = lvl;
        worstGate = gA;
        worstBus = bA;
      }
    }
    doneC[id] = worstDone;
    memLvl[id] = worstLvl;
    gateAt[id] = worstGate;
    busAt[id] = worstBus;
    if (worstLvl !== LVL.L1) memActive.push(id);
    return true;
  }

  const MAXC = 4000000;
  let c = 0;
  while (retired < N && c < MAXC) {
    // ---- Exit (retire) in program order from the head of the platform.
    let nRet = 0;
    while (nRet < W && robLen > 0) {
      const id = rob[robHead];
      if (doneC[id] < 0 || doneC[id] >= c) break;
      retireC[id] = c;
      const ins = instrs[id];
      if (ins.type === 'store') {
        for (const ln of ins.lines) {
          if (!l1.touch(ln)) {
            l1.insert(ln);
            l1Fill.delete(ln);
          }
          if (l2 && !l2.touch(ln)) {
            l2.insert(ln);
            l2Fill.delete(ln);
          }
        }
      }
      robHead = (robHead + 1) % WIN;
      robLen--;
      retired++;
      nRet++;
    }

    // ---- Departures (issue).
    let nIss = 0;
    let nWait = 0;
    let nReady = 0;
    lost.length = 0;
    let blocked = false;
    let blocker = -1;
    let nDep = 0, nMem = 0, nUA = 0, nUF = 0, nUL = 0, nOrd = 0, nWid = 0, nGat = 0;
    for (let k = 0; k < robLen; k++) {
      const id = rob[(robHead + k) % WIN];
      if (issueC[id] >= 0) continue;
      const ins = instrs[id];
      let blk = -1;
      let blkT = -1;
      let blkUn = false;
      for (let s = 0; s < ins.src.length; s++) {
        const p = ins.src[s];
        const d = doneC[p];
        if (d < 0) {
          if (!blkUn || p > blk) blk = p;
          blkUn = true;
        } else if (d > c && !blkUn && d > blkT) {
          blkT = d;
          blk = p;
        }
      }
      let code;
      let ref = -1;
      let rc;
      if (blk >= 0) {
        if (blkUn) {
          code = C.DEP;
          rc = root[blk] === C.MEM ? C.MEM : C.DEP;
        } else if (instrs[blk].type === 'load' && memLvl[blk] !== LVL.L1) {
          code = C.MEM;
          rc = C.MEM;
        } else {
          code = C.DEP;
          rc = C.DEP;
        }
        ref = blk;
        if (!OOO && !blocked) {
          blocked = true;
          blocker = id;
        }
      } else if (nIss >= W) {
        // Every departure slot is taken, so this ready instruction could not
        // have left this cycle whatever the timetable said.
        code = C.WIDTH;
        rc = C.WIDTH;
        nReady++;
      } else if (!OOO && blocked) {
        code = C.ORDER;
        ref = blocker;
        rc = C.ORDER;
        nReady++;
      } else {
        nReady++;
        const uf = unitFree[ins.unit];
        let u = -1;
        for (let q = 0; q < uf.length; q++) {
          if (uf[q] <= c) {
            u = q;
            break;
          }
        }
        if (u < 0) {
          code = C.UNIT;
          ref = ins.unit === 'alu' ? 0 : ins.unit === 'fpu' ? 1 : 2;
          rc = C.UNIT;
          if (!OOO && !blocked) {
            blocked = true;
            blocker = id;
          }
        } else if (ins.type === 'load' && !loadAccess(id, ins, c)) {
          code = C.GATES;
          ref = gatesNeeded;
          rc = C.MEM;
          if (!OOO && !blocked) {
            blocked = true;
            blocker = id;
          }
        } else {
          issueC[id] = c;
          unitIdx[id] = u;
          if (ins.type !== 'load') doneC[id] = c + ins.lat;
          uf[u] = ins.pipe ? c + 1 : c + ins.lat;
          unitBusy[ins.unit] += ins.pipe ? 1 : ins.lat;
          closeWait(id, c);
          nIss++;
          continue;
        }
      }
      setWait(id, code, ref, c);
      root[id] = rc;
      nWait++;
      if (rc !== C.WIDTH) lost.push(rc);
      switch (code) {
        case C.DEP: nDep++; break;
        case C.MEM: nMem++; break;
        case C.UNIT: if (ref === 0) nUA++; else if (ref === 1) nUF++; else nUL++; break;
        case C.ORDER: nOrd++; break;
        case C.WIDTH: nWid++; break;
        case C.GATES: nGat++; break;
      }
    }

    // ---- Boarding (dispatch) from the entrance onto the platform.
    let nD = 0;
    while (nD < W && feHead < fetchPtr && fetchC[feHead] + FE <= c && robLen < WIN) {
      const id = feHead++;
      dispC[id] = c;
      slot[id] = (robHead + robLen) % WIN;
      rob[slot[id]] = id;
      robLen++;
      nD++;
    }

    // ---- A wrong-route branch resolved: reopen the entrance.
    if (blockBr >= 0 && doneC[blockBr] >= 0 && doneC[blockBr] <= c) {
      brUntil = doneC[blockBr] + FE + 1;
      mispredicts.push({ id: blockBr, fetch: fetchC[blockBr], resolve: doneC[blockBr], starveFrom: brFrom, starveUntil: brUntil });
      refillBr = blockBr;
      blockBr = -1;
    }

    // ---- Fetch into the entrance.
    if (blockBr < 0) {
      let nF = 0;
      while (nF < W && fetchPtr < N && fetchPtr - feHead < feCap) {
        const id = fetchPtr++;
        fetchC[id] = c;
        // Lanes follow program order, so any W consecutive vehicles use
        // different lanes and a backed-up entrance queues per lane.
        feLane[id] = id % W;
        nF++;
        if (instrs[id].mispredict) {
          blockBr = id;
          brFrom = c + FE + 1;
          if (c >= brUntil) slotFrom = brFrom;
          brUntil = Infinity;
          break;
        }
      }
    }

    // ---- Account for every departure slot this cycle.
    const lostN = W - nIss;
    for (let k = 0; k < nIss; k++) cy.slots.push(C.BUSY);
    for (let k = 0; k < lostN; k++) {
      let code;
      if (k < lost.length) code = lost[k];
      else if (c >= slotFrom && c < brUntil) code = C.BRANCH;
      else if (robLen >= WIN) code = C.WINDOW;
      else if (fetchPtr >= N) code = C.DRAIN;
      else code = C.SUPPLY;
      cy.slots.push(code);
      slotTotals[code]++;
    }
    slotTotals[C.BUSY] += nIss;

    // Memory traffic snapshot.
    let gateQ = 0;
    let memOut = 0;
    for (let k = memActive.length - 1; k >= 0; k--) {
      const id = memActive[k];
      if (doneC[id] <= c) {
        memActive[k] = memActive[memActive.length - 1];
        memActive.pop();
        continue;
      }
      if (issueC[id] + L1LAT <= c) memOut++;
      if (gateAt[id] >= 0 && gateAt[id] <= c && c < busAt[id]) gateQ++;
    }
    let mshrBusy = 0;
    for (let m = 0; m < MSHR; m++) if (mshrUntil[m] > c) mshrBusy++;
    const busyOf = (arr) => {
      let n = 0;
      for (let q = 0; q < arr.length; q++) if (arr[q] > c) n++;
      return n;
    };

    cy.issued.push(nIss);
    cy.retired.push(nRet);
    cy.rob.push(robLen);
    cy.waiting.push(nWait);
    cy.fetchPtr.push(fetchPtr);
    cy.feHead.push(feHead);
    cy.mshr.push(mshrBusy);
    cy.gateQ.push(gateQ);
    cy.memOut.push(memOut);
    cy.feBlock.push(blockBr);
    cy.refill.push(blockBr < 0 && c < brUntil && refillBr >= 0 ? refillBr : -1);
    cy.busyAlu.push(busyOf(unitFree.alu));
    cy.busyFpu.push(busyOf(unitFree.fpu));
    cy.busyLsu.push(busyOf(unitFree.lsu));
    cy.nDep.push(nDep);
    cy.nMem.push(nMem);
    cy.nUnitAlu.push(nUA);
    cy.nUnitFpu.push(nUF);
    cy.nUnitLsu.push(nUL);
    cy.nOrder.push(nOrd);
    cy.nWidth.push(nWid);
    cy.nGates.push(nGat);
    cy.nReady.push(nReady);
    c++;
  }

  const cyc = {};
  for (const k of Object.keys(cy)) cyc[k] = cy[k].done();

  return {
    cfg,
    workload,
    instrs,
    map,
    N,
    W,
    FE,
    WIN,
    OOO,
    L1LAT,
    L2LAT,
    HAS_L2,
    MEMLAT,
    BUS,
    MSHR,
    unitCount,
    cycles: c,
    truncated: retired < N,
    fetchC,
    dispC,
    issueC,
    doneC,
    retireC,
    slot,
    unitIdx,
    feLane,
    memLvl,
    gateAt,
    busAt,
    waits,
    cyc,
    unitBusy,
    mem,
    slotTotals,
    mispredicts,
  };
}
