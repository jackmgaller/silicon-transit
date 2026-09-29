// The fictional instruction set: what each operation is, which station
// (execution unit) serves it and how long it takes there.

export const OPS = {
  add: { cls: 'int', type: 'int', unit: 'alu', lat: 1, pipe: true, name: 'Integer add', short: 'add' },
  sub: { cls: 'int', type: 'int', unit: 'alu', lat: 1, pipe: true, name: 'Integer subtract', short: 'sub' },
  and: { cls: 'int', type: 'int', unit: 'alu', lat: 1, pipe: true, name: 'Bitwise AND', short: 'and' },
  xor: { cls: 'int', type: 'int', unit: 'alu', lat: 1, pipe: true, name: 'Bitwise XOR', short: 'xor' },
  shl: { cls: 'int', type: 'int', unit: 'alu', lat: 1, pipe: true, name: 'Shift left', short: 'shl' },
  imul: { cls: 'int', type: 'int', unit: 'alu', lat: 3, pipe: true, name: 'Integer multiply', short: 'mul' },
  fadd: { cls: 'fp', type: 'fp', unit: 'fpu', lat: 3, pipe: true, name: 'Floating-point add', short: 'fadd' },
  fmul: { cls: 'fp', type: 'fp', unit: 'fpu', lat: 4, pipe: true, name: 'Floating-point multiply', short: 'fmul' },
  fma: { cls: 'fp', type: 'fp', unit: 'fpu', lat: 4, pipe: true, name: 'Fused multiply-add', short: 'fma' },
  fdiv: { cls: 'fp', type: 'fp', unit: 'fpu', lat: 12, pipe: false, name: 'Floating-point divide', short: 'fdiv' },
  load: { cls: 'mem', type: 'load', unit: 'lsu', lat: 0, pipe: true, name: 'Load from memory', short: 'load' },
  store: { cls: 'mem', type: 'store', unit: 'lsu', lat: 1, pipe: true, name: 'Store to memory', short: 'store' },
  br: { cls: 'branch', type: 'branch', unit: 'alu', lat: 1, pipe: true, name: 'Conditional branch', short: 'br' },
};

// Relative frequency of each operation inside a workload class.
export const CLASS_OPS = {
  int: [['add', 40], ['sub', 14], ['and', 10], ['xor', 10], ['shl', 10], ['imul', 16]],
  fp: [['fadd', 38], ['fmul', 34], ['fma', 22], ['fdiv', 6]],
  mem: [['load', 68], ['store', 32]],
  branch: [['br', 1]],
};

// Operations allowed in a vectorizable loop body.
export const VEC_OPS = {
  int: [['add', 45], ['sub', 15], ['xor', 15], ['imul', 25]],
  fp: [['fadd', 40], ['fmul', 35], ['fma', 25]],
};

export const TYPES = ['int', 'fp', 'load', 'store', 'branch'];
export const TYPE_LABEL = { int: 'Integer', fp: 'Floating point', load: 'Load', store: 'Store', branch: 'Branch' };
export const UNITS = ['alu', 'fpu', 'lsu'];
export const UNIT_LABEL = { alu: 'ALU', fpu: 'FPU', lsu: 'Load/store' };
export const UNIT_PLURAL = { alu: 'ALUs', fpu: 'FPUs', lsu: 'load/store ports' };
export const UNIT_NOUN = { alu: 'ALU', fpu: 'FPU', lsu: 'load/store port' };
export const UNIT_INDEX = { alu: 0, fpu: 1, lsu: 2 };

// Why a vehicle (instruction) is not moving, and where issue capacity went.
export const C = {
  BUSY: 0, // a departure slot was used
  DEP: 1, // waiting for a result from an earlier instruction
  MEM: 2, // waiting on data from L2 or main memory
  UNIT: 3, // ready, but every station of its kind was taken
  ORDER: 4, // ready, but in-order issue holds it behind an older one
  WINDOW: 5, // platform (window) full, nothing new can board
  BRANCH: 6, // front-end recovering from a wrong-route branch
  SUPPLY: 7, // front-end has not delivered anything yet
  DRAIN: 8, // no work left to board, last services finishing
  WIDTH: 9, // ready, but this cycle's departure slots were all used
  GATES: 10, // load ready, but every memory gate (MSHR) is busy
  NAME: 11, // ready, but its register is still needed by an older instruction
  REGS: 12, // no free rename register, so nothing new can board
};

export const CODE_INFO = [
  { key: 'busy', label: 'In service', short: 'In service' },
  { key: 'dep', label: 'Waiting for a connection', short: 'Connection' },
  { key: 'mem', label: 'Waiting on memory', short: 'Memory' },
  { key: 'unit', label: 'Station at capacity', short: 'Station full' },
  { key: 'order', label: 'Held by the fixed timetable', short: 'Held in order' },
  { key: 'window', label: 'Platform full', short: 'Platform full' },
  { key: 'branch', label: 'Wrong-route recovery', short: 'Wrong route' },
  { key: 'supply', label: 'Awaiting arrivals', short: 'No arrivals' },
  { key: 'drain', label: 'End of service', short: 'Last trains' },
  { key: 'width', label: 'Departure slots all taken', short: 'Slots full' },
  { key: 'gates', label: 'Memory gates all busy', short: 'Gates full' },
  { key: 'name', label: 'Register still in use', short: 'Register in use' },
  { key: 'regs', label: 'Out of rename registers', short: 'No free registers' },
];

// Codes that appear in the capacity breakdown, in display order.
export const SLOT_CODES = [C.BUSY, C.DEP, C.MEM, C.UNIT, C.ORDER, C.NAME, C.WINDOW, C.REGS, C.BRANCH, C.SUPPLY, C.DRAIN];

// Registers: sixteen names, r0–r15, shared by integer, floating-point and
// SIMD values (on SIMD networks every register is as wide as the lanes).
export const NREG = 16;
export const regName = (r) => 'r' + r;

// Why an access found (or missed) its line in L1.
export const LOC = {
  REUSE: 0, // this word was used before and is still here (temporal locality)
  NEAR: 1, // a neighboring word brought the line in (spatial locality)
  COLD: 2, // first time this program touched the line
  EVICTED: 3, // the line was here before but was pushed out for room
};
export const LOC_INFO = [
  { key: 'reuse', label: 'Reused', long: 'Reused data (temporal locality)' },
  { key: 'near', label: 'Neighbor', long: 'Brought in by a neighbor (spatial locality)' },
  { key: 'cold', label: 'First use', long: 'Missed: first use of the line' },
  { key: 'evicted', label: 'Evicted', long: 'Missed: line was pushed out earlier' },
];

// Memory level reached by a load.
export const LVL = { L1: 0, L2: 1, MEM: 2, SHARED_L1: 3, SHARED_L2: 4 };
export const LVL_LABEL = ['L1 hit', 'L2 hit', 'Main memory', 'Shared delivery at L1', 'Shared delivery at L2'];

export const hex = (n) => '0x' + (n >>> 0).toString(16).toUpperCase();
