// Map legend and the passenger-information guide.

import { h, clear } from './dom.js';

const cap = (t, cls = '') => h('span', { class: 'cap ' + cls, style: `--c:var(--op-${t})` });
const dot = (k) => h('span', { class: 'dot', style: `--c:var(--st-${k})` });

export function renderLegend(root) {
  clear(root).append(
    h('span', { class: 'legend-item' }, cap('int'), 'Integer'),
    h('span', { class: 'legend-item' }, cap('fp'), 'Float'),
    h('span', { class: 'legend-item' }, cap('load'), 'Load'),
    h('span', { class: 'legend-item' }, cap('store'), 'Store'),
    h('span', { class: 'legend-item' }, cap('branch'), 'Branch'),
    h('span', { class: 'legend-item' }, cap('fp', 'cap-done'), 'Finished'),
    h('span', { class: 'legend-item' }, cap('fp', 'cap-away'), 'Berth reserved'),
    h('span', { class: 'legend-item' }, dot('busy'), 'Ready to depart'),
    h('span', { class: 'legend-item' }, dot('dep'), 'Needs a result'),
    h('span', { class: 'legend-item' }, dot('mem'), 'Waiting on memory'),
    h('span', { class: 'legend-item' }, dot('unit'), 'Station full'),
    h('span', { class: 'legend-item' }, dot('order'), 'Held in order'),
  );
}

export function renderGuide(root) {
  const card = (title, body, glyphs) => h('article', { class: 'guide-card' }, glyphs ? h('div', { class: 'glyphs' }, glyphs) : null, h('h3', null, title), h('p', null, body));
  clear(root).append(
    card('Vehicles are instructions', 'Color shows the kind of work. The number names the work it carries, and the same number means the same work on every network, so you can follow one operation across machines.', [cap('int'), cap('fp'), cap('load'), cap('store'), cap('branch')]),
    card('The entrance is fetch and decode', 'Up to one vehicle per lane enters each cycle and rides through the entrance stops. When a branch is guessed wrong the signal turns red: nothing enters until the branch resolves, then the entrance has to refill.', null),
    card('The platform is the instruction window', 'Each vehicle reserves a berth from boarding until it exits. A dashed berth belongs to a vehicle that is out on the network. When every berth is taken, nothing new can board.', [cap('fp', 'cap-away'), 'reserved']),
    card('Fixed order or dynamic routing', 'In-order networks depart vehicles strictly in program order, so one stuck vehicle holds everyone behind it (the ringed berth is next in line). Out-of-order networks let any vehicle with its inputs ready depart first; a green glow marks a vehicle overtaking an older, stuck one.', null),
    card('Stations are execution units', 'Each track takes one new vehicle per cycle and carries it for the operation’s latency; the ticks mark cycles. A divide blocks its FPU for 12 cycles, shown as a single-track section.', null),
    card('SIMD lanes carry work in bulk', 'On SIMD networks, vectorizable work rides as coupled cars, one lane per operation. Pale lanes are capacity that carried nothing.', null),
    card('The memory line', 'Loads stop at L1 next door. Misses ride out to L2, then to main memory, a remote terminal whose distance on the map grows with its latency. Memory gates cap how many misses can be out at once; bandwidth sets how often a delivery can leave.', null),
    card('Exit in timetable order', 'Finished vehicles ride the return line back to their berth and wear a check mark. They exit at the terminus strictly in program order, so a finished vehicle can wait behind a slow one ahead of it.', [cap('int', 'cap-done'), 'finished']),
    card('Badges say why a vehicle waits', 'Green: ready, waiting only for a departure slot. Amber: it needs a result that isn’t ready. Blue: that result is coming from the caches or main memory. Red: every station of its kind is busy. Grey: the fixed timetable holds it behind an older vehicle.', [dot('busy'), dot('dep'), dot('mem'), dot('unit'), dot('order')]),
    card('Controls', 'Click any vehicle to see its whole journey and why it waited. Space plays and pauses, the arrow keys step one cycle, N jumps to the next stall, Escape clears the selection.', null),
  );
}
