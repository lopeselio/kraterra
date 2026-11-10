# Kraterra — design

## Pitch

A turn-based artillery duel in destructible voxel ground, the genre everyone played on a school computer,
rebuilt for NEAR: the battlefield and the arsenal come from **NEAR's block VRF** mixed with a committed salt,
so neither player nor our server can rig the map; every pick and shot is recorded onchain; and anyone can
replay a finished duel with `pnpm verify` and get the same score. Rare munitions are NFTs you own and draft
into your matches.

Tracks: **Games With Real Economies**, **NFTs That Do Something**.

## The duel

- **Battlefield:** a 192 × 96 voxel grid seen from the side, rendered as a 10-voxel-deep diorama slab. Row 0 is
  unbreakable bedrock. Five themes from the seed: Rolling Hills, Terraced Cliffs (overhangs, caves), Deep Valley
  (sometimes flooded), Archipelago (islands in the sea), Sky Reef (floating rock reefs). Each tank spawns on a flat pad.
- **Draft:** 20 common munitions are drawn into a pool (weighted). Players alternate picks (seat 0 first) until each
  holds 10. A signed-in player may instead pick from the **rare munitions** their NFT packs unlock (one card per pack
  kind they own, at most 3).
- **Battle:** 20 shots, alternating, seat 1 first (it picked second). Each munition fires once. Before a shot you may
  drive left/right (40 fuel for the whole match; climb at most 2 voxels a column). A shot is angle 0–180 and power 0–100.
- **Wind:** −10…+10, a new value every shot from `sha256("kraterra|wind|seed|shot")`, calm more often than gale. It
  accelerates the shell sideways every step of the flight.
- **Score:** damage dealt. Damage to your own tank scores for your rival. Highest total after 20 shots wins (ties draw).
  Tanks never die; it's a points duel.

### Munitions

| Common | Behaviour |
|---|---|
| Pebble, Thumper, Crater Maker | plain blasts, small to huge |
| Needle | fast, flat, small hard-hitting blast |
| Trident | three shells fanned 5° apart |
| Seedpod | bursts into six bomblets |
| Mole | tunnels 22 voxels on through the ground, then explodes |
| Bulwark | raises a 3 × 14 stone wall where it lands |
| Mudslinger | packs a ball of dirt (bury a tank, fill a crater) |
| Wildfire | flames run 14 voxels along the surface both ways, scorching grass |
| Tumbler | lands, then rolls downhill until a rise or a tank, then explodes |
| Skimmer | skips off the ground twice, then explodes |

| Rare (NFT packs only) | |
|---|---|
| Starfall | five shells fall from the sky above the impact |
| Tidebreaker | the biggest blast (radius 12) |
| Auger | bores 48 voxels through anything, then erupts |

### Physics (packages/rules/src/sim.ts)

Integer only. Positions in 1/4096 voxel; gravity 80, muzzle speed `8700 × power × speed% / 10000`, wind
`2 × wind` per step. Sines and cosines come from a 91-entry table of `round(sin(d°) × 4096)`. Every step is split
into half-voxel sub-steps so nothing tunnels through a one-voxel wall. A blast carves a disc (bedrock excepted),
scorches grass at the rim to ash, and damages each tank by `dmg × (r + 2 − max(0, d − 1)) / (r + 2)` where `d`
is the integer distance to the tank's centre. Afterwards tanks fall until something is under their tracks.
The only square root is `isqrt` (IEEE `sqrt` is exactly rounded, then corrected in integers).

## Onchain (NEAR testnet, `kraterra.testnet`)

```
server                                   contract
──────                                   ────────
salt (secret, 32 bytes)
create_match(id, sha256(salt), seats+packs) ─▶  checks pack ownership, stores the commit
                                           └▶  draw_vrf (a later receipt): vrf = hex(env::random_seed_array())
seed = sha256("kraterra|seed|vrf|salt")   ◀── returns vrf
terrain, pool, wind ← seed
play(id, [{seat, text}…]) ×N              ─▶  turn order, canonical move format, phase (draft vs battle)
settle(id, salt, scores)                  ─▶  sha256(salt) = commit; seed; redraws the pool; checks every pick
                                               and shot (pool cards taken once, own packs only, slots used once,
                                               angle/power/fuel ranges); records scores, winner, stats
```

- **Why the map can't be rigged:** the server commits to its salt before the VRF value exists; the contract draws the
  VRF value in a later receipt, after the commit is stored; the seed needs both. Players never see the salt until the
  end (so future wind stays unknown too). The server could refuse to play a map it dislikes (abandon), but it can't
  choose one.
- **Moves:** draft `p<i>` / `r<i>`, battle `s<slot>,<angle>,<power>,<move>`; one canonical spelling each. The referee
  (`kraterra-ref.testnet`) relays human moves in order. **Basalt signs its own moves** from `basalt.kraterra.testnet`,
  a sub-account whose only key is a function-call key for `play` and `mint_starter`.
- **What the contract does not do:** run the ballistics (too heavy for gas, and it doesn't need to: the inputs are
  fixed onchain and the physics is deterministic). The score the referee reports at `settle` is checked by replaying:
  `pnpm verify <id>` reads the contract's commit, VRF value, seed, pool and move log over public RPC and replays the
  duel with packages/rules.
- **Munition packs (NEP-171):** `mint_starter()` once per account (gasless through `kraterra-relay.testnet`, NEP-366);
  its kind (Starfall, Tidebreaker, Auger) comes from the block's random seed. Transferable with `nft_transfer`;
  metadata is an onchain SVG crate. At `create_match` the contract checks each listed pack is owned by that seat's
  account; those kinds become the seat's rare draft cards.
- **Stats:** per account (matches, wins, losses, draws, best score, total damage) and a leaderboard.

## Modes

- **Duel Basalt** (AI tank): Easy / Normal / Hard. Basalt drafts by value and aims by searching angle × power with the
  same `trace` the sim uses (wind included), then shakes its hand: ±7°/±9 power on Easy, ±3/±4 Normal, ±1/±1 Hard.
  `pnpm sim 20 hard easy` measures it (Hard beats Easy 10/10, Normal beats Easy 19/20, Hard beats Normal 20/20).
  Its generator is seeded from the secret salt, so players can't predict its shake.
- **Challenge a friend:** create → share the 6-character code or `/m/<code>` link → the friend accepts (guest or
  signed in). The match goes onchain once both seats are filled. A rival idle for 3 minutes can be claimed against.

## Onboarding

Title (an attract-mode duel plays behind it) → first time you press a play button: a six-card illustrated walkthrough
(the duel, aim/power/wind, the draft, destruction, scoring, what goes onchain) → the practice range (guided: aim and
fire; hit the target with the aim guide; hit it in the wind without the guide; free fire) → your match. "How to play"
(or `?`) reopens rules, controls, the full munition list and the onchain story, with links back to the walkthrough and
the range. Guests can do everything; signing in adds packs and a record.

## Client

React HUD over one three.js scene. Terrain is meshed in 16-column chunks: front/back faces merged into runs,
top/bottom faces merged, side faces per cell, a tiled bevel texture keeps the voxel grid visible on merged faces. A blast
rebuilds one or two chunks. Particles are one InstancedMesh (≤ 700). Pixel ratio is capped (1.5 on touch screens).
The browser re-runs each new move locally with packages/rules to animate it, then adopts the server's state.
Controls: drag from your tank to aim (direction = angle, length = power), sliders with ± buttons, ◀ ▶ drive with a
ghost tank preview, a munition sheet, FIRE; keys ←/→ ↑/↓ A/D 1–0 Space; drag to pan, pinch/wheel to zoom.

## Storage and hosting

Match records are JSON files under `DATA_DIR/matches` (an Azure Files share at `/data`). Sessions are in memory. One
Azure Container Apps replica (Basalt's timers, the chain queue and websockets live in memory).
