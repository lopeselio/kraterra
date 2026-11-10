// Independent check of a finished match. Needs no keys and trusts nothing the game server says
// beyond handing over the log: everything is compared with what the contract holds (read straight
// from a public NEAR RPC), and the whole duel is replayed with packages/rules.
//
//   pnpm verify <matchId> [--host https://…] [--rpc https://…] [--contract kraterra.testnet]
import { checkLog, drawPool, raresOf, replay, saltHash, seedOf, stateHash, THEME_NAMES, weapon } from '@kraterra/rules';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const id = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const HOST = opt('host', process.env.VERIFY_HOST ?? 'http://localhost:8841');
// public testnet RPCs (docs.near.org/api/rpc/providers); the next is tried when one refuses
const RPCS = args.includes('--rpc') ? [opt('rpc', '')] : ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs', 'https://rpc.testnet.near.org'];
const CONTRACT = opt('contract', process.env.CONTRACT_ID ?? 'kraterra.testnet');
if (!id) { console.error('usage: pnpm verify <matchId> [--host URL] [--rpc URL] [--contract ID]'); process.exit(2); }

interface Bundle {
  id: string; over: boolean; mode: string; difficulty: string; seats: { name: string; kind: string; account: string | null; packs: string[]; kinds: number[] }[];
  saltHash: string; vrf: string | null; salt: string | null; seed: string | null; moves: string[];
  result: { winner: number | null; scores: number[]; reason: string } | null; stateHash?: string;
  txs: { what: string; url: string }[]; lines: { who: string; signature?: string; signingAddress?: string }[];
}
interface ChainMatch {
  seats: { name: string; account: string | null; packs: string[]; rares: number[] }[];
  salt_hash: string; vrf: string | null; seed: string | null; pool: number[]; moves: string[];
  scores: number[] | null; winner: number | null; status: string; mode: string;
}

async function viewCall<T>(method: string, a: object): Promise<T> {
  let last = '';
  for (const rpc of RPCS) {
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') } }),
      });
      const j = (await res.json()) as { result?: { result: number[] }; error?: unknown };
      if (j.result) return JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T;
      last = `${rpc}: ${JSON.stringify(j.error).slice(0, 200)}`;
    } catch (e) { last = `${rpc}: ${(e as Error).message}`; }
  }
  throw new Error(`RPC: ${last}`);
}

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const b = (await (await fetch(`${HOST}/api/matches/${id}/proof`)).json()) as Bundle & { error?: string };
if (b.error) { console.error(b.error); process.exit(2); }
if (!b.over || !b.salt || !b.vrf) { console.error('that match is not over yet (or never reached the chain)'); process.exit(2); }
const c = await viewCall<ChainMatch | null>('get_match', { match_id: id });
console.log(`match ${id} on ${CONTRACT}: ${b.seats.map((s) => s.name).join(' vs ')} (${b.mode === 'ai' ? `vs Basalt on ${b.difficulty}` : 'friends'})\n`);
check(!!c, 'the contract has this match');
if (!c) process.exit(1);
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
console.log(`  battlefield: ${THEME_NAMES[s.theme]}${s.water ? `, water at ${s.water}` : ''}`);
const scores = s.tanks.map((t) => t.score);
if (c.status === 'settled') {
  check(same(scores, c.scores), `the replay scores ${scores.join(' – ')}, the same as the contract recorded`);
  check(s.winner === c.winner, `winner: ${s.winner === null ? 'a draw' : b.seats[s.winner].name}`);
  check(stateHash(s) === b.stateHash, 'the replay ends in the exact state the server ended in', stateHash(s).slice(0, 16));
} else {
  check(c.winner !== null, `resigned: ${c.winner === null ? '?' : b.seats[c.winner].name} won by forfeit after ${c.moves.length} moves`);
}
const signed = b.lines.filter((l) => l.signature);
console.log(`\n${b.lines.length} line(s) from Basalt, ${signed.length} signed by the NEAR AI enclave (taunts only: the AI's shots come from packages/rules)`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
