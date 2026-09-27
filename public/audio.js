// Laptop sound: procedural chiptune BGM and effects with Web Audio. No audio
// files, so nothing to load at the booth. Values follow the original Kiru
// host (square melody over triangle bass, C major pentatonic).
const MELODY = {
  normal: [262, 330, 392, 330, 262, 392, 330, 262, 294, 349, 440, 349, 294, 440, 349, 294],
  frenzy: [523, 659, 784, 880, 784, 659, 523, 659, 784, 880, 1047, 880, 784, 659, 784, 1047],
  idle: [262, 0, 392, 0, 330, 0, 440, 0, 294, 0, 392, 0, 349, 0, 262, 0],
};

// seconds per step, melody gain, whether the square lead plays
const MODES = {
  idle: { step: 0.3, gain: 0.05, lead: 'triangle' },
  warmup: { step: 0.22, gain: 0.1, lead: 'square' },
  main: { step: 0.19, gain: 0.1, lead: 'square' },
  chaos: { step: 0.15, gain: 0.11, lead: 'square' },
  frenzy: { step: 0.12, gain: 0.14, lead: 'square' },
  off: null,
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.mode = 'off';
    this.musicOn = true;
    this.step = 0;
    this.nextNote = 0;
    this.timer = null;
    this.lastSfx = new Map();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // Must be called from a user gesture (browser autoplay policy).
  async unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(comp);
      this.musicBus = this.ctx.createGain();
      this.musicBus.connect(this.master);
      this.noise = this.makeNoise();
      this.timer = setInterval(() => this.schedule(), 25);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  makeNoise() {
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setMusic(mode) {
    if (mode === this.mode) return;
    const wasOff = this.mode === 'off';
    this.mode = mode;
    if (!this.ctx) return;
    if (wasOff || mode === 'frenzy') {
      this.step = 0;
      this.nextNote = this.ctx.currentTime + 0.05;
    }
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicOn ? 1 : 0, this.ctx.currentTime, 0.05);
    return this.musicOn;
  }

  schedule() {
    const m = MODES[this.mode];
    if (!this.ready || !m) return;
    const now = this.ctx.currentTime;
    if (this.nextNote < now - 0.2) this.nextNote = now + 0.02;
    while (this.nextNote < now + 0.12) {
      const pattern = this.mode === 'frenzy' ? MELODY.frenzy : this.mode === 'idle' ? MELODY.idle : MELODY.normal;
      const f = pattern[this.step % pattern.length];
      const dur = m.step * 0.82;
      if (f) this.tone(f, this.nextNote, dur, m.lead, m.gain * 0.4, this.musicBus);
      if (this.step % 2 === 0) {
        const bassF = (pattern[this.step % pattern.length] || pattern[(this.step + 2) % pattern.length]) / 4;
        this.tone(bassF, this.nextNote, m.step * 1.5, 'triangle', m.gain * 0.5, this.musicBus);
      }
      if (this.mode === 'chaos' && this.step % 4 === 0) this.hat(this.nextNote, m.gain * 0.5);
      if (this.mode === 'frenzy' && this.step % 2 === 0) this.hat(this.nextNote, m.gain * 0.4);
      this.nextNote += m.step;
      this.step++;
    }
  }

  tone(freq, at, dur, type, gain, dest = this.master, endFreq = null) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.setValueAtTime(gain, at + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(dest);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  burst(at, dur, gain, filterType, freq, endFreq) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, at);
    if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, at + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(at, Math.random() * 0.5);
    src.stop(at + dur + 0.02);
  }

  hat(at, gain) {
    this.burst(at, 0.04, gain, 'highpass', 7000);
  }

  // At most one of each effect per `gap` seconds, so a 5-item slash is one
  // satisfying hit rather than a clipped pile-up.
  gate(name, gap) {
    if (!this.ready) return false;
    const now = this.ctx.currentTime;
    if (now - (this.lastSfx.get(name) ?? -1) < gap) return false;
    this.lastSfx.set(name, now);
    return true;
  }

  slice(mult = 1) {
    if (!this.gate('slice', 0.045)) return;
    const t = this.ctx.currentTime;
    const up = mult > 1 ? 1.5 : 1;
    this.tone(800 * up, t, 0.09, 'sawtooth', 0.13, this.master, 1600 * up);
    this.burst(t, 0.08, 0.18, 'bandpass', 3000, 7000);
  }

  bomb() {
    if (!this.gate('bomb', 0.08)) return;
    const t = this.ctx.currentTime;
    this.tone(300, t, 0.35, 'square', 0.2, this.master, 50);
    this.burst(t, 0.5, 0.5, 'lowpass', 1800, 90);
  }

  star() {
    if (!this.gate('star', 0.2)) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, t + i * 0.07, 0.12, 'square', 0.12));
  }

  countdown(final) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (final) {
      this.tone(1047, t, 0.35, 'square', 0.14);
      this.burst(t, 0.3, 0.25, 'bandpass', 2000, 8000);
    } else {
      this.tone(660, t, 0.14, 'square', 0.12);
    }
  }

  phase(name) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (name === 'chaos') {
      [880, 660, 880, 660].forEach((f, i) => this.tone(f, t + i * 0.13, 0.12, 'sawtooth', 0.08));
    } else if (name === 'main') {
      [392, 523].forEach((f, i) => this.tone(f, t + i * 0.1, 0.14, 'square', 0.1));
    }
  }

  tick() {
    if (!this.gate('tick', 0.5)) return;
    this.tone(1320, this.ctx.currentTime, 0.05, 'square', 0.06);
  }

  gong(top) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    [262, 330, 392, 523].forEach((f) => this.tone(f, t, 1.4, 'triangle', 0.1));
    this.burst(t, 0.6, 0.15, 'lowpass', 1200, 200);
    if (top) [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, t + 0.25 + i * 0.09, 0.2, 'square', 0.1));
  }

  cancel() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.tone(392, t, 0.25, 'triangle', 0.1, this.master, 196);
  }
}
