// Machine ("network") configurations: presets, editable parameters,
// one-variable experiments and human-readable differences.

import { PREDICTORS, PREDICTOR_BY_ID } from './predictor.js';

export const MAX_MACHINES = 4;
export const LETTERS = ['A', 'B', 'C', 'D'];
export const LINE_COLORS = ['#E63946', '#1D6FE0', '#0E9F6E', '#9B51E0'];

export const FLEET = [
  {
    id: 'local',
    name: 'Local',
    tagline: 'In-order, 2-wide, modest caches. Simple and frugal.',
    cfg: { ooo: false, width: 2, window: 16, renameRegs: 0, feDepth: 4, predictor: 'bit2', alu: 2, fpu: 1, lsu: 1, simd: 1, l1KB: 16, l1Lat: 3, l2KB: 128, l2Lat: 12, memNs: 60, memGBs: 16, mshr: 2, ghz: 2 },
  },
  {
    id: 'express',
    name: 'Express',
    tagline: 'Out-of-order, 4-wide, a deep platform and big caches.',
    cfg: { ooo: true, width: 4, window: 96, renameRegs: 64, feDepth: 6, predictor: 'global', alu: 4, fpu: 2, lsu: 2, simd: 1, l1KB: 32, l1Lat: 4, l2KB: 512, l2Lat: 14, memNs: 60, memGBs: 32, mshr: 8, ghz: 3 },
  },
  {
    id: 'streamliner',
    name: 'Streamliner',
    tagline: 'In-order with 8-lane SIMD and a wide memory line.',
    cfg: { ooo: false, width: 2, window: 24, renameRegs: 0, feDepth: 5, predictor: 'bit2', alu: 2, fpu: 2, lsu: 2, simd: 8, l1KB: 32, l1Lat: 4, l2KB: 512, l2Lat: 14, memNs: 60, memGBs: 64, mshr: 8, ghz: 2.5 },
  },
  {
    id: 'shuttle',
    name: 'Shuttle',
    tagline: 'One lane, no L2. The smallest network that still runs.',
    cfg: { ooo: false, width: 1, window: 8, renameRegs: 0, feDepth: 3, predictor: 'static', alu: 1, fpu: 1, lsu: 1, simd: 1, l1KB: 4, l1Lat: 2, l2KB: 0, l2Lat: 12, memNs: 60, memGBs: 8, mshr: 1, ghz: 1 },
  },
  {
    id: 'grand',
    name: 'Grand Central',
    tagline: '8-wide, 256 berths, 4-lane SIMD. Everything big.',
    cfg: { ooo: true, width: 8, window: 256, renameRegs: 192, feDepth: 8, predictor: 'tournament', alu: 6, fpu: 4, lsu: 3, simd: 4, l1KB: 64, l1Lat: 4, l2KB: 2048, l2Lat: 16, memNs: 60, memGBs: 64, mshr: 16, ghz: 3.5 },
  },
];

export const PARAM_GROUPS = [
  {
    id: 'core',
    title: 'Core and platform',
    params: [
      { key: 'ooo', label: 'Routing', kind: 'seg', options: [[false, 'Fixed order'], [true, 'Dynamic']], help: 'Fixed order issues strictly in program order (in-order). Dynamic routing lets any ready instruction depart first (out-of-order).' },
      { key: 'width', label: 'Width', kind: 'step', min: 1, max: 8, unit: '/cycle', help: 'Instructions fetched, issued and retired per cycle.' },
      { key: 'window', label: 'Platform berths', kind: 'select', options: [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256], help: 'Instruction window: how many instructions can be in flight between boarding and exit.' },
      { key: 'renameRegs', label: 'Rename registers', kind: 'select', options: [0, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256], none: 'None', help: 'Spare registers for renaming. Each result on its way takes one, so a register name can be reused at once. With none, an instruction must wait until older ones are done with its register.' },
      { key: 'feDepth', label: 'Entrance stops', kind: 'step', min: 2, max: 14, help: 'Front-end depth. Cycles from fetch to the platform, and the refill cost after a mispredicted branch.' },
      { key: 'predictor', label: 'Route guessing', kind: 'select', options: PREDICTORS.map((p) => p.id), help: (c) => `Branch predictor. ${PREDICTOR_BY_ID[c.predictor].help} A wrong guess closes the entrance until the branch resolves.` },
      { key: 'ghz', label: 'Clock', kind: 'select', options: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5], unit: ' GHz', help: 'Cycles per nanosecond. Memory is timed in nanoseconds, so a faster clock puts main memory more cycles away.' },
    ],
  },
  {
    id: 'stations',
    title: 'Stations',
    params: [
      { key: 'alu', label: 'ALUs', kind: 'step', min: 1, max: 8, help: 'Integer stations. Branches use them too.' },
      { key: 'fpu', label: 'FPUs', kind: 'step', min: 1, max: 6, help: 'Floating-point stations. Divides occupy one for 12 cycles.' },
      { key: 'lsu', label: 'Load/store ports', kind: 'step', min: 1, max: 4, help: 'Stations that send loads and stores toward the caches.' },
      { key: 'simd', label: 'SIMD lanes', kind: 'select', options: [1, 2, 4, 8, 16], help: 'Vectorizable work is packed into vehicles this many lanes wide.' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory line',
    params: [
      { key: 'l1KB', label: 'L1 size', kind: 'select', options: [2, 4, 8, 16, 32, 64, 128], unit: ' KB' },
      { key: 'l1Lat', label: 'L1 latency', kind: 'step', min: 1, max: 8, unit: ' cyc' },
      { key: 'l2KB', label: 'L2 size', kind: 'select', options: [0, 64, 128, 256, 512, 1024, 2048, 4096], unit: ' KB', none: 'None' },
      { key: 'l2Lat', label: 'L2 latency', kind: 'step', min: 6, max: 40, step: 2, unit: ' cyc' },
      { key: 'memNs', label: 'Memory latency', kind: 'select', options: [20, 40, 60, 80, 100, 150], unit: ' ns', help: 'Round trip to main memory after missing every cache.' },
      { key: 'memGBs', label: 'Memory bandwidth', kind: 'select', options: [4, 8, 16, 32, 64, 128], unit: ' GB/s', help: 'How often the memory line can start another 64-byte delivery.' },
      { key: 'mshr', label: 'Memory gates', kind: 'step', min: 1, max: 16, help: 'Cache misses that can be outstanding at once (MSHRs).' },
    ],
  },
];

export const PARAMS = PARAM_GROUPS.flatMap((g) => g.params);
export const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export function normalizeCfg(c) {
  const out = { ...FLEET[0].cfg, ...c };
  for (const p of PARAMS) {
    if (p.kind === 'step') out[p.key] = Math.min(p.max, Math.max(p.min, Math.round(out[p.key])));
    if (p.kind === 'select' && !p.options.includes(out[p.key])) {
      if (typeof p.options[0] === 'string') out[p.key] = FLEET[0].cfg[p.key];
      else out[p.key] = p.options.reduce((a, b) => (Math.abs(b - out[p.key]) < Math.abs(a - out[p.key]) ? b : a));
    }
    if (p.kind === 'seg') out[p.key] = !!out[p.key];
  }
  return out;
}

export const memCycles = (cfg) => Math.max(1, Math.round(cfg.memNs * cfg.ghz));
export const busCycles = (cfg) => Math.max(1, Math.round((64 * cfg.ghz) / cfg.memGBs));

export function formatParam(key, v) {
  const p = PARAM_BY_KEY[key];
  if (key === 'ooo') return v ? 'Dynamic' : 'Fixed order';
  if (key === 'predictor') return PREDICTOR_BY_ID[v]?.label ?? String(v);
  if (p?.none && v === 0) return p.none;
  if (key === 'l1KB' || key === 'l2KB') return v >= 1024 ? v / 1024 + ' MB' : v + ' KB';
  if (key === 'ghz') return v.toFixed(1) + ' GHz';
  return v + (p?.unit || '');
}

export function specChips(cfg) {
  return [
    { text: cfg.ooo ? 'Dynamic routing' : 'Fixed order', keys: ['ooo'] },
    { text: `${cfg.width}-wide`, keys: ['width'] },
    { text: `${cfg.window} berths`, keys: ['window'] },
    { text: cfg.renameRegs ? `${cfg.renameRegs} rename regs` : 'No renaming', keys: ['renameRegs'] },
    { text: `${cfg.alu} ALU · ${cfg.fpu} FPU · ${cfg.lsu} LS`, keys: ['alu', 'fpu', 'lsu'] },
    { text: cfg.simd > 1 ? `SIMD ×${cfg.simd}` : 'Scalar', keys: ['simd'] },
    { text: `L1 ${formatParam('l1KB', cfg.l1KB)}`, keys: ['l1KB', 'l1Lat'] },
    { text: cfg.l2KB ? `L2 ${formatParam('l2KB', cfg.l2KB)}` : 'No L2', keys: ['l2KB', 'l2Lat'] },
    { text: `Mem ${cfg.memNs} ns`, keys: ['memNs', 'memGBs', 'mshr'] },
    { text: formatParam('ghz', cfg.ghz), keys: ['ghz'] },
    { text: `${cfg.feDepth}-stop entrance`, keys: ['feDepth'] },
    { text: PREDICTOR_BY_ID[cfg.predictor].chip, keys: ['predictor'] },
  ];
}

const snapOption = (key, v) => PARAM_BY_KEY[key].options.reduce((a, b) => (Math.abs(b - v) <= Math.abs(a - v) ? b : a));
const halfMem = (c) => {
  const h = snapOption('memNs', c.memNs / 2);
  return h < c.memNs ? h : PARAM_BY_KEY.memNs.options[Math.max(0, PARAM_BY_KEY.memNs.options.indexOf(c.memNs) - 1)];
};

// The next predictor up. Local and global history both step to the
// tournament that combines them.
const UPGRADE = { static: 'bit1', bit1: 'bit2', bit2: 'local', local: 'tournament', global: 'tournament' };
const nextPredictor = (p) => UPGRADE[p] || p;

// One-variable experiments: clone a machine and change a single thing.
export const EXPERIMENTS = [
  { id: 'ooo', label: (c) => (c.ooo ? 'Switch to fixed order' : 'Switch to dynamic routing'), tag: (c) => (c.ooo ? 'in-order' : 'out-of-order'), apply: (c) => ({ ...c, ooo: !c.ooo }), ok: () => true },
  { id: 'alu', label: () => 'Add an ALU', tag: () => '+ALU', apply: (c) => ({ ...c, alu: c.alu + 1 }), ok: (c) => c.alu < 8 },
  { id: 'fpu', label: () => 'Add an FPU', tag: () => '+FPU', apply: (c) => ({ ...c, fpu: c.fpu + 1 }), ok: (c) => c.fpu < 6 },
  { id: 'lsu', label: () => 'Add a load/store port', tag: () => '+port', apply: (c) => ({ ...c, lsu: c.lsu + 1 }), ok: (c) => c.lsu < 4 },
  { id: 'simd', label: () => 'Double the SIMD lanes', tag: (c) => `SIMD ×${c.simd * 2}`, apply: (c) => ({ ...c, simd: c.simd * 2 }), ok: (c) => c.simd < 16 },
  { id: 'width', label: () => 'Double the width', tag: (c) => `${Math.min(8, c.width * 2)}-wide`, apply: (c) => ({ ...c, width: Math.min(8, c.width * 2) }), ok: (c) => c.width < 8 },
  { id: 'fe', label: () => 'Shorten the entrance', tag: (c) => `${Math.max(2, Math.round(c.feDepth / 2))}-stop entrance`, apply: (c) => ({ ...c, feDepth: Math.max(2, Math.round(c.feDepth / 2)) }), ok: (c) => c.feDepth > 2 },
  { id: 'rename', label: (c) => (c.renameRegs ? 'Turn off register renaming' : 'Add register renaming'), tag: (c) => (c.renameRegs ? 'no renaming' : 'renaming'), apply: (c) => ({ ...c, renameRegs: c.renameRegs ? 0 : snapOption('renameRegs', Math.max(16, c.window)) }), ok: () => true },
  { id: 'pregs', label: () => 'Double the rename registers', tag: (c) => `${Math.min(256, c.renameRegs * 2)} rename regs`, apply: (c) => ({ ...c, renameRegs: Math.min(256, c.renameRegs * 2) }), ok: (c) => c.renameRegs > 0 && c.renameRegs < 256 },
  { id: 'predict', label: () => 'Upgrade route guessing', tag: (c) => formatParam('predictor', nextPredictor(c.predictor)), apply: (c) => ({ ...c, predictor: nextPredictor(c.predictor) }), ok: (c) => c.predictor !== 'tournament' && c.predictor !== 'perfect' },
  { id: 'perfect', label: () => 'Guess every branch right', tag: () => 'perfect guess', apply: (c) => ({ ...c, predictor: 'perfect' }), ok: (c) => c.predictor !== 'perfect' },
  { id: 'window', label: () => 'Double the platform', tag: (c) => `${Math.min(256, c.window * 2)} berths`, apply: (c) => ({ ...c, window: Math.min(256, c.window * 2) }), ok: (c) => c.window < 256 },
  { id: 'l1', label: () => 'Double the L1 cache', tag: (c) => `L1 ${formatParam('l1KB', Math.min(128, c.l1KB * 2))}`, apply: (c) => ({ ...c, l1KB: Math.min(128, c.l1KB * 2) }), ok: (c) => c.l1KB < 128 },
  { id: 'l2', label: (c) => (c.l2KB ? 'Double the L2 cache' : 'Add a 256 KB L2'), tag: (c) => `L2 ${formatParam('l2KB', c.l2KB ? c.l2KB * 2 : 256)}`, apply: (c) => ({ ...c, l2KB: c.l2KB ? Math.min(4096, c.l2KB * 2) : 256 }), ok: (c) => c.l2KB < 4096 },
  { id: 'mem', label: () => 'Halve memory latency', tag: (c) => `mem ${halfMem(c)} ns`, apply: (c) => ({ ...c, memNs: halfMem(c) }), ok: (c) => c.memNs > 20 },
  { id: 'bw', label: () => 'Double memory bandwidth', tag: (c) => `${Math.min(128, c.memGBs * 2)} GB/s`, apply: (c) => ({ ...c, memGBs: Math.min(128, c.memGBs * 2) }), ok: (c) => c.memGBs < 128 },
  { id: 'mshr', label: () => 'Double the memory gates', tag: (c) => `${Math.min(16, c.mshr * 2)} gates`, apply: (c) => ({ ...c, mshr: Math.min(16, c.mshr * 2) }), ok: (c) => c.mshr < 16 },
  { id: 'clock', label: () => 'Raise the clock 1 GHz', tag: (c) => `${Math.min(5, c.ghz + 1).toFixed(1)} GHz`, apply: (c) => ({ ...c, ghz: Math.min(5, c.ghz + 1) }), ok: (c) => c.ghz < 5 },
];

export function describeDiff(a, b) {
  const out = [];
  for (const p of PARAMS) {
    if (a[p.key] !== b[p.key]) {
      const rank = (v) => (p.key === 'predictor' ? p.options.indexOf(v) : v);
      out.push({ key: p.key, label: p.label, from: formatParam(p.key, a[p.key]), to: formatParam(p.key, b[p.key]), up: rank(b[p.key]) > rank(a[p.key]) });
    }
  }
  return out;
}
