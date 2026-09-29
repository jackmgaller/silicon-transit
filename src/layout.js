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

  // Platform: the instruction window as a grid of berths.
  const cols = WIN <= 16 ? WIN : WIN <= 128 ? 16 : 32;
  const rows = Math.ceil(WIN / cols);
  const gapX = cols >= 32 ? 1.5 : 3;
  const innerW = X.platX1 - X.platX0 - 20;
  const bw = Math.min(30, (innerW - (cols - 1) * gapX) / cols);
  const bh = Math.max(6.5, Math.min(13, bw * 0.6));
  const aisle = cols >= 32 ? 4.5 : 6;
  const rowH = bh + aisle;
  const gridW = cols * bw + (cols - 1) * gapX;
  const platInnerH = rows * rowH + aisle;
  const platH = platInnerH + 30;

  const laneGap = W <= 2 ? 16 : W <= 4 ? 13 : 10.5;
  const entH = (W - 1) * laneGap + 40;
  const contentH = Math.max(stationsH + 8, platH, entH, 200);
  const yc = TOP + contentH / 2;

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

  // Platform box and berths.
  L.platY0 = yc - platH / 2;
  L.platY1 = yc + platH / 2;
  L.gridX0 = X.platX0 + (X.platX1 - X.platX0 - gridW) / 2;
  L.gridX1 = L.gridX0 + gridW;
  L.gridY0 = L.platY0 + 22 + aisle;
  L.berth = (slot) => {
    const r = Math.floor(slot / cols);
    const c = slot % cols;
    return { x: L.gridX0 + c * (bw + gapX) + bw / 2, y: L.gridY0 + r * rowH + bh / 2, row: r, col: c };
  };
  L.aisleY = (row) => L.gridY0 + row * rowH - aisle / 2;

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
  L.gate = L.memPoint(L.dGate);
  L.mem = L.memPoint(L.dMem);
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
