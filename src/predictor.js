// Branch predictors ("route guessing"). The timetable says where each branch
// comes from (its site) and which way it really goes; each network's
// predictor guesses in program order and learns from every outcome.

export const HIST_BITS = 6;
const HIST_MASK = (1 << HIST_BITS) - 1;

export const PREDICTORS = [
  { id: 'static', label: 'Static', chip: 'Static guess', help: 'No memory. Guesses that a loop goes round again and that a forward jump is skipped.' },
  { id: 'bit1', label: '1-bit', chip: '1-bit guess', help: 'Remembers the last way each branch went and guesses the same again.' },
  { id: 'bit2', label: '2-bit counter', chip: '2-bit guess', help: 'A saturating counter per branch: it takes two surprises in a row to change its mind.' },
  { id: 'local', label: 'Local history', chip: 'Local history', help: `Remembers each branch’s last ${HIST_BITS} turns and learns what follows each pattern. Catches loop exits and repeating patterns.` },
  { id: 'global', label: 'Global history', chip: 'Global history', help: `Learns from the last ${HIST_BITS} branches of any kind. Catches branches that follow an earlier one.` },
  { id: 'tournament', label: 'Tournament', chip: 'Tournament', help: 'Runs local and global history side by side and learns, per branch, which to trust.' },
  { id: 'perfect', label: 'Perfect', chip: 'Perfect guess', help: 'An impossible oracle that never guesses wrong. Shows what branches cost everything else.' },
];
export const PREDICTOR_BY_ID = Object.fromEntries(PREDICTORS.map((p) => [p.id, p]));

// Two-bit saturating counters: 0-1 guess not taken, 2-3 guess taken. A new
// entry starts weakly on the static guess, or on `fallback` when given.
class Counters {
  constructor() {
    this.m = new Map();
  }
  get(key, back, fallback) {
    const v = this.m.get(key);
    return v !== undefined ? v : fallback !== undefined ? fallback : back ? 2 : 1;
  }
  train(key, back, taken, fallback) {
    const v = this.get(key, back, fallback);
    this.m.set(key, taken ? Math.min(3, v + 1) : Math.max(0, v - 1));
  }
}

function makePredictor(id) {
  if (id === 'perfect') return { guess: (s, back, taken) => taken, learn() {} };
  if (id === 'static') return { guess: (s, back) => back, learn() {} };
  if (id === 'bit1') {
    const last = new Map();
    return {
      guess: (s, back) => (last.has(s) ? last.get(s) : back),
      learn: (s, back, taken) => last.set(s, taken),
    };
  }
  if (id === 'bit2') {
    const ct = new Counters();
    return { guess: (s, back) => ct.get(s, back) >= 2, learn: (s, back, taken) => ct.train(s, back, taken) };
  }
  // History predictors: a counter per (site, history) pair. A history not
  // seen before falls back on the branch's own 2-bit counter.
  const base = new Counters();
  const localHist = new Map();
  const local = new Counters();
  const global = new Counters();
  const chooser = new Counters();
  let ghist = 0;
  const lKey = (s) => s * 64 + (localHist.get(s) || 0);
  const gKey = (s) => s * 64 + ghist;
  const guessL = (s, back) => local.get(lKey(s), back, base.get(s, back)) >= 2;
  const guessG = (s, back) => global.get(gKey(s), back, base.get(s, back)) >= 2;
  return {
    guess(s, back) {
      if (id === 'local') return guessL(s, back);
      if (id === 'global') return guessG(s, back);
      // Tournament: the chooser leans global at 2-3, local at 0-1.
      return chooser.get(s, false) >= 2 ? guessG(s, back) : guessL(s, back);
    },
    learn(s, back, taken) {
      const l = guessL(s, back);
      const g = guessG(s, back);
      if (id === 'tournament' && l !== g) chooser.train(s, false, g === taken);
      local.train(lKey(s), back, taken, base.get(s, back));
      global.train(gKey(s), back, taken, base.get(s, back));
      base.train(s, back, taken);
      localHist.set(s, (((localHist.get(s) || 0) << 1) | (taken ? 1 : 0)) & HIST_MASK);
      ghist = ((ghist << 1) | (taken ? 1 : 0)) & HIST_MASK;
    },
  };
}

// Run one predictor over the timetable's branches (after the warm-up
// history, when the timetable asks for warm state). Returns, per scalar
// operation, 1 if the branch was taken and 2 if it was guessed taken.
export function predictBranches(workload, id) {
  const cache = (workload.guessCache ||= new Map());
  if (cache.has(id)) return cache.get(id);
  const { ops, branchSites: sites, warmBranches: warm } = workload;
  const p = makePredictor(PREDICTOR_BY_ID[id] ? id : 'bit2');
  if (workload.params.warm && warm) {
    for (let k = 0; k < warm.site.length; k++) {
      const s = warm.site[k];
      p.learn(s, sites[s].back, warm.taken[k] === 1);
    }
  }
  const out = new Uint8Array(ops.length);
  for (const o of ops) {
    if (o.type !== 'branch') continue;
    const back = sites[o.site].back;
    const g = p.guess(o.site, back, o.taken);
    p.learn(o.site, back, o.taken);
    out[o.i] = (o.taken ? 1 : 0) | (g ? 2 : 0);
  }
  cache.set(id, out);
  return out;
}

export function countWrong(workload, id) {
  const g = predictBranches(workload, id);
  let n = 0;
  for (const o of workload.ops) if (o.type === 'branch' && ((g[o.i] & 1) !== 0) !== ((g[o.i] & 2) !== 0)) n++;
  return n;
}
