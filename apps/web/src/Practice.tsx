import { useEffect, useMemo, useRef, useState } from 'react';
import { applyMove, cloneState, createState, previewDrive, sha256Hex, shotText, trace, type State } from '@kraterra/rules';
import { AimPanel, WindBadge, type Aim } from './Controls.tsx';
import type { Battlefield } from './scene.ts';
import { sfx } from './sound.ts';

// The practice range: everything runs in this browser on the real rules, against a target tank that
// never shoots back. A few guided steps (aim and fire, hit the target with the guide, hit it in the
// wind), then free fire with every common munition.

const ARSENAL = [1, 0, 3, 4, 5, 9, 10, 8, 6, 7];

function practiceState(): State {
  // a gentle hills map
  let k = 0;
  let s = createState({ matchId: 'practice', seed: sha256Hex('kraterra|practice|0'), rules: 1, seats: [{ name: 'You', rares: [] }, { name: 'Target', rares: [] }] });
  while (s.theme !== 'hills' && k < 40) { k++; s = createState({ matchId: 'practice', seed: sha256Hex(`kraterra|practice|${k}`), rules: 1, seats: [{ name: 'You', rares: [] }, { name: 'Target', rares: [] }] }); }
  return arm(s, 0);
}
/** a fresh turn: seat 0 to fire, the whole arsenal loaded, a full tank of fuel */
function arm(s: State, wind: number): State {
  s.phase = 'battle';
  s.inv = [ARSENAL.slice(), ARSENAL.slice()];
  s.used = [ARSENAL.map(() => false), ARSENAL.map(() => false)];
  s.moves = Array.from({ length: 21 }, () => 'p0');
  s.tanks[0].fuel = 40;
  s.wind = wind;
  return s;
}

/** The arc from where the tank would stand after its planned drive. */
export function guideArc(s: State, seat: number, aim: Aim, weaponId: number): number[] {
  const c = cloneState(s);
  const p = previewDrive(c, seat, aim.move);
  c.tanks[seat].x = p.x; c.tanks[seat].y = p.y;
  return trace(c, seat, weaponId, aim.angle, aim.power).pts;
}

const STEPS = [
  { title: 'Aim and fire', text: 'Drag from your tank (or use the sliders) to set the angle and power, then press FIRE (or Space).', wind: 0, guide: true },
  { title: 'Hit the target', text: 'The dotted line shows where your shell will fly. Land it on the orange tank on the right.', wind: 0, guide: true },
  { title: 'Mind the wind', text: 'The wind changes every shot and pushes shells sideways the whole way. The guide is off now: read the flag, adjust, and hit the target.', wind: 6, guide: false },
  { title: 'Free fire', text: 'You’ve got it. Try other munitions (tap the munition button or press 1–0): Mole tunnels, Bulwark builds a wall, Tumbler rolls downhill.', wind: -3, guide: false },
];

export function Practice({ bf, onExit, onPlay }: { bf: Battlefield; onExit: () => void; onPlay: () => void }) {
  const [s, setS] = useState<State>(practiceState);
  const [step, setStep] = useState(0);
  const [aim, setAim] = useState<Aim>({ angle: 50, power: 65, move: 0, slot: 0 });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [guide, setGuide] = useState(true);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    bf.me = 0;
    bf.setWorld(s);
    bf.overview();
    bf.onAim = (a) => setAim((cur) => ({ ...cur, angle: a.angle, power: a.power }));
    return () => { bf.onAim = null; bf.me = null; bf.setGhost(null, 0); bf.setGuide(null); };
  }, [bf, s]);

  const showGuide = STEPS[step].guide && guide;
  const arc = useMemo(() => (showGuide ? guideArc(s, 0, aim, s.inv[0][aim.slot]) : null), [s, aim, showGuide]);
  useEffect(() => {
    bf.setBarrel(0, aim.angle);
    bf.setGhost(aim.move ? previewDrive(s, 0, aim.move) : null, aim.angle);
    bf.setGuide(arc);
  }, [bf, aim, arc, s]);

  const fire = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    bf.setGuide(null);
    bf.setGhost(null, 0);
    const next = cloneState(s);
    const before = next.tanks[0].score;
    const ev = applyMove(next, shotText(aim.slot, aim.angle, aim.power, aim.move));
    await bf.play(ev);
    const hit = next.tanks[0].score > before;
    const self = next.tanks[1].score > 0;
    let st = step;
    if (step === 0) st = 1;
    else if ((step === 1 || step === 2) && hit) st = step + 1;
    setNote(hit ? `Hit! ${next.tanks[0].score - before} damage.` : self ? 'Ouch, that one hurt you: in a duel it would score for your rival.' : step >= 1 && step <= 2 ? 'Missed. Adjust and try again.' : null);
    if (hit) sfx('turn');
    next.tanks[1].score = 0;
    if (st !== step) setStep(st);
    const armed = arm(next, STEPS[st].wind);
    bf.setTanks(armed);
    setS(armed);
    setAim({ ...aim, move: 0 });
    setBusy(false);
  };

  const cur = STEPS[step];
  return (
    <div className="hud">
      <div className="top-hud card">
        <div className="vs"><b>Practice range</b><span className="sep">·</span><WindBadge wind={s.wind} /></div>
        <div className="steps" aria-label="Practice steps">{STEPS.map((_, k) => <i key={k} className={k < step ? 'done' : k === step ? 'on' : ''} />)}</div>
      </div>
      <div className="coach card">
        <b>{step + 1}. {cur.title}</b>
        <p>{cur.text}</p>
        {note && <p className="note">{note}</p>}
        <div className="row">
          {cur.guide && <label className="small"><input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} /> aim guide</label>}
          <span className="grow" />
          {step < 3 && <button className="ghost small" onClick={() => { const st = step + 1; setStep(st); const a = arm(cloneState(s), STEPS[st].wind); setS(a); }}>Skip step</button>}
          <button className="ghost small" onClick={onExit}>Leave</button>
          {step === 3 && <button className="small" onClick={onPlay}>Duel Basalt</button>}
        </div>
      </div>
      <AimPanel aim={aim} setAim={setAim} inv={s.inv[0]} used={s.used[0]} fuel={40} wind={s.wind} onFire={() => void fire()} busy={busy} />
    </div>
  );
}
