import { useEffect, useState, type ReactNode } from 'react';
import { WEAPONS } from '@kraterra/rules';
import { WeaponIcon } from './Controls.tsx';

// First run: a short illustrated walkthrough (six cards, drawn in inline SVG voxels), then the
// practice range. "How to play" reopens the same material as one sheet at any time (or "?").

export function Modal({ label, onClose, children, wide }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <div className="ob-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`ob-card${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

// ---------- the pictures ----------

const ground = (cols: number[], fill = '#67c24a', base = '#8d5b34'): ReactNode => cols.map((h, i) => (
  <g key={i}>
    <rect x={i * 10} y={120 - h} width={10} height={h} fill={base} />
    <rect x={i * 10} y={120 - h} width={10} height={4} fill={fill} />
  </g>
));
const tank = (x: number, y: number, color: string, angle: number, key?: string): ReactNode => {
  const a = (angle * Math.PI) / 180;
  return (
    <g key={key}>
      <rect x={x - 9} y={y - 5} width={18} height={5} fill="#26232b" />
      <rect x={x - 8} y={y - 11} width={16} height={6} fill={color} />
      <rect x={x - 5} y={y - 16} width={10} height={5} fill={color} opacity={0.75} />
      <line x1={x} y1={y - 14} x2={x + Math.cos(a) * 15} y2={y - 14 - Math.sin(a) * 15} stroke="#2a2a33" strokeWidth={3.5} />
    </g>
  );
};
const HILLS = [40, 42, 44, 44, 46, 50, 56, 62, 66, 64, 58, 52, 50, 52, 58, 62, 58, 52, 48, 46, 44, 44, 42, 42];

const ART: ReactNode[] = [
  // 1. the duel
  <svg viewBox="0 0 240 120" key="1">
    <rect width="240" height="120" fill="#8fd3ff" />
    {ground(HILLS)}
    {tank(25, 76, '#35d6c8', 40)}
    {tank(215, 76, '#ff8a3d', 140)}
    <path d="M37 58 Q 120 -10 196 64" stroke="#fff" strokeWidth="2" strokeDasharray="4 4" fill="none" />
    <rect x="193" y="60" width="6" height="6" fill="#ffb84a" />
  </svg>,
  // 2. aim, power, wind
  <svg viewBox="0 0 240 120" key="2">
    <rect width="240" height="120" fill="#7fc0f0" />
    {ground(HILLS.map((h) => Math.min(h, 48)))}
    {tank(40, 72, '#35d6c8', 50)}
    <path d="M40 58 L 40 26 A 32 32 0 0 1 61 33" stroke="#fff" strokeWidth="2" fill="none" />
    <text x="50" y="22" fill="#fff" fontSize="11" fontWeight="700">angle</text>
    <rect x="80" y="86" width="70" height="8" rx="4" fill="#1c2633" opacity=".55" /><rect x="80" y="86" width="48" height="8" rx="4" fill="#ffcf5a" />
    <text x="80" y="108" fill="#fff" fontSize="11" fontWeight="700">power</text>
    <g transform="translate(170 22)"><rect x="0" y="0" width="3" height="40" fill="#eee" /><path d="M3 2 L 40 8 L 3 16 Z" fill="#ff6a3c" /><text x="-4" y="54" fill="#fff" fontSize="11" fontWeight="700">wind ▶</text></g>
  </svg>,
  // 3. the draft
  <svg viewBox="0 0 240 120" key="3">
    <rect width="240" height="120" fill="#1d2633" />
    {WEAPONS.slice(0, 10).map((w, i) => (
      <g key={i} transform={`translate(${12 + (i % 5) * 44} ${14 + Math.floor(i / 5) * 46})`}>
        <rect width="38" height="38" rx="6" fill={w.color} opacity={i % 3 === 1 ? 0.35 : 1} />
        <rect x="4" y="4" width="30" height="5" fill="#fff" opacity=".35" />
        {i % 3 === 1 && <text x="19" y="25" textAnchor="middle" fontSize="10" fill={i % 2 ? '#ff8a3d' : '#35d6c8'} fontWeight="900">✓</text>}
      </g>
    ))}
    <text x="120" y="112" textAnchor="middle" fill="#cfe0ff" fontSize="10">you pick, they pick… 10 munitions each</text>
  </svg>,
  // 4. destruction
  <svg viewBox="0 0 240 120" key="4">
    <rect width="240" height="120" fill="#8fd3ff" />
    {ground(HILLS.map((h, i) => (i >= 9 && i <= 13 ? h - [12, 26, 32, 26, 12][i - 9] : h)))}
    <circle cx="115" cy="62" r="16" fill="#ffb84a" opacity=".5" />
    {tank(115, 94, '#ff8a3d', 150)}
    <path d="M115 64 L 115 86" stroke="#fff" strokeWidth="2" strokeDasharray="3 3" />
    <rect x="186" y="34" width="10" height="34" fill="#a9b0c2" /><text x="176" y="28" fill="#fff" fontSize="10" fontWeight="700">walls</text>
    <text x="16" y="24" fill="#fff" fontSize="10" fontWeight="700">craters, tunnels, mud</text>
  </svg>,
  // 5. scoring
  <svg viewBox="0 0 240 120" key="5">
    <rect width="240" height="120" fill="#24203a" />
    <text x="60" y="52" textAnchor="middle" fill="#35d6c8" fontSize="34" fontWeight="900">128</text>
    <text x="180" y="52" textAnchor="middle" fill="#ff8a3d" fontSize="34" fontWeight="900">97</text>
    <text x="120" y="48" textAnchor="middle" fill="#cfe0ff" fontSize="14">vs</text>
    <text x="120" y="78" textAnchor="middle" fill="#ffcf5a" fontSize="12" fontWeight="700">damage dealt = points</text>
    <text x="120" y="98" textAnchor="middle" fill="#cfe0ff" fontSize="10">10 shots each · hit yourself and your rival scores</text>
  </svg>,
  // 6. onchain
  <svg viewBox="0 0 240 120" key="6">
    <rect width="240" height="120" fill="#101722" />
    {['commit salt', 'NEAR VRF', 'every move', 'settle + check'].map((t, i) => (
      <g key={i} transform={`translate(${8 + i * 58} 34)`}>
        <rect width="50" height="38" rx="6" fill={['#35d6c8', '#c89bff', '#ffcf5a', '#6dffb0'][i]} />
        <text x="25" y="23" textAnchor="middle" fontSize="7.5" fontWeight="800" fill="#101722">{t}</text>
        {i < 3 && <text x="54" y="23" fill="#fff" fontSize="10">›</text>}
      </g>
    ))}
    <text x="120" y="98" textAnchor="middle" fill="#cfe0ff" fontSize="10">pnpm verify replays it all, no keys needed</text>
  </svg>,
];

const CARDS: { title: string; body: ReactNode }[] = [
  { title: 'Two tanks. One hill. Ten shells each.', body: <>Kraterra is a turn-based artillery duel on a voxel battlefield. Take turns lobbing shells over the terrain at your rival’s tank. Every hit scores the damage it does.</> },
  { title: 'Angle, power, wind', body: <>Set the barrel’s <b>angle</b> and the shot’s <b>power</b> (drag from your tank, or use the sliders). The <b>wind</b> changes every shot and pushes shells sideways for the whole flight: read the flag before you fire. You can also <b>drive</b> a few voxels (fuel is limited for the whole match).</> },
  { title: 'Draft your arsenal', body: <>Before the shooting, a pool of 20 munitions is drawn. You and your rival pick in turns until you each hold <b>10</b>. Each munition fires <b>once</b>, so the draft is half the game. Signed-in players can also draft rare munitions from the <b>NFT packs</b> in their wallet.</> },
  { title: 'The ground fights back', body: <>Explosions carve craters, tanks fall into them, the Mole tunnels through hills, Bulwark raises a wall, Mudslinger buries, Wildfire runs along the ground. Change the terrain to make your next shot easier, and theirs harder.</> },
  { title: 'Highest score wins', body: <>After 20 shots, whoever dealt the most damage wins. Careful: <b>damage to your own tank scores for your rival</b>. Duel Basalt the AI tank (Easy, Normal, Hard), or send a friend a room link.</> },
  { title: 'Nobody can rig the map', body: <>Our server commits a hash of a secret salt to the NEAR contract first; the contract then draws a random seed from <b>NEAR’s block VRF</b>. Terrain, pool and wind come from both. Every pick and shot is recorded onchain; at the end the salt is revealed, the contract checks the whole log, and <code>pnpm verify</code> replays the duel.</> },
];

export function Walkthrough({ onDone, onPractice }: { onDone: () => void; onPractice: () => void }) {
  const [i, setI] = useState(0);
  const c = CARDS[i];
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' && i < CARDS.length - 1) setI(i + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [i]);
  return (
    <Modal label="How Kraterra works" onClose={onDone}>
      <div className="ob-art">{ART[i]}</div>
      <div className="ob-step">{i + 1} / {CARDS.length}</div>
      <h2>{c.title}</h2>
      <p>{c.body}</p>
      <div className="ob-dots" aria-hidden="true">{CARDS.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>
      <div className="row ob-row">
        <button className="ghost" onClick={onDone}>Skip</button>
        <span className="grow" />
        {i > 0 && <button className="ghost" onClick={() => setI(i - 1)}>Back</button>}
        {i < CARDS.length - 1 ? <button autoFocus onClick={() => setI(i + 1)}>Next</button> : <button autoFocus onClick={onPractice}>Try the practice range</button>}
      </div>
    </Modal>
  );
}

export function HowToPlay({ onClose, onWalkthrough, onPractice }: { onClose: () => void; onWalkthrough: () => void; onPractice: () => void }) {
  return (
    <Modal label="How to play" onClose={onClose} wide>
      <h2>How to play</h2>
      <div className="ob-sheet">
        <section>
          <h3>The duel</h3>
          <ul>
            <li>A pool of 20 munitions is drawn; you pick in turns until you each hold 10. Each fires once.</li>
            <li>Then 20 shots, alternating (the player who picked second fires first). Score = damage dealt. Hurting yourself scores for your rival.</li>
            <li>Before a shot you may drive left or right; 40 fuel for the whole match.</li>
            <li>Wind changes every shot (−10 … +10) and pushes shells all the way.</li>
          </ul>
        </section>
        <section>
          <h3>Controls</h3>
          <ul>
            <li><b>Touch:</b> drag from your tank to aim (direction = angle, distance = power), or use the sliders and ± buttons. ◀ ▶ plans a drive. Tap the munition to change it. Drag elsewhere to pan, pinch to zoom.</li>
            <li><b>Desktop:</b> <kbd>←</kbd>/<kbd>→</kbd> angle, <kbd>↑</kbd>/<kbd>↓</kbd> power (<kbd>Shift</kbd> ×5), <kbd>A</kbd>/<kbd>D</kbd> drive, <kbd>1</kbd>–<kbd>0</kbd> munitions, <kbd>Space</kbd> fire. Drag from your tank to aim, drag elsewhere to pan, wheel to zoom.</li>
            <li><kbd>M</kbd> sound, <kbd>?</kbd> this sheet.</li>
          </ul>
        </section>
        <section>
          <h3>Munitions</h3>
          <div className="wlist">
            {WEAPONS.map((w) => (
              <div key={w.id} className="wrow"><WeaponIcon id={w.id} size={26} /><span><b>{w.name}</b>{w.rare ? <em> rare · NFT pack</em> : null}<small>{w.blurb}{w.dmg ? ` ${w.dmg} damage, radius ${w.r}.` : ''}</small></span></div>
            ))}
          </div>
        </section>
        <section>
          <h3>What goes onchain (NEAR testnet)</h3>
          <ul>
            <li><code>create_match</code>: the server commits <code>sha256(salt)</code> and your packs; the contract draws its VRF seed from the block in a later receipt.</li>
            <li>Terrain, pool and wind = <code>sha256(vrf | salt)</code>: neither player nor the server could choose them.</li>
            <li><code>play</code>: every pick and shot, in order. Basalt signs its own moves from <code>basalt.kraterra.testnet</code>.</li>
            <li><code>settle</code>: the salt is revealed; the contract redraws the pool and checks every move (turns, pool, slots, angles, power, fuel), then records the score.</li>
            <li><code>pnpm verify &lt;matchId&gt;</code> replays the whole duel from that log with no keys and compares the score.</li>
            <li><b>Munition packs</b> are NEP-171 NFTs: claim a starter pack gaslessly after signing in. Each pack kind adds a rare munition to your draft.</li>
          </ul>
        </section>
      </div>
      <div className="row ob-row">
        <button className="ghost" onClick={onWalkthrough}>Replay the walkthrough</button>
        <button className="ghost" onClick={onPractice}>Practice range</button>
        <span className="grow" />
        <button onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}
