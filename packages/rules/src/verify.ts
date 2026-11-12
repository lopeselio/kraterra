// The checks behind `pnpm verify` and the in-browser "Verify" button: a finished match's proof
// bundle (from the game server) against what the contract holds (from a public NEAR RPC), plus a
// full replay with these rules. Pure: the caller fetches both and prints the lines.
import { checkLog, drawPool, raresOf, saltHash, seedOf } from './protocol.ts';
import { replay, stateHash } from './sim.ts';
import { THEME_NAMES } from './terrain.ts';
import { weapon } from './weapons.ts';

export interface ProofBundle {
  id: string; over: boolean; mode: string; difficulty: string;
  seats: { name: string; kind: string; account: string | null; packs: string[]; kinds: number[] }[];
  saltHash: string; vrf: string | null; salt: string | null; seed: string | null; moves: string[];
  result: { winner: number | null; scores: number[]; reason: string } | null; stateHash?: string;
  txs: { what: string; url: string }[]; lines: { who: string; signature?: string; signingAddress?: string }[];
}
export interface ChainMatch {
  seats: { name: string; account: string | null; packs: string[]; rares: number[] }[];
  salt_hash: string; vrf: string | null; seed: string | null; pool: number[]; moves: string[];
  scores: number[] | null; winner: number | null; status: string; mode: string;
}
/** A check (ok set) or an information line (ok undefined). */
export interface VerifyLine { ok?: boolean; what: string; detail?: string }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every check, in order. `c` is the contract's get_match (null when it has no such match). */
export function verifyMatch(id: string, b: ProofBundle, c: ChainMatch | null): { lines: VerifyLine[]; failed: number } {
  const lines: VerifyLine[] = [];
  let failed = 0;
  const check = (ok: boolean, what: string, detail = ''): void => { if (!ok) failed++; lines.push({ ok, what, detail }); };
  check(!!c, 'the contract has this match');
  if (!c || !b.salt || !b.vrf) return { lines, failed };
  check(c.status === 'settled' || c.status === 'resigned', `the contract closed it (${c.status})`);

  // randomness nobody could pick
  check(saltHash(b.salt) === c.salt_hash && c.salt_hash === b.saltHash, 'the revealed salt matches the hash committed at create_match', c.salt_hash.slice(0, 16));
  check(c.vrf === b.vrf, 'the VRF value is the one the contract drew from the block (after the commit)', c.vrf?.slice(0, 16) ?? '');
  const seed = seedOf(b.vrf, b.salt);
  check(seed === c.seed && seed === b.seed, 'seed = sha256(vrf | salt), as the contract computed it', seed.slice(0, 16));
  const pool = drawPool(seed);
  check(same(pool, c.pool), 'the weapon pool redraws from that seed exactly as the contract drew it', pool.map((w) => weapon(w).name).slice(0, 4).join(', ') + '…');

  // munition packs
  const rares = b.seats.map((s) => raresOf(s.kinds));
  check(same(rares, c.seats.map((s) => s.rares)), 'each seat drafted only from the packs the contract saw it own', rares.map((r) => r.map((w) => weapon(w).name).join('+') || 'none').join(' / '));

  // the log
  check(same(b.moves, c.moves), `the move log is the one recorded onchain, move by move (${c.moves.length} moves)`);
  const log = checkLog(pool, rares, b.moves);
  check(log.ok, 'every pick and shot is legal (turn order, pool, slots, angles, power, fuel)', log.error ?? '');

  // the replay
  const s = replay({ matchId: id, seed, rules: 1, seats: b.seats.map((x, i) => ({ name: x.name, rares: rares[i] })) }, b.moves);
  lines.push({ what: `  battlefield: ${THEME_NAMES[s.theme]}${s.water ? `, water at ${s.water}` : ''}` });
  const scores = s.tanks.map((t) => t.score);
  if (c.status === 'settled') {
    check(same(scores, c.scores), `the replay scores ${scores.join(' – ')}, the same as the contract recorded`);
    check(s.winner === c.winner, `winner: ${s.winner === null ? 'a draw' : b.seats[s.winner].name}`);
    check(stateHash(s) === b.stateHash, 'the replay ends in the exact state the server ended in', stateHash(s).slice(0, 16));
  } else {
    check(c.winner !== null, `resigned: ${c.winner === null ? '?' : b.seats[c.winner].name} won by forfeit after ${c.moves.length} moves`);
  }
  return { lines, failed };
}

/** Public testnet RPCs (docs.near.org/api/rpc/providers), the most forgiving first. */
export const TESTNET_RPCS = ['https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com'];

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
};

/**
 * A contract view through the RPC list: each RPC is tried in turn, and a rate-limited (429) or failing
 * round is retried with a growing pause. Throws one readable error when every RPC refused.
 */
export async function viewCall<T>(contract: string, method: string, args: object, rpcs: string[] = TESTNET_RPCS, rounds = 3): Promise<T> {
  const errors: string[] = [];
  for (let round = 0; round < rounds; round++) {
    if (round) await new Promise((r) => setTimeout(r, 1500 * round));
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: b64(JSON.stringify(args)) } }),
        });
        if (res.status === 429) { errors.push(`${new URL(rpc).host}: rate-limited (429)`); continue; }
        const j = (await res.json()) as { result?: { result: number[] }; error?: { cause?: { name?: string }; data?: string; message?: string } };
        if (j.result) return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
        const msg = JSON.stringify(j.error ?? res.status).slice(0, 160);
        // the contract itself answered with an error: no other RPC will say otherwise
        if (/MethodNotFound|CodeDoesNotExist|UNKNOWN_ACCOUNT|panicked/.test(msg)) throw Object.assign(new Error(`${method}: ${msg}`), { final: true });
        if (/-429|Too Many|rate/i.test(msg)) { errors.push(`${new URL(rpc).host}: rate-limited`); continue; }
        errors.push(`${new URL(rpc).host}: ${msg}`);
      } catch (e) {
        if ((e as { final?: boolean }).final) throw e;
        errors.push(`${new URL(rpc).host}: ${(e as Error).message}`);
      }
    }
  }
  throw new Error(`every NEAR RPC refused (${errors.slice(-rpcs.length).join('; ')}). Wait a minute and try again, or pass --rpc <url>.`);
}
