import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Difficulty, WireState } from '@kraterra/rules';
import { config } from './config.ts';
import type { SignedLine } from './nearai.ts';

// Match records: one JSON file each under DATA_DIR/matches (an Azure Files share mounted at /data when
// hosted), so proof bundles survive restarts and redeploys.

export interface SeatRec {
  kind: 'account' | 'guest' | 'ai';
  name: string;
  account?: string;
  /** sha256 of the seat token the browser holds (humans) */
  tokenHash?: string;
  /** NFT munition packs brought to the match (one per kind) and their kinds */
  packs: string[];
  kinds: number[];
}

export interface ChainOp { what: string; method: string; args: Record<string, unknown>; gas: number; signer: string }

export type MatchPhase = 'lobby' | 'drawing' | 'draft' | 'battle' | 'over';

export interface MatchRecord {
  id: string;
  mode: 'ai' | 'friend';
  difficulty: Difficulty;
  createdAt: number;
  updatedAt: number;
  /** last time a move was made (friend matches can claim a win from an idle rival) */
  actedAt: number;
  seats: [SeatRec, SeatRec | null];
  phase: MatchPhase;
  /** secret until the match is over; only its hash goes onchain at create_match */
  salt: string;
  saltHash: string;
  /** the contract's VRF draw (hex), once create_match has landed */
  vrf: string | null;
  /** sha256(kraterra|seed|vrf|salt): secret until the end */
  seed: string | null;
  state: WireState | null;
  result: { winner: number | null; scores: number[]; reason: 'score' | 'resign' | 'timeout'; stateHash?: string } | null;
  lines: SignedLine[];
  chain: {
    /** false when chain writes are off, or create_match failed and the match fell back to a local draw */
    on: boolean;
    created: boolean;
    settled: boolean;
    pending: ChainOp[];
    txs: { what: string; hash: string }[];
    error?: string;
    retry?: { n: number; msg: string };
  };
}

const dir = join(config.dataDir, 'matches');
mkdirSync(dir, { recursive: true });
const mem = new Map<string, MatchRecord>();

export const validId = (id: string): boolean => /^[a-z0-9]{4,12}$/.test(id);

export function saveMatch(m: MatchRecord): void {
  mem.set(m.id, m);
  const file = join(dir, `${m.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(m));
  renameSync(`${file}.tmp`, file);
}

export function loadMatch(id: string): MatchRecord | null {
  if (!validId(id)) return null;
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const m = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as MatchRecord;
    mem.set(id, m);
    return m;
  } catch { return null; }
}

export function allMatches(): MatchRecord[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => loadMatch(f.slice(0, -5))).filter((m): m is MatchRecord => !!m);
}
