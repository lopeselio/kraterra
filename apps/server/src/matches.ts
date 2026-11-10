import { createHash, randomBytes } from 'node:crypto';
import {
  aiPick, aiShot, applyMove, createState, fromWire, raresOf, rngFrom, rollWind, saltHash, seedOf, stateHash, toWire, whoseTurn,
  type Difficulty, type SimEvent, type State,
} from '@kraterra/rules';
import { AI_ACCOUNT } from './ai-account.ts';
import { call, view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { voice } from './nearai.ts';
import { allMatches, loadMatch, saveMatch, type ChainOp, type MatchRecord, type SeatRec } from './store.ts';

// The match server. It keeps each match's state, runs the moves through packages/rules (the same
// checks the contract makes), plays Basalt, and relays every move to the contract in small batches.
//
// Onchain life of a match:
//   create_match  commits sha256(salt) and the seats' NFT packs; the contract then draws its VRF seed
//                 in a later receipt and returns it. Terrain, pool and wind come from sha256(vrf|salt).
//   play          the moves, in order (Basalt signs its own with a function-call key)
//   settle        reveals the salt; the contract redraws the pool, checks the whole log, records the scores

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const BASALT = 'Basalt';
const FRIEND_IDLE_MS = 3 * 60_000;

// ---------- change listeners (websocket pushes) ----------

type Listener = (m: MatchRecord, ev: { seat: number; text: string; events: SimEvent[] } | null) => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); };

function touch(m: MatchRecord, ev: Parameters<Listener>[1] = null): void {
  m.updatedAt = Date.now();
  saveMatch(m);
  for (const l of listeners) { try { l(m, ev); } catch { /* a dead socket */ } }
}

// ---------- views ----------

export function seatOf(m: MatchRecord, token: string | undefined): number | null {
  if (!token) return null;
  const h = sha(token);
  if (m.seats[0].tokenHash === h) return 0;
  if (m.seats[1]?.tokenHash === h) return 1;
  return null;
}

const publicSeat = (s: SeatRec | null) => s && { kind: s.kind, name: s.name, account: s.account ?? null, packs: s.packs, kinds: s.kinds };

export function publicView(m: MatchRecord, you: number | null = null) {
  const over = m.phase === 'over';
  return {
    id: m.id,
    mode: m.mode,
    difficulty: m.difficulty,
    you,
    phase: m.phase,
    createdAt: m.createdAt,
    seats: [publicSeat(m.seats[0]), publicSeat(m.seats[1])],
    state: m.state,
    turn: m.state && !over ? whoseTurn(fromWire(m.state)) : null,
    result: m.result,
    idleSince: m.actedAt,
    claimAfter: m.mode === 'friend' && !over ? m.actedAt + FRIEND_IDLE_MS : null,
    saltHash: m.saltHash,
    vrf: m.vrf,
    salt: over ? m.salt : null,
    seed: over ? m.seed : null,
    lines: m.lines.map((l) => ({ who: l.who, text: l.text, signed: !!l.signature })),
    chain: {
      on: m.chain.on,
      enabled: config.chainEnabled,
      contract: config.contract,
      created: m.chain.created,
      settled: m.chain.settled,
      queued: m.chain.pending.length,
      error: m.chain.error ?? null,
      retrying: m.chain.retry ? `retry ${m.chain.retry.n}/10: ${m.chain.retry.msg}` : null,
      txs: m.chain.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })),
    },
  };
}
export type MatchView = ReturnType<typeof publicView>;

export function summary(m: MatchRecord) {
  return {
    id: m.id, mode: m.mode, difficulty: m.difficulty, phase: m.phase, updatedAt: m.updatedAt, names: [m.seats[0].name, m.seats[1]?.name ?? null],
    scores: m.state ? fromWire(m.state).tanks.map((t) => t.score) : [0, 0], winner: m.result?.winner ?? null, settled: m.chain.settled,
  };
}

/** Everything `pnpm verify` needs to re-check a finished match without trusting this server. */
export function proofBundle(m: MatchRecord) {
  const over = m.phase === 'over';
  return {
    id: m.id, contract: config.contract, over, mode: m.mode, difficulty: m.difficulty,
    seats: m.seats.map((s) => s && { name: s.name, kind: s.kind, account: s.account ?? null, packs: s.packs, kinds: s.kinds }),
    saltHash: m.saltHash, vrf: m.vrf, salt: over ? m.salt : null, seed: over ? m.seed : null,
    moves: m.state?.moves ?? [], result: m.result, stateHash: over ? m.result?.stateHash : undefined,
    txs: m.chain.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })),
    lines: m.lines,
  };
}

// ---------- creating and joining ----------

const cleanName = (n: unknown): string => String(n ?? '').replace(/[^\p{L}\p{N} _'.-]/gu, '').trim().slice(0, 20) || 'Gunner';
const asDifficulty = (d: unknown): Difficulty => (d === 'easy' || d === 'hard' ? d : 'normal');
function newId(): string {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    const id = Array.from(randomBytes(6), (b) => A[b % A.length]).join('');
    if (!loadMatch(id)) return id;
  }
}

interface PackRow { token_id: string; metadata?: { extra?: string } }
/** One NFT pack per kind the account owns (at most three): the munitions it may draft. */
async function packsOf(account: string | undefined): Promise<{ packs: string[]; kinds: number[] }> {
  if (!account || !config.chainEnabled) return { packs: [], kinds: [] };
  const rows = await view<PackRow[]>('nft_tokens_for_owner', { account_id: account, from_index: null, limit: 50 }).catch(() => [] as PackRow[]);
  const byKind = new Map<number, string>();
  for (const r of rows) {
    let kind = -1;
    try { kind = Number((JSON.parse(r.metadata?.extra ?? '{}') as { kind?: number }).kind ?? -1); } catch { /* not ours */ }
    if (kind >= 0 && kind <= 2 && !byKind.has(kind)) byKind.set(kind, r.token_id);
  }
  const kinds = [...byKind.keys()].sort((a, b) => a - b).slice(0, 3);
  return { packs: kinds.map((k) => byKind.get(k)!), kinds };
}

function newSeat(name: string, account: string | null): { seat: SeatRec; token: string } {
  const token = randomBytes(24).toString('hex');
  const seat: SeatRec = account
    ? { kind: 'account', name, account, tokenHash: sha(token), packs: [], kinds: [] }
    : { kind: 'guest', name, tokenHash: sha(token), packs: [], kinds: [] };
  return { seat, token };
}

export function createMatch(opts: { mode: 'ai' | 'friend'; difficulty?: unknown; name: unknown; account: string | null }) {
  const id = newId();
  const { seat, token } = newSeat(cleanName(opts.name), opts.account);
  const now = Date.now();
  const salt = randomBytes(32).toString('hex');
  const m: MatchRecord = {
    id, mode: opts.mode, difficulty: asDifficulty(opts.difficulty), createdAt: now, updatedAt: now, actedAt: now,
    seats: [seat, null], phase: 'lobby', salt, saltHash: saltHash(salt), vrf: null, seed: null, state: null, result: null, lines: [],
    chain: { on: config.chainEnabled, created: false, settled: false, pending: [], txs: [] },
  };
  if (opts.mode === 'ai') {
    m.seats[1] = { kind: 'ai', name: BASALT, account: hasKey(AI_ACCOUNT) || !config.chainEnabled ? AI_ACCOUNT : undefined, packs: [], kinds: [] };
  }
  touch(m);
  if (m.seats[1]) void start(m);
  return { id, seat: 0, token };
}

export function joinMatch(m: MatchRecord, name: unknown, account: string | null) {
  if (m.mode !== 'friend') throw new Error('that match is against Basalt');
  if (m.seats[1]) throw new Error('both seats are taken');
  if (account && m.seats[0].account === account) throw new Error('that’s your own challenge: send the link to a friend');
  const { seat, token } = newSeat(cleanName(name), account);
  m.seats[1] = seat;
  touch(m);
  void start(m);
  return { id: m.id, seat: 1, token };
}

/** Both seats are here: commit the salt onchain, take the contract's VRF draw, build the battlefield. */
async function start(m: MatchRecord): Promise<void> {
  m.phase = 'drawing';
  touch(m);
  for (const s of m.seats) {
    if (!s) continue;
    const p = await packsOf(s.account);
    s.packs = p.packs; s.kinds = p.kinds;
  }
  let vrf: string | null = null;
  if (m.chain.on) {
    try {
      const r = await call<string>(config.referee, 'create_match', {
        match_id: m.id, salt_hash: m.saltHash, mode: m.mode === 'ai' ? `ai-${m.difficulty}` : 'friend',
        seats: m.seats.map((s) => ({ name: s!.name, account: s!.account ?? null, packs: s!.packs })),
      }, 60);
      m.chain.txs.push({ what: 'create_match (VRF draw)', hash: r.tx });
      m.chain.created = true;
      if (typeof r.value === 'string' && /^[0-9a-f]{64}$/.test(r.value)) vrf = r.value;
      else vrf = (await view<{ vrf: string | null } | null>('get_match', { match_id: m.id }))?.vrf ?? null;
      if (!vrf) throw new Error('the contract returned no VRF seed');
    } catch (e) {
      // the match still plays, from a local draw, and says why it isn't onchain
      m.chain.on = false;
      m.chain.error = `create_match: ${(e as Error).message.slice(0, 300)}`;
      console.warn(`match ${m.id}: ${m.chain.error}`);
    }
  }
  m.vrf = vrf ?? randomBytes(32).toString('hex');
  m.seed = seedOf(m.vrf, m.salt);
  const s = createState({ matchId: m.id, seed: m.seed, rules: 1, seats: m.seats.map((x) => ({ name: x!.name, rares: raresOf(x!.kinds) })) });
  m.state = toWire(s);
  m.phase = 'draft';
  m.actedAt = Date.now();
  touch(m);
  if (m.mode === 'ai') say(m, 'intro');
  scheduleAi(m);
}

// ---------- playing ----------

/** A seat's move: checked by packages/rules exactly as the contract checks it, then queued for the chain. */
export function move(m: MatchRecord, seat: number, text: string): void {
  if (!m.state || (m.phase !== 'draft' && m.phase !== 'battle')) throw new Error('the match isn’t running');
  const s = fromWire(m.state);
  if (whoseTurn(s) !== seat) throw new Error('it’s not your turn');
  apply(m, s, seat, String(text).slice(0, 24));
  scheduleAi(m);
}

function apply(m: MatchRecord, s: State, seat: number, text: string): void {
  const before = s.tanks.map((t) => t.score);
  const events = applyMove(s, text);
  rollWind(s, m.seed!);
  m.state = toWire(s);
  m.phase = s.phase === 'over' ? 'over' : s.phase;
  m.actedAt = Date.now();
  const signer = m.seats[seat]!.kind === 'ai' && hasKey(AI_ACCOUNT) ? AI_ACCOUNT : config.referee;
  queue(m, { what: 'play', method: 'play', args: { match_id: m.id, moves: [{ seat, text }] }, gas: 0, signer });
  if (m.mode === 'ai' && s.phase !== 'draft') {
    const gained = s.tanks.map((t, i) => t.score - before[i]);
    if (gained[1] >= 30) say(m, 'hit');
    else if (gained[0] >= 30) say(m, 'hurt');
  }
  if (s.phase === 'over') finish(m, s, 'score');
  touch(m, { seat, text, events });
}

/** Basalt moves after a short pause (long enough for the browser to finish animating the last shot). */
const aiTimers = new Map<string, NodeJS.Timeout>();
function scheduleAi(m: MatchRecord): void {
  if (m.mode !== 'ai' || !m.state || aiTimers.has(m.id)) return;
  const s = fromWire(m.state);
  if (whoseTurn(s) !== 1) return;
  const delay = s.phase === 'draft' ? 700 : s.moves.length === 20 ? 2500 : 4200;
  aiTimers.set(m.id, setTimeout(() => {
    aiTimers.delete(m.id);
    const cur = loadMatch(m.id);
    if (!cur?.state || cur.phase === 'over') return;
    const st = fromWire(cur.state);
    if (whoseTurn(st) !== 1) return;
    // its hand shakes from a generator only the server knows (the salt is secret until the end)
    const r = rngFrom(`basalt|${cur.salt}|${st.moves.length}`);
    const text = st.phase === 'draft' ? aiPick(st, 1, cur.difficulty, r) : aiShot(st, 1, cur.difficulty, r);
    try { apply(cur, st, 1, text); } catch (e) { console.warn(`basalt ${cur.id}: ${(e as Error).message}`); }
    scheduleAi(cur);
  }, delay));
}

function finish(m: MatchRecord, s: State, reason: 'score' | 'resign' | 'timeout', winner: number | null = s.winner): void {
  m.phase = 'over';
  m.result = { winner, scores: s.tanks.map((t) => t.score), reason, stateHash: stateHash(s) };
  if (reason === 'score') {
    queue(m, { what: 'settle (salt revealed)', method: 'settle', args: { match_id: m.id, salt: m.salt, scores: m.result.scores }, gas: 250, signer: config.referee });
  }
  if (m.mode === 'ai') say(m, 'end');
}

export function resign(m: MatchRecord, seat: number, reason: 'resign' | 'timeout' = 'resign'): void {
  if (m.phase === 'over') throw new Error('the match is already over');
  if (!m.state || !m.seats[1]) {
    // nobody joined yet (or no battlefield): just close it
    m.phase = 'over';
    m.result = { winner: null, scores: [0, 0], reason };
    touch(m);
    return;
  }
  const s = fromWire(m.state);
  finish(m, s, reason, 1 - seat);
  if (m.chain.created) queue(m, { what: `resign (${m.seats[seat]!.name}${reason === 'timeout' ? ', timed out' : ''})`, method: 'resign', args: { match_id: m.id, seat, salt: m.salt }, gas: 250, signer: config.referee });
  touch(m);
}

/** In a friend match, the seat that's waiting may claim the win once the other has been idle for 3 minutes. */
export function claim(m: MatchRecord, seat: number): void {
  if (m.mode !== 'friend' || !m.state || m.phase === 'over') throw new Error('nothing to claim');
  const turn = whoseTurn(fromWire(m.state));
  if (turn === seat || turn === null) throw new Error('it’s your turn');
  if (Date.now() < m.actedAt + FRIEND_IDLE_MS) throw new Error('your rival still has time');
  resign(m, turn, 'timeout');
}

// ---------- Basalt's voice (NEAR AI, signed; it never picks a shot) ----------

const PERSONA = 'You are Basalt, an old, gravel-voiced artillery tank with a dry sense of humour, fighting a duel on a voxel battlefield. Speak to your opponent directly as "you"; never guess their gender. One short sentence (under 16 words). No quotation marks, no emojis.';
const FALLBACK: Record<string, string[]> = {
  intro: ['Dig in. I’ve levelled bigger hills than you.', 'Mind the wind. I always do.'],
  hit: ['That one had your name stencilled on it.', 'Rearranged your landscape, did I?'],
  hurt: ['Lucky shot. My paint’s seen worse.', 'Hm. You’ve done this before.'],
  win: ['Good duel. The crater’s yours to keep.', 'Better luck next barrage.'],
  lose: ['Well shot. I’ll be over here, smouldering.', 'You win this field. I’ll want a rematch.'],
};

function say(m: MatchRecord, moment: 'intro' | 'hit' | 'hurt' | 'end'): void {
  if (m.mode !== 'ai' || m.lines.length >= 8) return;
  const foe = m.seats[0].name;
  const won = m.result?.winner === 1;
  const key = moment === 'end' ? (won ? 'win' : 'lose') : moment;
  const prompt = {
    intro: `Greet ${foe} before your artillery duel begins.`,
    hit: `You just landed a heavy shell on ${foe}'s tank. Gloat.`,
    hurt: `${foe} just landed a heavy shell on you. React.`,
    win: `You won the duel against ${foe}.`,
    lose: `You lost the duel to ${foe}. Concede gracefully.`,
  }[key];
  const pool = FALLBACK[key];
  const asked = Date.now();
  void voice(BASALT, PERSONA, prompt, pool[m.lines.length % pool.length]).then((line) => {
    const cur = loadMatch(m.id) ?? m;
    cur.lines.push({ ...line, at: asked });
    cur.lines.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
    touch(cur);
  });
}

// ---------- the chain queue ----------

const timers = new Map<string, NodeJS.Timeout>();
const flushing = new Set<string>();

function queue(m: MatchRecord, op: ChainOp): void {
  if (!m.chain.on || !m.chain.created) return;
  m.chain.pending.push(op);
  schedule(m.id, 1500);
}

function schedule(id: string, ms: number): void {
  if (timers.has(id)) return;
  timers.set(id, setTimeout(() => { timers.delete(id); void flush(id); }, ms));
}

const MAX_MOVES = 12;
const MAX_RETRIES = 10;

/** Sends a match's queued operations in order, merging runs of moves from one signer into one `play` call. */
async function flush(id: string): Promise<void> {
  if (flushing.has(id)) { schedule(id, 1000); return; }
  const m = loadMatch(id);
  if (!m || m.chain.error) return;
  flushing.add(id);
  try {
    while (m.chain.pending.length) {
      const first = m.chain.pending[0];
      let take = 1;
      let op = first;
      if (first.method === 'play') {
        const moves: unknown[] = [];
        take = 0;
        while (take < m.chain.pending.length && m.chain.pending[take].method === 'play' && m.chain.pending[take].signer === first.signer && moves.length < MAX_MOVES) {
          moves.push(...(m.chain.pending[take].args.moves as unknown[]));
          take++;
        }
        const who = first.signer === AI_ACCOUNT ? ' (signed by Basalt)' : '';
        op = { what: `play ×${moves.length}${who}`, method: 'play', args: { match_id: id, moves }, gas: Math.min(150, 20 + moves.length * 5), signer: first.signer };
      }
      const r = await call(op.signer, op.method, op.args, op.gas);
      m.chain.pending.splice(0, take);
      m.chain.txs.push({ what: op.what, hash: r.tx });
      if (op.method === 'settle' || op.method === 'resign') m.chain.settled = true;
      touch(m);
    }
    m.chain.retry = undefined;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    // a refusal from the contract is final; anything else (RPCs, rate limits, a stale nonce) never ran: try again
    const refused = /failed:/.test(msg);
    const n = (m.chain.retry?.n ?? 0) + 1;
    if (refused || n > MAX_RETRIES) { m.chain.error = msg; m.chain.retry = undefined; }
    else { m.chain.retry = { n, msg }; schedule(id, Math.min(300_000, 10_000 * 2 ** (n - 1))); }
    console.warn(`chain ${id}: ${refused ? 'refused' : `attempt ${n}`}: ${msg}`);
    touch(m);
  } finally {
    flushing.delete(id);
  }
}

/** On startup: carry on sending what was queued before a restart, and pick up Basalt's turn. */
export function resume(): void {
  for (const m of allMatches()) {
    if (m.phase === 'drawing') { m.phase = 'over'; m.result = { winner: null, scores: [0, 0], reason: 'resign' }; saveMatch(m); continue; }
    if (m.chain.pending.length) {
      if (m.chain.error && !/failed:/.test(m.chain.error)) { m.chain.error = undefined; saveMatch(m); }
      if (!m.chain.error) schedule(m.id, 2000);
    }
    if (m.phase === 'draft' || m.phase === 'battle') scheduleAi(m);
  }
}
