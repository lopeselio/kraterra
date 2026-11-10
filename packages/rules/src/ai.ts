import { int, type Rng } from './rng.ts';
import { shotText } from './protocol.ts';
import { trace, type State } from './sim.ts';
import { weapon } from './weapons.ts';

// Basalt, the AI tank. It drafts and aims with the same simulation the match runs on (wind
// included), then its hand shakes by an amount set by the difficulty. No LLM is involved: NEAR AI
// only voices its taunts. The server passes in a seeded generator; the AI's moves are logged and
// signed onchain like anyone's, so a replay never needs to re-run this.

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

const SHAKE: Record<Difficulty, { angle: number; power: number; best: number; coarse: number }> = {
  easy: { angle: 7, power: 9, best: 35, coarse: 6 },
  normal: { angle: 3, power: 4, best: 75, coarse: 3 },
  hard: { angle: 1, power: 1, best: 100, coarse: 1 },
};

/** How much a munition is worth having, roughly its expected damage. */
export function value(id: number): number {
  const w = weapon(id);
  switch (w.kind) {
    case 'spread': return w.dmg * 2;
    case 'cluster': return w.dmg * 3;
    case 'rain': return w.dmg * 3;
    case 'wall': case 'mud': return 14;
    case 'fire': return w.dmg + 4;
    default: return w.dmg + w.r * 2;
  }
}

/** The AI's draft pick (a move text). */
export function aiPick(s: State, seat: number, d: Difficulty, r: Rng): string {
  const rares = s.seats[seat].rares;
  const options: { text: string; v: number }[] = [];
  rares.forEach((id, i) => { if (!s.rareUsed[seat][i]) options.push({ text: `r${i}`, v: value(id) + 10 }); });
  s.pool.forEach((id, i) => { if (!s.taken[i]) options.push({ text: `p${i}`, v: value(id) }); });
  // keep one or two utility rounds at most
  const utility = s.inv[seat].filter((id) => ['wall', 'mud'].includes(weapon(id).kind)).length;
  for (const o of options) {
    const id = o.text[0] === 'r' ? rares[Number(o.text.slice(1))] : s.pool[Number(o.text.slice(1))];
    if (['wall', 'mud'].includes(weapon(id).kind) && utility >= 1) o.v -= 30;
  }
  options.sort((a, b) => b.v - a.v);
  if (int(r, 1, 100) <= SHAKE[d].best) return options[0].text;
  return options[int(r, 0, Math.min(options.length, 6) - 1)].text;
}

/** The AI's shot (a move text): best aim found by search, then shaken. */
export function aiShot(s: State, seat: number, d: Difficulty, r: Rng): string {
  const me = s.tanks[seat], foe = s.tanks[1 - seat];
  const shake = SHAKE[d];
  // which munition: hard and normal fire the strongest first; easy fires in draft order
  const slots = s.inv[seat].map((id, i) => ({ i, id })).filter((x) => !s.used[seat][x.i]);
  const damaging = slots.filter((x) => weapon(x.id).dmg > 0);
  const pickFrom = damaging.length ? damaging : slots;
  let slot = pickFrom[0];
  if (d !== 'easy') slot = [...pickFrom].sort((a, b) => value(b.id) - value(a.id))[d === 'hard' ? 0 : int(r, 0, Math.min(1, pickFrom.length - 1))];
  const w = weapon(slot.id);
  const dir = foe.x > me.x ? 1 : -1;
  let best = { angle: dir > 0 ? 45 : 135, power: 60, miss: 1e9 };
  const target = { x: foe.x, y: foe.y + 1 };
  for (let a = 15; a <= 80; a += shake.coarse * 2) {
    const angle = dir > 0 ? a : 180 - a;
    for (let p = 25; p <= 100; p += shake.coarse * 2) {
      const t = trace(s, seat, w.id, angle, p);
      if (t.kind === 'out') continue;
      const dx = t.x - target.x, dy = t.y - target.y;
      const self = (t.x - me.x) * (t.x - me.x) + (t.y - me.y) * (t.y - me.y);
      const miss = dx * dx + dy * dy + (self < 64 ? 4000 : 0);
      if (miss < best.miss) best = { angle, power: p, miss };
    }
  }
  // refine around the best
  if (d !== 'easy') {
    const b0 = best;
    for (let da = -3; da <= 3; da++) for (let dp = -4; dp <= 4; dp++) {
      const angle = Math.max(0, Math.min(180, b0.angle + da)), p = Math.max(1, Math.min(100, b0.power + dp));
      const t = trace(s, seat, w.id, angle, p);
      if (t.kind === 'out') continue;
      const dx = t.x - target.x, dy = t.y - target.y;
      const miss = dx * dx + dy * dy;
      if (miss < best.miss) best = { angle, power: p, miss };
    }
  }
  const angle = Math.max(0, Math.min(180, best.angle + int(r, -shake.angle, shake.angle)));
  const power = Math.max(1, Math.min(100, best.power + int(r, -shake.power, shake.power)));
  return shotText(slot.i, angle, power, 0);
}
