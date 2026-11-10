# Kraterra

A turn-based **artillery duel in destructible voxel ground**, on NEAR. Draft ten munitions from a shared pool, read the wind, and lob shells over hills that crater, tunnel, burn and wall up under fire. Duel **Basalt** the AI tank (Easy / Normal / Hard) or send a friend a room link.

Nobody can rig the battlefield: our server commits a hash of a secret salt onchain first, then the contract draws a seed from **NEAR's block VRF** (`env::random_seed_array()`) in a later receipt. Terrain, weapon pool and wind come from both. Every pick and shot is recorded onchain; at the end the salt is revealed and the contract redraws the pool and checks the whole move log. `pnpm verify <matchId>` replays the duel from that log with no keys and compares the score. Rare munitions are **NFT packs** (NEP-171) you own in your wallet and draft into your matches.

Built for NEAR HACKATHON (Nov 2026). Tracks: **Games With Real Economies**, **NFTs That Do Something**. Design: [DESIGN.md](DESIGN.md). Source: https://github.com/lopeselio/kraterra

**Play it:** https://kraterra.orangehill-dc994ea2.northeurope.azurecontainerapps.io (NEAR testnet; phones and desktops; guests welcome).

- Contract (testnet): [`kraterra.testnet`](https://testnet.nearblocks.io/address/kraterra.testnet): matches (commit, VRF draw, move log, settlement) and munition packs (NEP-171).
- Referee: [`kraterra-ref.testnet`](https://testnet.nearblocks.io/address/kraterra-ref.testnet). Gasless relayer: [`kraterra-relay.testnet`](https://testnet.nearblocks.io/address/kraterra-relay.testnet).
- Basalt, the AI tank: [`basalt.kraterra.testnet`](https://testnet.nearblocks.io/address/basalt.kraterra.testnet), a sub-account with **only a function-call key** (`play`, `mint_starter`). It signs its own moves.

## Try it (do X, see Y)

```bash
pnpm install
pnpm build            # the web app
pnpm start            # http://localhost:8841 (server + built web app)
```

With no NEAR keys, run `CHAIN=0 pnpm start`: everything plays the same, but nothing is written onchain (the results say "Offline mode").

1. **Open http://localhost:8841.** You see the KRATERRA title over a voxel diorama where two tanks trade shells by themselves (attract mode), then panels: name, **Duel Basalt** with an Easy/Normal/Hard switch, **Challenge a friend**, a room-code box, **Practice range**, **Munition packs**, the leaderboard and recent duels.
2. **Press "Duel Basalt"** (Easy is the default). The first time, a **six-card illustrated walkthrough** opens (the duel; angle, power and wind; the draft; destructible ground; scoring; what goes onchain). Its last button, **Try the practice range**, takes you to step 3; **Skip** goes straight to the duel. Reopen it any time from **? How to play**.
3. **Practice range.** A guided coach card: *1. Aim and fire* (drag from your tank or use the sliders, press FIRE or Space; a dotted aim guide shows the arc), *2. Hit the target* (the orange tank; you see "Hit! N damage."), *3. Mind the wind* (wind 6 ▶, no guide), *4. Free fire* with every common munition, then **Duel Basalt**. Everything runs in your browser on the real rules.
4. **The duel starts with a VRF draw.** A card reads *Drawing the battlefield*: "Salt hash committed: `abcd1234…`", then "NEAR contract draws a VRF seed in a later block" with a link to the `create_match` transaction, then the battlefield appears (its theme is named in the top bar: Rolling Hills, Terraced Cliffs, Deep Valley, Archipelago or Sky Reef). Basalt greets you in a speech bubble (with a NEAR AI key: "✓ NEAR AI", a TEE-signed line).
5. **Draft.** A sheet lists the 20-card pool. Tap a card on your turn ("Your pick"); Basalt picks in between; both 10-slot inventories fill below. **Pick for me** drafts for you. Signed in with packs, a *Your NFT packs* row shows your rare cards (glowing purple).
6. **Battle.** Basalt fires first. On your turn the aiming dock appears: munition button (opens a sheet of your 10, used ones marked "fired"), **Angle** and **Power** sliders with − / + buttons, **◀ ▶** to plan a drive (a ghost tank shows where you'll stop; fuel bar), **FIRE**. Or drag from your tank (direction = angle, distance = power). Desktop: ←/→ angle, ↑/↓ power (Shift ×5), A/D drive, 1–0 munitions, Space fire; drag elsewhere to pan, wheel to zoom (pinch on phones). The top bar shows the score, "Shot n/20" and the wind (◀◀ 7 = strong wind to the left). Shells leave a trail; blasts flash, shake the camera, carve craters and scorch grass; hits float "-N"; tanks drop into craters; Bulwark raises a stone wall, Mudslinger packs dirt, Wildfire runs along the ground, Mole and Auger tunnel.
7. **Results.** "Victory" / "Defeat" / "A draw" with the scores, then within a few seconds **"✓ Settled onchain: the contract checked the revealed salt, redrew the pool and checked all 40 moves."** **Show N transactions** lists `create_match (VRF draw)`, the `play` transactions (Basalt's are its own), and `settle (salt revealed)` on nearblocks. Below: the exact `pnpm verify <id>` command and a **proof bundle (JSON)** link.
8. **Check it yourself**, with no keys and without trusting our server:

   ```
   pnpm verify <matchId>                                  # local server
   pnpm verify <matchId> --host https://<hosted-url>      # hosted
   ```

   Example from a live testnet match below.
9. **Challenge a friend.** Press it: you get a 6-character code and a `/m/<code>` link (Copy / Share). Your friend opens it, types a name, presses **Accept the duel** (no wallet needed); the draw and the draft start for both. If the player whose turn it is goes idle for 3 minutes, the other gets **claim the win**.
10. **Sign in with NEAR** (top right; NEAR Connect: Meteor, Intear, HOT, MyNearWallet, …). The wallet signs "Sign in to <host>" (NEP-413). In *Munition packs*, **Claim your starter pack (free, gasless)**: a NEP-366 meta-transaction paid by `kraterra-relay.testnet` mints an NFT pack (Starfall, Tidebreaker or Auger, picked by the block's VRF) shown as its onchain SVG crate. Its munition now appears in your drafts; the contract checks you still own the pack when the match is created. Your record (duels, wins, best score, damage) is kept onchain.
11. **Headless:** `pnpm e2e` (server at http://localhost:8841) creates a faucet account, signs in, claims a starter pack gaslessly, duels Basalt on Normal over HTTP (drafting the pack munition), waits for every move and the settlement onchain, and compares the contract's record.

### A live run (hosted, testnet, 10 Nov 2026)

`pnpm e2e https://kraterra.orangehill-dc994ea2.northeurope.azurecontainerapps.io` (the faucet was rate-limiting, so the test account is a funded sub-account; the 40 `play` lines are left out):

```
▶ sign in: Better Auth + better-near-auth (the wallet signs "Sign in to <host>")
  ✓ session cookie set; the server sees e2e-mwagm9c7.kraterra.testnet

▶ claim a starter munition pack, gasless (NEP-366 meta-transaction through the relayer)
  ✓ mint_starter AxMraLv8zfFqCYEL3tAJtiGiyefGXQXXw1RpEgNZn3DU
  ✓ pack-2: “Auger pack” (kind picked by the block's VRF), owned by e2e-mwagm9c7.kraterra.testnet

▶ duel Basalt on Normal, drafting the pack munition
  ✓ match em5cqa: salt hash 94b482ee4649bb9b… committed, then the contract drew VRF b291352117eb9a8d… in a later receipt
  ✓ battlefield “valley”; you may draft 1 pack munition(s), Basalt 1
  ✓ drafted Auger from the pack
  ✓ Basalt: “That tickled. Now take this.”
  ✓ over: E2E Gunner 144 – 54 Basalt; you win

▶ wait for every move and the settlement onchain
  ✓ create_match (VRF draw)        https://testnet.nearblocks.io/txns/3fvUhB4MHLXntVMLft5iz8t1tZD3HydYsajUU2ZMS1JK
  ✓ play ×1 (signed by Basalt)     https://testnet.nearblocks.io/txns/FjKqFkp2xP94yYcjyDprkYA9M4j3h7F5rmHv7WUBtZ6q
  … 39 more play transactions …
  ✓ settle (salt revealed)         https://testnet.nearblocks.io/txns/8RPkjnsEZas39CLG3mXwY3W5NEVophXJJbLBb4F9LKja
  ✓ contract: settled, 40 moves, scores 144 – 54, winner seat 0, seed e11f1e0acc4614af…
  ✓ your record onchain: 1 match, 1 win(s), 144 damage
```

`pnpm verify em5cqa --host https://kraterra.orangehill-dc994ea2.northeurope.azurecontainerapps.io`:

```
match em5cqa on kraterra.testnet: E2E Gunner vs Basalt (vs Basalt on normal)

✓ the contract has this match
✓ the contract closed it (settled)
✓ the revealed salt matches the hash committed at create_match  94b482ee4649bb9b
✓ the VRF value is the one the contract drew from the block (after the commit)  b291352117eb9a8d
✓ seed = sha256(vrf | salt), as the contract computed it  e11f1e0acc4614af
✓ the weapon pool redraws from that seed exactly as the contract drew it  Trident, Thumper, Pebble, Pebble…
✓ each seat drafted only from the packs the contract saw it own  Auger / Starfall
✓ the move log is the one recorded onchain, move by move (40 moves)
✓ every pick and shot is legal (turn order, pool, slots, angles, power, fuel)
  battlefield: Deep Valley, water at 12
✓ the replay scores 144 – 54, the same as the contract recorded
✓ winner: E2E Gunner
✓ the replay ends in the exact state the server ended in  33d422727beeff13

6 line(s) from Basalt, 6 signed by the NEAR AI enclave (taunts only: the AI's shots come from packages/rules)

all checks passed
```

An earlier local run, `pnpm verify 4fgnan` (Archipelago, 108 – 94), passes the same checks.

## How it works

```
apps/web             three.js voxel diorama + React HUD (Vite); NEAR Connect wallet; guests need no wallet
apps/server          matches (HTTP + websocket pushes), Basalt, the chain queue, Better Auth + gasless relayer,
                     verify and e2e CLIs
packages/rules       terrain, draft, integer ballistics and every munition, Basalt's aim, the onchain protocol
                     (deterministic, isomorphic, no floats that differ across platforms)
contracts/kraterra   Rust near-sdk 5.29: commit → VRF draw → move log → settle with a full log check; NEP-171 packs
```

- **Randomness nobody picks.** `create_match` stores `sha256(salt)` and the seats' packs, then calls back into the contract (`draw_vrf`, a later receipt) to read `env::random_seed_array()`, the block's VRF-derived seed. `seed = sha256("kraterra|seed|<vrf>|<salt>")`. The server can't steer the VRF value (it committed first); the contract can't see the salt; players see neither until the end.
- **The log.** Every draft pick (`p3`, `r0`) and shot (`s4,52,71,-3`: slot, angle, power, drive) goes to `play` in order (human moves batched by the referee, Basalt's signed by Basalt). The contract enforces turn order, the phase and one canonical spelling per move.
- **Settlement.** `settle` reveals the salt; the contract recomputes the seed, **redraws the 20-card pool with the same generator as packages/rules** (shared test vector), and checks every move: pool cards taken once, rare cards only from the seat's own packs, every shot from an unused slot of the shooter's inventory, angle 0–180, power 0–100, total drive within 40 fuel. Then it records the scores, the winner and both accounts' stats.
- **Physics** (packages/rules/src/sim.ts): integer positions (1/4096 voxel), a fixed sine table, half-voxel sub-steps, wind as a per-step acceleration. The same code runs on the server, in the browser (to animate each move) and in `pnpm verify`.
- **Basalt** searches angle × power with the same `trace` the sim uses (wind included) and shakes by difficulty. The shake comes from a generator seeded with the secret salt. NEAR AI Cloud (a TEE-hosted model) only voices its taunts; each line keeps its enclave signature.
- **Chain invisible.** Guests never see a wallet. A signed-in player signs once to sign in and once (gasless) to claim a pack. A match costs the referee ~42 small transactions.

### What the chain does *not* prove

- **The contract doesn't run the ballistics.** It fixes the inputs (seed, pool, every move) and checks they're legal; the score is checked by replaying (`pnpm verify`, open to anyone). A referee lying about the score at `settle` would be caught by any verifier, not refused by the contract.
- **Human moves aren't signed by the human.** The referee relays them in order as they're made (Basalt's moves are signed by Basalt). Signed-in players could sign their own (`play` accepts a seat's own account), but the UI doesn't ask, to keep the duel wallet-free.
- **The server could abandon a match** it doesn't like after seeing the VRF value (it can't choose a map, only refuse one). Abandoned matches stay visible onchain without a `settle`.
- **Guest seats are labels** the server speaks for.

## Tests

```bash
pnpm --filter @kraterra/rules test   # 31: terrain (every theme, tanks on the ground, wire form), integer maths, wind, replay
                                     #     determinism (state hash), move checks, every munition's behaviour, Basalt's
                                     #     strength by difficulty, and the protocol: the shared hash + pool vector,
                                     #     canonical moves, log checks
pnpm contract:test                   # 19: shared vector, full match through settle, forged salt, turn order, formats,
                                     #     draft-phase rules, duplicate picks and reused slots caught at settle, fuel,
                                     #     pack ownership, starter once, strangers can't play, resign, transfers
pnpm typecheck
pnpm sim 20 hard easy                # all-AI balance: wins per difficulty, mean scores, themes, ms per match
```

## Deploying

- **Contract:** `pnpm contract:build`, then `near contract deploy kraterra.testnet use-file contracts/kraterra/target/near/kraterra.wasm with-init-call new json-args '{"owner":"kraterra.testnet","referee":"kraterra-ref.testnet"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send` (later redeploys: `without-init-call`).
- **Basalt:** `pnpm setup:ai` (idempotent) creates `basalt.kraterra.testnet` with a function-call key for `play` and `mint_starter` and claims its starter pack.
- **Hosting:** `scripts/deploy-azure.sh` (Azure Container Apps, resource group `kraterra`, one replica), then `scripts/azure-storage.sh` once to mount an Azure Files share at `/data` (the first revision waits for it), then `SKIP_SETUP=1 scripts/deploy-azure.sh` so wallet sign-in uses the app's own hostname. Match records survive redeploys. Keys go in as one `NEAR_KEYS` secret; nothing is in the repo.

## Lineage and disclosures

- **Genre.** Turn-based artillery duels (Pocket Tanks, Scorched Earth, Worms). Kraterra copies **no names, art, sounds or weapon list** from any of them; its munitions, rules, world and onchain scheme are its own.
- **Other projects.** Independent of our other NEAR HACKATHON games (Bazaar of Liars, Realm Ledger, Parkwright, Sushi Sabotage, Fogwater, Emberfall): its own repo, contract, rules and server. It reuses the same stack and sign-in pattern (Better Auth + better-near-auth, a gasless relayer) and sits beside them in the NEAR Arcade.
- **AI.** NEAR AI Cloud only voices Basalt's taunts. The model never aims, picks or decides anything.
- **Libraries:** three.js, React, better-auth and better-near-auth, near-api-js, near-kit, @noble/hashes, ws, Vite, near-sdk (Rust).
- **Assets:** every model is procedural boxes (`apps/web/src/scene.ts`); every sound is synthesised (`apps/web/src/sound.ts`); fonts are Inter and Pixelify Sans (Google Fonts, OFL).

## License

MIT
