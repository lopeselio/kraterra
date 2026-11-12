import type { Difficulty, WireState } from '@kraterra/rules';

// Server API (same origin). The wallet session is Better Auth's HttpOnly cookie; a seat in a match is
// a random token this browser keeps (localStorage), sent as x-seat-token.

export async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-seat-token'] = token;
  const res = await fetch(`/api${path}`, body === undefined ? { headers, credentials: 'same-origin' } : { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface ServerConfig { network: string; contract: string; referee: string; chain: boolean; relayer: string | null; nearAi: boolean; ai: string | null }
export interface PackToken { token_id: string; owner_id: string; metadata: { title: string; description: string; media: string; extra: string } }
export interface Stats { matches: number; wins: number; losses: number; draws: number; best: number; damage: number }
export interface Me { accountId: string | null; packs: PackToken[]; starter: boolean; stats: Stats | null }
export interface SeatView { kind: 'account' | 'guest' | 'ai'; name: string; account: string | null; packs: string[]; kinds: number[] }
export interface MatchView {
  id: string; mode: 'ai' | 'friend'; difficulty: Difficulty; you: number | null;
  phase: 'lobby' | 'drawing' | 'draft' | 'battle' | 'over'; createdAt: number;
  seats: [SeatView, SeatView | null]; state: WireState | null; turn: number | null;
  result: { winner: number | null; scores: number[]; reason: 'score' | 'resign' | 'timeout' } | null;
  idleSince: number; claimAfter: number | null;
  saltHash: string; vrf: string | null; salt: string | null; seed: string | null;
  lines: { who: string; text: string; signed: boolean }[];
  chain: { on: boolean; enabled: boolean; contract: string; created: boolean; settled: boolean; queued: number; error: string | null; retrying: string | null; txs: { what: string; hash: string; url: string }[] };
}
export interface Summary { id: string; mode: string; difficulty: string; phase: string; updatedAt: number; names: (string | null)[]; scores: number[]; winner: number | null; settled: boolean }

export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;

// ---------- this browser's seats and preferences ----------

const SEATS = 'kraterra:seats';
export function getSeat(id: string): { seat: number; token: string } | null {
  try { return (JSON.parse(localStorage.getItem(SEATS) ?? '{}') as Record<string, { seat: number; token: string }>)[id] ?? null; } catch { return null; }
}
export function putSeat(id: string, seat: number, token: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(SEATS) ?? '{}') as Record<string, unknown>;
    all[id] = { seat, token };
    localStorage.setItem(SEATS, JSON.stringify(all));
  } catch { /* private mode: this tab still works */ }
}
const pref = (k: string, d: string): string => { try { return localStorage.getItem(`kraterra:${k}`) ?? d; } catch { return d; } };
const setPref = (k: string, v: string): void => { try { localStorage.setItem(`kraterra:${k}`, v); } catch { /* fine */ } };
export const getName = (): string => pref('name', '');
export const setName = (n: string): void => setPref('name', n);
export const getDifficulty = (): Difficulty => { const d = pref('difficulty', 'easy'); return d === 'normal' || d === 'hard' ? d : 'easy'; };
export const setDifficulty = (d: Difficulty): void => setPref('difficulty', d);
export const onboarded = (): { walked: boolean; practiced: boolean } => ({ walked: pref('walked', '') === '1', practiced: pref('practiced', '') === '1' });
export const setWalked = (): void => setPref('walked', '1');
export const setPracticed = (): void => setPref('practiced', '1');

/** Live pushes for one match. Reconnects on drop. */
export function watch(id: string, token: string | undefined, onMatch: (m: MatchView) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const open = (): void => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => ws?.send(JSON.stringify({ t: 'watch', id, token }));
    ws.onmessage = (e) => { try { const m = JSON.parse(String(e.data)) as { t: string; match: MatchView }; if (m.t === 'match') onMatch(m.match); } catch { /* ignore */ } };
    ws.onclose = () => { if (!closed) setTimeout(open, 1500); };
  };
  open();
  return () => { closed = true; ws?.close(); };
}
