import { describe, expect, it } from 'vitest';
import { PICKS, checkLog, drawPool, parseMove, raresOf, saltHash, seatOfMove, seedOf } from '../src/protocol.ts';

const SALT = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const POOL = [3, 1, 0, 0, 0, 10, 10, 5, 0, 5, 1, 1, 7, 6, 6, 7, 6, 2, 7, 6];

describe('protocol', () => {
  // the same vector is in contracts/kraterra/src/tests.rs
  it('matches the contract: salt hash, seed, pool draw', () => {
    expect(saltHash(SALT)).toBe('2a8abfa8cb9906290437854193ca6bca41d4d4e26d1d454bd66a35158095e737');
    const seed = seedOf('ab'.repeat(32), SALT);
    expect(seed).toBe('5645e850911ede5ff2a226e1003cb812230bbf89b02cc1d1aeb839faf2b77c49');
    expect(drawPool(seed)).toEqual(POOL);
  });

  it('parses only canonical moves', () => {
    expect(parseMove('p0')).toEqual({ t: 'pick', pool: 0 });
    expect(parseMove('p19')).toEqual({ t: 'pick', pool: 19 });
    expect(parseMove('p07')).toBeNull();
    expect(parseMove('r2')).toEqual({ t: 'rare', idx: 2 });
    expect(parseMove('s3,180,100,-40')).toEqual({ t: 'shot', slot: 3, angle: 180, power: 100, move: -40 });
    for (const bad of ['s3,181,100,0', 's3,90,101,0', 's3,90,50,41', 's3,90,50,-0', 's3,090,50,0', 's3,90,50', 'x1']) expect(parseMove(bad)).toBeNull();
    expect(raresOf([2, 0, 2, 9])).toEqual([12, 14]);
  });

  it('turn order: seat 0 drafts first, seat 1 fires first', () => {
    expect([0, 1, 2, 19].map(seatOfMove)).toEqual([0, 1, 0, 1]);
    expect([20, 21, 22, 39].map(seatOfMove)).toEqual([1, 0, 1, 0]);
  });

  it('checks a log like the contract does', () => {
    const picks = Array.from({ length: PICKS }, (_, k) => `p${k}`);
    const ok = checkLog(POOL, [[], []], picks);
    expect(ok.ok).toBe(true);
    expect(ok.inv[0]).toEqual(POOL.filter((_, i) => i % 2 === 0));
    // a pool card taken twice
    expect(checkLog(POOL, [[], []], ['p0', 'p0']).ok).toBe(false);
    // a rare the seat doesn't have
    expect(checkLog(POOL, [[12], []], ['r0', 'r0']).error).toContain('not your munition');
    // shots: slots once, fuel 40
    const shots = [...picks, 's0,45,50,30', 's0,45,50,0', 's1,45,50,-10', 's0,45,50,0'];
    expect(checkLog(POOL, [[], []], shots).error).toContain('slot empty or used');
    const fuel = [...picks, 's0,45,50,30', 's0,45,50,0', 's1,45,50,-10', 's1,45,50,0', 's2,45,50,1'];
    expect(checkLog(POOL, [[], []], fuel).error).toContain('out of fuel');
    expect(checkLog(POOL, [[], []], ['s0,45,50,0']).error).toContain('the draft is not over');
  });
});
