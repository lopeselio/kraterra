import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// Seeded generator (xoshiro128**) with integer outputs, seeded through sha256. The contract
// (contracts/kraterra) runs the same generator to redraw the weapon pool. No Math.random here.

export interface Rng { a: number; b: number; c: number; d: number }

/** A generator seeded from text (the first 16 bytes of its sha256). */
export function rngFrom(text: string): Rng {
  const h = sha256(utf8ToBytes(text));
  const w = (k: number): number => ((h[k] << 24) | (h[k + 1] << 16) | (h[k + 2] << 8) | h[k + 3]) >>> 0;
  const r = { a: w(0), b: w(4), c: w(8), d: w(12) };
  if (!(r.a | r.b | r.c | r.d)) r.a = 1;
  return r;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** Next uint32. */
export function nextU32(r: Rng): number {
  const out = Math.imul(rotl(Math.imul(r.b, 5) >>> 0, 7), 9) >>> 0;
  const t = (r.b << 9) >>> 0;
  r.c = (r.c ^ r.a) >>> 0;
  r.d = (r.d ^ r.b) >>> 0;
  r.b = (r.b ^ r.c) >>> 0;
  r.a = (r.a ^ r.d) >>> 0;
  r.c = (r.c ^ t) >>> 0;
  r.d = rotl(r.d, 11);
  return out;
}

/** Integer in [lo, hi] inclusive. */
export const int = (r: Rng, lo: number, hi: number): number => lo + (nextU32(r) % (hi - lo + 1));
/** True with probability pct/100. */
export const chance = (r: Rng, pct: number): boolean => nextU32(r) % 100 < pct;
