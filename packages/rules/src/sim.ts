import { canonical, sha256Hex } from './hash.ts';
import { int, rngFrom } from './rng.ts';
import { FUEL, PICKS, SHOTS, drawPool, parseMove, seatOfMove } from './protocol.ts';
import {
  AIR, ASH, BEDROCK, DIRT, GRASS, H, STONE, W, decodeGrid, encodeGrid, generate, idx, inside, surface, type Theme,
} from './terrain.ts';
import { weapon, type Weapon } from './weapons.ts';

// The match, deterministic and integer-only. Positions are in 1/4096 of a voxel; no Math.random, no
// Date, no transcendental functions (sines come from a fixed table). The server, the browser (to
// animate) and `pnpm verify` all run this same code, and a replay of the log reproduces the state.

export const FX = 4096;
/** gravity, in 1/4096 voxel per step² */
export const G = 80;
/** muzzle speed at power 100, in 1/4096 voxel per step */
export const V100 = 8700;
/** wind acceleration per wind unit, per step */
export const WIND_K = 2;
export const MAX_WIND = 10;
const MAX_STEPS = 2400;

// round(sin(d°) × 4096), d = 0..90
const SIN = [0, 71, 143, 214, 286, 357, 428, 499, 570, 641, 711, 782, 852, 921, 991, 1060, 1129, 1198, 1266, 1334, 1401, 1468, 1534, 1600, 1666, 1731, 1796, 1860, 1923, 1986, 2048, 2110, 2171, 2231, 2290, 2349, 2408, 2465, 2522, 2578, 2633, 2687, 2741, 2793, 2845, 2896, 2946, 2996, 3044, 3091, 3138, 3183, 3228, 3271, 3314, 3355, 3396, 3435, 3474, 3511, 3547, 3582, 3617, 3650, 3681, 3712, 3742, 3770, 3798, 3824, 3849, 3873, 3896, 3917, 3937, 3956, 3974, 3991, 4006, 4021, 4034, 4046, 4056, 4065, 4074, 4080, 4086, 4090, 4094, 4095, 4096];
const clampDeg = (a: number): number => Math.max(0, Math.min(180, a));
export const sinD = (a: number): number => { a = clampDeg(a); return a <= 90 ? SIN[a] : SIN[180 - a]; };
export const cosD = (a: number): number => { a = clampDeg(a); return a <= 90 ? SIN[90 - a] : -SIN[a - 90]; };
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n)); // sqrt is exactly rounded in IEEE 754, then corrected
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

export interface Tank { x: number; y: number; angle: number; power: number; fuel: number; score: number }
export interface SeatSetup { name: string; rares: number[] }
export interface Setup { matchId: string; seed: string; seats: SeatSetup[]; rules: number }

export type Phase = 'draft' | 'battle' | 'over';
export interface State {
  matchId: string;
  theme: Theme;
  water: number;
  grid: Uint8Array;
  seats: SeatSetup[];
  pool: number[];
  taken: boolean[];
  rareUsed: boolean[][];
  inv: number[][];
  used: boolean[][];
  tanks: Tank[];
  moves: string[];
  /** wind for the shot about to be fired, -10..10 (positive blows right) */
  wind: number;
  phase: Phase;
  /** winning seat, or null for a draw / not over */
  winner: number | null;
}

/** Wind for the n-th shot, from the seed (the server reveals it shot by shot). */
export function windFor(seed: string, shot: number): number {
  const r = rngFrom(`kraterra|wind|${seed}|${shot}`);
  // calm more often than gale
  const a = int(r, -MAX_WIND, MAX_WIND), b = int(r, -MAX_WIND, MAX_WIND);
  return Math.abs(a) < Math.abs(b) ? a : b;
}

export function createState(setup: Setup): State {
  const w = generate(setup.seed);
  const pool = drawPool(setup.seed);
  const tanks = w.spawns.map((x, i): Tank => ({ x, y: surface(w.grid, x), angle: i === 0 ? 45 : 135, power: 60, fuel: FUEL, score: 0 }));
  return {
    matchId: setup.matchId, theme: w.theme, water: w.water, grid: w.grid, seats: setup.seats.map((s) => ({ name: s.name, rares: [...s.rares] })),
    pool, taken: pool.map(() => false), rareUsed: setup.seats.map((s) => s.rares.map(() => false)),
    inv: [[], []], used: [[], []], tanks, moves: [], wind: windFor(setup.seed, 0), phase: 'draft', winner: null,
  };
}

export const whoseTurn = (s: State): number | null => (s.phase === 'over' ? null : seatOfMove(s.moves.length));
export const shotsFired = (s: State): number => Math.max(0, s.moves.length - PICKS);

// ---------- events (what the browser animates) ----------

export type SimEvent =
  | { t: 'pick'; seat: number; weapon: number; from: 'pool' | 'pack'; idx: number }
  | { t: 'move'; seat: number; pts: number[] }
  | { t: 'aim'; seat: number; angle: number; power: number; weapon: number }
  | { t: 'fly'; weapon: number; pts: number[]; kind: 'shell' | 'dig' | 'roll' }
  | { t: 'boom'; x: number; y: number; r: number; cells: number[]; weapon: number }
  | { t: 'build'; x: number; y: number; cells: number[]; what: 'wall' | 'mud' }
  | { t: 'fire'; x: number; y: number; cols: number[]; cells: number[] }
  | { t: 'splash'; x: number; y: number }
  | { t: 'hit'; seat: number; dmg: number; to: number }
  | { t: 'fall'; seat: number; y: number }
  | { t: 'end'; winner: number | null };

// ---------- moves ----------

/**
 * Applies one move (validated as the contract does) and returns what happened. Throws on an illegal
 * move. The caller rolls the next wind (`rollWind`) once the move is applied.
 */
export function applyMove(s: State, text: string): SimEvent[] {
  if (s.phase === 'over') throw new Error('the match is over');
  const seat = seatOfMove(s.moves.length);
  const m = parseMove(text);
  if (!m) throw new Error(`bad move "${text}"`);
  const ev: SimEvent[] = [];
  if (s.phase === 'draft') {
    if (m.t === 'pick') {
      if (m.pool >= s.pool.length || s.taken[m.pool]) throw new Error('that munition is already taken');
      s.taken[m.pool] = true;
      s.inv[seat].push(s.pool[m.pool]);
      ev.push({ t: 'pick', seat, weapon: s.pool[m.pool], from: 'pool', idx: m.pool });
    } else if (m.t === 'rare') {
      const rares = s.seats[seat].rares;
      if (m.idx >= rares.length || s.rareUsed[seat][m.idx]) throw new Error('that pack munition is not yours to pick');
      s.rareUsed[seat][m.idx] = true;
      s.inv[seat].push(rares[m.idx]);
      ev.push({ t: 'pick', seat, weapon: rares[m.idx], from: 'pack', idx: m.idx });
    } else throw new Error('the draft is not over yet');
    s.used[seat].push(false);
    s.moves.push(text);
    if (s.moves.length === PICKS) s.phase = 'battle';
    return ev;
  }
  if (m.t !== 'shot') throw new Error('the draft is over: fire a shot');
  if (m.slot >= s.inv[seat].length || s.used[seat][m.slot]) throw new Error('that slot is empty or used');
  const tank = s.tanks[seat];
  if (Math.abs(m.move) > tank.fuel) throw new Error('not enough fuel');
  s.used[seat][m.slot] = true;
  s.moves.push(text);
  tank.fuel -= Math.abs(m.move);
  tank.angle = m.angle;
  tank.power = m.power;
  if (m.move) driveTank(s, seat, m.move, ev);
  const w = weapon(s.inv[seat][m.slot]);
  ev.push({ t: 'aim', seat, angle: m.angle, power: m.power, weapon: w.id });
  fireWeapon(s, seat, w, m.angle, m.power, ev);
  settleTanks(s, ev);
  if (s.moves.length === PICKS + SHOTS) {
    s.phase = 'over';
    const [a, b] = s.tanks.map((t) => t.score);
    s.winner = a > b ? 0 : b > a ? 1 : null;
    ev.push({ t: 'end', winner: s.winner });
  }
  return ev;
}

/** After a move: the wind for the next shot (server and verify only: it needs the seed). */
export function rollWind(s: State, seed: string): void {
  s.wind = windFor(seed, shotsFired(s));
}

// ---------- driving ----------

const inTank = (t: Tank, x: number, y: number): boolean => x >= t.x - 1 && x <= t.x + 1 && y >= t.y && y <= t.y + 2;
const blocked = (s: State, x: number, y: number): boolean => {
  for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) if (inside(x + dx, y + dy) && s.grid[idx(x + dx, y + dy)] !== AIR) return true;
  return false;
};
const supported = (s: State, x: number, y: number): boolean => {
  if (y <= 1) return true;
  for (let dx = -1; dx <= 1; dx++) if (inside(x + dx, y - 1) && s.grid[idx(x + dx, y - 1)] !== AIR) return true;
  return false;
};

function driveTank(s: State, seat: number, move: number, ev: SimEvent[]): void {
  const t = s.tanks[seat];
  const other = s.tanks[1 - seat];
  const dir = move > 0 ? 1 : -1;
  const pts = [t.x, t.y];
  for (let k = 0; k < Math.abs(move); k++) {
    const nx = t.x + dir;
    if (nx < 2 || nx > W - 3 || Math.abs(nx - other.x) < 4) break;
    // climb at most 2 voxels, then fall to the ground
    let ny = -1;
    for (let up = 0; up <= 2; up++) if (!blocked(s, nx, t.y + up)) { ny = t.y + up; break; }
    if (ny < 0) break;
    while (!supported(s, nx, ny)) ny--;
    t.x = nx; t.y = ny;
    pts.push(t.x, t.y);
  }
  ev.push({ t: 'move', seat, pts });
}

function settleTanks(s: State, ev: SimEvent[]): void {
  s.tanks.forEach((t, seat) => {
    const from = t.y;
    while (!supported(s, t.x, t.y)) t.y--;
    // buried in new dirt or stone: stay put (the turret digs itself a pocket)
    if (t.y !== from) ev.push({ t: 'fall', seat, y: t.y });
  });
}

// ---------- terrain edits ----------

function setCell(s: State, x: number, y: number, m: number, out: number[]): void {
  if (!inside(x, y) || y < 1) return;
  const i = idx(x, y);
  if (s.grid[i] === m || s.grid[i] === BEDROCK) return;
  s.grid[i] = m;
  out.push(i * 8 + m);
}

function carve(s: State, cx: number, cy: number, r: number, out: number[]): void {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) setCell(s, x, y, AIR, out);
  }
  // scorched rim: grass at the crater's lip turns to ash
  for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) {
    if (inside(x, y) && s.grid[idx(x, y)] === GRASS && (x - cx) * (x - cx) + (y - cy) * (y - cy) <= (r + 1) * (r + 1)) setCell(s, x, y, ASH, out);
  }
}

const tankAt = (s: State, x: number, y: number): number => s.tanks.findIndex((t) => inTank(t, x, y));
const anyTankCell = (s: State, x: number, y: number): boolean => s.tanks.some((t) => inTank(t, x, y));

/** Damage to every tank near (cx, cy): full at the centre, falling off to 0 just past r. */
function damage(s: State, shooter: number, cx: number, cy: number, r: number, dmg: number, ev: SimEvent[]): void {
  if (dmg <= 0) return;
  s.tanks.forEach((t, seat) => {
    const dx = t.x - cx, dy = t.y + 1 - cy;
    const d = isqrt(dx * dx + dy * dy);
    if (d > r + 1) return;
    const amount = Math.trunc((dmg * (r + 2 - Math.max(0, d - 1))) / (r + 2));
    if (amount <= 0) return;
    hit(s, shooter, seat, amount, ev);
  });
}

/** Points go to the shooter; hurting yourself scores for your rival. */
function hit(s: State, shooter: number, seat: number, amount: number, ev: SimEvent[]): void {
  const to = seat === shooter ? 1 - shooter : shooter;
  s.tanks[to].score += amount;
  ev.push({ t: 'hit', seat, dmg: amount, to });
}

function explode(s: State, shooter: number, w: Weapon, cx: number, cy: number, r: number, dmg: number, ev: SimEvent[]): void {
  const cells: number[] = [];
  carve(s, cx, cy, r, cells);
  ev.push({ t: 'boom', x: cx, y: cy, r, cells, weapon: w.id });
  damage(s, shooter, cx, cy, r, dmg, ev);
}

// ---------- flight ----------

interface Shell { x: number; y: number; vx: number; vy: number }
interface Impact {
  kind: 'ground' | 'tank' | 'out' | 'water';
  /** cell of the impact and the last free position before it, in 1/4096 voxel */
  cx: number; cy: number; lx: number; ly: number;
  vx: number; vy: number;
  tank: number;
}

const px = (v: number): number => Math.round((v * 100) / FX) / 100;

/** Flies a shell until it hits something; records its path (voxel units) into pts. */
function fly(s: State, owner: number, sh: Shell, pts: number[], wind = true): Impact {
  let { x, y, vx, vy } = sh;
  let armed = owner < 0;
  pts.push(px(x), px(y));
  const waterTop = s.water * FX;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (wind) vx += s.wind * WIND_K;
    vy -= G;
    const n = 1 + Math.trunc(Math.max(Math.abs(vx), Math.abs(vy)) / 2048);
    let lx = x, ly = y;
    for (let i = 1; i <= n; i++) {
      const nx = x + Math.trunc((vx * i) / n);
      const ny = y + Math.trunc((vy * i) / n);
      if (nx < 0 || nx >= W * FX || ny < -FX * 4) {
        pts.push(px(nx), px(ny));
        return { kind: 'out', cx: Math.floor(nx / FX), cy: Math.floor(ny / FX), lx, ly, vx, vy, tank: -1 };
      }
      const cx = Math.floor(nx / FX), cy = Math.floor(ny / FX);
      if (cy < H) {
        const ti = tankAt(s, cx, cy);
        if (ti >= 0 && (ti !== owner || armed)) { pts.push(px(nx), px(ny)); return { kind: 'tank', cx, cy, lx, ly, vx, vy, tank: ti }; }
        if (ti < 0 && owner >= 0) armed = true;
        if (cy >= 0 && s.grid[idx(cx, cy)] !== AIR) { pts.push(px(lx), px(ly)); return { kind: 'ground', cx, cy, lx, ly, vx, vy, tank: -1 }; }
        if (ny < waterTop) { pts.push(px(nx), px(ny)); return { kind: 'water', cx, cy, lx: nx, ly: ny, vx, vy, tank: -1 }; }
      }
      lx = nx; ly = ny;
    }
    x += vx; y += vy;
    pts.push(px(x), px(y));
  }
  return { kind: 'out', cx: Math.floor(x / FX), cy: Math.floor(y / FX), lx: x, ly: y, vx, vy, tank: -1 };
}

/** Where the barrel tip is and the muzzle velocity for a shot. */
export function muzzle(t: Tank, angle: number, power: number, speed = 100): Shell {
  const v = Math.trunc((V100 * power * speed) / 10000);
  return {
    x: t.x * FX + FX / 2 + 3 * cosD(angle),
    y: (t.y + 2) * FX + FX / 2 + 3 * sinD(angle),
    vx: Math.trunc((v * cosD(angle)) / 4096),
    vy: Math.trunc((v * sinD(angle)) / 4096),
  };
}

const cellOf = (imp: Impact): [number, number] => (imp.kind === 'ground' ? [Math.floor(imp.lx / FX), Math.floor(imp.ly / FX)] : [imp.cx, imp.cy]);

function fireWeapon(s: State, seat: number, w: Weapon, angle: number, power: number, ev: SimEvent[]): void {
  const t = s.tanks[seat];
  if (w.kind === 'spread') {
    for (const da of [-5, 0, 5]) shell(s, seat, w, muzzle(t, clampDeg(angle + da), power, w.speed), ev);
    return;
  }
  shell(s, seat, w, muzzle(t, angle, power, w.speed), ev);
}

/** One shell's flight and what it does when it lands. */
function shell(s: State, seat: number, w: Weapon, sh: Shell, ev: SimEvent[], bounces = 0): void {
  const pts: number[] = [];
  const imp = fly(s, seat, sh, pts);
  ev.push({ t: 'fly', weapon: w.id, pts, kind: 'shell' });
  if (imp.kind === 'out') return;
  const [cx, cy] = cellOf(imp);
  if (imp.kind === 'water' && w.kind !== 'rain') ev.push({ t: 'splash', x: cx, y: s.water });
  switch (w.kind) {
    case 'blast': case 'spread':
      explode(s, seat, w, cx, cy, w.r, w.dmg, ev);
      break;
    case 'cluster': {
      explode(s, seat, w, cx, cy, 2, 8, ev);
      const base = { x: imp.lx, y: Math.max(imp.ly, cy * FX) + FX };
      for (let k = 0; k < 6; k++) {
        const vx = [-2400, -1500, -700, 700, 1500, 2400][k];
        const p2: number[] = [];
        const i2 = fly(s, -1, { x: base.x, y: base.y + FX, vx, vy: 2200 + (k % 3) * 500 }, p2, false);
        ev.push({ t: 'fly', weapon: w.id, pts: p2, kind: 'shell' });
        if (i2.kind !== 'out') { const [bx, by] = cellOf(i2); explode(s, seat, w, bx, by, w.r, w.dmg, ev); }
      }
      break;
    }
    case 'dig': {
      if (imp.kind === 'tank') { explode(s, seat, w, cx, cy, w.r, w.dmg, ev); break; }
      const len = isqrt(imp.vx * imp.vx + imp.vy * imp.vy) || 1;
      const dx = Math.trunc((imp.vx * 2048) / len), dy = Math.trunc((imp.vy * 2048) / len);
      let x = imp.lx, y = imp.ly;
      const cells: number[] = [];
      const p2 = [px(x), px(y)];
      const reach = w.id === 14 ? 48 : 22;
      for (let k = 0; k < reach * 2; k++) {
        const nx = x + dx, ny = y + dy;
        const gx = Math.floor(nx / FX), gy = Math.floor(ny / FX);
        if (!inside(gx, gy) || gy < 1) break;
        x = nx; y = ny;
        p2.push(px(x), px(y));
        if (anyTankCell(s, gx, gy)) break;
        for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) setCell(s, gx + ox, gy + oy, AIR, cells);
      }
      ev.push({ t: 'fly', weapon: w.id, pts: p2, kind: 'dig' });
      ev.push({ t: 'boom', x: Math.floor(x / FX), y: Math.floor(y / FX), r: 0, cells, weapon: w.id });
      explode(s, seat, w, Math.floor(x / FX), Math.floor(y / FX), w.r, w.dmg, ev);
      break;
    }
    case 'wall': {
      const cells: number[] = [];
      const base = imp.kind === 'water' ? s.water : surface(s.grid, Math.max(0, Math.min(W - 1, cx)), cy + 1);
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = base; y < base + 14; y++) {
        if (!anyTankCell(s, x, y) && inside(x, y) && s.grid[idx(x, y)] === AIR) setCell(s, x, y, STONE, cells);
      }
      ev.push({ t: 'build', x: cx, y: base, cells, what: 'wall' });
      if (imp.kind === 'tank') hit(s, seat, imp.tank, 6, ev);
      break;
    }
    case 'mud': {
      const cells: number[] = [];
      for (let y = cy - w.r; y <= cy + w.r; y++) for (let x = cx - w.r; x <= cx + w.r; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > w.r * w.r) continue;
        if (!anyTankCell(s, x, y) && inside(x, y) && s.grid[idx(x, y)] === AIR) setCell(s, x, y, DIRT, cells);
      }
      ev.push({ t: 'build', x: cx, y: cy, cells, what: 'mud' });
      if (imp.kind === 'tank') hit(s, seat, imp.tank, 6, ev);
      break;
    }
    case 'fire': {
      const cells: number[] = [];
      carve(s, cx, cy, 1, cells);
      const cols: number[] = [cx];
      const near = s.tanks.map((t): number => (Math.abs(t.x - cx) <= 1 ? 0 : 99));
      for (const dir of [-1, 1]) {
        let y = surface(s.grid, cx, cy + 2);
        for (let k = 1; k <= w.r; k++) {
          const x = cx + dir * k;
          if (x < 0 || x >= W) break;
          const ny = surface(s.grid, x, y + 3);
          if (ny > y + 3 || (s.water && ny <= s.water)) break;
          y = ny;
          cols.push(x);
          if (inside(x, y - 1) && s.grid[idx(x, y - 1)] === GRASS) setCell(s, x, y - 1, ASH, cells);
          s.tanks.forEach((t, i) => { if (Math.abs(t.x - x) <= 1 && Math.abs(t.y - y) <= 2) near[i] = Math.min(near[i], k); });
        }
      }
      ev.push({ t: 'fire', x: cx, y: cy, cols, cells });
      near.forEach((d, i) => { if (d < 99) hit(s, seat, i, Math.max(6, w.dmg - 2 * d), ev); });
      break;
    }
    case 'roll': {
      if (imp.kind !== 'ground') { explode(s, seat, w, cx, cy, w.r, w.dmg, ev); break; }
      let x = cx, y = surface(s.grid, cx, cy + 1);
      const l = surface(s.grid, Math.max(0, x - 1), y + 1), r = surface(s.grid, Math.min(W - 1, x + 1), y + 1);
      const dir = l < r ? -1 : r < l ? 1 : imp.vx < 0 ? -1 : 1;
      const p2 = [x + 0.5, y + 0.5];
      for (let k = 0; k < 64; k++) {
        const nx = x + dir;
        if (nx < 0 || nx >= W) break;
        if (s.tanks.some((t) => Math.abs(t.x - nx) <= 1 && Math.abs(t.y - y) <= 2)) { x = nx; break; }
        const ny = surface(s.grid, nx, y + 1);
        if (ny > y) break; // a rise stops it
        if (s.water && ny <= s.water) { x = nx; y = s.water; break; }
        x = nx; y = ny;
        p2.push(x + 0.5, y + 0.5);
      }
      p2.push(x + 0.5, y + 0.5);
      ev.push({ t: 'fly', weapon: w.id, pts: p2, kind: 'roll' });
      explode(s, seat, w, x, y, w.r, w.dmg, ev);
      break;
    }
    case 'skip': {
      if (imp.kind === 'ground' && bounces < 2) {
        shell(s, seat, w, { x: imp.lx, y: imp.ly, vx: Math.trunc((imp.vx * 8) / 10), vy: Math.trunc((Math.abs(imp.vy) * 6) / 10) }, ev, bounces + 1);
        break;
      }
      explode(s, seat, w, cx, cy, w.r, w.dmg, ev);
      break;
    }
    case 'rain': {
      explode(s, seat, w, cx, cy, 2, 6, ev);
      for (const ox of [-8, -4, 0, 4, 8]) {
        const p2: number[] = [];
        const i2 = fly(s, -1, { x: (cx + ox) * FX + FX / 2, y: (H + 6) * FX, vx: 0, vy: -1500 }, p2, false);
        ev.push({ t: 'fly', weapon: w.id, pts: p2, kind: 'shell' });
        if (i2.kind !== 'out') { const [bx, by] = cellOf(i2); explode(s, seat, w, bx, by, w.r, w.dmg, ev); }
      }
      break;
    }
  }
}

// ---------- previews and the AI's aim ----------

/** The first impact of a shot, without changing anything (practice-range ghost arc, the AI's aim). */
export function trace(s: State, seat: number, weaponId: number, angle: number, power: number): { pts: number[]; x: number; y: number; kind: string } {
  const w = weapon(weaponId);
  const pts: number[] = [];
  const imp = fly(s, seat, muzzle(s.tanks[seat], angle, power, w.speed), pts);
  const [x, y] = cellOf(imp);
  return { pts, x, y, kind: imp.kind };
}

// ---------- replay, hashing, wire form ----------

/** Rebuilds a match from its setup and move log (what `pnpm verify` does). */
export function replay(setup: Setup, moves: string[], each?: (s: State, ev: SimEvent[], k: number) => void): State {
  const s = createState(setup);
  moves.forEach((m, k) => {
    const ev = applyMove(s, m);
    rollWind(s, setup.seed);
    each?.(s, ev, k);
  });
  return s;
}

export function stateHash(s: State): string {
  return sha256Hex(canonical({ ...toWire(s), grid: sha256Hex(encodeGrid(s.grid)) }));
}

export type WireState = Omit<State, 'grid'> & { grid: string };
export const toWire = (s: State): WireState => ({ ...s, grid: encodeGrid(s.grid) });
export const fromWire = (w: WireState): State => ({ ...structuredCloneish(w), grid: decodeGrid(w.grid) });
const structuredCloneish = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const cloneState = (s: State): State => ({ ...structuredCloneish({ ...s, grid: '' }), grid: new Uint8Array(s.grid) }) as State;
