// Every sound is synthesised in WebAudio: nothing to download.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let drone: { stop: () => void; level: (v: number) => void } | null = null;
let muted = (() => { try { return localStorage.getItem('kraterra:muted') === '1'; } catch { return false; } })();

export const isMuted = (): boolean => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try { localStorage.setItem('kraterra:muted', m ? '1' : '0'); } catch { /* fine */ }
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.05);
}

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

function noise(c: AudioContext, dur: number): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource();
  s.buffer = buf;
  return s;
}

function env(c: AudioContext, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(master!);
  return g;
}

function tone(freq: number, type: OscillatorType, peak: number, decay: number, slideTo?: number, delay = 0): void {
  const c = ac();
  if (!c || muted) return;
  const o = c.createOscillator();
  o.type = type;
  const t = c.currentTime + delay;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + decay);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g);
  g.connect(master!);
  o.start(t);
  o.stop(t + decay + 0.05);
}

function whoosh(peak: number, from: number, to: number, dur: number): void {
  const c = ac();
  if (!c || muted) return;
  const n = noise(c, dur);
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.4;
  f.frequency.setValueAtTime(from, c.currentTime);
  f.frequency.exponentialRampToValueAtTime(to, c.currentTime + dur);
  n.connect(f);
  f.connect(env(c, peak, 0.02, dur));
  n.start();
}

export type Sfx = 'fire' | 'boom' | 'bigboom' | 'dig' | 'splash' | 'pick' | 'click' | 'hit' | 'build' | 'flame' | 'turn' | 'win' | 'lose' | 'drive' | 'whistle';

export function sfx(kind: Sfx, n = 0): void {
  const c = ac();
  if (!c || muted) return;
  switch (kind) {
    case 'fire': tone(160, 'square', 0.3, 0.18, 50); whoosh(0.45, 2200, 300, 0.3); break;
    case 'boom': tone(90, 'sine', 0.55, 0.5, 30); whoosh(0.5, 1400, 120, 0.55); break;
    case 'bigboom': tone(60, 'sine', 0.7, 1.1, 22); tone(110, 'sawtooth', 0.18, 0.6, 30); whoosh(0.7, 1000, 60, 1.1); break;
    case 'dig': whoosh(0.3, 300, 900, 0.5); tone(70, 'square', 0.12, 0.5, 50); break;
    case 'splash': whoosh(0.4, 3000, 600, 0.6); tone(300, 'sine', 0.08, 0.3, 120); break;
    case 'pick': tone(520 + Math.min(n, 12) * 30, 'triangle', 0.18, 0.16); tone(780 + Math.min(n, 12) * 40, 'sine', 0.1, 0.22, undefined, 0.05); break;
    case 'click': tone(1200, 'square', 0.05, 0.04); break;
    case 'hit': tone(240, 'sawtooth', 0.25, 0.3, 80); tone(480, 'square', 0.1, 0.12); break;
    case 'build': tone(120, 'square', 0.15, 0.35, 220); whoosh(0.2, 500, 1500, 0.35); break;
    case 'flame': whoosh(0.35, 4000, 700, 1.0); break;
    case 'turn': tone(660, 'triangle', 0.14, 0.15); tone(880, 'triangle', 0.12, 0.2, undefined, 0.1); break;
    case 'drive': tone(80 + n, 'sawtooth', 0.06, 0.08); break;
    case 'whistle': tone(1400, 'sine', 0.04, 0.6, 700); break;
    case 'win': [523, 659, 784, 1046].forEach((f, k) => tone(f, 'triangle', 0.2, 0.5, undefined, k * 0.12)); break;
    case 'lose': [392, 311, 233].forEach((f, k) => tone(f, 'triangle', 0.18, 0.6, undefined, k * 0.18)); break;
  }
}

/** Wind over the battlefield: a soft noise bed whose level follows the wind's strength. */
export function startWind(): void {
  const c = ac();
  if (!c || drone) return;
  const g = c.createGain();
  g.gain.value = 0.0;
  g.connect(master!);
  const n = noise(c, 4); n.loop = true;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.7;
  const lfo = c.createOscillator(); lfo.frequency.value = 0.17;
  const lg = c.createGain(); lg.gain.value = 180;
  lfo.connect(lg); lg.connect(f.frequency);
  n.connect(f); f.connect(g);
  [n, lfo].forEach((s) => s.start());
  drone = {
    stop: () => { g.gain.setTargetAtTime(0, c.currentTime, 0.6); setTimeout(() => { [n, lfo].forEach((s) => { try { s.stop(); } catch { /* done */ } }); }, 2500); drone = null; },
    level: (v: number) => g.gain.setTargetAtTime(0.02 + v * 0.06, c.currentTime, 0.8),
  };
}
export const windLevel = (v: number): void => drone?.level(v);
export const stopWind = (): void => drone?.stop();
export const unlockAudio = (): void => { ac(); };
