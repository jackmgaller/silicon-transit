// Network cards: header with spec chips and actions, the adjust drawer,
// the transit-map canvas and the live service status line.

import { h, svg, clear } from './dom.js';
import { PARAM_GROUPS, specChips, formatParam } from './machine.js';
import { NetworkView } from './render.js';

const ICON_DUP = '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="9" height="9" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M13 4.5H6.2A1.7 1.7 0 0 0 4.5 6.2V13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_X = '<svg viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_CARET = '<svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SLIDERS = '<svg viewBox="0 0 20 20"><path d="M4 6h12M4 14h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="6" r="2.4" fill="var(--white)" stroke="currentColor" stroke-width="1.8"/><circle cx="13" cy="14" r="2.4" fill="var(--white)" stroke="currentColor" stroke-width="1.8"/></svg>';

export function buildCard(M, app) {
  const nameInput = h('input', { class: 'net-name', id: `m${M.uid}-name`, 'aria-label': `Name of network ${M.letter}`, maxlength: 32 });
  nameInput.value = M.name;
  fitName(nameInput);
  nameInput.addEventListener('input', () => {
    fitName(nameInput);
    app.renameMachine(M, nameInput.value);
  });
  const chips = h('div', { class: 'chips' });
  const adjust = h('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', onclick: () => app.toggleDrawer(M) }, svg(ICON_SLIDERS), 'Adjust');
  const tryBtn = h('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'menu', onclick: () => app.openExperiments(M, tryBtn) }, 'Try one change', svg(ICON_CARET));
  const dup = h('button', { class: 'btn btn-round', type: 'button', title: 'Duplicate this network', 'aria-label': `Duplicate network ${M.letter}`, onclick: () => app.cloneMachine(M) }, svg(ICON_DUP));
  const del = h('button', { class: 'btn btn-round', type: 'button', title: 'Remove this network', 'aria-label': `Remove network ${M.letter}`, onclick: () => app.removeMachine(M) }, svg(ICON_X));
  const bullet = h('span', { class: 'bullet' }, M.letter);
  const head = h('header', { class: 'net-head' }, bullet, nameInput, chips, h('div', { class: 'net-actions' }, adjust, tryBtn, dup, del));
  const drawer = h('div', { class: 'drawer', hidden: true });
  const canvas = h('canvas', { role: 'img', 'aria-label': `Transit map of network ${M.letter}. Click a vehicle to follow its journey.` });
  const stage = h('div', { class: 'net-stage' }, canvas);
  const pill = h('span', { class: 'status-pill' }, 'Good service');
  const text = h('p', { class: 'status-text' });
  const clock = h('span', { class: 'net-clock' });
  const status = h('footer', { class: 'net-status' }, pill, text, clock);
  const root = h('article', { class: 'net', vars: { '--line': M.color }, 'data-uid': M.uid }, head, drawer, stage, status);
  root.addEventListener('pointerdown', () => app.setFocus(M.uid));
  M.el = { root, bullet, nameInput, chips, adjust, tryBtn, dup, del, drawer, canvas, stage, pill, text, clock };
  M.view = new NetworkView(canvas);
  return root;
}

function fitName(input) {
  input.style.width = Math.max(6, Math.min(24, input.value.length + 1)) + 'ch';
}

export function updateCard(M, app) {
  const base = app.baseline();
  const diffKeys = new Set();
  if (base && base !== M) for (const k of Object.keys(M.cfg)) if (M.cfg[k] !== base.cfg[k]) diffKeys.add(k);
  const chips = clear(M.el.chips);
  for (const chip of specChips(M.cfg)) {
    const changed = chip.keys.some((k) => diffKeys.has(k));
    chips.append(h('span', { class: 'chip' + (changed ? ' chip-diff' : ''), title: changed ? `Differs from network ${base.letter}` : null }, chip.text));
  }
  M.el.bullet.textContent = M.letter;
  M.el.root.style.setProperty('--line', M.color);
  const full = app.state.machines.length >= app.maxMachines;
  M.el.dup.disabled = full;
  M.el.tryBtn.disabled = full;
  M.el.del.disabled = app.state.machines.length <= 1;
  if (!M.el.drawer.hidden) buildDrawer(M, app, diffKeys);
}

export function buildDrawer(M, app, diffKeys) {
  const focusedId = M.el.drawer.contains(document.activeElement) ? document.activeElement.id : null;
  const drawer = clear(M.el.drawer);
  const base = app.baseline();
  const cfg = M.cfg;
  if (!diffKeys) {
    diffKeys = new Set();
    if (base && base !== M) for (const k of Object.keys(cfg)) if (cfg[k] !== base.cfg[k]) diffKeys.add(k);
  }
  for (const g of PARAM_GROUPS) {
    const group = h('section', { class: 'drawer-group' }, h('h3', null, g.title));
    for (const p of g.params) {
      const id = `m${M.uid}-${p.key}`;
      let control;
      if (p.kind === 'seg') {
        control = h('div', { class: 'seg seg-sm', role: 'radiogroup', 'aria-label': p.label },
          p.options.map(([v, label]) => h('button', { type: 'button', role: 'radio', id: `${id}-${v}`, 'aria-checked': String(cfg[p.key] === v), onclick: () => app.setMachineParam(M, p.key, v) }, label)),
        );
      } else if (p.kind === 'step') {
        const step = p.step || 1;
        const out = h('output', { id }, String(cfg[p.key]));
        control = h('div', { class: 'stepper' },
          h('button', { type: 'button', id: `${id}-dec`, 'aria-label': `Decrease ${p.label}`, disabled: cfg[p.key] <= p.min, onclick: () => app.setMachineParam(M, p.key, Math.max(p.min, cfg[p.key] - step)) }, '−'),
          out,
          h('button', { type: 'button', id: `${id}-inc`, 'aria-label': `Increase ${p.label}`, disabled: cfg[p.key] >= p.max, onclick: () => app.setMachineParam(M, p.key, Math.min(p.max, cfg[p.key] + step)) }, '+'),
        );
      } else {
        const sel = h('select', { class: 'select', id, 'aria-label': p.label },
          p.options.map((v) => h('option', { value: String(v), selected: cfg[p.key] === v }, formatParam(p.key, v))),
        );
        sel.addEventListener('change', () => app.setMachineParam(M, p.key, typeof p.options[0] === 'string' ? sel.value : +sel.value));
        control = sel;
      }
      const unit = p.kind === 'step' && p.unit ? h('small', null, p.unit.trim()) : null;
      const help = typeof p.help === 'function' ? p.help(cfg) : p.help;
      group.append(
        h('div', { class: 'param' + (p.kind === 'seg' ? ' param-stack' : '') + (diffKeys.has(p.key) ? ' is-changed' : ''), title: help || null },
          h('label', { class: 'param-label', for: p.kind === 'select' ? id : null }, h('span', { class: 'param-name' }, p.label), help ? h('small', null, help) : unit),
          control,
        ),
      );
    }
    drawer.append(group);
  }
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el && !el.disabled) el.focus();
  }
}
