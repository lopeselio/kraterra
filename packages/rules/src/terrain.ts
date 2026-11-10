import { int, rngFrom, type Rng } from './rng.ts';

// The voxel world: a W×H grid of cells seen from the side (the 3D scene extrudes it into a slab).
// Row 0 is bedrock and never breaks. Generated from the match seed only, with integer maths.

export const W = 192;
export const H = 96;

export const AIR = 0, GRASS = 1, DIRT = 2, ROCK = 3, BEDROCK = 4, STONE = 5, ASH = 6, SAND = 7;
export const MATERIALS = ['air', 'grass', 'dirt', 'rock', 'bedrock', 'stone', 'ash', 'sand'];

export const THEMES = ['hills', 'cliffs', 'valley', 'islands', 'skyreef'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_NAMES: Record<Theme, string> = {
  hills: 'Rolling Hills', cliffs: 'Terraced Cliffs', valley: 'Deep Valley', islands: 'Archipelago', skyreef: 'Sky Reef',
};

export interface World { theme: Theme; grid: Uint8Array; water: number; spawns: [number, number] }

export const idx = (x: number, y: number): number => y * W + x;
export const inside = (x: number, y: number): boolean => x >= 0 && x < W && y >= 0 && y < H;
export const solid = (g: Uint8Array, x: number, y: number): boolean => inside(x, y) && g[idx(x, y)] !== AIR;

/** smoothstep between control points, in integers (t in 0..16) */
function ease(a: number, b: number, t: number): number {
  const s = 3 * t * t * 16 - 2 * t * t * t; // over 4096
  return a + Math.trunc(((b - a) * s) / 4096);
}

function heights(theme: Theme, r: Rng): number[] {
  const n = W / 16 + 1;
  const ctrl: number[] = [];
  for (let i = 0; i < n; i++) {
    switch (theme) {
      case 'hills': ctrl.push(int(r, 24, 50)); break;
      case 'cliffs': ctrl.push(int(r, 18, 62)); break;
      case 'valley': {
        const d = Math.abs(i - (n - 1) / 2) * 2; // 0 mid .. n-1 at the edges
        ctrl.push(14 + Math.trunc((d * 44) / (n - 1)) + int(r, -4, 4));
        break;
      }
      case 'islands': ctrl.push(int(r, 4, 12)); break;
      case 'skyreef': ctrl.push(int(r, 14, 30)); break;
    }
  }
  const h: number[] = [];
  for (let x = 0; x < W; x++) {
    const i = Math.trunc(x / 16);
    h.push(ease(ctrl[i], ctrl[Math.min(i + 1, n - 1)], x % 16));
  }
  if (theme === 'cliffs') for (let x = 0; x < W; x++) h[x] = Math.max(10, Math.trunc(h[x] / 9) * 9 + 4);
  if (theme === 'hills' || theme === 'valley') {
    // small bumps
    let d = 0;
    for (let x = 0; x < W; x++) { d = Math.max(-2, Math.min(2, d + int(r, -1, 1))); h[x] += Math.trunc(d / 2); }
  }
  if (theme === 'islands') {
    // islands rising out of the sea
    const isl = int(r, 4, 5);
    for (let k = 0; k < isl; k++) {
      const cx = k === 0 ? 26 : k === 1 ? W - 27 : int(r, 50, W - 50);
      const half = int(r, 12, 20);
      const top = int(r, 28, 42);
      for (let x = Math.max(0, cx - half); x < Math.min(W, cx + half); x++) {
        const t = Math.abs(x - cx);
        h[x] = Math.max(h[x], top - Math.trunc((t * t * (top - 6)) / (half * half)));
      }
    }
  }
  return h;
}

/** The world a seed makes: terrain, water level and the two tanks' columns. */
export function generate(seed: string): World {
  const r = rngFrom(`kraterra|terrain|${seed}`);
  const theme = THEMES[int(r, 0, THEMES.length - 1)];
  const h = heights(theme, r);
  const water = theme === 'islands' ? 20 : theme === 'valley' && int(r, 0, 1) === 1 ? 12 : 0;
  const spawns: [number, number] = [int(r, 18, 34), W - 1 - int(r, 18, 34)];
  // flat pads for the tanks, above any water
  for (const sx of spawns) {
    const top = Math.max(h[sx], water + 6);
    for (let x = sx - 3; x <= sx + 3; x++) h[x] = top;
  }
  const grid = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const top = Math.min(h[x], H - 8);
    for (let y = 0; y < top; y++) {
      let m = ROCK;
      if (y === 0) m = BEDROCK;
      else if (y === top - 1) m = water && top <= water + 2 ? SAND : GRASS;
      else if (y >= top - 5) m = water && top <= water + 2 ? SAND : DIRT;
      grid[idx(x, y)] = m;
    }
  }
  if (theme === 'cliffs') {
    // overhangs and caves
    const caves = int(r, 2, 4);
    for (let k = 0; k < caves; k++) {
      const cx = int(r, 50, W - 50), cy = int(r, 10, 34), cr = int(r, 4, 7);
      carveDisc(grid, cx, cy, cr);
    }
  }
  if (theme === 'skyreef') {
    // floating rock reefs in the middle of the sky
    const reefs = int(r, 3, 4);
    for (let k = 0; k < reefs; k++) {
      const cx = int(r, 56, W - 56), cy = int(r, 50, 70), rx = int(r, 8, 15), ry = int(r, 3, 5);
      const inEll = (x: number, y: number): boolean => (x - cx) * (x - cx) * ry * ry + (y - cy) * (y - cy) * rx * rx <= rx * rx * ry * ry;
      for (let y = cy - ry; y <= cy + ry; y++) {
        for (let x = cx - rx; x <= cx + rx; x++) {
          if (inside(x, y) && inEll(x, y)) grid[idx(x, y)] = inEll(x, y + 1) ? ROCK : GRASS;
        }
      }
    }
  }
  return { theme, grid, water, spawns };
}

function carveDisc(g: Uint8Array, cx: number, cy: number, rad: number): void {
  for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
    if (y < 1 || !inside(x, y)) continue;
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad) g[idx(x, y)] = AIR;
  }
}

/** Highest solid row + 1 in a column (where something resting on it sits), or 1 for bare bedrock. */
export function surface(g: Uint8Array, x: number, from = H - 1): number {
  for (let y = Math.min(from, H - 1); y >= 0; y--) if (g[idx(x, y)] !== AIR) return y + 1;
  return 1;
}

// ---------- compact text form for the wire ----------

/** Run-length text: "<material><count base36>." runs, row-major. */
export function encodeGrid(g: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < g.length) {
    let j = i;
    while (j < g.length && g[j] === g[i]) j++;
    out += `${g[i]}${(j - i).toString(36)}.`;
    i = j;
  }
  return out;
}
export function decodeGrid(s: string): Uint8Array {
  const g = new Uint8Array(W * H);
  let i = 0;
  for (const run of s.split('.')) {
    if (!run) continue;
    const m = Number(run[0]);
    const n = parseInt(run.slice(1), 36);
    g.fill(m, i, i + n);
    i += n;
  }
  return g;
}
