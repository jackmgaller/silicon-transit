// Timeline scrubber: one strip per network showing how its departure
// capacity was used across the run, with a draggable playhead.

import { PAL, withAlpha } from './palette.js';
import { SLOT_CODES } from './isa.js';

const ROW_H = 9;
const ROW_GAP = 4;
const LEFT = 22;

export class Scrubber {
  constructor(canvas, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.machines = [];
    this.cache = null;
    this.cssW = 0;
    this.dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.seekFrom(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) this.seekFrom(e);
    });
    const end = () => {
      this.dragging = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  seekFrom(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left - LEFT;
    const w = r.width - LEFT - 6;
    this.onSeek(Math.max(0, Math.min(1, x / w)) * this.tMax);
  }

  setData(machines, tMax, sync) {
    this.machines = machines;
    this.tMax = Math.max(1, tMax);
    this.sync = sync;
    this.cache = null;
    this.resize();
  }

  resize() {
    const cssW = this.canvas.parentElement.clientWidth;
    const cssH = Math.max(1, this.machines.length) * (ROW_H + ROW_GAP) + 12;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr && this.cache) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.round(cssH * dpr);
    this.cache = null;
  }

  // Draw every network's capacity strip once; frames only add the playhead.
  build() {
    const cv = document.createElement('canvas');
    cv.width = this.canvas.width;
    cv.height = this.canvas.height;
    const ctx = cv.getContext('2d');
    ctx.scale(this.dpr, this.dpr);
    const w = this.cssW - LEFT - 6;
    this.machines.forEach((M, row) => {
      const tr = M.trace;
      const y = 6 + row * (ROW_H + ROW_GAP);
      ctx.fillStyle = M.color;
      ctx.beginPath();
      ctx.arc(9, y + ROW_H / 2, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 8.5px ${PAL.fontUi}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(M.letter, 9, y + ROW_H / 2 + 0.5);
      const span = this.sync === 'time' ? tr.cycles / tr.cfg.ghz : tr.cycles;
      const px = Math.max(1, Math.round((span / this.tMax) * w));
      ctx.fillStyle = withAlpha('#141820', 0.05);
      ctx.fillRect(LEFT, y, w, ROW_H);
      const counts = new Float64Array(16);
      for (let x = 0; x < px; x++) {
        const c0 = Math.floor((x / px) * tr.cycles);
        const c1 = Math.max(c0 + 1, Math.floor(((x + 1) / px) * tr.cycles));
        counts.fill(0);
        let total = 0;
        for (let c = c0; c < c1 && c < tr.cycles; c++) {
          for (let k = 0; k < tr.W; k++) counts[tr.cyc.slots[c * tr.W + k]]++;
          total += tr.W;
        }
        if (!total) continue;
        let yy = y + ROW_H;
        for (const code of SLOT_CODES) {
          if (!counts[code]) continue;
          const hh = (counts[code] / total) * ROW_H;
          ctx.fillStyle = PAL.code[code];
          ctx.fillRect(LEFT + x, yy - hh, 1.02, hh);
          yy -= hh;
        }
      }
      // Finish flag.
      ctx.fillStyle = PAL.ink;
      ctx.fillRect(LEFT + px - 1, y - 1, 2, ROW_H + 2);
    });
    this.cache = cv;
  }

  draw(t, focusUid) {
    if (!this.machines.length) return;
    this.resize();
    if (!this.cache) this.build();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const w = this.cssW - LEFT - 6;
    // Focused network's stalls as ticks under its strip.
    const row = this.machines.findIndex((M) => M.uid === focusUid);
    if (row >= 0) {
      const M = this.machines[row];
      const y = 6 + row * (ROW_H + ROW_GAP) + ROW_H + 1;
      ctx.fillStyle = withAlpha('#141820', 0.55);
      for (const ep of M.episodes) {
        const g = this.sync === 'time' ? ep.start / M.trace.cfg.ghz : ep.start;
        ctx.fillRect(LEFT + (g / this.tMax) * w - 0.5, y, 1, 2);
      }
    }
    const x = LEFT + (Math.min(t, this.tMax) / this.tMax) * w;
    ctx.fillStyle = PAL.ink;
    ctx.fillRect(x - 1, 2, 2, this.cssH - 4);
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
  }
}

