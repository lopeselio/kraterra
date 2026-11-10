import { sha256Hex } from './hash.ts';
import { nextU32, rngFrom } from './rng.ts';
import { RARE_IDS, WEAPONS } from './weapons.ts';

// What the contract checks, built from exactly the same strings and numbers as contracts/kraterra
// (shared test vector in both suites):
//
//   salt_hash = sha256(salt)                         committed by the referee at create_match
//   vrf       = hex(env::random_seed_array())        drawn by the contract in a later receipt
//   seed      = sha256("kraterra|seed|<vrf>|<salt>") known only once the salt is revealed at settle
//   pool      = 20 commons drawn by xoshiro128** seeded from sha256("kraterra|pool|<seed>")
//
// Moves (one string each, alternating seats):
//   draft  (20)  "p<i>"  take pool card i      "r<i>"  take your own munition-pack card i
//   battle (20)  "s<slot>,<angle 0-180>,<power 0-100>,<move -40..40>"   seat 1 fires first

export const POOL_SIZE = 20;
export const SLOTS = 10;
export const PICKS = SLOTS * 2;
export const SHOTS = SLOTS * 2;
export const FUEL = 40;
export const MAX_RARES = 3;

export const saltHash = (salt: string): string => sha256Hex(salt);
export const seedOf = (vrf: string, salt: string): string => sha256Hex(`kraterra|seed|${vrf}|${salt}`);

/** The 20 common munitions in this match's draft pool. */
export function drawPool(seed: string): number[] {
  const r = rngFrom(`kraterra|pool|${seed}`);
  const commons = WEAPONS.filter((w) => w.weight > 0);
  const total = commons.reduce((a, w) => a + w.weight, 0);
  const out: number[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    let v = nextU32(r) % total;
    for (const w of commons) {
      if (v < w.weight) { out.push(w.id); break; }
      v -= w.weight;
    }
  }
  return out;
}

/** Whose move the k-th one is. Draft: seat 0 picks first; battle: seat 1 fires first. */
export const seatOfMove = (k: number): number => (k < PICKS ? k % 2 : (k - PICKS + 1) % 2);

export type Move =
  | { t: 'pick'; pool: number }
  | { t: 'rare'; idx: number }
  | { t: 'shot'; slot: number; angle: number; power: number; move: number };

/** Parses a move; only the canonical spelling is accepted (no leading zeros, no "-0"). */
export function parseMove(text: string): Move | null {
  let m = /^p(\d{1,2})$/.exec(text);
  if (m && text === `p${Number(m[1])}`) return { t: 'pick', pool: Number(m[1]) };
  m = /^r(\d)$/.exec(text);
  if (m) return { t: 'rare', idx: Number(m[1]) };
  m = /^s(\d),(\d{1,3}),(\d{1,3}),(-?\d{1,2})$/.exec(text);
  if (m) {
    const s = { t: 'shot' as const, slot: Number(m[1]), angle: Number(m[2]), power: Number(m[3]), move: Number(m[4]) };
    if (s.angle > 180 || s.power > 100 || Math.abs(s.move) > FUEL) return null;
    if (text !== shotText(s.slot, s.angle, s.power, s.move)) return null;
    return s;
  }
  return null;
}
export const shotText = (slot: number, angle: number, power: number, move: number): string => `s${slot},${angle},${power},${move}`;

/** The rare weapon ids a seat may draft, from the pack kinds it brought (each kind once). */
export const raresOf = (kinds: number[]): number[] =>
  [...new Set(kinds.filter((k) => k >= 0 && k < RARE_IDS.length))].sort((a, b) => a - b).slice(0, MAX_RARES).map((k) => RARE_IDS[k]);

export interface LogCheck { ok: boolean; error?: string; inv: number[][] }

/**
 * Checks a (possibly partial) move log the way the contract does at settlement: turn order, every
 * pick from the pool or the seat's own packs and taken once, every shot from an unused slot of the
 * shooter's own inventory, angles, powers and fuel in range.
 */
export function checkLog(pool: number[], rares: number[][], moves: string[]): LogCheck {
  const taken = pool.map(() => false);
  const rareUsed = rares.map((r) => r.map(() => false));
  const inv: number[][] = [[], []];
  const used: boolean[][] = [[], []];
  const fuel = [FUEL, FUEL];
  const fail = (k: number, why: string): LogCheck => ({ ok: false, error: `move ${k} (${moves[k]}): ${why}`, inv });
  if (moves.length > PICKS + SHOTS) return { ok: false, error: 'too many moves', inv };
  for (let k = 0; k < moves.length; k++) {
    const seat = seatOfMove(k);
    const m = parseMove(moves[k]);
    if (!m) return fail(k, 'bad format');
    if (k < PICKS) {
      if (m.t === 'pick') {
        if (m.pool >= pool.length || taken[m.pool]) return fail(k, 'not in the pool');
        taken[m.pool] = true;
        inv[seat].push(pool[m.pool]);
      } else if (m.t === 'rare') {
        if (m.idx >= rares[seat].length || rareUsed[seat][m.idx]) return fail(k, 'not your munition');
        rareUsed[seat][m.idx] = true;
        inv[seat].push(rares[seat][m.idx]);
      } else return fail(k, 'the draft is not over');
      used[seat].push(false);
    } else {
      if (m.t !== 'shot') return fail(k, 'the draft is over');
      if (m.slot >= inv[seat].length || used[seat][m.slot]) return fail(k, 'slot empty or used');
      if (Math.abs(m.move) > fuel[seat]) return fail(k, 'out of fuel');
      used[seat][m.slot] = true;
      fuel[seat] -= Math.abs(m.move);
    }
  }
  return { ok: true, inv };
}
