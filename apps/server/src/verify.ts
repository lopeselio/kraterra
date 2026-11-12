// Independent check of a finished match. Needs no keys and trusts nothing the game server says
// beyond handing over the log: everything is compared with what the contract holds (read straight
// from a public NEAR RPC), and the whole duel is replayed with packages/rules.
// The checks live in packages/rules/src/verify.ts; the web app's "Verify in this browser" runs the same.
//
//   pnpm verify <matchId> [--host https://…] [--rpc https://…] [--contract kraterra.testnet]
//   pnpm verify <matchId> https://…        (the host as a bare second argument works too)
import { TESTNET_RPCS, verifyMatch, viewCall, type ChainMatch, type ProofBundle } from '@kraterra/rules';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const bare = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const id = bare.find((a) => !/^https?:\/\//.test(a));
const HOST = opt('host', bare.find((a) => /^https?:\/\//.test(a)) ?? process.env.VERIFY_HOST ?? 'http://localhost:8841').replace(/\/+$/, '');
const RPCS = args.includes('--rpc') ? [opt('rpc', '')] : TESTNET_RPCS;
const CONTRACT = opt('contract', process.env.CONTRACT_ID ?? 'kraterra.testnet');
if (!id) { console.error('usage: pnpm verify <matchId> [--host URL] [--rpc URL] [--contract ID]'); process.exit(2); }
const die = (msg: string): never => { console.error(msg); process.exit(2); };

let b: ProofBundle & { error?: string };
try {
  const res = await fetch(`${HOST}/api/matches/${id}/proof`);
  b = (await res.json().catch(() => ({ error: `${HOST} answered HTTP ${res.status}` }))) as typeof b;
} catch (e) { die(`can't reach ${HOST}: ${(e as Error).message}.${HOST.includes('localhost') ? ' For a match on the hosted game add --host https://kraterra.lopeselio.online' : ' Is that the right --host?'}`); }
if (b!.error) die(`${HOST}: ${b!.error}${/no such/i.test(b!.error) && !process.argv.includes('--host') ? ' (a hosted match needs --host https://kraterra.lopeselio.online)' : ''}`);
if (!b!.over || !b!.salt || !b!.vrf) die('that match is not over yet (or never reached the chain)');
let c: ChainMatch | null = null;
try { c = await viewCall<ChainMatch | null>(CONTRACT, 'get_match', { match_id: id }, RPCS); } catch (e) { die(`RPC: ${(e as Error).message}`); }

console.log(`match ${id} on ${CONTRACT}: ${b!.seats.map((s) => s.name).join(' vs ')} (${b!.mode === 'ai' ? `vs Basalt on ${b!.difficulty}` : 'friends'})\n`);
const { lines, failed } = verifyMatch(id, b!, c);
for (const l of lines) console.log(l.ok === undefined ? l.what : `${l.ok ? '✓' : '✗'} ${l.what}${l.detail ? `  ${l.detail}` : ''}`);
const signed = b!.lines.filter((l) => l.signature);
console.log(`\n${b!.lines.length} line(s) from Basalt, ${signed.length} signed by the NEAR AI enclave (taunts only: the AI's shots come from packages/rules)`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
