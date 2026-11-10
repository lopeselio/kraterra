import { describe, expect, it } from 'vitest';
import {
  AIR, BEDROCK, H, PICKS, SHOTS, THEMES, W, WEAPONS, aiPick, aiShot, applyMove, cloneState, cosD, createState, decodeGrid, encodeGrid,
  fromWire, generate, idx, isqrt, replay, rngFrom, rollWind, sha256Hex, sinD, stateHash, toWire, trace, whoseTurn, windFor,
  type Difficulty, type Setup, type State,
} from '../src/index.ts';

const setup = (k: number, rares: number[][] = [[], []]): Setup => ({
  matchId: `t-${k}`, seed: sha256Hex(`test|${k}`), rules: 1, seats: [{ name: 'A', rares: rares[0] }, { name: 'B', rares: rares[1] }],
});

/** A full AI-vs-AI match; returns the state and its log. */
function play(k: number, d: Difficulty[] = ['normal', 'normal'], rares?: number[][]): { s: State; log: string[]; su: Setup } {
  const su = setup(k, rares);
  const s = createState(su);
  const r = rngFrom(`ai|${k}`);
  while (s.phase !== 'over') {
    const seat = whoseTurn(s)!;
    applyMove(s, s.phase === 'draft' ? aiPick(s, seat, d[seat], r) : aiShot(s, seat, d[seat], r));
    rollWind(s, su.seed);
  }
  return { s, log: [...s.moves], su };
}

describe('terrain', () => {
  it('is the same for the same seed and keeps bedrock', () => {
    const a = generate(sha256Hex('x')), b = generate(sha256Hex('x'));
    expect(encodeGrid(a.grid)).toBe(encodeGrid(b.grid));
    for (let x = 0; x < W; x++) expect(a.grid[idx(x, 0)]).toBe(BEDROCK);
  });
  it('makes every theme across seeds, with tanks on the ground', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 60; k++) {
      const s = createState(setup(k));
      seen.add(s.theme);
      for (const t of s.tanks) {
        expect(s.grid[idx(t.x, t.y)]).toBe(AIR);
        expect(s.grid[idx(t.x, t.y - 1)]).not.toBe(AIR);
        expect(t.y).toBeGreaterThan(s.water);
      }
    }
    expect([...seen].sort()).toEqual([...THEMES].sort());
  });
  it('round-trips the wire form', () => {
    const s = createState(setup(3));
    expect(decodeGrid(encodeGrid(s.grid))).toEqual(s.grid);
    expect(stateHash(fromWire(JSON.parse(JSON.stringify(toWire(s)))))).toBe(stateHash(s));
  });
});

describe('integer maths', () => {
  it('has exact sines and square roots', () => {
    expect(sinD(90)).toBe(4096); expect(cosD(0)).toBe(4096); expect(cosD(180)).toBe(-4096); expect(sinD(30)).toBe(2048);
    for (const n of [0, 1, 2, 15, 16, 17, 99999, 123456789]) { const r = isqrt(n); expect(r * r <= n && (r + 1) * (r + 1) > n).toBe(true); }
  });
  it('draws wind in range, calm more often', () => {
    const w = Array.from({ length: 400 }, (_, i) => windFor('s', i));
    expect(Math.max(...w)).toBeLessThanOrEqual(10); expect(Math.min(...w)).toBeGreaterThanOrEqual(-10);
    expect(w.filter((x) => Math.abs(x) <= 3).length).toBeGreaterThan(w.filter((x) => Math.abs(x) >= 7).length);
  });
});

describe('match', () => {
  it('runs a full match: 20 picks, 20 shots, a winner by score', () => {
    const { s } = play(1);
    expect(s.moves.length).toBe(PICKS + SHOTS);
    expect(s.inv.map((i) => i.length)).toEqual([10, 10]);
    expect(s.used.flat().every(Boolean)).toBe(true);
    const [a, b] = s.tanks.map((t) => t.score);
    expect(s.winner).toBe(a > b ? 0 : b > a ? 1 : null);
  });
  it('replays from the log to the same state hash (determinism)', () => {
    for (const k of [2, 5, 9]) {
      const { s, log, su } = play(k, ['hard', 'easy'], [[12, 13], [14]]);
      expect(stateHash(replay(su, log))).toBe(stateHash(s));
    }
  });
  it('refuses moves out of turn, taken cards and used slots', () => {
    const s = createState(setup(4));
    applyMove(s, 'p0');
    expect(() => applyMove(s, 'p0')).toThrow();
    expect(() => applyMove(s, 's0,45,50,0')).toThrow();
    expect(() => applyMove(s, 'r0')).toThrow();
    expect(() => applyMove(s, 'p05')).toThrow();
  });
  it('lets a seat draft its own pack munitions, once', () => {
    const s = createState(setup(6, [[13], []]));
    applyMove(s, 'r0');
    expect(s.inv[0]).toEqual([13]);
    applyMove(s, 'p1');
    expect(() => applyMove(s, 'r0')).toThrow();
  });
  it('spends fuel and refuses to drive further than the tank holds', () => {
    const s = createState(setup(7));
    for (let k = 0; k < PICKS; k++) applyMove(s, `p${k}`);
    const x0 = s.tanks[1].x;
    applyMove(s, 's0,135,0,-6');
    expect(s.tanks[1].fuel).toBe(34);
    expect(s.tanks[1].x).toBeLessThanOrEqual(x0);
    expect(() => applyMove(s, 's0,45,50,41')).toThrow();
  });
});

describe('munitions', () => {
  /** Fires every munition from seat 1 at the rival, from a fresh match. */
  for (const w of WEAPONS) {
    it(`${w.name} flies, lands and changes the world as it should`, () => {
      const su = setup(11, [[], [12, 13, 14]]);
      const s = createState(su);
      // seat 0 drafts commons, seat 1 drafts its packs first then commons
      s.pool[1] = w.id;
      let p = 0;
      for (let k = 0; k < PICKS; k++) {
        const seat = k % 2;
        if (seat === 1 && w.rare && k === 1) { applyMove(s, `r${[12, 13, 14].indexOf(w.id)}`); continue; }
        while (s.taken[p] || (seat === 0 && p === 1)) p++;
        applyMove(s, `p${p}`);
      }
      const slot = s.inv[1].indexOf(w.id);
      expect(slot).toBeGreaterThanOrEqual(0);
      // aim with the AI's own search, at hard (exact) difficulty
      const r = rngFrom('aim');
      const shot = aiShot({ ...cloneState(s), inv: [s.inv[0], s.inv[1].map((id, i) => (i === slot ? id : -1))], used: [s.used[0], s.used[1].map((_, i) => i !== slot)] } as State, 1, 'hard', r);
      const before = encodeGrid(s.grid);
      const ev = applyMove(s, shot);
      expect(ev.some((e) => e.t === 'fly')).toBe(true);
      if (w.kind === 'wall' || w.kind === 'mud') expect(ev.some((e) => e.t === 'build')).toBe(true);
      else expect(encodeGrid(s.grid)).not.toBe(before);
      // the needle's 2-voxel blast may just miss on a hilly line of fire; every other munition lands on target
      if (w.dmg > 0 && w.r >= 3) expect(s.tanks[1].score + s.tanks[0].score).toBeGreaterThan(0);
    });
  }
  it('traces an arc that falls back down', () => {
    const s = createState(setup(12));
    const t = trace(s, 0, 1, 60, 60);
    expect(t.pts.length).toBeGreaterThan(20);
    expect(t.y).toBeLessThan(H);
  });
});

describe('the AI', () => {
  it('only makes legal moves and the hard one beats the easy one', () => {
    let hard = 0;
    for (let k = 20; k < 26; k++) if (play(k, ['hard', 'easy']).s.winner === 0) hard++;
    expect(hard).toBeGreaterThanOrEqual(5);
  });
});
