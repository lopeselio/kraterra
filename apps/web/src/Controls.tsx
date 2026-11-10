import { useEffect, useState } from 'react';
import { weapon, type Weapon } from '@kraterra/rules';
import { sfx } from './sound.ts';

// The aiming panel, shared by matches and the practice range: angle and power sliders with nudge
// buttons, the drive buttons with the fuel gauge, the munition sheet and a big Fire button.
// Desktop keys: ←/→ angle, ↑/↓ power (Shift ×5), A/D drive, 1–9 and 0 munitions, Space fire.

export interface Aim { angle: number; power: number; move: number; slot: number }

const GLYPH: Record<string, string> = {
  blast: '●', spread: '⋔', cluster: '✣', dig: '⤓', wall: '▮', mud: '◍', fire: '≋', roll: '◉', skip: '⌒', rain: '⇣',
};

export function WeaponIcon({ id, size = 34 }: { id: number; size?: number }) {
  const w = weapon(id);
  return (
    <span className="wicon" style={{ width: size, height: size, background: w.color, fontSize: size * 0.5 }} aria-hidden="true">
      <i>{GLYPH[w.kind] ?? '●'}</i>
    </span>
  );
}

export function WeaponCard({ id, onClick, disabled, taken, note }: { id: number; onClick?: () => void; disabled?: boolean; taken?: string | null; note?: string }) {
  const w: Weapon = weapon(id);
  return (
    <button className={`wcard${taken ? ' taken' : ''}${w.rare ? ' rare' : ''}`} onClick={onClick} disabled={disabled || !!taken} title={w.blurb}>
      <WeaponIcon id={id} />
      <span className="wtext">
        <b>{w.name}</b>
        <small>{w.dmg > 0 ? `${w.dmg} dmg · r${w.r}` : 'terrain'}{w.rare ? ' · rare' : ''}</small>
        {note && <em>{note}</em>}
      </span>
      {taken && <span className="tag">{taken}</span>}
    </button>
  );
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function AimPanel(props: {
  aim: Aim; setAim: (a: Aim) => void; inv: number[]; used: boolean[]; fuel: number; wind: number;
  onFire: () => void; busy?: boolean; hint?: string | null; allowMove?: boolean;
}) {
  const { aim, setAim, inv, used, fuel, onFire, busy } = props;
  const [sheet, setSheet] = useState(false);
  const set = (p: Partial<Aim>): void => setAim({ ...aim, ...p });
  const nudge = (k: 'angle' | 'power', d: number): void => {
    sfx('click');
    set({ [k]: clamp(aim[k] + d, k === 'angle' ? 0 : 1, k === 'angle' ? 180 : 100) } as Partial<Aim>);
  };
  const drive = (d: number): void => { sfx('click'); set({ move: clamp(aim.move + d, -fuel, fuel) }); };
  const cur = inv[aim.slot];

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (busy) return;
      const step = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); set({ angle: clamp(aim.angle + step, 0, 180) }); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); set({ angle: clamp(aim.angle - step, 0, 180) }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); set({ power: clamp(aim.power + step, 1, 100) }); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); set({ power: clamp(aim.power - step, 1, 100) }); }
      else if ((e.key === 'a' || e.key === 'A') && props.allowMove !== false) drive(-1);
      else if ((e.key === 'd' || e.key === 'D') && props.allowMove !== false) drive(1);
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!used[aim.slot]) onFire(); }
      else if (/^[0-9]$/.test(e.key)) {
        const i = e.key === '0' ? 9 : Number(e.key) - 1;
        if (i < inv.length && !used[i]) { sfx('click'); set({ slot: i }); }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <div className="aim" onPointerDown={(e) => e.stopPropagation()}>
      {props.hint && <div className="aim-hint">{props.hint}</div>}
      <div className="aim-grid">
        <button className="weapon-btn" onClick={() => { sfx('click'); setSheet(true); }} disabled={busy}>
          {cur !== undefined && <WeaponIcon id={cur} size={30} />}
          <span><b>{cur !== undefined ? weapon(cur).name : '—'}</b><small>{inv.filter((_, i) => !used[i]).length} left · change ▴</small></span>
        </button>
        <Slider label="Angle" unit="°" value={aim.angle} min={0} max={180} reverse onChange={(v) => set({ angle: v })} onNudge={(d) => nudge('angle', -d)} disabled={busy} />
        <Slider label="Power" unit="" value={aim.power} min={1} max={100} onChange={(v) => set({ power: v })} onNudge={(d) => nudge('power', d)} disabled={busy} />
        {props.allowMove !== false && (
          <div className="drive">
            <button className="ghost" onClick={() => drive(-1)} disabled={busy || aim.move <= -fuel} aria-label="Drive left">◀</button>
            <div className="fuel" title="Fuel: every voxel you drive uses one, for the whole match">
              <small>Move {aim.move > 0 ? `+${aim.move}` : aim.move}</small>
              <span className="bar"><i style={{ width: `${(100 * (fuel - Math.abs(aim.move))) / 40}%` }} /></span>
              <small>fuel {fuel - Math.abs(aim.move)}</small>
            </div>
            <button className="ghost" onClick={() => drive(1)} disabled={busy || aim.move >= fuel} aria-label="Drive right">▶</button>
          </div>
        )}
        <button className="fire" onClick={onFire} disabled={busy || used[aim.slot] || cur === undefined}>FIRE</button>
      </div>
      {sheet && (
        <div className="sheet-back" onClick={() => setSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose a munition">
            <div className="sheet-head"><b>Your munitions</b><small>each fires once · keys 1–0</small><button className="ghost small" onClick={() => setSheet(false)}>Close</button></div>
            <div className="wgrid">
              {inv.map((id, i) => (
                <WeaponCard key={i} id={id} taken={used[i] ? 'fired' : null} note={`${i === 9 ? 0 : i + 1}${i === aim.slot ? ' · selected' : ''}`} onClick={() => { sfx('click'); set({ slot: i }); setSheet(false); }} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Slider({ label, unit, value, min, max, onChange, onNudge, disabled, reverse }: { label: string; unit: string; value: number; min: number; max: number; onChange: (v: number) => void; onNudge: (d: number) => void; disabled?: boolean; reverse?: boolean }) {
  // the angle slider runs right-to-left so dragging right lowers the barrel toward the right
  const shown = reverse ? max + min - value : value;
  return (
    <div className="slider">
      <div className="slider-top"><small>{label}</small><b>{value}{unit}</b></div>
      <div className="slider-row">
        <button className="ghost nudge" onClick={() => onNudge(-1)} disabled={disabled} aria-label={`${label} down`}>−</button>
        <input type="range" min={min} max={max} value={shown} disabled={disabled} aria-label={label}
          onChange={(e) => { const v = Number(e.target.value); onChange(reverse ? max + min - v : v); }} />
        <button className="ghost nudge" onClick={() => onNudge(1)} disabled={disabled} aria-label={`${label} up`}>+</button>
      </div>
    </div>
  );
}

export function WindBadge({ wind }: { wind: number }) {
  const s = Math.abs(wind);
  return (
    <span className={`wind${s >= 7 ? ' strong' : ''}`} title={`Wind ${wind > 0 ? 'right' : wind < 0 ? 'left' : 'calm'} ${s}/10: it pushes every shell sideways the whole flight`}>
      <small>wind</small>
      <b>{wind < 0 ? '◀'.repeat(Math.max(1, Math.ceil(s / 4))) : ''} {s === 0 ? 'calm' : s} {wind > 0 ? '▶'.repeat(Math.max(1, Math.ceil(s / 4))) : ''}</b>
    </span>
  );
}
