# Silicon Transit

An interactive, deterministic CPU simulator drawn as an optimistic Y2K
transit network. Generate a workload, configure fictional processors, and
watch the same work run on each one, then read a service report that explains
why one network was faster.

- **Vehicles** are instructions (color = kind). SIMD work rides as coupled
  cars, one lane per operation.
- **Entrance** is fetch/decode, **platform** is the instruction window
  (reorder buffer), **stations** are execution units, the **memory line**
  runs to L1, L2 and the main-memory terminal, and vehicles exit at the
  **terminus** in program order.
- Every animation, metric and sentence is read from one cycle-level trace
  produced by `src/sim.js`.

## Run

From this folder (the commands below all assume it):

```bash
python3 tools/serve.py 4912
```

Then open http://localhost:4912. The dev server disables caching and accepts
`POST /__snap?name=x` canvas snapshots into `tools/snaps/` for debugging.

## Build a single file

```bash
node tools/build.mjs
```

Writes `dist/silicon-transit.html` (page fragment for publishing as an
artifact) and `dist/standalone.html` (opens directly in a browser).

## Check the simulator

```bash
node tools/test.mjs
```

Runs every preset workload on every fleet machine and every one-variable
experiment, checking invariants: in-order fetch and retirement, dependencies
respected, width and unit limits, window and memory-gate capacity, slot
accounting, SIMD coverage and determinism. `node tools/experiments.mjs local -v`
prints the speedup and generated explanation for each experiment.

## Layout

| File | Role |
| --- | --- |
| `src/workload.js` | Seeded workload generator, presets, cache warm-up history |
| `src/machine.js` | Machine parameters, fleet presets, one-change experiments |
| `src/sim.js` | SIMD lowering and the cycle simulator (the trace) |
| `src/cache.js` | Set-associative LRU cache |
| `src/analysis.js` | Stats, limits, stall episodes, generated explanations |
| `src/layout.js`, `src/render.js` | Transit-map geometry and canvas renderer |
| `src/main.js` | App state, playback, selection, fleet management |
| `src/planner.js`, `src/fleet.js`, `src/inspector.js`, `src/report.js`, `src/scrubber.js`, `src/guide.js` | UI panels |
