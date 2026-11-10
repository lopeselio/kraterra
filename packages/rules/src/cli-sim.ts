// All-AI matches: how often each difficulty wins, average scores, how long the sim takes.
//   pnpm sim [matches] [difficultyA] [difficultyB]
declare const process: { argv: string[] };
import { aiPick, aiShot, type Difficulty } from './ai.ts';
import { sha256Hex } from './hash.ts';
import { rngFrom } from './rng.ts';
import { applyMove, createState, rollWind, whoseTurn } from './sim.ts';

const n = Number(process.argv[2] ?? 20);
const diffs = [(process.argv[3] ?? 'hard') as Difficulty, (process.argv[4] ?? 'easy') as Difficulty];
const wins = [0, 0, 0];
const scores = [0, 0];
const themes: Record<string, number> = {};
const t0 = performance.now();
for (let k = 0; k < n; k++) {
  const seed = sha256Hex(`sim|${k}`);
  const s = createState({ matchId: `sim-${k}`, seed, seats: [{ name: 'A', rares: [] }, { name: 'B', rares: [] }], rules: 1 });
  themes[s.theme] = (themes[s.theme] ?? 0) + 1;
  const r = rngFrom(`ai|${k}`);
  while (s.phase !== 'over') {
    const seat = whoseTurn(s)!;
    applyMove(s, s.phase === 'draft' ? aiPick(s, seat, diffs[seat], r) : aiShot(s, seat, diffs[seat], r));
    rollWind(s, seed);
  }
  wins[s.winner ?? 2]++;
  scores[0] += s.tanks[0].score; scores[1] += s.tanks[1].score;
}
console.log(`${n} matches, ${diffs[0]} vs ${diffs[1]}: wins ${wins[0]} / ${wins[1]} (draws ${wins[2]}); mean score ${Math.round(scores[0] / n)} / ${Math.round(scores[1] / n)}`);
console.log(`themes ${JSON.stringify(themes)}; ${Math.round((performance.now() - t0) / n)} ms per match`);
