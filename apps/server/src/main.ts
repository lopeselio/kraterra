import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { AI_ACCOUNT } from './ai-account.ts';
import { BA_PATH, accountFromHeaders, authHandler } from './ba.ts';
import { view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { claim, createMatch, joinMatch, move, onChange, proofBundle, publicView, resign, resume, seatOf, summary } from './matches.ts';
import { attestation, nearAiEnabled } from './nearai.ts';
import { allMatches, loadMatch, type MatchRecord } from './store.ts';

// ---------- tiny HTTP helpers ----------

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body<T>(req: IncomingMessage, max = 20_000): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(config.webDist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(config.webDist))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web app not built: pnpm build'); return; }
  const immutable = file.includes(`${join(config.webDist, 'assets')}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

// one change at a time per match
const locks = new Map<string, Promise<unknown>>();
function locked<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
  locks.set(id, run);
  void run.finally(() => { if (locks.get(id) === run) locks.delete(id); }).catch(() => undefined);
  return run;
}

// a brake on match creation per address (every match costs the referee gas)
const creates = new Map<string, number[]>();
function allowCreate(ip: string): boolean {
  const now = Date.now();
  const list = (creates.get(ip) ?? []).filter((t) => t > now - 3600_000);
  if (list.length >= 40) return false;
  list.push(now);
  creates.set(ip, list);
  return true;
}
const ipOf = (req: IncomingMessage): string => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

function matchAndSeat(req: IncomingMessage, id: string): { m: MatchRecord; seat: number | null } {
  const m = loadMatch(id);
  if (!m) throw Object.assign(new Error('no such match'), { code: 404 });
  return { m, seat: seatOf(m, String(req.headers['x-seat-token'] ?? '')) };
}
function mustSeat(seat: number | null): number {
  if (seat === null) throw Object.assign(new Error('you’re not playing in this match'), { code: 403 });
  return seat;
}

// small caches for chain views the title screen polls
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const post = req.method === 'POST';
  try {
    // wallet sign-in, sessions and the gasless relay: Better Auth + better-near-auth
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev' });
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/config') {
      return json(res, 200, {
        network: config.network, contract: config.contract, referee: config.referee, chain: config.chainEnabled,
        relayer: hasKey(config.relayer) ? config.relayer : null, nearAi: nearAiEnabled(), ai: hasKey(AI_ACCOUNT) ? AI_ACCOUNT : null,
      });
    }
    if (p === '/api/me') {
      if (!me) return json(res, 401, { error: 'not signed in' });
      const chain = config.chainEnabled;
      const [packs, starter, stats] = await Promise.all([
        chain ? view('nft_tokens_for_owner', { account_id: me, from_index: null, limit: 50 }).catch(() => []) : [],
        chain ? view<boolean>('has_starter', { account_id: me }).catch(() => false) : false,
        chain ? view('stats_of', { account_id: me }).catch(() => null) : null,
      ]);
      return json(res, 200, { accountId: me, packs, starter, stats });
    }
    if (p === '/api/leaderboard') return json(res, 200, config.chainEnabled ? await cached('board', 15000, () => view('leaderboard', { limit: 15 })).catch(() => []) : []);
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p === '/api/recent') {
      const done = allMatches().filter((m) => m.phase === 'over' && m.result?.reason === 'score').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
      return json(res, 200, done.map(summary));
    }
    if (p === '/api/matches' && post) {
      if (!allowCreate(ipOf(req))) return json(res, 429, { error: 'that’s a lot of duels: try again in a while' });
      const b = await body<{ mode?: string; difficulty?: string; name?: string }>(req);
      return json(res, 200, createMatch({ mode: b.mode === 'friend' ? 'friend' : 'ai', difficulty: b.difficulty, name: b.name, account: me }));
    }
    const mm = /^\/api\/matches\/([a-z0-9]{4,12})(?:\/(join|move|resign|claim|proof))?$/.exec(p);
    if (mm) {
      const [, id, action] = mm;
      if (!action) { const { m, seat } = matchAndSeat(req, id); return json(res, 200, publicView(m, seat)); }
      if (action === 'proof') return json(res, 200, proofBundle(matchAndSeat(req, id).m));
      if (!post) return json(res, 405, { error: 'POST only' });
      const b = await body<Record<string, unknown>>(req);
      const out = await locked(id, async () => {
        const { m, seat } = matchAndSeat(req, id);
        switch (action) {
          case 'join': return joinMatch(m, b.name, me);
          case 'move': move(m, mustSeat(seat), String(b.text ?? '')); break;
          case 'resign': resign(m, mustSeat(seat)); break;
          case 'claim': claim(m, mustSeat(seat)); break;
        }
        return publicView(m, seat);
      });
      return json(res, 200, out);
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    const code = (e as { code?: number }).code;
    json(res, typeof code === 'number' ? code : 400, { error: (e as Error).message });
  }
}

const server = createServer((req, res) => { void route(req, res); });

// ---------- websocket: live match pushes ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4_000, perMessageDeflate: { threshold: 1024 } });
const watchers = new Map<WebSocket, { id: string; seat: number | null }>();
wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw) => {
    let m: { t?: string; id?: string; token?: string };
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t !== 'watch') return;
    const g = loadMatch(String(m.id ?? ''));
    if (!g) return;
    const seat = seatOf(g, m.token);
    watchers.set(ws, { id: g.id, seat });
    ws.send(JSON.stringify({ t: 'match', match: publicView(g, seat) }));
  });
  ws.on('close', () => watchers.delete(ws));
});
onChange((g, ev) => {
  for (const [ws, w] of watchers) {
    if (w.id === g.id && ws.readyState === 1) ws.send(JSON.stringify({ t: 'match', match: publicView(g, w.seat), move: ev ? { seat: ev.seat, text: ev.text } : null }));
  }
});
setInterval(() => { for (const ws of watchers.keys()) if (ws.readyState === 1) ws.ping(); }, 25_000).unref();

server.listen(config.port, () => {
  console.log(`Kraterra on :${config.port} (contract ${config.contract}, chain ${config.chainEnabled ? 'on' : 'off'})`);
});
resume();
export { explorerTx };
