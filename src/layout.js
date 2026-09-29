// Geometry of one machine's transit map, in logical pixels (LW wide).
// The layout is derived from the machine's configuration, so changing the
// hardware changes the network: lanes, berths, tracks, SIMD rails and the
// distance to main memory all come from here.

export const LW = 1200;

export const X = {
  depot: 94,
  depotBoard: 60,
  entX0: 132,
  entX1: 226,
  holdX: 240,
  platX0: 256,
  platX1: 574,
  busX: 594,
  plateX: 620,
  trackX0: 650,
  trackX1: 846,
  riserX: 862,
  l1X: 900,
  memTurnX: 1140,
};

export function computeLayout(tr) {
  const cfg = tr.cfg;
  const W = tr.W;
  const FE = tr.FE;
  const WIN = tr.WIN;
  const S = cfg.simd;
  const TOP = 64;

  // Station tracks: one per unit, grouped by kind. SIMD machines get a
  // bundle of thin rails, one per lane.
  const laneH = S <= 1 ? 0 : S <= 2 ? 5 : S <= 4 ? 3.6 : S <= 8 ? 2.5 : 1.7;
  const bundleH = S <= 1 ? 12 : Math.max(13, Math.round(S * laneH + 4));
  const trackGap = bundleH + 8;
  const groupLabelH = 18;
  const groupGap = 10;
  const groups = [
    { unit: 'alu', n: cfg.alu, letter: 'A', name: 'Integer' },
    { unit: 'fpu', n: cfg.fpu, letter: 'F', name: 'Floating point' },
    { unit: 'lsu', n: cfg.lsu, letter: 'M', name: 'Load / store' },
  ];
  let stationsH = -groupGap;
  for (const g of groups) stationsH += groupLabelH + g.n * trackGap + groupGap;

  // Platform: the instruction window as a grid of berths. On a split-lines
  // network it is drawn as one line per kind of station instead, each with
  // room for the most vehicles of its kind that were ever aboard at once.
  const cols = WIN <= 16 ? WIN : WIN <= 128 ? 16 : 32;
  const lines = tr.SPLIT ? splitLines(tr, cols) : null;
  const rows = lines ? lines.reduce((n, ln) => n + ln.rows, 0) : Math.ceil(WIN / cols);
  const lineHeadH = lines ? 15 : 0;
  const gapX = cols >= 32 ? 1.5 : 3;
  const innerW = X.platX1 - X.platX0 - 20;
  const bw = Math.min(30, (innerW - (cols - 1) * gapX) / cols);
  const bh = Math.max(6.5, Math.min(13, bw * 0.6));
  const aisle = cols >= 32 ? 4.5 : 6;
  const rowH = bh + aisle;
  const gridW = cols * bw + (cols - 1) * gapX;
  const platInnerH = rows * rowH + aisle + (lines ? lines.length * lineHeadH : 0);
  const platH = platInnerH + 30;

  // Register board above the platform: the sixteen names in two rows.
  const regRows = 2;
  const regCols = 8;
  const regHeadH = 18;
  const regCellH = 15;
  const regRowGap = 4;
  const regH = regHeadH + regRows * regCellH + (regRows - 1) * regRowGap + 7;
  const regGap = 10;
  const coreH = regH + regGap + platH;

  const laneGap = W <= 2 ? 16 : W <= 4 ? 13 : 10.5;
  const entH = (W - 1) * laneGap + 40;
  const contentH = Math.max(stationsH + 8, coreH + 4, entH, 200);
  // The platform (and the entrance and depot that feed it) sits below the
  // register board; the two are centered together.
  const coreTop = TOP + (contentH - coreH) / 2;
  const yc = coreTop + regH + regGap + platH / 2;

  const L = {
    W, FE, WIN, S, TOP, contentH, yc, laneH, bundleH, cols, rows, bw, bh, aisle, rowH, gapX,
  };

  // Entrance lanes and stops.
  L.laneY = [];
  for (let l = 0; l < W; l++) L.laneY.push(yc - ((W - 1) * laneGap) / 2 + l * laneGap);
  L.stopX = [];
  for (let s = 0; s < FE; s++) L.stopX.push(FE === 1 ? X.entX0 : X.entX0 + (s / (FE - 1)) * (X.entX1 - X.entX0));

  // Depot list of upcoming instructions.
  L.depotStep = 17;
  L.depotY0 = yc - 2.5 * L.depotStep;

  // Register board and its cells, spanning the entrance and the platform.
  const regX0 = X.entX0 - 8;
  const regX1 = X.platX1;
  const cellGap = 5;
  const cellW = (regX1 - regX0 - 20 - (regCols - 1) * cellGap) / regCols;
  L.reg = { x0: regX0, x1: regX1, y0: coreTop, y1: coreTop + regH, headY: coreTop + 10, cells: [] };
  for (let k = 0; k < regRows * regCols; k++) {
    const row = Math.floor(k / regCols);
    const col = k % regCols;
    const x = regX0 + 10 + col * (cellW + cellGap);
    const y = coreTop + regHeadH + row * (regCellH + regRowGap);
    L.reg.cells.push({ x, y, w: cellW, h: regCellH, cx: x + cellW / 2, cy: y + regCellH / 2 });
  }

  // Platform box and berths.
  L.platY0 = yc - platH / 2;
  L.platY1 = yc + platH / 2;
  L.gridX0 = X.platX0 + (X.platX1 - X.platX0 - gridW) / 2;
  L.gridX1 = L.gridX0 + gridW;
  L.gridY0 = L.platY0 + 22 + aisle;
  // Top of each berth row; split lines add a heading above each line.
  const rowLine = new Int8Array(rows);
  if (lines) for (const ln of lines) rowLine.fill(ln.index, ln.row0, ln.row0 + ln.rows);
  const rowTop = (r) => L.gridY0 + r * rowH + (lines ? (rowLine[Math.max(0, Math.min(rows - 1, r))] + 1) * lineHeadH : 0);
  L.berth = (slot) => {
    const r = Math.floor(slot / cols);
    const c = slot % cols;
    return { x: L.gridX0 + c * (bw + gapX) + bw / 2, y: rowTop(r) + bh / 2, row: r, col: c };
  };
  L.aisleY = (row) => rowTop(row) - aisle / 2;
  L.slots = lines ? rows * cols : WIN;
  L.lines = lines;
  if (lines) {
    for (const ln of lines) {
      ln.base = ln.row0 * cols;
      ln.headY = rowTop(ln.row0) - aisle - lineHeadH / 2 + 2;
    }
  }

  // Station tracks.
  const stY0 = TOP + (contentH - stationsH) / 2;
  let y = stY0;
  L.groups = [];
  L.tracks = { alu: [], fpu: [], lsu: [] };
  for (const g of groups) {
    const gl = { ...g, labelY: y + 8, tracks: [] };
    y += groupLabelH;
    for (let i = 0; i < g.n; i++) {
      const ty = y + trackGap / 2;
      const t = { unit: g.unit, idx: i, y: ty, x0: X.trackX0, x1: X.trackX1, h: bundleH };
      gl.tracks.push(t);
      L.tracks[g.unit].push(t);
      y += trackGap;
    }
    gl.y0 = gl.labelY - 8;
    gl.y1 = y;
    L.groups.push(gl);
    y += groupGap;
  }
  const lsu = L.tracks.lsu;
  L.lsuY = (lsu[0].y + lsu[lsu.length - 1].y) / 2;

  // Memory line: L1 station next to the load/store tracks, then a route whose
  // length grows with latency out to the main-memory terminal.
  const l1r = 5 + 1.5 * Math.log2(cfg.l1KB);
  const l2r = cfg.l2KB ? 9 + 2.3 * Math.log2(cfg.l2KB / 64 + 1) : 0;
  L.l1 = { x: X.l1X, y: L.lsuY, r: l1r };
  const pathTopY = TOP - 16;
  L.memPath = [
    { x: X.l1X, y: L.lsuY },
    { x: X.memTurnX, y: L.lsuY },
    { x: X.memTurnX, y: pathTopY },
    { x: X.riserX + 40, y: pathTopY },
  ];
  L.memSeg = [];
  let acc = 0;
  for (let k = 1; k < L.memPath.length; k++) {
    const a = L.memPath[k - 1];
    const b = L.memPath[k];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    L.memSeg.push({ a, b, len, at: acc });
    acc += len;
  }
  L.memPathLen = acc;
  const extra = tr.L2LAT - tr.L1LAT;
  L.dL2 = cfg.l2KB ? Math.max(l1r + l2r + 14, 15 * Math.sqrt(extra)) : 0;
  L.dGate = (cfg.l2KB ? L.dL2 + l2r + 14 : l1r + 22);
  L.dMem = Math.min(acc - 10, L.dGate + Math.max(56, 14.5 * Math.sqrt(tr.MEMLAT)));
  // Vehicles dock at the terminal's near edge rather than on its sign.
  L.dTurn = Math.max(L.dGate + 12, L.dMem - 48);
  L.memPoint = (d) => {
    if (d <= 0) return { x: L.memPath[0].x, y: L.memPath[0].y };
    for (const s of L.memSeg) {
      if (d <= s.at + s.len) {
        const u = (d - s.at) / s.len;
        return { x: s.a.x + (s.b.x - s.a.x) * u, y: s.a.y + (s.b.y - s.a.y) * u };
      }
    }
    const last = L.memPath[L.memPath.length - 1];
    return { x: last.x, y: last.y };
  };
  // Polyline between two distances along the memory route (either direction).
  L.memBetween = (d0, d1) => {
    const pts = [L.memPoint(d0)];
    const corners = L.memSeg.slice(1).map((s) => s.at);
    if (d1 > d0) for (const k of corners) { if (k > d0 && k < d1) pts.push(L.memPoint(k)); }
    else for (let i = corners.length - 1; i >= 0; i--) { const k = corners[i]; if (k < d0 && k > d1) pts.push(L.memPoint(k)); }
    pts.push(L.memPoint(d1));
    return pts;
  };
  L.l2 = cfg.l2KB ? { ...L.memPoint(L.dL2), r: l2r } : null;
  // The cache yard: every line the program touches, above the memory line.
  L.yard = { x0: 876, x1: 1128, y0: TOP - 8, y1: Math.max(TOP + 62, L.l1.y - L.l1.r - 42) };
  L.gate = L.memPoint(L.dGate);
  L.mem = L.memPoint(L.dMem);
  // Keep the yard clear of the main-memory terminal when a long memory
  // route carries it up the far side or along the top.
  const Y = L.yard;
  if (L.mem.x + 48 > Y.x0 && L.mem.x - 48 < Y.x1) {
    if (L.mem.y - 23 < Y.y0 + 30) Y.y0 = L.mem.y + 23;
    else if (L.mem.y - 23 < Y.y1) Y.y1 = Math.max(Y.y0 + 60, L.mem.y - 23);
  }
  L.mshrBoxes = [];
  const perRow = Math.min(8, tr.MSHR);
  for (let m = 0; m < tr.MSHR; m++) {
    const r = Math.floor(m / 8);
    const cIdx = m % 8;
    L.mshrBoxes.push({ x: X.l1X - (perRow * 9) / 2 + cIdx * 9 + 4.5, y: L.lsuY + l1r + 33 + r * 9 });
  }

  // Return line for finished vehicles, and the terminus below the platform.
  L.returnY = TOP - 16;
  L.termY = TOP + contentH + 22;
  L.termSignX = 58;
  L.H = L.termY + 26;
  return L;
}

// Split lines: one line per kind of station, in the order the station groups
// are stacked. Each line gets whole rows, enough for the most vehicles of its
// kind that were aboard at once. prefix[k][id] counts line-k vehicles older
// than id, so a vehicle's place in its line is a difference of two prefixes.
const LINE_UNITS = ['alu', 'fpu', 'lsu'];

function splitLines(tr, cols) {
  const { N, instrs } = tr;
  const prefix = LINE_UNITS.map(() => new Int32Array(N + 1));
  for (let id = 0; id < N; id++) {
    const k = LINE_UNITS.indexOf(instrs[id].unit);
    for (let q = 0; q < 3; q++) prefix[q][id + 1] = prefix[q][id] + (q === k ? 1 : 0);
  }
  // Aboard during cycle c: boarded at or before c, not yet exited.
  const peak = [0, 0, 0];
  let head = 0;
  let tail = 0;
  for (let c = 0; c < tr.cycles; c++) {
    while (head < N && tr.retireC[head] <= c) head++;
    while (tail < N && tr.dispC[tail] >= 0 && tr.dispC[tail] <= c) tail++;
    for (let q = 0; q < 3; q++) peak[q] = Math.max(peak[q], prefix[q][Math.max(head, tail)] - prefix[q][head]);
  }
  let row0 = 0;
  return LINE_UNITS.map((unit, index) => {
    const rows = Math.max(1, Math.ceil(peak[index] / cols));
    const ln = { unit, index, rows, row0, cap: rows * cols, prefix: prefix[index] };
    row0 += rows;
    return ln;
  });
}
