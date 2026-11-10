import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PICKS, SHOTS, THEME_NAMES, aiPick, applyMove, cloneState, encodeGrid, fromWire, parseMove, previewDrive, rngFrom, shotText, weapon, type State,
} from '@kraterra/rules';
import { api, getName, getSeat, putSeat, setName, watch, type MatchView } from './api.ts';
import { AimPanel, WeaponCard, WeaponIcon, WindBadge, type Aim } from './Controls.tsx';
import { SEAT_COLOR, type Battlefield } from './scene.ts';
import { sfx, startWind, stopWind, windLevel } from './sound.ts';

// One match on screen. The server's view arrives over a websocket; each new move is re-run locally
// with packages/rules to animate it (the same code the server and `pnpm verify` run), then the
// server's state is adopted.

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const short = (h: string | null | undefined): string => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : '…');

export function Match({ id, bf, onHome, onRematch }: { id: string; bf: Battlefield; onHome: () => void; onRematch: (mode: 'ai' | 'friend', difficulty: string) => void }) {
  const [seat, setSeat] = useState(() => getSeat(id));
  const [view, setView] = useState<MatchView | null>(null);
  const [shown, setShown] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aim, setAim] = useState<Aim>({ angle: 45, power: 60, move: 0, slot: 0 });
  const [sending, setSending] = useState(false);
  const [lastLine, setLastLine] = useState<{ text: string; signed: boolean } | null>(null);
  const cur = useRef<State | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lines = useRef(0);
  const me = view?.you ?? seat?.seat ?? null;

  /** Bring the scene up to a new server view, animating each new move. */
  const ingest = useCallback((v: MatchView) => {
    queue.current = queue.current.then(async () => {
      setView(v);
      if (v.lines.length > lines.current) {
        const l = v.lines[v.lines.length - 1];
        lines.current = v.lines.length;
        setLastLine(l);
        setTimeout(() => setLastLine((x) => (x === l ? null : x)), 6000);
      }
      if (!v.state) return;
      const target = fromWire(v.state);
      const c = cur.current;
      const behind = c ? target.moves.length - c.moves.length : -1;
      const shotsBehind = c ? target.moves.slice(c.moves.length).filter((m) => m[0] === 's').length : 0;
      if (!c || c.matchId !== target.matchId || behind < 0 || shotsBehind > 1) {
        bf.setWorld(target);
        if (!c) bf.overview();
      } else if (behind > 0) {
        setBusy(true);
        for (let k = c.moves.length; k < target.moves.length; k++) {
          const ev = applyMove(c, target.moves[k]);
          if (target.moves[k][0] === 's') await bf.play(ev); else sfx('pick', k);
        }
        if (encodeGrid(c.grid) !== encodeGrid(target.grid)) bf.setWorld(target); else bf.setTanks(target);
        setBusy(false);
      }
      cur.current = cloneState(target);
      setShown(target);
    });
  }, [bf]);

  useEffect(() => {
    let alive = true;
    void api<MatchView>(`/matches/${id}`, undefined, seat?.token).then((v) => { if (alive) ingest(v); }).catch((e) => setErr((e as Error).message));
    const stop = watch(id, seat?.token, ingest);
    return () => { alive = false; stop(); };
  }, [id, seat, ingest]);

  useEffect(() => {
    bf.me = me;
    startWind();
    return () => { bf.me = null; bf.onAim = null; bf.setGhost(null, 0); bf.setGuide(null); stopWind(); };
  }, [bf, me]);

  const s = shown;
  const synced = !!(s && view?.state && s.moves.length === fromWire(view.state).moves.length);
  const myTurn = !!(s && view && me !== null && view.turn === me && synced && !busy && view.phase !== 'over');
  const inBattle = s?.phase === 'battle';

  // a fresh aim at the start of each of my turns
  const turnKey = s ? s.moves.length : -1;
  useEffect(() => {
    if (!s || me === null || !inBattle || !myTurn) return;
    const t = s.tanks[me];
    const slot = Math.max(0, s.used[me].findIndex((u) => !u));
    setAim({ angle: t.angle, power: t.power, move: 0, slot });
    sfx('turn');
    const dir = s.tanks[1 - me].x > t.x ? 1 : -1;
    if (window.innerWidth < window.innerHeight) bf.focusOn(t.x + dir * 30, t.y + 18);
  }, [turnKey, myTurn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (s) windLevel(Math.abs(s.wind) / 10); }, [s]);

  // the barrel and the planned drive follow the aim
  useEffect(() => {
    if (!s || me === null || !myTurn || !inBattle) { bf.onAim = null; bf.setGhost(null, 0); return; }
    bf.onAim = (a) => setAim((x) => ({ ...x, angle: a.angle, power: a.power }));
    bf.setBarrel(me, aim.angle);
    bf.setGhost(aim.move ? previewDrive(s, me, aim.move) : null, aim.angle);
  }, [bf, s, me, myTurn, inBattle, aim]);

  const send = async (text: string): Promise<void> => {
    if (!seat) return;
    setSending(true);
    setErr(null);
    try { ingest(await api<MatchView>(`/matches/${id}/move`, { text }, seat.token)); } catch (e) { setErr((e as Error).message); } finally { setSending(false); }
  };
  const fire = (): void => { if (s && me !== null) { bf.setGhost(null, 0); void send(shotText(aim.slot, aim.angle, aim.power, aim.move)); } };

  if (err && !view) return <div className="hud"><div className="center card"><p className="err">{err}</p><button onClick={onHome}>Home</button></div></div>;
  if (!view) return <div className="hud"><div className="center card"><p>Loading the battlefield…</p></div></div>;

  const names = view.seats.map((x) => x?.name ?? 'waiting…');
  const scores = s ? s.tanks.map((t) => t.score) : [0, 0];
  const shotN = s ? Math.max(0, s.moves.length - PICKS) : 0;
  const rival = me === null ? null : 1 - me;

  return (
    <div className="hud">
      <div className="top-hud card">
        <div className="vs">
          <span className="who" style={{ color: hex(SEAT_COLOR[0]) }}>{names[0]}{me === 0 ? ' (you)' : ''}</span>
          <b className="score">{scores[0]}</b><span className="sep">–</span><b className="score">{scores[1]}</b>
          <span className="who" style={{ color: hex(SEAT_COLOR[1]) }}>{names[1]}{me === 1 ? ' (you)' : ''}</span>
        </div>
        <div className="meta">
          {s && <span>{THEME_NAMES[s.theme]}</span>}
          {s?.phase === 'draft' && <span>Draft {Math.min(PICKS, s.moves.length + 1)}/{PICKS}</span>}
          {inBattle && <span>Shot {Math.min(SHOTS, shotN + 1)}/{SHOTS}</span>}
          {inBattle && <WindBadge wind={s!.wind} />}
          {view.mode === 'ai' && <span className="dim">Basalt · {view.difficulty}</span>}
        </div>
      </div>

      {lastLine && <div className="bubble card"><b>Basalt</b> {lastLine.text}{lastLine.signed && <small title="signed by the NEAR AI enclave"> ✓ NEAR AI</small>}</div>}

      {view.phase === 'lobby' && <Lobby view={view} seat={seat} onJoined={(st) => { putSeat(id, st.seat, st.token); setSeat(st); }} />}
      {view.phase === 'drawing' && <Drawing view={view} />}
      {view.phase === 'draft' && s && <Draft s={s} view={view} me={me} myTurn={myTurn} sending={sending} onPick={(t) => void send(t)} />}

      {inBattle && view.phase !== 'over' && (myTurn
        ? <AimPanel aim={aim} setAim={setAim} inv={s!.inv[me!]} used={s!.used[me!]} fuel={s!.tanks[me!].fuel} wind={s!.wind} onFire={fire} busy={sending} hint={shotN === 0 ? 'Your turn. Drag from your tank or use the sliders, then FIRE.' : null} />
        : <Waiting view={view} me={me} busy={busy} seat={seat} />)}

      {view.phase === 'over' && !busy && synced && <Results view={view} s={s} me={me} onHome={onHome} onRematch={() => onRematch(view.mode, view.difficulty)} />}

      {err && view && <div className="toast err" onClick={() => setErr(null)}>{err}</div>}
      {view.phase !== 'over' && me !== null && rival !== null && (
        <button className="ghost small resign" onClick={() => { if (confirm('Resign this match? Your rival wins.')) void api(`/matches/${id}/resign`, {}, seat?.token).catch((e) => setErr((e as Error).message)); }}>Resign</button>
      )}
    </div>
  );
}

function Lobby({ view, seat, onJoined }: { view: MatchView; seat: { seat: number; token: string } | null; onJoined: (s: { seat: number; token: string }) => void }) {
  const link = `${location.origin}/m/${view.id}`;
  const [name, setNm] = useState(getName());
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!seat) {
    return (
      <div className="center card">
        <h2>{view.seats[0].name} challenges you</h2>
        <p className="dim">A turn-based artillery duel on a voxel battlefield. No wallet needed.</p>
        <div className="row"><input value={name} onChange={(e) => setNm(e.target.value)} placeholder="Your name" maxLength={20} /><button onClick={() => {
          setName(name);
          void api<{ seat: number; token: string }>(`/matches/${view.id}/join`, { name }).then(onJoined).catch((e) => setErr((e as Error).message));
        }}>Accept the duel</button></div>
        {err && <p className="err">{err}</p>}
      </div>
    );
  }
  return (
    <div className="center card">
      <h2>Challenge a friend</h2>
      <p>Send this link, or the room code. The duel starts when they open it.</p>
      <div className="code">{view.id.toUpperCase()}</div>
      <div className="row"><input readOnly value={link} onFocus={(e) => e.target.select()} />
        <button onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy link'}</button>
        {'share' in navigator && <button className="ghost" onClick={() => void navigator.share({ title: 'Kraterra duel', text: 'Duel me in Kraterra', url: link }).catch(() => undefined)}>Share</button>}
      </div>
      <p className="dim small">Waiting for your friend…</p>
    </div>
  );
}

function Drawing({ view }: { view: MatchView }) {
  const create = view.chain.txs.find((t) => t.what.startsWith('create_match'));
  return (
    <div className="center card drawing">
      <h2>Drawing the battlefield</h2>
      <ol className="chainsteps">
        <li className="done">Salt hash committed: <code>{short(view.saltHash)}</code></li>
        <li className={view.vrf ? 'done' : 'on'}>{view.chain.enabled ? 'NEAR contract draws a VRF seed in a later block' : 'Offline mode: a local random draw'}{create && <> · <a href={create.url} target="_blank" rel="noreferrer">tx</a></>}</li>
        <li>Terrain, munition pool and wind = sha256(vrf | salt)</li>
      </ol>
      <div className="spinner" aria-hidden="true" />
    </div>
  );
}

function Draft({ s, view, me, myTurn, sending, onPick }: { s: State; view: MatchView; me: number | null; myTurn: boolean; sending: boolean; onPick: (text: string) => void }) {
  const takenBy = useMemo(() => {
    const t: (number | null)[] = s.pool.map(() => null);
    s.moves.forEach((m, k) => { const p = parseMove(m); if (p?.t === 'pick') t[p.pool] = k % 2; });
    return t;
  }, [s]);
  const mine = me ?? 0;
  const names = view.seats.map((x) => x?.name ?? '');
  const turnName = names[s.moves.length % 2];
  return (
    <div className="draft card" onPointerDown={(e) => e.stopPropagation()}>
      <div className="draft-head">
        <b>The draft</b>
        <span className={myTurn ? 'go' : 'dim'}>{myTurn ? 'Your pick' : `${turnName} is picking…`}</span>
        <span className="grow" />
        {myTurn && <button className="ghost small" disabled={sending} onClick={() => onPick(aiPick(s, mine, 'hard', rngFrom(String(Math.random()))))}>Pick for me</button>}
      </div>
      <p className="dim small">Take turns until you each hold 10. Every munition fires once. Tap a card.</p>
      {me !== null && s.seats[me].rares.length > 0 && (
        <>
          <div className="draft-label">Your NFT packs</div>
          <div className="wgrid rares">
            {s.seats[me].rares.map((id, i) => <WeaponCard key={i} id={id} taken={s.rareUsed[me][i] ? 'yours' : null} disabled={!myTurn || sending} onClick={() => onPick(`r${i}`)} />)}
          </div>
        </>
      )}
      <div className="draft-label">The pool</div>
      <div className="wgrid">
        {s.pool.map((id, i) => <WeaponCard key={i} id={id} taken={takenBy[i] === null ? null : takenBy[i] === me ? 'yours' : names[takenBy[i]!]} disabled={!myTurn || sending} onClick={() => onPick(`p${i}`)} />)}
      </div>
      <div className="invs">
        {[0, 1].map((k) => (
          <div key={k} className="inv"><small style={{ color: hex(SEAT_COLOR[k]) }}>{names[k]}{k === me ? ' (you)' : ''}</small>
            <div className="slots">{Array.from({ length: 10 }, (_, i) => <span key={i} className="slot">{s.inv[k][i] !== undefined && <WeaponIcon id={s.inv[k][i]} size={22} />}</span>)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Waiting({ view, me, busy, seat }: { view: MatchView; me: number | null; busy: boolean; seat: { seat: number; token: string } | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const turn = view.turn;
  const name = turn === null ? '' : view.seats[turn]?.name;
  const canClaim = view.claimAfter !== null && me !== null && turn !== me && now > view.claimAfter;
  return (
    <div className="status-bar card">
      {busy ? <span>…</span> : me === null ? <span>Watching: {name}’s turn</span> : turn === me ? <span>Your turn…</span> : <span>{view.mode === 'ai' ? 'Basalt is aiming…' : `${name} is aiming…`}</span>}
      {canClaim && <button className="small" onClick={() => void api(`/matches/${view.id}/claim`, {}, seat?.token)}>{name} is idle: claim the win</button>}
    </div>
  );
}

function Results({ view, s, me, onHome, onRematch }: { view: MatchView; s: State | null; me: number | null; onHome: () => void; onRematch: () => void }) {
  const r = view.result;
  const [open, setOpen] = useState(false);
  const played = useRef(false);
  const won = r && me !== null && r.winner === me;
  useEffect(() => {
    if (played.current || !r) return;
    played.current = true;
    sfx(r.winner === null ? 'turn' : won ? 'win' : 'lose');
  }, [r, won]);
  if (!r) return null;
  const names = view.seats.map((x) => x?.name ?? '');
  const title = r.winner === null ? 'A draw' : me === null ? `${names[r.winner]} wins` : won ? 'Victory' : 'Defeat';
  const plays = view.chain.txs.filter((t) => t.what.startsWith('play'));
  return (
    <div className="center card results" onPointerDown={(e) => e.stopPropagation()}>
      <h2 className={won ? 'win' : ''}>{title}</h2>
      <p className="big">{names[0]} <b>{r.scores[0]}</b> – <b>{r.scores[1]}</b> {names[1]}</p>
      {r.reason !== 'score' && <p className="dim">{r.reason === 'timeout' ? 'Won on time: the rival went idle.' : 'Won by resignation.'}</p>}
      {s && <p className="dim small">{THEME_NAMES[s.theme]} · {s.moves.filter((m) => m[0] === 's').length} shots</p>}
      <div className="onchain">
        {!view.chain.enabled ? <p className="dim">Offline mode: nothing was written onchain.</p>
          : !view.chain.on ? <p className="err small">Not onchain: {view.chain.error}</p>
          : view.chain.settled ? <p className="ok">✓ Settled onchain: the contract checked the revealed salt, redrew the pool and checked all {s?.moves.length ?? 0} moves.</p>
          : <p className="dim">Recording onchain… {view.chain.queued} queued{view.chain.retrying ? ` (${view.chain.retrying})` : ''}</p>}
        <button className="linkish" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {view.chain.txs.length} transactions</button>
        {open && (
          <ul className="txs">
            {view.chain.txs.filter((t) => !t.what.startsWith('play')).map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}
            {plays.length > 0 && <li>{plays.length} × play: {plays.slice(0, 6).map((t, i) => <a key={t.hash} href={t.url} target="_blank" rel="noreferrer">{i ? ' · ' : ''}{t.what.includes('Basalt') ? 'Basalt' : 'move'}</a>)}{plays.length > 6 ? ' …' : ''}</li>}
          </ul>
        )}
        <p className="small">Check it yourself, no keys: <code>pnpm verify {view.id}{location.hostname === 'localhost' ? '' : ` --host ${location.origin}`}</code> · <a href={`/api/matches/${view.id}/proof`} target="_blank" rel="noreferrer">proof bundle (JSON)</a></p>
        {view.salt && <p className="tiny dim">salt {short(view.salt)} · vrf {short(view.vrf)} · seed {short(view.seed)}</p>}
      </div>
      <div className="row center-row">
        <button onClick={onRematch}>{view.mode === 'ai' ? 'Duel Basalt again' : 'New challenge'}</button>
        <button className="ghost" onClick={onHome}>Home</button>
      </div>
      {s && me !== null && <p className="tiny dim">Your arsenal: {s.inv[me].map((id) => weapon(id).name).join(', ')}</p>}
    </div>
  );
}
