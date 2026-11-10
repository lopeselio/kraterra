import { useCallback, useEffect, useRef, useState } from 'react';
import { aiPick, aiShot, applyMove, createState, rngFrom, sha256Hex, whoseTurn, windFor, type Difficulty, type State } from '@kraterra/rules';
import {
  api, explorerAccount, getDifficulty, getName, onboarded, putSeat, setDifficulty, setName, setPracticed, setWalked,
  type Me, type ServerConfig, type Summary,
} from './api.ts';
import { Match } from './Match.tsx';
import { Practice } from './Practice.tsx';
import { Battlefield } from './scene.ts';
import { isMuted, setMuted, unlockAudio } from './sound.ts';
import { HowToPlay, Walkthrough } from './Walkthrough.tsx';
import { call, setContract, signIn, signOut } from './wallet.ts';

// The shell: one three.js battlefield behind everything; the title screen, the practice range and
// matches on top. Routes: / (title), /practice, /m/<id> (a match; the link you send a friend).

type Route = { at: 'title' } | { at: 'practice' } | { at: 'match'; id: string };
const parse = (): Route => {
  const m = /^\/m\/([a-z0-9]{4,12})\/?$/i.exec(location.pathname);
  if (m) return { at: 'match', id: m[1].toLowerCase() };
  if (location.pathname.startsWith('/practice')) return { at: 'practice' };
  return { at: 'title' };
};

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [bf, setBf] = useState<Battlefield | null>(null);
  const [route, setRoute] = useState<Route>(parse);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [mute, setMute] = useState(isMuted());
  const [help, setHelp] = useState(false);
  const [walk, setWalk] = useState(false);
  /** what to do once the first-run walkthrough and practice are done */
  const after = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const b = new Battlefield(host.current);
    setBf(b);
    return () => b.dispose();
  }, []);

  useEffect(() => {
    void api<ServerConfig>('/config').then((c) => { setCfg(c); setContract(c.contract); }).catch(() => undefined);
    void api<Me>('/me').then((m) => setAccount(m.accountId)).catch(() => setAccount(null));
    const pop = (): void => setRoute(parse());
    window.addEventListener('popstate', pop);
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') { const m = !isMuted(); setMuted(m); setMute(m); }
      if (e.key === '?') setHelp(true);
    };
    window.addEventListener('keydown', key);
    const unlock = (): void => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('keydown', key); };
  }, []);

  const go = useCallback((r: Route) => {
    history.pushState(null, '', r.at === 'match' ? `/m/${r.id}` : r.at === 'practice' ? '/practice' : '/');
    setRoute(r);
  }, []);

  const startMatch = useCallback(async (mode: 'ai' | 'friend', difficulty: string) => {
    const r = await api<{ id: string; seat: number; token: string }>('/matches', { mode, difficulty, name: getName() || 'Gunner' });
    putSeat(r.id, r.seat, r.token);
    go({ at: 'match', id: r.id });
  }, [go]);

  /** First-run gate: walkthrough, then the practice range, then whatever the player asked for. */
  const firstRun = useCallback((then: () => void) => {
    const o = onboarded();
    if (o.walked && o.practiced) { then(); return; }
    after.current = then;
    if (!o.walked) setWalk(true); else go({ at: 'practice' });
  }, [go]);

  return (
    <>
      <div ref={host} className="field" />
      <header className="topbar">
        <a className="logo" href="/" onClick={(e) => { e.preventDefault(); go({ at: 'title' }); }}>KRATERRA</a>
        <span className="grow" />
        <button className="ghost small" onClick={() => setHelp(true)} title="How to play (?)">? <span className="wide-only">How to play</span></button>
        <button className="ghost small" onClick={() => { const m = !mute; setMuted(m); setMute(m); }} title="Sound (M)" aria-label="Sound">{mute ? '🔇' : '🔊'}</button>
        <Account account={account} setAccount={setAccount} />
      </header>
      {bf && route.at === 'title' && (
        <Title bf={bf} cfg={cfg} account={account}
          onPlay={(d) => firstRun(() => void startMatch('ai', d))}
          onFriend={() => firstRun(() => void startMatch('friend', 'normal'))}
          onJoin={(code) => go({ at: 'match', id: code.toLowerCase() })}
          onPractice={() => go({ at: 'practice' })}
          onTour={() => { after.current = null; setWalk(true); }} />
      )}
      {bf && route.at === 'practice' && (
        <Practice bf={bf}
          onExit={() => { setPracticed(); go({ at: 'title' }); }}
          onPlay={() => { setPracticed(); const then = after.current; after.current = null; if (then) then(); else void startMatch('ai', 'easy'); }} />
      )}
      {bf && route.at === 'match' && (
        <Match key={route.id} id={route.id} bf={bf} onHome={() => go({ at: 'title' })} onRematch={(mode, d) => void startMatch(mode, d)} />
      )}
      {walk && (
        <Walkthrough
          onDone={() => { setWalked(); setWalk(false); const then = after.current; if (then) { after.current = null; then(); } }}
          onPractice={() => { setWalked(); setWalk(false); go({ at: 'practice' }); }} />
      )}
      {help && <HowToPlay onClose={() => setHelp(false)} onWalkthrough={() => { setHelp(false); setWalk(true); }} onPractice={() => { setHelp(false); go({ at: 'practice' }); }} />}
    </>
  );
}

function Account({ account, setAccount }: { account: string | null; setAccount: (a: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (account) {
    return (
      <span className="acct">
        <a href={explorerAccount(account)} target="_blank" rel="noreferrer" title={account}>{account.length > 22 ? `${account.slice(0, 20)}…` : account}</a>
        <button className="ghost small" onClick={() => { void signOut().then(() => setAccount(null)); }}>Sign out</button>
      </span>
    );
  }
  return (
    <span className="acct">
      {err && <span className="err small" title={err}>!</span>}
      <button className="small" disabled={busy} onClick={() => { setBusy(true); setErr(null); void signIn().then(setAccount).catch((e) => setErr((e as Error).message)).finally(() => setBusy(false)); }}>{busy ? 'Signing in…' : 'Sign in with NEAR'}</button>
    </span>
  );
}

/** Attract mode: Basalt duels itself behind the title screen. */
function useDemo(bf: Battlefield): void {
  useEffect(() => {
    let alive = true;
    let round = 0;
    const run = async (): Promise<void> => {
      while (alive) {
        const seed = sha256Hex(`kraterra|title|${round++ % 7}`);
        const s: State = createState({ matchId: 'title', seed, rules: 1, seats: [{ name: 'A', rares: [] }, { name: 'B', rares: [12] }] });
        const r = rngFrom(seed);
        while (s.phase === 'draft') { applyMove(s, aiPick(s, whoseTurn(s)!, 'hard', r)); }
        bf.setWorld(s);
        bf.overview(14);
        for (let k = 0; k < 8 && alive; k++) {
          s.wind = windFor(seed, k);
          const seat = whoseTurn(s)!;
          const ev = applyMove(s, aiShot(s, seat, 'normal', r));
          await new Promise((res) => setTimeout(res, 900));
          if (!alive) return;
          await bf.play(ev);
        }
      }
    };
    void run();
    return () => { alive = false; };
  }, [bf]);
}

function Title({ bf, cfg, account, onPlay, onFriend, onJoin, onPractice, onTour }: {
  bf: Battlefield; cfg: ServerConfig | null; account: string | null;
  onPlay: (d: Difficulty) => void; onFriend: () => void; onJoin: (code: string) => void; onPractice: () => void; onTour: () => void;
}) {
  useDemo(bf);
  const [name, setNm] = useState(getName());
  const [diff, setDiff] = useState<Difficulty>(getDifficulty());
  const [code, setCode] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [board, setBoard] = useState<[string, { wins: number; matches: number; damage: number }][]>([]);
  const [recent, setRecent] = useState<Summary[]>([]);
  const [claim, setClaim] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const fresh = !onboarded().walked;

  const loadMe = useCallback(() => { if (account) void api<Me>('/me').then(setMe).catch(() => setMe(null)); else setMe(null); }, [account]);
  useEffect(loadMe, [loadMe]);
  useEffect(() => {
    void api<typeof board>('/leaderboard').then(setBoard).catch(() => undefined);
    void api<Summary[]>('/recent').then(setRecent).catch(() => undefined);
  }, []);
  const saveName = (n: string): void => { setNm(n); setName(n); };

  const claimStarter = async (): Promise<void> => {
    setClaim({ busy: true, msg: null });
    try {
      const r = await call('mint_starter', {});
      setClaim({ busy: false, msg: r.gasless ? 'Claimed, gasless (paid by our relayer).' : 'Claimed.' });
      setTimeout(loadMe, 2500);
    } catch (e) { setClaim({ busy: false, msg: (e as Error).message }); }
  };

  return (
    <div className="title">
      <section className="hero">
        <h1>KRATERRA</h1>
        <p>A turn-based artillery duel in destructible voxel ground. Draft your arsenal, read the wind, carve the hills. The battlefield is drawn from NEAR’s VRF; every shot is recorded onchain.</p>
        {fresh && <button className="ghost tour" onClick={onTour}>New here? See how it works (1 min)</button>}
      </section>

      <section className="panel play">
        <label className="name">Your name <input value={name} onChange={(e) => saveName(e.target.value)} placeholder="Gunner" maxLength={20} /></label>
        <div className="playrow">
          <button className="primary" onClick={() => onPlay(diff)}>Duel Basalt</button>
          <div className="seg" role="radiogroup" aria-label="Difficulty">
            {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
              <button key={d} role="radio" aria-checked={diff === d} className={diff === d ? 'on' : ''} onClick={() => { setDiff(d); setDifficulty(d); }}>{d}</button>
            ))}
          </div>
        </div>
        <p className="dim small">Basalt is the AI tank: it aims with the same physics you do, and its hand shakes less on harder levels.</p>
        <div className="playrow">
          <button onClick={onFriend}>Challenge a friend</button>
          <form className="join" onSubmit={(e) => { e.preventDefault(); if (/^[a-z0-9]{4,12}$/i.test(code.trim())) onJoin(code.trim()); }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Room code" maxLength={12} aria-label="Room code" />
            <button className="ghost">Join</button>
          </form>
        </div>
        <div className="playrow">
          <button className="ghost" onClick={onPractice}>Practice range</button>
          <button className="ghost" onClick={onTour}>Walkthrough</button>
        </div>
      </section>

      <section className="panel">
        <h2>Munition packs</h2>
        {!account ? (
          <p className="dim">Guests play everything. <b>Sign in with NEAR</b> (top right) to claim a free starter pack: an NFT in your wallet that adds a rare munition (Starfall, Tidebreaker or Auger) to your draft, and to keep your record onchain.</p>
        ) : (
          <>
            {me && me.packs.length > 0 && (
              <div className="packs">
                {me.packs.map((p) => <figure key={p.token_id}><img src={p.metadata.media} alt="" width={72} height={72} /><figcaption>{p.metadata.title}<small>{p.token_id}</small></figcaption></figure>)}
              </div>
            )}
            {me && !me.starter && <button disabled={claim.busy || !cfg?.chain} onClick={() => void claimStarter()}>{claim.busy ? 'Waiting for your wallet…' : 'Claim your starter pack (free, gasless)'}</button>}
            {me && me.packs.length === 0 && me.starter && <p className="dim small">Your starter pack has moved to another wallet.</p>}
            {claim.msg && <p className="small">{claim.msg}</p>}
            {me?.stats && <p className="small">Your record: {me.stats.matches} duels, {me.stats.wins} wins, best score {me.stats.best}, {me.stats.damage} damage dealt.</p>}
          </>
        )}
      </section>

      <div className="twocol">
        <section className="panel">
          <h2>Leaderboard</h2>
          {board.length === 0 ? <p className="dim small">No signed-in duels yet.</p> : (
            <table className="ledger"><tbody>{board.slice(0, 10).map(([a, st], i) => <tr key={a}><td>{i + 1}</td><td><a href={explorerAccount(a)} target="_blank" rel="noreferrer">{a.length > 24 ? `${a.slice(0, 22)}…` : a}</a></td><td>{st.wins}W</td><td className="dim">{st.damage} dmg</td></tr>)}</tbody></table>
          )}
        </section>
        <section className="panel">
          <h2>Recent duels</h2>
          {recent.length === 0 ? <p className="dim small">None yet.</p> : (
            <ul className="recent">{recent.slice(0, 6).map((m) => (
              <li key={m.id}><a href={`/m/${m.id}`}>{m.names[0]} <b>{m.scores[0]}–{m.scores[1]}</b> {m.names[1]}</a> <small className="dim">{m.settled ? '✓ settled' : '…'} · <code>{m.id}</code></small></li>
            ))}</ul>
          )}
        </section>
      </div>
      <footer className="foot">
        {cfg && <>Contract <a href={explorerAccount(cfg.contract)} target="_blank" rel="noreferrer">{cfg.contract}</a>{cfg.ai && <> · Basalt <a href={explorerAccount(cfg.ai)} target="_blank" rel="noreferrer">{cfg.ai}</a></>} · NEAR testnet{!cfg.chain && ' · offline mode'} · </>}
        <a href="https://github.com/lopeselio/kraterra" target="_blank" rel="noreferrer">source</a>
      </footer>
    </div>
  );
}
