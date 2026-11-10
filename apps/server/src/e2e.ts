// End-to-end run against the live testnet contract and a running server, as a signed-in player.
// Creates a fresh faucet-funded test account each run (no real wallet involved).
//   pnpm e2e [baseUrl]            (default http://localhost:8841)
// Steps: sign in through Better Auth + better-near-auth (NEP-413) -> claim a starter munition pack
// (an NFT) as a gasless NEP-366 meta-transaction through the relayer -> duel Basalt over HTTP,
// drafting the pack's rare munition (the player aims with the same search Basalt uses) -> wait for
// every move and the settlement onchain -> compare the contract's record with the result.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, KeyPair, KeyPairSigner, actions, type KeyPairString } from 'near-api-js';
import { Near } from 'near-kit';
import { sha256 } from '@noble/hashes/sha2.js';
import { provider as rpc } from './chain.ts';
import { aiPick, aiShot, fromWire, rngFrom, weapon, type WireState } from '@kraterra/rules';

const URL_ = process.argv[2] ?? process.env.E2E_URL ?? 'http://localhost:8841';
const CONTRACT = process.env.CONTRACT_ID ?? 'kraterra.testnet';
const stamp = Date.now().toString(36);
const step = (s: string): void => console.log(`\n▶ ${s}`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const credFile = (a: string): string => join(homedir(), '.near-credentials', 'testnet', `${a}.json`);
function faucetAccount(id: string): KeyPairString {
  execFileSync('near', ['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { stdio: 'ignore' });
  return JSON.parse(readFileSync(credFile(id), 'utf8')).private_key as KeyPairString;
}
/**
 * When the faucet is rate-limited: a sub-account of a testnet account we hold, funded with 0.3 NEAR.
 * Default: the contract's owner account, which the running server doesn't sign with (so no nonce clash).
 */
async function fundedSubAccount(label: string): Promise<{ id: string; key: KeyPairString }> {
  const funder = process.env.E2E_FUNDER ?? CONTRACT;
  const fk = JSON.parse(readFileSync(credFile(funder), 'utf8')).private_key as KeyPairString;
  const kp = KeyPair.fromRandom('ed25519');
  const sub = `${label}.${funder}`;
  const f = new Account(funder, rpc, KeyPairSigner.fromSecretKey(fk));
  await f.signAndSendTransaction({ receiverId: sub, actions: [actions.createAccount(), actions.transfer(300_000_000_000_000_000_000_000n), actions.addFullAccessKey(kp.getPublicKey())], waitUntil: 'EXECUTED_OPTIMISTIC' });
  writeFileSync(credFile(sub), JSON.stringify({ account_id: sub, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return { id: sub, key: kp.toString() as KeyPairString };
}

/** sha256 of the NEP-413 payload a wallet signs (what better-near-auth verifies). */
function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const str = (t: string): Uint8Array => { const e = new TextEncoder().encode(t); return Buffer.concat([u32(e.length), e]); };
  return sha256(Buffer.concat([u32(2 ** 31 + 413), str(message), nonce, str(recipient), new Uint8Array([0])]));
}

let id = `kraterra-e2e-${stamp}.testnet`;
step(`create ${id} from the testnet faucet`);
let key: KeyPairString;
try { key = faucetAccount(id); } catch {
  ({ id, key } = await fundedSubAccount(`e2e-${stamp}`));
  console.log(`  (the faucet is rate-limited: using ${id}, funded by its parent account)`);
}
const provider = rpc;
await sleep(3000);
ok('account funded');

const view = async <T>(method: string, args: object): Promise<T> => (await provider.callFunction({ contractId: CONTRACT, method, args: args as Record<string, unknown>, blockQuery: { finality: 'optimistic' } })) as T;
let cookie = '';
const origin = new URL(URL_).origin;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL_}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const j = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path}: ${j.error ?? j.message ?? res.status}`);
  return j;
}

// a wallet stand-in: near-kit with the test account's key builds the signed delegate action
const kit = new Near({ network: 'testnet', privateKey: key as `ed25519:${string}`, defaultSignerId: id });
async function relay(method: string, args: object): Promise<string> {
  const { payload } = await kit.transaction(id).functionCall(CONTRACT, method, args, { gas: '50 Tgas', attachedDeposit: '0 yocto' }).delegate();
  const r = await api<{ txHash: string }>('/ba/near/relay', { payload });
  for (let k = 0; k < 30; k++) {
    const st = await api<{ status: string }>(`/ba/near/relay-status/${r.txHash}`);
    if (st.status === 'completed') return r.txHash;
    if (st.status === 'failed') throw new Error(`${method} relay failed (${r.txHash})`);
    await sleep(1500);
  }
  return r.txHash;
}

step('sign in: Better Auth + better-near-auth (the wallet signs "Sign in to <host>")');
const host = new URL(URL_).host;
const { nonce } = await api<{ nonce: string }>('/ba/near/nonce', { accountId: id, networkId: 'testnet' });
const kp = KeyPair.fromString(key);
const message = `Sign in to ${host}`;
const sig = kp.sign(nep413Hash(message, Buffer.from(nonce, 'hex'), host));
await api('/ba/near/verify', { signedMessage: { accountId: id, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(sig.signature).toString('base64') }, message, recipient: host, nonce, accountId: id });
ok(`session cookie set; the server sees ${(await api<{ accountId: string }>('/me')).accountId}`);

step('claim a starter munition pack, gasless (NEP-366 meta-transaction through the relayer)');
ok(`mint_starter ${await relay('mint_starter', {})}`);
type Pack = { token_id: string; metadata: { title: string; extra: string } };
const profile = await api<{ packs: Pack[]; starter: boolean }>('/me');
const pack = profile.packs[0];
if (!pack) throw new Error('no pack after mint_starter');
ok(`${pack.token_id}: “${pack.metadata.title}” (kind picked by the block's VRF), owned by ${id}`);

step('duel Basalt on Normal, drafting the pack munition');
const created = await api<{ id: string; token: string }>('/matches', { mode: 'ai', difficulty: 'normal', name: 'E2E Gunner' });
const matchId = created.id;
const seatHeaders = { 'x-seat-token': created.token };
interface View { phase: string; turn: number | null; state: WireState | null; vrf: string | null; saltHash: string; result: { winner: number | null; scores: number[] } | null; seats: { name: string; kinds: number[] }[]; chain: { txs: { what: string; url: string }[]; queued: number; settled: boolean; error: string | null; created: boolean }; lines: { who: string; text: string }[] }
const getView = async (): Promise<View> => {
  const res = await fetch(`${URL_}/api/matches/${matchId}`, { headers: { ...seatHeaders, cookie } });
  return (await res.json()) as View;
};
const post = async (text: string): Promise<void> => {
  const res = await fetch(`${URL_}/api/matches/${matchId}/move`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie, ...seatHeaders }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`move ${text}: ${(await res.json() as { error: string }).error}`);
};
let v = await getView();
for (let k = 0; k < 40 && v.phase === 'drawing'; k++) { await sleep(1000); v = await getView(); }
if (!v.state) throw new Error(`no battlefield: ${v.chain.error}`);
ok(`match ${matchId}: salt hash ${v.saltHash.slice(0, 16)}… committed, then the contract drew VRF ${v.vrf?.slice(0, 16)}… in a later receipt`);
ok(`battlefield “${fromWire(v.state).theme}”; you may draft ${v.seats[0].kinds.length} pack munition(s), Basalt ${v.seats[1].kinds.length}`);
const brain = rngFrom(`e2e|${stamp}`);
let rarePicked = false;
const deadline = Date.now() + 8 * 60_000;
while (v.phase !== 'over') {
  if (Date.now() > deadline) throw new Error('the duel took too long');
  if (v.turn === 0 && v.state) {
    const s = fromWire(v.state);
    let text: string;
    if (s.phase === 'draft') text = !rarePicked && s.seats[0].rares.length ? 'r0' : aiPick(s, 0, 'hard', brain);
    else text = aiShot(s, 0, 'normal', brain);
    if (text === 'r0') { rarePicked = true; ok(`drafted ${weapon(s.seats[0].rares[0]).name} from the pack`); }
    await post(text);
  }
  await sleep(600);
  v = await getView();
}
for (const l of v.lines) ok(`${l.who}: “${l.text}”`);
const [a, b] = v.result!.scores;
ok(`over: E2E Gunner ${a} – ${b} Basalt; ${v.result!.winner === null ? 'a draw' : v.result!.winner === 0 ? 'you win' : 'Basalt wins'}`);

step('wait for every move and the settlement onchain');
for (let k = 0; k < 100 && !(v.chain.settled && v.chain.queued === 0); k++) { await sleep(3000); v = await getView(); if (v.chain.error) break; }
if (!v.chain.settled) throw new Error(`not settled: ${v.chain.error}`);
for (const t of v.chain.txs) ok(`${t.what.padEnd(30)} ${t.url}`);
const cm = await view<{ status: string; scores: number[]; winner: number | null; moves: string[]; seed: string }>('get_match', { match_id: matchId });
ok(`contract: ${cm.status}, ${cm.moves.length} moves, scores ${cm.scores.join(' – ')}, winner ${cm.winner === null ? 'none (draw)' : `seat ${cm.winner}`}, seed ${cm.seed.slice(0, 16)}…`);
if (JSON.stringify(cm.scores) !== JSON.stringify(v.result!.scores)) throw new Error('the contract recorded different scores');
const stats = await view<{ matches: number; wins: number; damage: number }>('stats_of', { account_id: id });
ok(`your record onchain: ${stats.matches} match, ${stats.wins} win(s), ${stats.damage} damage`);
console.log(`\nall player steps passed. Check the match yourself:\n  pnpm verify ${matchId}${URL_ === 'http://localhost:8841' ? '' : ` --host ${URL_}`}`);
process.exit(0);
