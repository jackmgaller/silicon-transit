// Prints the effect of every one-variable experiment on each preset.
// Run: node tools/experiments.mjs [base-machine]
import { PRESETS, generateWorkload, presetParams } from '../src/workload.js';
import { FLEET, EXPERIMENTS, normalizeCfg } from '../src/machine.js';
import { simulate } from '../src/sim.js';
import { computeStats, compareNarrative } from '../src/analysis.js';

const baseId = process.argv[2] || 'local';
const verbose = process.argv.includes('-v');
const base = normalizeCfg(FLEET.find((m) => m.id === baseId).cfg);
for (const p of PRESETS) {
  const wl = generateWorkload(presetParams(p.id, { seed: 2718, warm: true }));
  const tA = simulate(wl, base);
  const A = { name: 'Base', cfg: base, trace: tA, stats: computeStats(tA) };
  const cells = [];
  for (const ex of EXPERIMENTS) {
    if (!ex.ok(base)) continue;
    const cfg = normalizeCfg(ex.apply(base));
    const tB = simulate(wl, cfg);
    const B = { name: ex.tag(base), cfg, trace: tB, stats: computeStats(tB) };
    const speed = A.stats.ns / B.stats.ns;
    cells.push(`${ex.id}:${speed.toFixed(2)}`);
    if (verbose) {
      const n = compareNarrative(A, B);
      console.log(`  [${p.id} ${ex.id}] ${n.headline}\n     - ${n.notes.slice(0, 3).join('\n     - ')}`);
    }
  }
  console.log(`${p.id.padEnd(12)} ${String(A.stats.cycles).padStart(5)}c  ${cells.join('  ')}`);
}
