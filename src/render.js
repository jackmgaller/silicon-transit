// Canvas renderer for one machine's transit map. Everything drawn here is a
// pure function of the simulation trace and the display time t (in cycles):
// at integer t every vehicle sits where the trace says it was during that
// cycle; between integers it travels along the network to its next spot.

import { X, computeLayout } from './layout.js';
import { PAL, withAlpha } from './palette.js';
import { C, LVL, OPS, LOC, NREG, regName } from './isa.js';
import { waitAt, headAt, oldestWaiting, fmtInt, cycleAt, regVersions, writersAt, yardModel, lineWhere, accessesOf } from './analysis.js';

const DEPOT_N = 6;
export const K = { DEPOT: 0, FE: 1, BERTH: 2, UNIT: 3, MEM: 4, EXIT: 5 };
const AT = { PATH: 0, L1: 1, BAY: 2, GATE: 3 };
const EMPTY = new Map();

const STOP_WORD = { in: 'in', board: 'board', depart: 'depart', done: 'done', exit: 'exit' };

const easeIO = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const lerp = (a, b, u) => a + (b - a) * u;

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

// Point at fraction u along a polyline.
function along(pts, u) {
  if (pts.length === 1 || u <= 0) return pts[0];
  if (u >= 1) return pts[pts.length - 1];
  let total = 0;
  const lens = [];
  for (let k = 1; k < pts.length; k++) {
    const l = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
    lens.push(l);
    total += l;
  }
  if (total < 0.001) return pts[pts.length - 1];
  let d = u * total;
  for (let k = 0; k < lens.length; k++) {
    if (d <= lens[k]) {
      const f = lens[k] ? d / lens[k] : 0;
      return { x: lerp(pts[k].x, pts[k + 1].x, f), y: lerp(pts[k].y, pts[k + 1].y, f) };
    }
    d -= lens[k];
  }
  return pts[pts.length - 1];
}

export class NetworkView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.dpr = 1;
    this.cssW = 0;
    this.staticCanvas = null;
    this.selected = -1;
    this.linked = null;
    this.hover = -1;
    this.journey = null;
    this.consumers = null;
    this.frame = [];
  }

  setMachine(M) {
    this.M = M;
    this.tr = M.trace;
    this.L = computeLayout(this.tr);
    this.staticCanvas = null;
    this.journey = null;
    this.consumers = null;
    this.yardGeom = null;
    this.hoverLine = null;
    this.hoverReg = -1;
    if (this.selected >= this.tr.N) this.selected = -1;
    if (this.cssW) this.resize(this.cssW, true);
  }

  resize(cssW, force) {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (!force && cssW === this.cssW && dpr === this.dpr) return;
    this.cssW = cssW;
    this.dpr = dpr;
    this.scale = cssW / 1200;
    const cssH = Math.round(this.L.H * this.scale);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.staticCanvas = null;
  }

  invalidate() {
    this.staticCanvas = null;
  }

  // ------------------------------------------------------------------------
  // Where is instruction `id` during cycle c?

  snap(id, c) {
    const tr = this.tr;
    const f = tr.fetchC[id];
    if (c < f) {
      const n = id - this.depotHead(c);
      return n >= 0 && n < DEPOT_N ? { k: K.DEPOT, n } : null;
    }
    const d = tr.dispC[id];
    if (c < d) {
      const fh = c < tr.cycles ? tr.cyc.feHead[c] : tr.N;
      const g = Math.floor((id - fh) / tr.W);
      const stop = Math.max(0, Math.min(c - f, tr.FE - g));
      return { k: K.FE, stop, lane: tr.feLane[id] };
    }
    const i = tr.issueC[id];
    if (c < i) {
      const w = waitAt(tr, id, c);
      return { k: K.BERTH, slot: tr.slot[id], st: 0, code: w ? w[2] : -1 };
    }
    const dn = tr.doneC[id];
    if (c < dn) {
      const ins = tr.instrs[id];
      if (ins.type !== 'load') return { k: K.UNIT, unit: ins.unit, idx: tr.unitIdx[id], p: (c - i + 1) / (dn - i) };
      return this.memSnap(id, c, i, dn);
    }
    const r = tr.retireC[id];
    if (c < r) return { k: K.BERTH, slot: tr.slot[id], st: 1, code: -1 };
    const age = c - r;
    return age <= 1 ? { k: K.EXIT, n: age, slot: tr.slot[id] } : null;
  }

  // First instruction not yet fetched at cycle c (the top of the depot board).
  depotHead(c) {
    const tr = this.tr;
    return c < 0 ? 0 : c < tr.cycles ? tr.cyc.fetchPtr[c] : tr.N;
  }

  memSnap(id, c, i, dn) {
    const tr = this.tr;
    const L = this.L;
    if (c === i) return { k: K.UNIT, unit: 'lsu', idx: tr.unitIdx[id], p: 1 };
    const T0 = i + tr.L1LAT;
    if (c < T0) return { k: K.MEM, at: AT.L1, d: 0 };
    const lvl = tr.memLvl[id];
    if (lvl === LVL.SHARED_L1) return { k: K.MEM, at: AT.BAY, d: 0 };
    if (lvl === LVL.L2 || lvl === LVL.SHARED_L2) {
      const u = (c - T0 + 1) / (dn - T0);
      return { k: K.MEM, at: AT.PATH, d: u <= 0.5 ? u * 2 * L.dL2 : (1 - (u - 0.5) * 2) * L.dL2 };
    }
    const gate = tr.gateAt[id];
    const bus = tr.busAt[id];
    if (c < gate) return { k: K.MEM, at: AT.PATH, d: ((c - T0 + 1) / Math.max(1, gate - T0)) * L.dGate };
    if (c < bus) return { k: K.MEM, at: AT.GATE, d: L.dGate };
    const u = (c - bus + 1) / (dn - bus);
    return { k: K.MEM, at: AT.PATH, d: u <= 0.5 ? L.dGate + (L.dTurn - L.dGate) * u * 2 : L.dTurn * (1 - (u - 0.5) * 2) };
  }

  posOf(s, id, ranks) {
    const L = this.L;
    switch (s.k) {
      case K.DEPOT:
        return { x: X.depot, y: L.depotY0 + s.n * L.depotStep };
      case K.FE:
        return { x: s.stop >= this.tr.FE ? X.holdX : L.stopX[s.stop], y: L.laneY[s.lane] };
      case K.BERTH:
        return L.berth(s.slot);
      case K.UNIT: {
        const t = L.tracks[s.unit][s.idx];
        return { x: t.x0 + 16 + s.p * (t.x1 - t.x0 - 32), y: t.y };
      }
      case K.MEM: {
        if (s.at === AT.L1) return { x: L.l1.x + ((id % 3) - 1) * 4, y: L.l1.y + ((id % 2) * 2 - 1) * 3 };
        if (s.at === AT.BAY) {
          const r = ranks.get(id) || 0;
          return { x: L.l1.x - 15 + (r % 4) * 10, y: L.l1.y - L.l1.r - 12 - Math.floor(r / 4) * 9 };
        }
        if (s.at === AT.GATE) {
          const r = ranks.get(id) || 0;
          return L.memPoint(Math.max(2, L.dGate - 3 - r * 12));
        }
        return L.memPoint(s.d);
      }
      case K.EXIT: {
        if (s.n === 0) return { x: L.berth(s.slot).x, y: L.termY };
        return { x: L.termSignX + 10, y: L.termY };
      }
    }
    return { x: 0, y: 0 };
  }

  sizeOf(s) {
    const L = this.L;
    switch (s.k) {
      case K.BERTH:
        return [L.bw - 1.5, L.bh - 1.5];
      case K.UNIT:
        return [26, L.S > 1 ? L.bundleH - 2 : 11];
      case K.DEPOT:
        return [22, 11];
      case K.FE:
        return [19, 10];
      default:
        return [18, 10];
    }
  }

  // Waypoints between two snapshots, so vehicles follow the network's lines.
  // A result riding home stops at its register on the board first.
  route(a, b, pa, pb, id = -1) {
    const L = this.L;
    const dst = id >= 0 ? this.tr.instrs[id].dst : -1;
    const home = (pts, x, y) => {
      const ay = L.aisleY(pb.row);
      if (dst >= 0 && dst < NREG) {
        const cell = L.reg.cells[dst];
        const below = L.reg.y1 + 5;
        pts.push({ x, y }, { x: cell.cx, y }, { x: cell.cx, y: cell.cy }, { x: cell.cx, y: below }, { x: pb.x, y: below }, { x: pb.x, y: ay }, pb);
      } else pts.push({ x, y }, { x: pb.x, y }, { x: pb.x, y: ay }, pb);
      return pts;
    };
    if (a.k === K.MEM && b.k === K.MEM) {
      if (a.at === AT.PATH && b.at === AT.PATH) return L.memBetween(a.d, b.d);
      return [pa, pb];
    }
    if (a.k === b.k) return [pa, pb];
    if (a.k === K.DEPOT && b.k === K.FE) return [pa, { x: X.entX0 - 14, y: pb.y }, pb];
    if (a.k === K.FE && b.k === K.BERTH) {
      const ay = L.aisleY(pb.row);
      return [pa, { x: X.holdX + 6, y: pa.y }, { x: L.gridX0 - 5, y: ay }, { x: pb.x, y: ay }, pb];
    }
    if (a.k === K.BERTH && b.k === K.UNIT) {
      const ay = L.aisleY(pa.row);
      const t = L.tracks[b.unit][b.idx];
      return [pa, { x: pa.x, y: ay }, { x: L.gridX1 + 6, y: ay }, { x: X.busX, y: ay }, { x: X.busX, y: t.y }, { x: t.x0 + 4, y: t.y }, pb];
    }
    if (a.k === K.UNIT && b.k === K.BERTH) return home([pa, { x: X.riserX, y: pa.y }], X.riserX, L.returnY);
    if (a.k === K.UNIT && b.k === K.MEM) {
      const pts = [pa, { x: X.trackX1 + 8, y: pa.y }, { x: L.l1.x, y: L.l1.y }];
      if (b.at === AT.PATH && b.d > 0) pts.push(...L.memBetween(0, b.d).slice(1));
      pts.push(pb);
      return pts;
    }
    if (a.k === K.MEM && b.k === K.BERTH) {
      const pts = a.at === AT.PATH && a.d > 0 ? L.memBetween(a.d, 0) : [pa];
      pts.push({ x: L.l1.x, y: L.l1.y }, { x: X.riserX, y: L.l1.y });
      return home(pts, X.riserX, L.returnY);
    }
    return [pa, pb];
  }

  // Range of instruction ids that may be visible around cycle c.
  visibleRange(c) {
    const tr = this.tr;
    if (c >= tr.cycles + 2) return [0, -1];
    let lo = 0;
    let hi = tr.N - 1;
    const want = c - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tr.retireC[mid] >= want) hi = mid;
      else lo = mid + 1;
    }
    const fp = c + 1 < tr.cycles ? tr.cyc.fetchPtr[Math.max(0, c + 1)] : tr.N;
    return [lo, Math.min(tr.N - 1, fp + DEPOT_N)];
  }

  // Compute every visible vehicle's position for display time t.
  layoutFrame(t, linear) {
    const tr = this.tr;
    const L = this.L;
    let c = cycleAt(t);
    let u = Math.max(0, t - c);
    if (c >= tr.cycles) {
      c = tr.cycles;
      u = 0;
    }
    const e = linear ? u : u < 0.74 ? easeIO(u / 0.74) : 1;
    const [lo, hi] = this.visibleRange(c);
    const items = [];
    for (let id = lo; id <= hi; id++) {
      const a = this.snap(id, c);
      const b = this.snap(id, c + 1);
      if (!a && !b) continue;
      items.push({ id, a, b });
    }
    const rankA = new Map();
    const rankB = new Map();
    const rank = (key, map, filter, order) => {
      const list = items.filter((it) => it[key] && filter(it[key]));
      list.sort(order);
      list.forEach((it, k) => map.set(it.id, k));
    };
    const bus = (x, y) => tr.busAt[x.id] - tr.busAt[y.id] || x.id - y.id;
    const byId = (x, y) => x.id - y.id;
    rank('a', rankA, (s) => s.k === K.MEM && s.at === AT.GATE, bus);
    rank('b', rankB, (s) => s.k === K.MEM && s.at === AT.GATE, bus);
    const bayA = new Map();
    const bayB = new Map();
    rank('a', bayA, (s) => s.k === K.MEM && s.at === AT.BAY, byId);
    rank('b', bayB, (s) => s.k === K.MEM && s.at === AT.BAY, byId);
    for (const it of items) {
      const ra = it.a && it.a.at === AT.BAY ? bayA : rankA;
      const rb = it.b && it.b.at === AT.BAY ? bayB : rankB;
      // A vehicle joining the depot board rides up from below it with the
      // queue, rather than appearing on top of the vehicles moving up.
      const joining = !it.a && it.b && it.b.k === K.DEPOT;
      const from = joining ? { k: K.DEPOT, n: it.id - this.depotHead(c) } : it.a;
      const pa = from ? this.posOf(from, it.id, ra) : null;
      const pb = it.b ? this.posOf(it.b, it.id, rb) : null;
      let p;
      let alpha = 1;
      let size;
      if (pa && pb) {
        const moving = pa.x !== pb.x || pa.y !== pb.y;
        p = moving ? along(this.route(from, it.b, pa, pb, it.id), e) : pa;
        const sa = this.sizeOf(from);
        const sb = this.sizeOf(it.b);
        size = [lerp(sa[0], sb[0], e), lerp(sa[1], sb[1], e)];
        if (joining) alpha = Math.max(0, Math.min(1, (DEPOT_N - 0.5 - (p.y - L.depotY0) / L.depotStep) * 2));
      } else if (pa) {
        p = pa;
        size = this.sizeOf(it.a);
        alpha = 1 - e;
      } else {
        p = pb;
        size = this.sizeOf(it.b);
        alpha = e;
      }
      it.x = p.x;
      it.y = p.y;
      it.w = size[0];
      it.h = size[1];
      it.alpha = alpha;
      it.s = e < 0.5 ? it.a || it.b : it.b || it.a;
    }
    this.frame = items;
    this.frameC = c;
    this.frameE = e;
    return { c, u, e, items };
  }

  hit(mx, my) {
    const pad = 3;
    for (let k = this.frame.length - 1; k >= 0; k--) {
      const it = this.frame[k];
      if (it.alpha < 0.3) continue;
      if (Math.abs(mx - it.x) <= it.w / 2 + pad && Math.abs(my - it.y) <= it.h / 2 + pad) return it.id;
    }
    // A reserved berth belongs to the vehicle that is away executing.
    const L = this.L;
    const tr = this.tr;
    const c = this.frameC;
    const head = headAt(tr, c);
    if (head < 0) return -1;
    for (let id = head; id < tr.N && tr.dispC[id] <= c && tr.dispC[id] >= 0; id++) {
      const b = L.berth(tr.slot[id]);
      if (Math.abs(mx - b.x) <= L.bw / 2 + 1 && Math.abs(my - b.y) <= L.bh / 2 + 1) return id;
    }
    return -1;
  }

  vehicleAt(id) {
    return this.frame.find((it) => it.id === id) || null;
  }

  // ------------------------------------------------------------------------
  // Drawing.

  draw(t, opts = {}) {
    const ctx = this.ctx;
    const tr = this.tr;
    const L = this.L;
    if (!this.staticCanvas) this.drawStatic();
    const sc = this.scale * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(sc, 0, 0, sc, 0, 0);

    const T = Math.max(0, t);
    const { c, e, items } = this.layoutFrame(T, opts.linear);
    const done = c >= tr.cycles;

    this.drawBerthState(c, items);
    this.drawSignals(c, T);
    this.drawUnitsState(items, c);
    this.drawMemoryState(c, T, items);
    this.drawRegisters(c, T, items);
    this.drawYard(c, T, items);

    const selId = this.selected;
    const hasSel = selId >= 0;
    let related = null;
    if (hasSel) {
      related = new Set(tr.instrs[selId].src);
      related.add(selId);
      for (const k of this.consumersOf(selId)) related.add(k);
      this.drawJourney(selId);
    }
    // Dynamic routing: vehicles departing past an older, stuck one get a glow.
    // Vehicles departing between c and c+1 glow when an older one is still
    // stuck after that departure (it is being overtaken).
    const oldest = tr.OOO && !done ? oldestWaiting(tr, c + 1) : -1;
    for (const it of items) {
      const dim = hasSel && !related.has(it.id);
      if (oldest >= 0 && it.id > oldest && it.a && it.a.k === K.BERTH && it.b && (it.b.k === K.UNIT || it.b.k === K.MEM) && e > 0.02 && e < 0.98) {
        this.glow(it, dim ? 0.2 : 1 - Math.abs(e - 0.5) * 1.6);
      }
      this.drawVehicle(it, dim ? 0.28 : 1, it.id === selId, it.id === this.hover);
    }
    if (this.linked) for (const it of items) if (this.linked.has(it.id)) this.ring(it, PAL.accent, 3);
    if (hasSel) this.drawDeps(selId, items);
    this.drawCounters(c, done);
    if (done) this.drawComplete();
  }

  consumersOf(id) {
    if (!this.consumers) {
      this.consumers = Array.from({ length: this.tr.N }, () => []);
      for (const ins of this.tr.instrs) for (const p of ins.src) this.consumers[p].push(ins.id);
    }
    return this.consumers[id];
  }

  textWidth(text, size, weight, spacing = 0) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${PAL.fontUi}`;
    ctx.letterSpacing = spacing + 'px';
    const w = ctx.measureText(text).width;
    ctx.letterSpacing = '0px';
    return w;
  }

  label(text, x, y, opts = {}) {
    const ctx = this.ctx;
    ctx.font = `${opts.weight || 700} ${opts.size || 9}px ${opts.mono ? PAL.fontMono : PAL.fontUi}`;
    ctx.fillStyle = opts.color || PAL.ink2;
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.base || 'middle';
    if (opts.spacing) ctx.letterSpacing = opts.spacing + 'px';
    ctx.fillText(text, x, y);
    if (opts.spacing) ctx.letterSpacing = '0px';
  }

  drawStatic() {
    const L = this.L;
    const tr = this.tr;
    const cfg = tr.cfg;
    const cv = document.createElement('canvas');
    cv.width = this.canvas.width;
    cv.height = this.canvas.height;
    const ctx = cv.getContext('2d');
    const saved = this.ctx;
    this.ctx = ctx;
    const sc = this.scale * this.dpr;
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Map paper with a faint survey grid.
    ctx.fillStyle = PAL.card;
    ctx.fillRect(0, 0, 1200, L.H);
    ctx.fillStyle = PAL.grid;
    for (let x = 12; x < 1200; x += 24) for (let y = 12; y < L.H; y += 24) ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);

    // Region captions.
    const cap = (title, sub, x) => {
      this.label(title, x, 14, { size: 9, weight: 800, color: PAL.ink, spacing: 1.4, align: 'center' });
      this.label(sub, x, 26, { size: 8.5, weight: 500, color: PAL.ink3, align: 'center' });
    };
    cap('NEXT UP', 'program order', X.depotBoard);
    cap('ENTRANCE', `fetch & decode · ${tr.FE} stops`, (X.entX0 + X.entX1) / 2 + 4);
    cap('PLATFORM', `instruction window · ${tr.WIN} berths`, (X.platX0 + X.platX1) / 2);
    cap('STATIONS', 'execution units', (X.plateX + X.trackX1) / 2);
    cap('MEMORY LINE', 'caches → main memory', 1030);

    // Return line (finished vehicles ride back to their berths).
    ctx.strokeStyle = PAL.ret;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    const trackYs = [...L.tracks.alu, ...L.tracks.fpu, ...L.tracks.lsu].map((t) => t.y);
    const riserBottom = Math.max(...trackYs, L.l1.y);
    ctx.moveTo(X.riserX, riserBottom);
    ctx.lineTo(X.riserX, L.returnY);
    ctx.lineTo(L.reg.cells[0].cx, L.returnY);
    for (const y of trackYs) {
      ctx.moveTo(X.trackX1 + 2, y);
      ctx.lineTo(X.riserX, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    this.label('return line · results ride home via their register', X.riserX - 6, L.returnY - 7, { size: 7.5, weight: 600, color: PAL.ink3, align: 'right' });

    // Depot board.
    ctx.fillStyle = withAlpha('#FFFFFF', 0.75);
    ctx.strokeStyle = PAL.rule;
    ctx.lineWidth = 1;
    rr(ctx, 12, L.depotY0 - 13, 96, DEPOT_N * L.depotStep + 8, 9);
    ctx.fill();
    ctx.stroke();

    // Entrance lanes with their stops.
    for (let l = 0; l < tr.W; l++) {
      const y = L.laneY[l];
      ctx.strokeStyle = PAL.entrance;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(X.entX0 - 14, y);
      ctx.lineTo(X.holdX + 6, y);
      ctx.stroke();
      for (let s = 0; s < tr.FE; s++) {
        ctx.beginPath();
        ctx.arc(L.stopX[s], y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = PAL.ink2;
        ctx.stroke();
      }
    }

    // Platform box and berths.
    ctx.fillStyle = withAlpha('#FFFFFF', 0.82);
    ctx.strokeStyle = PAL.rule2;
    ctx.lineWidth = 1.2;
    rr(ctx, X.platX0, L.platY0, X.platX1 - X.platX0, L.platY1 - L.platY0, 12);
    ctx.fill();
    ctx.stroke();
    const routeTitle = cfg.ooo ? 'DYNAMIC ROUTING' : 'FIXED ORDER';
    this.label(routeTitle, X.platX0 + 12, L.platY0 + 12, { size: 8, weight: 800, color: cfg.ooo ? PAL.accent : PAL.ink2, spacing: 1 });
    const titleW = this.textWidth(routeTitle, 8, 800, 1);
    this.label(cfg.ooo ? 'any ready vehicle may depart' : 'departures strictly in order', X.platX0 + 12 + titleW + 7, L.platY0 + 12, { size: 7.5, weight: 500, color: PAL.ink3 });
    for (let s = 0; s < tr.WIN; s++) {
      const b = L.berth(s);
      rr(ctx, b.x - L.bw / 2, b.y - L.bh / 2, L.bw, L.bh, Math.min(3, L.bh / 3));
      ctx.fillStyle = '#F1F3F2';
      ctx.fill();
      ctx.strokeStyle = PAL.rule;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Register board: sixteen names, each showing whose result it holds.
    const R = L.reg;
    ctx.fillStyle = withAlpha('#FFFFFF', 0.82);
    ctx.strokeStyle = PAL.rule2;
    ctx.lineWidth = 1.2;
    rr(ctx, R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0, 10);
    ctx.fill();
    ctx.stroke();
    this.label('REGISTERS', R.x0 + 12, R.headY, { size: 8, weight: 800, color: PAL.ink, spacing: 1 });
    const regTitleW = this.textWidth('REGISTERS', 8, 800, 1);
    this.label(tr.RENAME ? `16 names · renamed with ${tr.RENAME} spares` : '16 names · no renaming: one value per name', R.x0 + 12 + regTitleW + 7, R.headY, { size: 7.5, weight: 500, color: PAL.ink3 });
    for (let r = 0; r < NREG; r++) {
      const cell = R.cells[r];
      rr(ctx, cell.x, cell.y, cell.w, cell.h, 4);
      ctx.fillStyle = '#F1F3F2';
      ctx.fill();
      ctx.strokeStyle = PAL.rule;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      this.label(regName(r), cell.x + 8, cell.cy + 0.5, { size: 7, weight: 700, mono: true, color: PAL.ink2, align: 'center' });
    }

    // Cache yard: the lines this program touches, in address order.
    const Y = L.yard;
    const yg = this.yardLayout();
    ctx.fillStyle = withAlpha('#FFFFFF', 0.78);
    ctx.strokeStyle = PAL.rule2;
    ctx.lineWidth = 1.2;
    rr(ctx, Y.x0, Y.y0, Y.x1 - Y.x0, Y.y1 - Y.y0, 10);
    ctx.fill();
    ctx.stroke();
    this.label('CACHE LINES', Y.x0 + 10, Y.y0 + 10, { size: 8, weight: 800, color: PAL.ink, spacing: 1 });
    const yardTitleW = this.textWidth('CACHE LINES', 8, 800, 1);
    this.label('8 words each', Y.x0 + 10 + yardTitleW + 6, Y.y0 + 10, { size: 7.5, weight: 500, color: PAL.ink3 });
    for (const lb of yg.labels) this.label(lb.name.toUpperCase(), Y.x0 + 9, lb.y, { size: 6.5, weight: 800, color: PAL.ink3, spacing: 0.3 });
    if (!yg.cars.length) this.label('this timetable never touches memory', (Y.x0 + Y.x1) / 2, (Y.y0 + Y.y1) / 2, { size: 8, weight: 600, color: PAL.ink3, align: 'center' });
    // Legend: seat colors, then where a line is.
    let lx = Y.x0 + 10;
    const ly = Y.y1 - 8;
    const key = (draw, text) => {
      draw(lx, ly);
      this.label(text, lx + 9, ly + 0.5, { size: 6.5, weight: 700, color: PAL.ink2 });
      lx += 9 + this.textWidth(text, 6.5, 700) + 8;
    };
    const seat = (col) => (x, y) => {
      ctx.fillStyle = col;
      ctx.fillRect(x, y - 3, 6, 6);
    };
    const car = (stroke, fill, dash) => (x, y) => {
      rr(ctx, x - 0.5, y - 3, 7, 6, 1.5);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.setLineDash(dash ? [1.5, 1.2] : []);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    key(seat(PAL.loc[LOC.REUSE]), 'reused');
    key(seat(PAL.loc[LOC.NEAR]), 'neighbor');
    key(seat(PAL.loc[LOC.EVICTED]), 'missed');
    key(car(PAL.memL1, '#FFFFFF'), 'in L1');
    if (tr.HAS_L2) key(car(PAL.mem, '#E9F0FA'), 'L2');
    key(car(withAlpha('#7C8594', 0.7), null, true), 'memory');
    // A thin siding from L1 up to the yard.
    ctx.strokeStyle = withAlpha(PAL.memL1.startsWith('#') ? PAL.memL1 : '#06A3C4', 0.45);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(L.l1.x, L.l1.y - L.l1.r - 2);
    ctx.lineTo(L.l1.x, Y.y1);
    ctx.stroke();
    ctx.setLineDash([]);

    // Interchange bus from platform to stations.
    const allTracks = [...L.tracks.alu, ...L.tracks.fpu, ...L.tracks.lsu];
    const top = Math.min(L.yc, allTracks[0].y);
    const bot = Math.max(L.yc, allTracks[allTracks.length - 1].y);
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(X.platX1, L.yc);
    ctx.lineTo(X.busX, L.yc);
    ctx.moveTo(X.busX, top);
    ctx.lineTo(X.busX, bot);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    for (const t of allTracks) {
      ctx.beginPath();
      ctx.moveTo(X.busX, t.y);
      ctx.lineTo(t.x0, t.y);
      ctx.stroke();
    }
    // Interchange glyph.
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2;
    rr(ctx, X.busX - 9, L.yc - 13, 18, 26, 9);
    ctx.fill();
    ctx.stroke();
    if (cfg.ooo) {
      ctx.strokeStyle = PAL.accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const dy of [-6, 0, 6]) {
        ctx.moveTo(X.busX - 4, L.yc);
        ctx.lineTo(X.busX + 4, L.yc + dy);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(X.busX - 4, L.yc);
      ctx.lineTo(X.busX + 4, L.yc);
      ctx.moveTo(X.busX - 4, L.yc - 6);
      ctx.lineTo(X.busX - 4, L.yc + 6);
      ctx.stroke();
    }

    // Station groups and tracks.
    const latTicks = { alu: 1, fpu: 4, lsu: 1 };
    for (const g of L.groups) {
      const col = PAL.unit[g.unit];
      this.label(`${g.name.toUpperCase()} · ${g.n} ${g.unit === 'lsu' ? (g.n === 1 ? 'PORT' : 'PORTS') : g.unit.toUpperCase() + (g.n === 1 ? '' : 'S')}`, X.plateX - 12, g.labelY, { size: 8, weight: 800, color: withAlpha(col.startsWith('#') ? col : '#888888', 1), spacing: 0.8 });
      for (const t of g.tracks) {
        const h = t.h;
        // Track band.
        ctx.fillStyle = withAlpha(col, 0.13);
        rr(ctx, t.x0, t.y - h / 2, t.x1 - t.x0, h, h / 2);
        ctx.fill();
        if (L.S > 1) {
          ctx.strokeStyle = withAlpha(col, 0.5);
          ctx.lineWidth = Math.max(0.6, L.laneH * 0.35);
          ctx.beginPath();
          for (let k = 0; k < L.S; k++) {
            const ly = t.y - h / 2 + 2 + (k + 0.5) * ((h - 4) / L.S);
            ctx.moveTo(t.x0 + 6, ly);
            ctx.lineTo(t.x1 - 6, ly);
          }
          ctx.stroke();
        } else {
          ctx.strokeStyle = withAlpha(col, 0.75);
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(t.x0 + 6, t.y);
          ctx.lineTo(t.x1 - 6, t.y);
          ctx.stroke();
        }
        // Stage ticks: one per cycle of the station's usual latency.
        const n = latTicks[g.unit];
        ctx.strokeStyle = withAlpha(col, 0.9);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let k = 1; k < n; k++) {
          const x = t.x0 + 16 + (k / n) * (t.x1 - t.x0 - 32);
          ctx.moveTo(x, t.y - h / 2 - 2);
          ctx.lineTo(x, t.y - h / 2 + 1.5);
        }
        ctx.stroke();
        // Bullet.
        ctx.beginPath();
        ctx.arc(X.plateX, t.y, 8.5, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        this.label(g.letter + (t.idx + 1), X.plateX, t.y + 0.5, { size: 8, weight: 800, color: '#FFFFFF', align: 'center' });
      }
    }

    // Memory line.
    const lsuTracks = L.tracks.lsu;
    ctx.strokeStyle = PAL.memL1;
    ctx.lineWidth = 2;
    for (const t of lsuTracks) {
      ctx.beginPath();
      ctx.moveTo(t.x1 - 4, t.y);
      ctx.lineTo(X.trackX1 + 8, t.y);
      ctx.lineTo(L.l1.x, L.l1.y);
      ctx.stroke();
    }
    const strokePath = (pts, color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.stroke();
    };
    const l2End = L.l2 ? L.dL2 : 0;
    if (L.l2) strokePath(L.memBetween(0, l2End), PAL.memL1, 6);
    strokePath(L.memBetween(l2End, L.dMem), PAL.mem, 6);
    // Direction dashes on the long haul.
    ctx.setLineDash([2, 7]);
    strokePath(L.memBetween(L.dGate + 8, L.dMem - 30), withAlpha('#FFFFFF', 0.8), 1.4);
    ctx.setLineDash([]);

    const station = (p, r, ring, name) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ring;
      ctx.stroke();
      this.label(name, p.x, p.y + 0.5, { size: Math.min(11, r * 0.8), weight: 800, color: PAL.ink, align: 'center' });
    };
    station(L.l1, L.l1.r, PAL.memL1, 'L1');
    this.label(`${fmtKB(cfg.l1KB)} · ${tr.L1LAT} cyc`, L.l1.x, L.l1.y + L.l1.r + 11, { size: 8, weight: 700, color: PAL.ink2, align: 'center' });
    if (L.l2) {
      station(L.l2, L.l2.r, PAL.mem, 'L2');
      this.label(`${fmtKB(cfg.l2KB)} · ${tr.L2LAT} cyc`, L.l2.x + 4, L.l2.y - L.l2.r - 9, { size: 8, weight: 700, color: PAL.ink2, align: 'left' });
    } else {
      this.label('no L2', (L.l1.x + L.gate.x) / 2 + 8, L.l1.y - 12, { size: 8, weight: 600, color: PAL.ink3, align: 'center' });
    }
    // Memory gate: a fare-gate bar across the line.
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2;
    const gp = L.gate;
    ctx.beginPath();
    ctx.moveTo(gp.x - 1, gp.y - 9);
    ctx.lineTo(gp.x - 1, gp.y + 9);
    ctx.moveTo(gp.x + 3, gp.y - 9);
    ctx.lineTo(gp.x + 3, gp.y + 9);
    ctx.stroke();
    // A short memory route leaves little room before the terminal.
    let bwText = `memory line: 1 delivery every ${tr.BUS} cyc`;
    if (Math.abs(L.mem.y - gp.y) < 30 && gp.x - 4 + this.textWidth(bwText, 7.5, 600) > L.mem.x - 48) bwText = `1 delivery / ${tr.BUS} cyc`;
    this.label(bwText, gp.x - 4, gp.y + 17, { size: 7.5, weight: 600, color: PAL.ink3 });

    // Main-memory terminal.
    const mp = L.mem;
    ctx.fillStyle = PAL.ink;
    rr(ctx, mp.x - 44, mp.y - 17, 88, 34, 10);
    ctx.fill();
    ctx.fillStyle = withAlpha('#FFFFFF', 0.12);
    rr(ctx, mp.x - 41, mp.y - 15, 82, 12, 6);
    ctx.fill();
    this.label('MAIN MEMORY', mp.x, mp.y - 5, { size: 8, weight: 800, color: '#FFFFFF', align: 'center', spacing: 0.8 });
    this.label(`${tr.MEMLAT} cyc · ${cfg.memNs} ns`, mp.x, mp.y + 8, { size: 8, weight: 600, color: withAlpha('#FFFFFF', 0.8), align: 'center' });

    // Memory gates (MSHRs).
    for (const b of L.mshrBoxes) {
      rr(ctx, b.x - 3.2, b.y - 3.2, 6.4, 6.4, 1.6);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = PAL.rule2;
      ctx.lineWidth = 1;
      ctx.stroke();
    }


    // Terminus.
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(196, L.termY);
    ctx.lineTo(X.platX1 - 8, L.termY);
    ctx.stroke();
    this.label('exit in program order', X.platX1 - 10, L.termY - 9, { size: 7.5, weight: 600, color: PAL.ink3, align: 'right' });

    this.ctx = saved;
    this.staticCanvas = cv;
  }

  drawBerthState(c, items) {
    const ctx = this.ctx;
    const tr = this.tr;
    const L = this.L;
    const head = headAt(tr, c);
    if (head < 0) return;
    // Reserved berths: vehicle is away at a station or on the memory line.
    ctx.setLineDash([2.5, 2]);
    ctx.lineWidth = 1.1;
    for (let id = head; id < tr.N; id++) {
      const d = tr.dispC[id];
      if (d < 0 || d > c) break;
      if (tr.issueC[id] <= c && tr.doneC[id] > c) {
        const b = L.berth(tr.slot[id]);
        const col = PAL.type[tr.instrs[id].type];
        rr(ctx, b.x - L.bw / 2 + 0.5, b.y - L.bh / 2 + 0.5, L.bw - 1, L.bh - 1, 2.5);
        ctx.fillStyle = withAlpha(col, 0.1);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    // Head of the platform: next to exit.
    if (tr.dispC[head] >= 0 && tr.dispC[head] <= c) {
      const b = L.berth(tr.slot[head]);
      ctx.fillStyle = PAL.ink;
      ctx.beginPath();
      ctx.moveTo(b.x - 3.5, b.y + L.bh / 2 + 1.5);
      ctx.lineTo(b.x + 3.5, b.y + L.bh / 2 + 1.5);
      ctx.lineTo(b.x, b.y + L.bh / 2 + 5.5);
      ctx.closePath();
      ctx.fill();
    }
    // Fixed order: only the oldest waiting vehicle may depart.
    if (!tr.OOO) {
      const nx = oldestWaiting(tr, c);
      if (nx >= 0 && tr.issueC[nx] > c) {
        const b = L.berth(tr.slot[nx]);
        const w = waitAt(tr, nx, c);
        const blocked = w && w[2] !== C.WIDTH;
        ctx.strokeStyle = blocked ? PAL.code[C.UNIT] : PAL.good;
        ctx.lineWidth = 1.8;
        rr(ctx, b.x - L.bw / 2 - 2.5, b.y - L.bh / 2 - 2.5, L.bw + 5, L.bh + 5, 4);
        ctx.stroke();
      }
    }
  }

  drawSignals(c, T) {
    const tr = this.tr;
    const L = this.L;
    const ctx = this.ctx;
    const cc = Math.min(c, tr.cycles - 1);
    const blocked = cc >= 0 && tr.cyc.feBlock[cc] >= 0 && c < tr.cycles;
    const refill = !blocked && cc >= 0 && tr.cyc.refill[cc] >= 0 && c < tr.cycles;
    const x = X.entX0 - 20;
    const y = L.laneY[0] - 16;
    rr(ctx, x - 6, y - 6, 12, 12, 6);
    ctx.fillStyle = PAL.ink;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = blocked ? PAL.code[C.BRANCH] : refill ? PAL.code[C.DEP] : PAL.good;
    ctx.fill();
    if (blocked) {
      const b = tr.cyc.feBlock[cc];
      const pulse = 0.55 + 0.45 * Math.sin(T * Math.PI * 2);
      ctx.beginPath();
      ctx.arc(x, y, 7 + pulse * 3, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(PAL.code[C.BRANCH].startsWith('#') ? PAL.code[C.BRANCH] : '#E8457A', 0.35 * pulse);
      ctx.lineWidth = 2;
      ctx.stroke();
      this.label(`HOLD · wrong route #${tr.instrs[b].num}`, x + 10, y, { size: 8, weight: 800, color: PAL.code[C.BRANCH] });
    } else if (refill) {
      this.label('refilling after wrong route', x + 10, y, { size: 8, weight: 700, color: PAL.ink2 });
    }
    // Boarding held at the end of the entrance.
    const stop = c < tr.cycles && cc >= 0 ? tr.cyc.board[cc] : 0;
    if (stop === C.REGS || stop === C.WINDOW) {
      const col = stop === C.REGS ? PAL.code[C.REGS] : PAL.code[C.UNIT];
      const y0 = L.laneY[0] - 7;
      const y1 = L.laneY[tr.W - 1] + 7;
      ctx.fillStyle = col;
      rr(ctx, X.holdX + 8, y0, 3, y1 - y0, 1.5);
      ctx.fill();
      this.label(stop === C.REGS ? 'HOLD · no spare register' : 'HOLD · platform full', X.holdX + 10, y1 + 8, { size: 7.5, weight: 800, color: col, align: 'right' });
    }
  }

  drawUnitsState(items, c) {
    const ctx = this.ctx;
    const L = this.L;
    const tr = this.tr;
    const busy = new Set();
    let singleLabeled = false;
    for (const it of items) {
      const s = it.a;
      if (s && s.k === K.UNIT) {
        busy.add(s.unit + s.idx);
        const ins = tr.instrs[it.id];
        if (!ins.pipe) {
          // Non-pipelined work (divide) holds the whole station: single track.
          const t = L.tracks[s.unit][s.idx];
          ctx.save();
          rr(ctx, t.x0, t.y - t.h / 2 - 3, t.x1 - t.x0, t.h + 6, (t.h + 6) / 2);
          ctx.clip();
          ctx.strokeStyle = withAlpha(PAL.type.fp, 0.35);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let x = t.x0 - 20; x < t.x1 + 20; x += 7) {
            ctx.moveTo(x, t.y + t.h);
            ctx.lineTo(x + 12, t.y - t.h);
          }
          ctx.stroke();
          ctx.restore();
          if (!singleLabeled) {
            singleLabeled = true;
            this.label('divide: single track', t.x1 - 4, t.y - t.h / 2 - 7, { size: 7, weight: 700, color: PAL.typeDark.fp, align: 'right' });
          }
        }
      }
    }
    for (const g of L.groups) {
      for (const t of g.tracks) {
        if (busy.has(g.unit + t.idx)) {
          ctx.beginPath();
          ctx.arc(X.plateX, t.y, 11.5, 0, Math.PI * 2);
          ctx.strokeStyle = withAlpha(PAL.unit[g.unit], 0.45);
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
      }
    }
  }

  drawMemoryState(c, T, items) {
    const ctx = this.ctx;
    const tr = this.tr;
    const L = this.L;
    const cc = Math.min(c, tr.cycles - 1);
    const mshr = cc >= 0 && c < tr.cycles ? tr.cyc.mshr[cc] : 0;
    L.mshrBoxes.forEach((b, k) => {
      if (k < mshr) {
        rr(ctx, b.x - 3.2, b.y - 3.2, 6.4, 6.4, 1.6);
        ctx.fillStyle = PAL.mem;
        ctx.fill();
      }
    });
    // Hit / miss flashes as lookups finish.
    for (const it of items) {
      const id = it.id;
      const ins = tr.instrs[id];
      if (ins.type !== 'load' || tr.issueC[id] < 0) continue;
      const i = tr.issueC[id];
      const lvl = tr.memLvl[id];
      const tL1 = i + tr.L1LAT;
      const dt = T - tL1;
      if (dt > -0.6 && dt < 0.9) {
        // Colored like the yard: reused, neighbor, rode along, or missed.
        const acc = accessesOf(tr, id);
        const ev = acc.reduce((x, y) => (y.fill > x.fill ? y : x), acc[0]);
        const a = 1 - Math.abs(dt - 0.15) / 0.9;
        const col = lvl === LVL.SHARED_L1 ? PAL.shared : PAL.loc[ev ? ev.cls : LOC.COLD];
        this.flash(L.l1, L.l1.r + 4 + (dt + 0.6) * 5, col, a);
      }
      if (L.l2 && lvl !== LVL.L1 && lvl !== LVL.SHARED_L1) {
        const tL2 = lvl === LVL.MEM ? tr.gateAt[id] : tL1 + (tr.doneC[id] - tL1) / 2;
        const d2 = T - tL2;
        if (d2 > -0.6 && d2 < 0.9) {
          const a = 1 - Math.abs(d2 - 0.15) / 0.9;
          this.flash(L.l2, L.l2.r + 4 + (d2 + 0.6) * 5, lvl === LVL.MEM ? PAL.code[C.UNIT] : PAL.good, a);
        }
      }
    }
  }

  // ------------------------------------------------------------------------
  // Registers.

  // Where the capsule for register r sits inside its cell.
  regCap(r) {
    const cell = this.L.reg.cells[r];
    return { x: cell.x + 16.5, y: cell.y + 2, w: cell.w - 19, h: cell.h - 4 };
  }

  drawRegisters(c, T, items) {
    const ctx = this.ctx;
    const tr = this.tr;
    const L = this.L;
    const R = L.reg;
    const done = c >= tr.cycles;
    // Registers some ready vehicle is waiting to write (no renaming).
    const clash = new Set();
    for (const it of items) {
      const a = it.a;
      if (a && a.k === K.BERTH && a.st === 0 && a.code === C.NAME) clash.add(tr.instrs[it.id].dst);
    }
    const sel = this.selected >= 0 ? tr.instrs[this.selected] : null;
    for (let r = 0; r < NREG; r++) {
      const cell = R.cells[r];
      const cap = this.regCap(r);
      const { latest, aboard } = regVersions(tr, r, done ? tr.cycles : c);
      const rad = cap.h / 2;
      if (latest < 0) {
        // Nothing in this program has written it yet.
        rr(ctx, cap.x, cap.y, cap.w, cap.h, rad);
        ctx.setLineDash([1.6, 1.6]);
        ctx.strokeStyle = PAL.rule2;
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const ins = tr.instrs[latest];
        const col = PAL.type[ins.type];
        const dark = PAL.typeDark[ins.type];
        const ready = tr.doneC[latest] >= 0 && tr.doneC[latest] <= c;
        rr(ctx, cap.x, cap.y, cap.w, cap.h, rad);
        if (ready) {
          ctx.fillStyle = col;
          ctx.fill();
          ctx.strokeStyle = dark;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        } else {
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.setLineDash([2, 1.4]);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        this.label('#' + ins.num, cap.x + cap.w / 2, cap.y + cap.h / 2 + 0.6, { size: 7, weight: 700, mono: true, color: ready ? '#FFFFFF' : dark, align: 'center' });
        // Renaming keeps older values of this name in spare registers
        // until the vehicles after them exit: one dot each.
        const older = aboard.length - (aboard[aboard.length - 1] === latest ? 1 : 0);
        if (tr.RENAME && older > 0) {
          ctx.fillStyle = PAL.ink2;
          for (let k = 0; k < Math.min(3, older); k++) {
            ctx.beginPath();
            ctx.arc(cell.x + 4.4 + k * 3.6, cell.y + cell.h - 2.2, 1.1, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // The result lands: a ring as it is written.
        const dt = T - tr.doneC[latest];
        if (tr.doneC[latest] >= 0 && dt > -0.35 && dt < 1) {
          const a = 1 - Math.abs(dt - 0.1) / 0.95;
          rr(ctx, cell.x - 1.5 - dt * 2, cell.y - 1.5 - dt * 2, cell.w + 3 + dt * 4, cell.h + 3 + dt * 4, 5 + dt * 2);
          ctx.globalAlpha = Math.max(0, Math.min(1, a));
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      const ring = (color, dash, pad = 2) => {
        rr(ctx, cell.x - pad, cell.y - pad, cell.w + pad * 2, cell.h + pad * 2, 5);
        ctx.setLineDash(dash ? [2.5, 1.8] : []);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      };
      if (clash.has(r)) ring(PAL.code[C.NAME], true);
      if (sel && sel.srcRegs.includes(r)) ring(PAL.code[C.DEP], false);
      if (sel && sel.dst === r) ring(PAL.accent, false, 3.2);
      if (this.hoverReg === r) ring(PAL.ink, false, 1.2);
    }
    // Rename pool meter.
    if (tr.RENAME) {
      const used = done ? 0 : writersAt(tr, c);
      const full = used >= tr.RENAME;
      const bw = 48;
      const bx = R.x1 - 12 - bw;
      const by = R.headY - 2.5;
      rr(ctx, bx, by, bw, 5, 2.5);
      ctx.fillStyle = '#E4E8EA';
      ctx.fill();
      if (used > 0) {
        rr(ctx, bx, by, Math.max(5, (bw * used) / tr.RENAME), 5, 2.5);
        ctx.fillStyle = full ? PAL.code[C.REGS] : PAL.accent;
        ctx.fill();
      }
      this.label(`${used} / ${tr.RENAME} spares in use`, bx - 6, R.headY + 0.5, { size: 7.5, weight: 800, color: full ? PAL.code[C.REGS] : PAL.ink2, align: 'right' });
    }
    // Departing vehicles pick up their inputs from the board.
    const e = this.frameE;
    if (e > 0.02 && e < 0.98) {
      for (const it of items) {
        if (!it.a || it.a.k !== K.BERTH || !it.b || (it.b.k !== K.UNIT && it.b.k !== K.MEM)) continue;
        const ins = tr.instrs[it.id];
        if (!ins.srcRegs.length) continue;
        const a = Math.sin(Math.PI * e) * (this.selected < 0 || this.selected === it.id ? 0.55 : 0.15);
        ctx.globalAlpha = a;
        ctx.strokeStyle = PAL.type[ins.type];
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const r of ins.srcRegs) {
          if (r < 0 || r >= NREG) continue;
          const cell = R.cells[r];
          ctx.moveTo(cell.cx, cell.y + cell.h);
          ctx.lineTo(it.x, it.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  hitReg(mx, my) {
    const R = this.L.reg;
    if (mx < R.x0 || mx > R.x1 || my < R.y0 || my > R.y1) return -1;
    for (let r = 0; r < NREG; r++) {
      const cell = R.cells[r];
      if (mx >= cell.x - 1.5 && mx <= cell.x + cell.w + 1.5 && my >= cell.y - 1.5 && my <= cell.y + cell.h + 1.5) return r;
    }
    return -1;
  }

  // ------------------------------------------------------------------------
  // Cache yard.

  // Car positions: each region of memory starts a row, labeled in the gutter;
  // contiguous lines couple into trains. Cars shrink until everything fits.
  yardLayout() {
    if (this.yardGeom) return this.yardGeom;
    const Y = this.L.yard;
    const model = yardModel(this.tr);
    const gutter = 32;
    const x0 = Y.x0 + 8 + gutter;
    const x1 = Y.x1 - 8;
    const y0 = Y.y0 + 20;
    const y1 = Y.y1 - 16;
    let geom = null;
    for (let sw = 3.4; sw >= 0.4 && !geom; sw -= 0.05) {
      const w = 8 * sw + 2;
      const h = Math.max(2.6, Math.min(8.5, sw * 2.5));
      const rowGap = Math.max(1.6, h * 0.42);
      const cars = [];
      const labels = [];
      let y = y0;
      for (const reg of model.regions) {
        let x = x0;
        const top = y;
        let prev = -2;
        for (const m of reg.lines) {
          const join = m.line === prev + 1;
          let gap = x > x0 ? (join ? 1.3 : Math.max(2.4, sw * 1.1)) : 0;
          if (x + gap + w > x1) {
            y += h + rowGap;
            x = x0;
            gap = 0;
          }
          cars.push({ m, x: x + gap, y, w, h, sw, join: join && gap > 0 });
          x += gap + w;
          prev = m.line;
        }
        labels.push({ name: reg.short, y: top + h / 2 });
        y = Math.max(y + h + rowGap + 2.5, top + 10);
      }
      if (y - rowGap - 2.5 <= y1 || sw < 0.45) geom = { cars, labels };
    }
    this.yardGeom = geom;
    return geom;
  }

  drawYard(c, T, items) {
    const ctx = this.ctx;
    const tr = this.tr;
    const L = this.L;
    const Y = L.yard;
    const g = this.yardLayout();
    const byLine = new Map();
    // L1 capacity: lines this run has used, other resident lines, free.
    const cc = Math.max(0, Math.min(c, tr.cycles - 1));
    const lines = tr.l1Lines;
    const run = tr.cycles ? tr.cyc.l1Run[cc] : 0;
    const size = tr.cycles ? tr.cyc.l1Size[cc] : 0;
    const bw = 44;
    const bx = Y.x1 - 10 - bw;
    const by = Y.y0 + 7.5;
    rr(ctx, bx, by, bw, 5, 2.5);
    ctx.fillStyle = '#E4E8EA';
    ctx.fill();
    ctx.save();
    rr(ctx, bx, by, bw, 5, 2.5);
    ctx.clip();
    ctx.fillStyle = withAlpha('#06A3C4', 0.3);
    ctx.fillRect(bx, by, (bw * size) / lines, 5);
    ctx.fillStyle = PAL.memL1;
    ctx.fillRect(bx, by, Math.max(run ? 1.5 : 0, (bw * run) / lines), 5);
    ctx.restore();
    this.label(`L1 ${fmtInt(lines)} lines`, bx - 5, Y.y0 + 10.5, { size: 7, weight: 800, color: PAL.ink2, align: 'right' });

    const sel = this.selected >= 0 ? accessesOf(tr, this.selected) : [];
    const selLines = new Map(sel.map((e) => [e.line, e.mask]));
    for (const car of g.cars) {
      const m = car.m;
      byLine.set(m.line, car);
      const where = lineWhere(m, T);
      const r = Math.min(2.2, car.h / 2.6);
      rr(ctx, car.x, car.y, car.w, car.h, r);
      if (where === 'l1' || where === 'arriving') ctx.fillStyle = '#FFFFFF';
      else if (where === 'l2') ctx.fillStyle = '#E9F0FA';
      else ctx.fillStyle = withAlpha('#FFFFFF', 0.35);
      ctx.fill();
      if (where === 'arriving') {
        // The line is on its way: fill in as the delivery approaches.
        let span = null;
        for (const iv of m.l1) if (T >= iv[0] && T < iv[1]) span = iv;
        if (span) {
          const f = Math.max(0, Math.min(1, (T - span[0]) / Math.max(1, span[2] - span[0])));
          ctx.fillStyle = withAlpha('#06A3C4', 0.18);
          ctx.fillRect(car.x, car.y, car.w * f, car.h);
        }
      }
      // Seats: one per 8-byte word, colored by how its latest access went.
      const sw = (car.w - 2) / 8;
      let flash = null;
      for (let k = m.acc.length - 1; k >= 0; k--) {
        const x = m.acc[k];
        if (x.t <= T && T - x.t < 1.1) {
          flash = x;
          break;
        }
        if (x.t < T - 1.1) break;
      }
      for (let w = 0; w < 8; w++) {
        let last = null;
        for (let k = m.acc.length - 1; k >= 0; k--) {
          const x = m.acc[k];
          if (x.t <= T && x.e.mask & (1 << w)) {
            last = x;
            break;
          }
        }
        if (!last) continue;
        const age = T - last.t;
        ctx.globalAlpha = age < 1 ? 1 : Math.max(0.55, 1 - (age - 1) / 120);
        ctx.fillStyle = PAL.loc[last.e.cls];
        ctx.fillRect(car.x + 1 + w * sw + (sw > 1.6 ? 0.3 : 0), car.y + 1, Math.max(0.6, sw - (sw > 1.6 ? 0.6 : 0)), car.h - 2);
      }
      ctx.globalAlpha = 1;
      rr(ctx, car.x, car.y, car.w, car.h, r);
      if (where === 'arriving' || where === 'mem') ctx.setLineDash([1.8, 1.4]);
      ctx.strokeStyle = where === 'l1' || where === 'arriving' ? PAL.memL1 : where === 'l2' ? PAL.mem : withAlpha('#7C8594', 0.55);
      ctx.lineWidth = where === 'mem' ? 0.7 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
      if (car.join) {
        ctx.strokeStyle = PAL.ink3;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(car.x - 1.4, car.y + car.h / 2);
        ctx.lineTo(car.x, car.y + car.h / 2);
        ctx.stroke();
      }
      if (flash) {
        const a = 1 - (T - flash.t) / 1.1;
        ctx.globalAlpha = a;
        rr(ctx, car.x - 1.5, car.y - 1.5, car.w + 3, car.h + 3, r + 1.5);
        ctx.strokeStyle = PAL.loc[flash.e.cls];
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (selLines.has(m.line) || this.hoverLine === m) {
        rr(ctx, car.x - 2.5, car.y - 2.5, car.w + 5, car.h + 5, r + 2.5);
        ctx.strokeStyle = this.hoverLine === m ? PAL.ink : PAL.accent;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    // Loads at L1 are looking up their line: a thread from L1 to the car.
    // (Loads riding along wait in the bay; their car shows the delivery.)
    for (const it of items) {
      const s = it.s;
      if (!s || s.k !== K.MEM || s.at !== AT.L1) continue;
      for (const e of accessesOf(tr, it.id)) {
        const car = byLine.get(e.line);
        if (!car) continue;
        const col = PAL.loc[e.cls];
        ctx.globalAlpha = this.selected < 0 || this.selected === it.id ? 0.6 : 0.15;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(it.x, it.y);
        ctx.lineTo(car.x + car.w / 2, car.y + car.h);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  hitLine(mx, my) {
    const Y = this.L.yard;
    if (mx < Y.x0 || mx > Y.x1 || my < Y.y0 || my > Y.y1) return null;
    const g = this.yardLayout();
    let best = null;
    let bd = Infinity;
    for (const car of g.cars) {
      const dx = Math.max(car.x - mx, 0, mx - (car.x + car.w));
      const dy = Math.max(car.y - my, 0, my - (car.y + car.h));
      const d = dx + dy;
      if (d < bd) {
        bd = d;
        best = car.m;
      }
    }
    return bd <= 2.5 ? best : null;
  }

  flash(p, r, col, a) {
    if (a <= 0) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = col;
    ctx.globalAlpha = Math.min(1, a);
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawVehicle(it, alpha, selected, hovered) {
    const ctx = this.ctx;
    const tr = this.tr;
    const ins = tr.instrs[it.id];
    const s = it.s;
    const col = PAL.type[ins.type];
    const dark = PAL.typeDark[ins.type];
    const a = alpha * it.alpha;
    if (a <= 0.01) return;
    let w = it.w;
    let h = it.h;
    if (hovered || selected) {
      w += 3;
      h += 2;
    }
    const x = it.x - w / 2;
    const y = it.y - h / 2;
    const r = Math.min(h / 2, 5);
    ctx.globalAlpha = a;
    const doneStyle = s.k === K.BERTH && s.st === 1;
    const onTrack = s.k === K.UNIT && tr.cfg.simd > 1;
    if (selected) {
      rr(ctx, x - 4, y - 4, w + 8, h + 8, r + 4);
      ctx.fillStyle = withAlpha('#141820', 0.12);
      ctx.fill();
    }
    rr(ctx, x, y, w, h, r);
    if (doneStyle) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = col;
      ctx.stroke();
      if (w > 9) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        const cx = it.x - (w > 20 ? w / 2 - 6 : 0);
        ctx.moveTo(cx - 2.5, it.y);
        ctx.lineTo(cx - 0.6, it.y + 2);
        ctx.lineTo(cx + 2.8, it.y - 2.2);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = col;
      ctx.fill();
      if (ins.vector || onTrack) {
        // Lanes: coupled cars side by side (or stacked on SIMD tracks).
        const lanes = ins.width > 1 ? ins.width : tr.cfg.simd;
        const active = ins.lanes;
        ctx.save();
        rr(ctx, x, y, w, h, r);
        ctx.clip();
        ctx.fillStyle = withAlpha('#FFFFFF', 0.72);
        if (onTrack) {
          const lh = h / lanes;
          for (let k = active; k < lanes; k++) ctx.fillRect(x, y + k * lh, w, lh);
          ctx.strokeStyle = withAlpha('#FFFFFF', 0.55);
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          for (let k = 1; k < lanes; k++) {
            ctx.moveTo(x, y + k * lh);
            ctx.lineTo(x + w, y + k * lh);
          }
          ctx.stroke();
        } else {
          // Off the tracks, lanes show as a segmented strip along the
          // bottom edge so the number stays readable.
          const sh = Math.max(2, h * 0.34);
          const lw = w / lanes;
          ctx.fillStyle = withAlpha('#141820', 0.28);
          ctx.fillRect(x, y + h - sh, lw * active, sh);
          ctx.fillStyle = withAlpha('#FFFFFF', 0.78);
          ctx.fillRect(x + lw * active, y + h - sh, lw * (lanes - active), sh);
          if (lw > 1.8) {
            ctx.strokeStyle = withAlpha('#FFFFFF', 0.7);
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            for (let k = 1; k < lanes; k++) {
              ctx.moveTo(x + k * lw, y + h - sh);
              ctx.lineTo(x + k * lw, y + h);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
      // Gloss.
      rr(ctx, x + 1.5, y + 1, w - 3, h * 0.42, r * 0.7);
      ctx.fillStyle = withAlpha('#FFFFFF', 0.3);
      ctx.fill();
      rr(ctx, x, y, w, h, r);
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = dark;
      ctx.stroke();
    }
    if (selected || hovered) {
      rr(ctx, x - 1.5, y - 1.5, w + 3, h + 3, r + 1.5);
      ctx.lineWidth = selected ? 2 : 1.4;
      ctx.strokeStyle = PAL.ink;
      ctx.stroke();
    }
    // Number label when there is room on screen; the depot board lists
    // number and operation in columns left of the capsule, like a
    // departures board, so departing vehicles never cross the text.
    const screenW = w * this.scale;
    if (s.k === K.DEPOT) {
      // A vehicle leaving for the entrance drops its listing straight away.
      const fade = it.b && it.b.k !== K.DEPOT ? Math.max(0, 1 - this.frameE * 4) : 1;
      if (fade > 0) {
        ctx.globalAlpha = a * fade;
        this.label(`#${ins.num}`, it.x - 58, it.y + 0.5, { size: 7.5, weight: 700, mono: true, color: PAL.ink, align: 'right' });
        this.label(`${OPS[ins.op].short}${ins.vector ? '×' + ins.lanes : ''}`, it.x - 54, it.y + 0.5, { size: 7.5, weight: 600, mono: true, color: PAL.ink2, align: 'left' });
        ctx.globalAlpha = a;
      }
    } else if (screenW >= 21 && h * this.scale >= 8.5 && !(onTrack && tr.cfg.simd > 4)) {
      const fs = Math.min(8.5, h * 0.78);
      const lift = !onTrack && !doneStyle && ins.vector ? -h * 0.14 : 0;
      this.label('#' + ins.num, it.x + (doneStyle && w > 20 ? 3 : 0), it.y + 0.6 + lift, {
        size: fs,
        weight: 700,
        mono: true,
        color: doneStyle ? dark : '#FFFFFF',
        align: 'center',
      });
    }
    // Wait badge.
    if (s.k === K.BERTH && s.st === 0 && s.code >= 0) {
      const bx = x + w - 1;
      const by = y + 1;
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(2.4, Math.min(3.4, h * 0.3)), 0, Math.PI * 2);
      ctx.fillStyle = s.code === C.WIDTH ? PAL.good : PAL.code[s.code === C.GATES ? C.MEM : s.code];
      ctx.fill();
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  glow(it, a) {
    if (a <= 0) return;
    const ctx = this.ctx;
    ctx.globalAlpha = Math.min(1, a);
    rr(ctx, it.x - it.w / 2 - 4, it.y - it.h / 2 - 4, it.w + 8, it.h + 8, it.h / 2 + 4);
    ctx.fillStyle = withAlpha(PAL.good, 0.28);
    ctx.fill();
    ctx.strokeStyle = PAL.good;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ring(it, color, pad) {
    const ctx = this.ctx;
    rr(ctx, it.x - it.w / 2 - pad, it.y - it.h / 2 - pad, it.w + pad * 2, it.h + pad * 2, it.h / 2 + pad);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  buildJourney(id) {
    const tr = this.tr;
    const pts = [];
    const stops = [];
    const f = tr.fetchC[id];
    const r = tr.retireC[id];
    const push = (p) => {
      const q = pts[pts.length - 1];
      if (!q || Math.abs(q.x - p.x) > 0.3 || Math.abs(q.y - p.y) > 0.3) pts.push({ x: p.x, y: p.y });
    };
    for (let c = f - 1; c <= r; c++) {
      const a = this.snap(id, c);
      const b = this.snap(id, c + 1);
      if (!a || !b) continue;
      const pa = this.posOf(a, id, EMPTY);
      const pb = this.posOf(b, id, EMPTY);
      for (const p of this.route(a, b, pa, pb, id)) push(p);
    }
    const key = [
      [tr.fetchC[id], 'in'],
      [tr.dispC[id], 'board'],
      [tr.issueC[id], 'depart'],
      [tr.doneC[id], 'done'],
      [tr.retireC[id], 'exit'],
    ];
    for (const [c, kind] of key) {
      const s = this.snap(id, c);
      if (s) stops.push({ ...this.posOf(s, id, EMPTY), c, kind });
    }
    return { id, pts, stops };
  }

  drawJourney(id) {
    const ctx = this.ctx;
    if (!this.journey || this.journey.id !== id) this.journey = this.buildJourney(id);
    const { pts, stops } = this.journey;
    if (pts.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = withAlpha('#141820', 0.1);
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.stroke();
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const s of stops) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // Cycle tags at each stop, nudged apart when stops sit close together.
    const placed = [];
    for (const s of stops) {
      const text = `${STOP_WORD[s.kind]} c${s.c}`;
      const w = this.textWidth(text, 7.5, 800) + 8;
      let tx = s.x - w / 2;
      let ty = s.y - 17;
      for (let tries = 0; tries < 4; tries++) {
        const hit = placed.some((p) => Math.abs(p.x - tx) < (p.w + w) / 2 + 2 && Math.abs(p.y - ty) < 12);
        if (!hit) break;
        ty -= 13;
      }
      placed.push({ x: tx, y: ty, w });
      rr(ctx, tx, ty - 6, w, 12, 6);
      ctx.fillStyle = PAL.ink;
      ctx.fill();
      this.label(text, tx + w / 2, ty + 0.5, { size: 7.5, weight: 800, color: '#FFFFFF', align: 'center' });
    }
  }

  drawDeps(id, items) {
    const ctx = this.ctx;
    const me = items.find((it) => it.id === id);
    if (!me) return;
    const byId = new Map(items.map((it) => [it.id, it]));
    const curve = (from, to, color, dashed) => {
      const mx = (from.x + to.x) / 2;
      const my = Math.min(from.y, to.y) - 18 - Math.abs(from.x - to.x) * 0.08;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      if (dashed) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(mx, my, to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Arrowhead at the receiving end.
      const ang = Math.atan2(to.y - my, to.x - mx);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - 6 * Math.cos(ang - 0.4), to.y - 6 * Math.sin(ang - 0.4));
      ctx.lineTo(to.x - 6 * Math.cos(ang + 0.4), to.y - 6 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    };
    for (const p of this.tr.instrs[id].src) {
      const it = byId.get(p);
      if (it) {
        curve(it, me, PAL.code[C.DEP], false);
        this.ring(it, PAL.code[C.DEP], 2.5);
      }
    }
    for (const q of this.consumersOf(id)) {
      const it = byId.get(q);
      if (it) curve(me, it, PAL.accent, true);
    }
  }

  drawCounters(c, done) {
    const tr = this.tr;
    const L = this.L;
    const ctx = this.ctx;
    const cc = Math.min(c, tr.cycles - 1);
    const aboard = done ? 0 : tr.cyc.rob[cc];
    const head = headAt(tr, c);
    const exited = done || head < 0 ? tr.N : head;
    this.label(`${aboard} / ${tr.WIN} aboard`, X.platX1 - 12, L.platY0 + 12, { size: 8.5, weight: 800, color: aboard >= tr.WIN ? PAL.code[C.UNIT] : PAL.ink, align: 'right' });
    // Terminus sign above the vehicles, so exits slide in underneath it.
    ctx.fillStyle = PAL.ink;
    rr(ctx, 14, L.termY - 10, 86, 20, 10);
    ctx.fill();
    this.label('TERMINUS', L.termSignX - 1, L.termY + 0.5, { size: 8.5, weight: 800, color: '#FFFFFF', align: 'center', spacing: 1.2 });
    // Terminus tally, on its own plate between the sign and the line.
    rr(ctx, 104, L.termY - 9, 88, 18, 9);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = PAL.rule2;
    ctx.lineWidth = 1;
    ctx.stroke();
    this.label(`${fmtInt(exited)} / ${fmtInt(tr.N)} exited`, 148, L.termY + 0.5, { size: 8.5, weight: 800, color: PAL.ink, align: 'center' });
    const left = Math.max(0, tr.N - (c < 0 ? 0 : c < tr.cycles ? tr.cyc.fetchPtr[cc] : tr.N));
    this.label(`${fmtInt(left)} to go`, X.depotBoard, L.depotY0 + DEPOT_N * L.depotStep + 4, { size: 8, weight: 700, color: PAL.ink3, align: 'center' });
    const gates = done ? 0 : tr.cyc.mshr[cc];
    const last = L.mshrBoxes[L.mshrBoxes.length - 1];
    this.label(`memory gates · ${gates} of ${tr.MSHR} busy`, L.l1.x, last.y + 11, { size: 7.5, weight: 700, color: gates >= tr.MSHR ? PAL.code[C.UNIT] : PAL.ink3, align: 'center' });
    if (!done && tr.cyc.gateQ[cc] > 0) {
      const q = tr.cyc.gateQ[cc];
      this.label(`${q} waiting for bandwidth`, L.gate.x - 4, L.gate.y + 28, { size: 7.5, weight: 800, color: PAL.mem });
    }
  }

  drawComplete() {
    const ctx = this.ctx;
    const tr = this.tr;
    const L = this.L;
    const x = (X.platX0 + X.platX1) / 2;
    const y = L.yc;
    ctx.fillStyle = withAlpha('#FFFFFF', 0.9);
    ctx.strokeStyle = PAL.good;
    ctx.lineWidth = 2;
    rr(ctx, x - 118, y - 26, 236, 52, 26);
    ctx.fill();
    ctx.stroke();
    this.label('SERVICE COMPLETE', x, y - 8, { size: 10, weight: 800, color: PAL.good, align: 'center', spacing: 1.5 });
    this.label(`${fmtInt(tr.cycles)} cycles · ${fmtNs(tr.cycles / tr.cfg.ghz)}`, x, y + 9, { size: 10, weight: 700, color: PAL.ink, align: 'center' });
  }
}

function fmtKB(kb) {
  return kb >= 1024 ? kb / 1024 + ' MB' : kb + ' KB';
}
function fmtNs(ns) {
  if (ns >= 1000) return (ns / 1000).toFixed(2) + ' µs';
  return ns.toFixed(1) + ' ns';
}
