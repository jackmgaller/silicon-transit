// Sound. Each network hums along as it runs: a soft pluck whenever
// instructions exit, pitched by what kind of work they were, so loops turn
// into little repeating tunes and wide networks strum two-note chords. Stalls go
// quiet (with a low "bop" when a long one starts) and a finished network
// plays a short station chime. Everything sits in one pentatonic scale, so
// several networks at once stay consonant rather than cacophonous.

import { C, OPS } from './isa.js';

const PREF_KEY = 'silicon-transit:sound';

// Semitones above the root (C5) for each kind of work: C, E, G, A and D.
const TYPE_STEP = { int: 0, fp: 4, load: 7, store: 9, branch: 14 };
const ROOT = 523.25;
const hz = (semi) => ROOT * Math.pow(2, semi / 12);

const MAX_VOICES = 14;
const MIN_STALL = 6; // cycles

export class Sound {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.voices = 0;
    this.tracks = new WeakMap();
    this.lastStall = 0;
    this.on = true;
    try {
      this.on = localStorage.getItem(PREF_KEY) !== '0';
    } catch {}
    // Browsers only allow audio after a gesture, so the context is created
    // on the first one.
    const unlock = () => {
      if (this.on) this.ensure();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.5;
      const soften = ctx.createBiquadFilter();
      soften.type = 'lowpass';
      soften.frequency.value = 4200;
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -18;
      limit.ratio.value = 6;
      master.connect(soften).connect(limit).connect(ctx.destination);
      this.ctx = ctx;
      this.out = master;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get ready() {
    return this.on && this.ctx && this.ctx.state === 'running';
  }

  setOn(on) {
    this.on = on;
    try {
      localStorage.setItem(PREF_KEY, on ? '1' : '0');
    } catch {}
    if (on) {
      const ctx = this.ensure();
      if (ctx) ctx.resume().then(() => this.chime(0, 0.7));
    } else if (this.ctx) this.ctx.suspend();
  }

  // ------------------------------------------------------------- Voices

  // A small kalimba-like pluck: a sine with a quieter octave that fades first.
  pluck(freq, at, gain, pan, len = 0.4) {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + len);
    const shine = ctx.createGain();
    shine.gain.setValueAtTime(0.35, at);
    shine.gain.exponentialRampToValueAtTime(0.001, at + len * 0.3);
    const a = ctx.createOscillator();
    a.frequency.value = freq;
    const b = ctx.createOscillator();
    b.frequency.value = freq * 2;
    b.connect(shine).connect(env);
    a.connect(env);
    this.route(env, pan);
    a.start(at);
    b.start(at);
    a.stop(at + len + 0.02);
    b.stop(at + len + 0.02);
    this.voices++;
    a.onended = () => this.voices--;
  }

  // A soft sliding tone, for stalls.
  glide(from, to, at, gain, pan, len) {
    if (this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, at + len);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(to, at + len * 0.8);
    o.connect(env);
    this.route(env, pan);
    o.start(at);
    o.stop(at + len + 0.02);
    this.voices++;
    o.onended = () => this.voices--;
  }

  route(node, pan) {
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p).connect(this.out);
    } else node.connect(this.out);
  }

  // --------------------------------------------------------------- Cues

  chime(pan = 0, gain = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.02;
    [0, 4, 7, 12].forEach((s, i) => this.pluck(hz(s), t + i * 0.09, 0.16 * gain, pan, i === 3 ? 0.9 : 0.45));
  }

  play(on) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.01;
    const [a, b] = on ? [7, 12] : [12, 7];
    this.pluck(hz(a), t, 0.07, 0, 0.18);
    this.pluck(hz(b), t + 0.06, 0.07, 0, 0.22);
  }

  stall(code, pan = 0, gain = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.01;
    if (code === 'branch') this.glide(hz(14), hz(7), t, 0.07 * gain, pan, 0.3);
    else this.glide(hz(-17), hz(-20), t, 0.16 * gain, pan, 0.32);
  }

  // ----------------------------------------------------------- Following

  // Called every frame for each network with its local cycle. `moving` is
  // true only while time runs forward on its own (playing or stepping);
  // scrubs and jumps resync silently. `rate` is local cycles per second.
  follow(M, lc, { moving, focus, pan, rate, crowd }) {
    const tr = M.trace;
    const c = Math.floor(lc + 1e-6);
    let s = this.tracks.get(M);
    if (!s || s.version !== M.version || !moving || !this.ready || c < s.c) {
      s = this.resync(M, c);
      this.tracks.set(M, s);
      return;
    }
    if (c === s.c && !s.count) return;
    const now = this.ctx.currentTime;
    const gain = focus ? 1 : 0.55;

    // Instructions retire in program order, so a cursor walks them.
    const { retireC, instrs, N } = tr;
    while (s.next < N && retireC[s.next] <= c) {
      const type = OPS[instrs[s.next].op].type;
      s.types[type] = (s.types[type] || 0) + 1;
      s.count++;
      s.next++;
    }
    const eps = M.episodes;
    const minStall = Math.max(MIN_STALL, 0.2 * rate);
    while (s.ep < eps.length && eps[s.ep].start <= c) {
      const e = eps[s.ep++];
      if (e.end - e.start >= minStall && now - this.lastStall > 0.3) {
        this.lastStall = now;
        this.stall(e.code === C.BRANCH ? 'branch' : 'mem', pan, gain);
      }
    }
    s.c = c;

    // One note (or a two-note strum) per cycle, merged when cycles fly
    // by faster than a comfortable pace.
    const gap = (rate > 20 ? 0.15 : 0.1) * (1 + 0.3 * (crowd - 1));
    if (s.count && now - s.last >= gap) {
      const top = Object.entries(s.types).sort((a, b) => b[1] - a[1]).slice(0, 2);
      const full = Math.min(1, s.count / Math.max(1, tr.W * Math.max(1, rate * gap)));
      const g = (0.11 * gain * (0.75 + 0.25 * full)) / Math.sqrt(top.length);
      top.forEach(([type], i) => this.pluck(hz(TYPE_STEP[type]), now + 0.01 + i * 0.014, g, pan));
      s.last = now;
      s.types = {};
      s.count = 0;
    }
    if (s.next >= N && !s.done) {
      s.done = true;
      this.chime(pan, gain);
    }
  }

  resync(M, c) {
    const { retireC, N } = M.trace;
    let lo = 0;
    let hi = N;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (retireC[mid] <= c) lo = mid + 1;
      else hi = mid;
    }
    let ep = M.episodes.findIndex((e) => e.start > c);
    if (ep < 0) ep = M.episodes.length;
    return { version: M.version, c, next: lo, ep, types: {}, count: 0, last: 0, done: lo >= N };
  }
}
