# Kraterra — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Independent of the other NEAR Arcade games (Bazaar of Liars, Realm Ledger, Parkwright, Sushi Sabotage, Fogwater, Emberfall, …): its own repo, contract, rules and server.
- Inspired by the artillery-duel genre (Pocket Tanks and friends): no names, art, sounds or weapon list copied. All art is procedural voxels; all sound is synthesised.
- packages/rules is deterministic and isomorphic (browser + Node): no Math.random, no Date, no DOM, no node: imports, no transcendental maths (sines come from a fixed integer table). Integer positions only (1/4096 voxel). A replay of the move log must reproduce the state hash.
- packages/rules/src/protocol.ts (salt hash, seed, pool draw, move format, log check) must match contracts/kraterra byte for byte (shared test vector in both test suites).
- The map seed is sha256(vrf | salt): the server commits sha256(salt) first; the contract draws `env::random_seed_array()` in a later receipt. Never let the server pick or see the VRF value before committing.
- The LLM never chooses a shot or decides a result; packages/rules (ai.ts, sim.ts) and the contract do. NEAR AI only voices Basalt's taunts.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits. Every change after the first push goes on a branch, through a PR, and is rebase-merged (`gh pr merge --rebase --delete-branch`).
