// Canvas colors, read from the CSS tokens so the maps and the page agree.

export const PAL = {
  type: {},
  typeDark: {},
  code: [],
  loc: [],
};

function darken(hex, f) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

export function withAlpha(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n, fb) => cs.getPropertyValue(n).trim() || fb;
  PAL.ink = get('--ink', '#141820');
  PAL.ink2 = get('--ink-2', '#4A5261');
  PAL.ink3 = get('--ink-3', '#7C8594');
  PAL.card = get('--card', '#FBFCFA');
  PAL.rule = get('--rule', '#D5DAD9');
  PAL.rule2 = get('--rule-2', '#C3C9CA');
  PAL.grid = get('--map-grid', '#E6EAE8');
  PAL.entrance = get('--line-entrance', '#A7B0BC');
  PAL.mem = get('--line-mem', '#1C5DB8');
  PAL.memL1 = get('--op-load', '#06A3C4');
  PAL.ret = get('--line-return', '#B8C0CA');
  PAL.accent = get('--accent', '#0A84C6');
  PAL.good = get('--st-busy', '#22A45D');
  for (const t of ['int', 'fp', 'load', 'store', 'branch']) {
    PAL.type[t] = get('--op-' + t, '#888888');
    PAL.typeDark[t] = darken(PAL.type[t], 0.72);
  }
  PAL.unit = { alu: PAL.type.int, fpu: PAL.type.fp, lsu: PAL.type.load };
  const codes = ['busy', 'dep', 'mem', 'unit', 'order', 'window', 'branch', 'supply', 'drain', 'width', 'gates', 'name', 'regs'];
  PAL.code = codes.map((k) => get('--st-' + k, '#999999'));
  PAL.loc = ['reuse', 'near', 'cold', 'evicted'].map((k) => get('--loc-' + k, '#999999'));
  PAL.shared = get('--loc-ride', '#F2A100');
  PAL.fontUi = get('--font-ui', 'sans-serif');
  PAL.fontMono = get('--font-mono', 'monospace');
  PAL.fontDisplay = get('--font-display', 'sans-serif');
}
