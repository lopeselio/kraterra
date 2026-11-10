//! Kraterra onchain: artillery duels whose map and weapon pool nobody can pick, a checked move log,
//! and munition packs (NEP-171) that players draft into their matches.
//!
//! - **Randomness.** The referee commits `sha256(salt)` at `create_match`. The contract then draws
//!   `vrf = hex(env::random_seed_array())` in a *later receipt* (`draw_vrf`), from the block's
//!   VRF-derived random seed, which the referee could not know when it committed. The match seed is
//!   `sha256("kraterra|seed|<vrf>|<salt>")`: the terrain, the winds and the draft pool come from it.
//!   Neither player nor the server can choose it.
//! - **Moves.** Every draft pick and every shot (weapon slot, angle, power, move) is appended with
//!   `play`, in strict turn order, by the referee or by the seat's own account (the AI tank signs its
//!   own moves with a function-call key).
//! - **Settlement.** `settle` reveals the salt. The contract checks it against the commitment,
//!   recomputes the seed and the draft pool (the same xoshiro128** draw as packages/rules), and checks
//!   the whole log: every pick was in the pool or the seat's own packs and taken once, every shot used
//!   an unused slot of the shooter's own inventory, angles, powers and fuel in range. The scores come
//!   from the deterministic simulation, which `pnpm verify` replays off-chain.
//! - **Munition packs** are NEP-171 tokens. Owning a pack of a kind lets you draft its rare weapon.
//!   `mint_starter` gives each account one pack, its kind drawn from the block's random seed.
//!
//! Hashes and the pool draw match packages/rules byte for byte (shared test vector in both suites).

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::{env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, PanicOnDefault, Promise, PromiseOrValue};

#[cfg(test)]
mod tests;

pub const POOL_SIZE: usize = 20;
pub const SLOTS: usize = 10;
pub const PICKS: usize = SLOTS * 2;
pub const SHOTS: usize = SLOTS * 2;
pub const FUEL: i32 = 40;
pub const MAX_RARES: usize = 3;
/// weights of the common munitions, ids 0..11 (packages/rules/src/weapons.ts)
pub const WEIGHTS: [u32; 12] = [12, 12, 5, 8, 7, 7, 5, 5, 6, 6, 6, 5];
/// rare munition ids by pack kind
pub const RARE_IDS: [u8; 3] = [12, 13, 14];
pub const PACK_NAMES: [&str; 3] = ["Starfall", "Tidebreaker", "Auger"];
pub const PACK_BLURBS: [&str; 3] = [
    "Calls five shells down from the sky above the impact.",
    "The biggest blast in the arsenal.",
    "Bores 48 voxels through anything, then erupts.",
];
pub const PACK_COLORS: [&str; 3] = ["#c89bff", "#3d8bff", "#ff4fa3"];
const MAX_NAME: usize = 24;
const GAS_FOR_DRAW: Gas = Gas::from_tgas(10);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Matches,
    Packs,
    PackIds,
    Owned,
    OwnedSet { owner_hash: Vec<u8> },
    Starters,
    Stats,
}

// ---------- data ----------

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SeatIn {
    pub name: String,
    pub account: Option<AccountId>,
    pub packs: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Seat {
    pub name: String,
    pub account: Option<AccountId>,
    pub packs: Vec<String>,
    /// the rare munition ids this seat may draft
    pub rares: Vec<u8>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MoveIn {
    pub seat: u8,
    pub text: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Match {
    pub seats: Vec<Seat>,
    pub salt_hash: String,
    pub vrf: Option<String>,
    pub seed: Option<String>,
    pub pool: Vec<u8>,
    pub moves: Vec<String>,
    pub scores: Option<Vec<u32>>,
    pub winner: Option<u8>,
    /// "drawing" | "live" | "settled" | "resigned"
    pub status: String,
    pub mode: String,
    pub created_ms: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub matches: u32,
    pub wins: u32,
    pub losses: u32,
    pub draws: u32,
    /// best score in one match
    pub best: u32,
    /// total damage dealt
    pub damage: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Pack {
    pub owner_id: AccountId,
    pub kind: u8,
    pub minted_ms: U64,
}

#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub extra: Option<String>,
}

#[near(serializers = [json])]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

fn event(standard: &str, version: &str, ev: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": standard, "version": version, "event": ev, "data": [data] })));
}
fn kraterra_event(ev: &str, data: serde_json::Value) {
    event("kraterra", "1.0.0", ev, data);
}
fn nep171(ev: &str, data: serde_json::Value) {
    event("nep171", "1.2.0", ev, data);
}

#[ext_contract(ext_nft_receiver)]
pub trait NonFungibleTokenReceiver {
    fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> PromiseOrValue<bool>;
}
#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn draw_vrf(&mut self, match_id: String) -> String;
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String) -> bool;
}

// ---------- the protocol packages/rules builds too ----------

pub fn sha_hex(s: &str) -> String {
    hex::encode(env::sha256_array(s.as_bytes()))
}
pub fn seed_of(vrf: &str, salt: &str) -> String {
    sha_hex(&format!("kraterra|seed|{vrf}|{salt}"))
}

/// xoshiro128** seeded from the first 16 bytes of sha256(text), as packages/rules/src/rng.ts.
pub struct Rng {
    a: u32,
    b: u32,
    c: u32,
    d: u32,
}
impl Rng {
    pub fn from_text(text: &str) -> Rng {
        let h = env::sha256_array(text.as_bytes());
        let w = |k: usize| u32::from_be_bytes([h[k], h[k + 1], h[k + 2], h[k + 3]]);
        let mut r = Rng { a: w(0), b: w(4), c: w(8), d: w(12) };
        if r.a | r.b | r.c | r.d == 0 {
            r.a = 1;
        }
        r
    }
    pub fn next_u32(&mut self) -> u32 {
        let out = self.b.wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.b << 9;
        self.c ^= self.a;
        self.d ^= self.b;
        self.b ^= self.c;
        self.a ^= self.d;
        self.c ^= t;
        self.d = self.d.rotate_left(11);
        out
    }
}

pub fn draw_pool(seed: &str) -> Vec<u8> {
    let mut r = Rng::from_text(&format!("kraterra|pool|{seed}"));
    let total: u32 = WEIGHTS.iter().sum();
    (0..POOL_SIZE)
        .map(|_| {
            let mut v = r.next_u32() % total;
            for (id, w) in WEIGHTS.iter().enumerate() {
                if v < *w {
                    return id as u8;
                }
                v -= w;
            }
            unreachable!()
        })
        .collect()
}

pub fn seat_of_move(k: usize) -> u8 {
    if k < PICKS {
        (k % 2) as u8
    } else {
        ((k - PICKS + 1) % 2) as u8
    }
}

#[derive(Debug, PartialEq, Clone)]
pub enum Move {
    Pick(usize),
    Rare(usize),
    Shot { slot: usize, angle: u32, power: u32, mv: i32 },
}

fn digits(s: &str, max: usize) -> Option<u32> {
    if s.is_empty() || s.len() > max || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Parses a move; only the canonical spelling is accepted (packages/rules parseMove).
pub fn parse_move(text: &str) -> Option<Move> {
    if let Some(rest) = text.strip_prefix('p') {
        let n = digits(rest, 2)?;
        return (format!("p{n}") == text).then_some(Move::Pick(n as usize));
    }
    if let Some(rest) = text.strip_prefix('r') {
        let n = digits(rest, 1)?;
        return Some(Move::Rare(n as usize));
    }
    if let Some(rest) = text.strip_prefix('s') {
        let parts: Vec<&str> = rest.split(',').collect();
        if parts.len() != 4 {
            return None;
        }
        let slot = digits(parts[0], 1)?;
        let angle = digits(parts[1], 3)?;
        let power = digits(parts[2], 3)?;
        let (neg, m) = match parts[3].strip_prefix('-') {
            Some(x) => (true, x),
            None => (false, parts[3]),
        };
        let mag = digits(m, 2)? as i32;
        let mv = if neg { -mag } else { mag };
        if angle > 180 || power > 100 || mv.abs() > FUEL {
            return None;
        }
        if format!("s{slot},{angle},{power},{mv}") != text {
            return None;
        }
        return Some(Move::Shot { slot: slot as usize, angle, power, mv });
    }
    None
}

/// Rare weapon ids from pack kinds: sorted, each kind once, at most 3.
pub fn rares_of(kinds: &[u8]) -> Vec<u8> {
    let mut k: Vec<u8> = kinds.iter().copied().filter(|k| (*k as usize) < RARE_IDS.len()).collect();
    k.sort();
    k.dedup();
    k.truncate(MAX_RARES);
    k.into_iter().map(|x| RARE_IDS[x as usize]).collect()
}

/// The contract's check of a (possibly partial) log; returns the inventories or why it fails.
pub fn check_log(pool: &[u8], rares: &[Vec<u8>], moves: &[String]) -> Result<Vec<Vec<u8>>, String> {
    let mut taken = vec![false; pool.len()];
    let mut rare_used: Vec<Vec<bool>> = rares.iter().map(|r| vec![false; r.len()]).collect();
    let mut inv: Vec<Vec<u8>> = vec![vec![], vec![]];
    let mut used: Vec<Vec<bool>> = vec![vec![], vec![]];
    let mut fuel = [FUEL, FUEL];
    if moves.len() > PICKS + SHOTS {
        return Err("too many moves".into());
    }
    for (k, text) in moves.iter().enumerate() {
        let seat = seat_of_move(k) as usize;
        let fail = |why: &str| Err(format!("move {k} ({text}): {why}"));
        let Some(m) = parse_move(text) else { return fail("bad format") };
        if k < PICKS {
            match m {
                Move::Pick(i) => {
                    if i >= pool.len() || taken[i] {
                        return fail("not in the pool");
                    }
                    taken[i] = true;
                    inv[seat].push(pool[i]);
                }
                Move::Rare(i) => {
                    if i >= rares[seat].len() || rare_used[seat][i] {
                        return fail("not your munition");
                    }
                    rare_used[seat][i] = true;
                    inv[seat].push(rares[seat][i]);
                }
                Move::Shot { .. } => return fail("the draft is not over"),
            }
            used[seat].push(false);
        } else {
            let Move::Shot { slot, mv, .. } = m else { return fail("the draft is over") };
            if slot >= inv[seat].len() || used[seat][slot] {
                return fail("slot empty or used");
            }
            if mv.abs() > fuel[seat] {
                return fail("out of fuel");
            }
            used[seat][slot] = true;
            fuel[seat] -= mv.abs();
        }
    }
    Ok(inv)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_match_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Kraterra {
    owner: AccountId,
    referee: AccountId,
    matches: LookupMap<String, Match>,
    match_count: u64,
    packs: LookupMap<String, Pack>,
    pack_ids: Vector<String>,
    owned: LookupMap<AccountId, IterableSet<String>>,
    starters: LookupSet<AccountId>,
    stats: IterableMap<AccountId, Stats>,
}

#[near]
impl Kraterra {
    #[init]
    pub fn new(owner: AccountId, referee: AccountId) -> Self {
        Self {
            owner,
            referee,
            matches: LookupMap::new(Key::Matches),
            match_count: 0,
            packs: LookupMap::new(Key::Packs),
            pack_ids: Vector::new(Key::PackIds),
            owned: LookupMap::new(Key::Owned),
            starters: LookupSet::new(Key::Starters),
            stats: IterableMap::new(Key::Stats),
        }
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }
    fn only_referee(&self) {
        require!(env::predecessor_account_id() == self.referee, "only the referee");
    }

    pub fn set_referee(&mut self, referee: AccountId) {
        self.only_owner();
        self.referee = referee;
    }

    // ---------- matches ----------

    /// Commits the salt's hash and seats the players; the VRF draw follows in a later receipt.
    pub fn create_match(&mut self, match_id: String, salt_hash: String, seats: Vec<SeatIn>, mode: String) -> Promise {
        self.only_referee();
        require!(valid_match_id(&match_id), "match id: 1-40 of a-z 0-9 -");
        require!(self.matches.get(&match_id).is_none(), "that match exists");
        require!(is_hex64(&salt_hash), "salt_hash must be 64 lowercase hex");
        require!(seats.len() == 2, "a duel has two seats");
        require!(mode.len() <= 24, "mode too long");
        let mut out = Vec::with_capacity(2);
        for s in seats {
            require!(!s.name.is_empty() && s.name.chars().count() <= MAX_NAME, "name: 1-24 characters");
            require!(s.packs.len() <= 10, "at most 10 packs per seat");
            let mut kinds = vec![];
            if !s.packs.is_empty() {
                let acct = s.account.clone().unwrap_or_else(|| env::panic_str("only an account can bring packs"));
                for id in &s.packs {
                    let p = self.packs.get(id).unwrap_or_else(|| env::panic_str("no such pack"));
                    require!(p.owner_id == acct, "that pack isn't the seat's");
                    kinds.push(p.kind);
                }
            }
            out.push(Seat { name: s.name, account: s.account, packs: s.packs, rares: rares_of(&kinds) });
        }
        self.matches.insert(
            match_id.clone(),
            Match {
                seats: out,
                salt_hash: salt_hash.clone(),
                vrf: None,
                seed: None,
                pool: vec![],
                moves: vec![],
                scores: None,
                winner: None,
                status: "drawing".into(),
                mode,
                created_ms: U64(env::block_timestamp_ms()),
            },
        );
        self.match_count += 1;
        kraterra_event("match_created", json!({ "match_id": match_id, "salt_hash": salt_hash }));
        ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_DRAW).draw_vrf(match_id)
    }

    /// Runs in a later receipt than the commitment: the block's VRF-derived seed becomes the match's.
    #[private]
    pub fn draw_vrf(&mut self, match_id: String) -> String {
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == "drawing", "already drawn");
        let vrf = hex::encode(env::random_seed_array());
        m.vrf = Some(vrf.clone());
        m.status = "live".into();
        kraterra_event("vrf_drawn", json!({ "match_id": match_id, "vrf": vrf, "block": env::block_height() }));
        vrf
    }

    /// Appends moves in turn order. The referee relays for everyone; a seat's own account may too.
    pub fn play(&mut self, match_id: String, moves: Vec<MoveIn>) {
        let who = env::predecessor_account_id();
        let referee = who == self.referee;
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == "live", "the match isn't live");
        require!(!moves.is_empty(), "no moves");
        for mv in moves {
            let k = m.moves.len();
            require!(k < PICKS + SHOTS, "the match is over");
            require!(mv.seat < 2, "bad seat");
            if !referee {
                require!(m.seats[mv.seat as usize].account.as_ref() == Some(&who), "only the referee or that seat's account");
            }
            require!(mv.seat == seat_of_move(k), "not that seat's turn");
            let parsed = parse_move(&mv.text).unwrap_or_else(|| env::panic_str("bad move format"));
            let draft = k < PICKS;
            match parsed {
                Move::Shot { .. } => require!(!draft, "the draft is not over"),
                _ => require!(draft, "the draft is over"),
            }
            m.moves.push(mv.text);
        }
    }

    /// Reveals the salt; checks it, the seed, the pool and the whole log; records the result.
    pub fn settle(&mut self, match_id: String, salt: String, scores: Vec<u32>) {
        self.only_referee();
        let mut m = self.matches.get(&match_id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == "live", "the match isn't live");
        require!(m.moves.len() == PICKS + SHOTS, "the match isn't finished");
        require!(scores.len() == 2, "two scores");
        require!(sha_hex(&salt) == m.salt_hash, "the salt doesn't match the commitment");
        let seed = seed_of(m.vrf.as_ref().unwrap(), &salt);
        let pool = draw_pool(&seed);
        let rares: Vec<Vec<u8>> = m.seats.iter().map(|s| s.rares.clone()).collect();
        if let Err(e) = check_log(&pool, &rares, &m.moves) {
            env::panic_str(&format!("bad log: {e}"));
        }
        let winner = if scores[0] > scores[1] {
            Some(0)
        } else if scores[1] > scores[0] {
            Some(1)
        } else {
            None
        };
        m.seed = Some(seed.clone());
        m.pool = pool;
        m.scores = Some(scores.clone());
        m.winner = winner;
        m.status = "settled".into();
        for (i, s) in m.seats.iter().enumerate() {
            if let Some(a) = &s.account {
                let mut st = self.stats.get(a).cloned().unwrap_or_default();
                st.matches += 1;
                match winner {
                    None => st.draws += 1,
                    Some(w) if w as usize == i => st.wins += 1,
                    _ => st.losses += 1,
                }
                st.best = st.best.max(scores[i]);
                st.damage += scores[i] as u64;
                self.stats.insert(a.clone(), st);
            }
        }
        kraterra_event("settled", json!({ "match_id": match_id, "seed": seed, "scores": scores, "winner": winner }));
        self.matches.insert(match_id, m);
    }

    /// A seat gives up (or left): the salt is revealed all the same, the other seat wins.
    pub fn resign(&mut self, match_id: String, seat: u8, salt: String) {
        self.only_referee();
        let mut m = self.matches.get(&match_id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(m.status == "drawing" || m.status == "live", "the match is over");
        require!(seat < 2, "bad seat");
        require!(sha_hex(&salt) == m.salt_hash, "the salt doesn't match the commitment");
        if let Some(vrf) = &m.vrf {
            let seed = seed_of(vrf, &salt);
            m.pool = draw_pool(&seed);
            m.seed = Some(seed);
        }
        let winner = 1 - seat;
        m.winner = Some(winner);
        m.status = "resigned".into();
        for (i, s) in m.seats.iter().enumerate() {
            if let Some(a) = &s.account {
                let mut st = self.stats.get(a).cloned().unwrap_or_default();
                st.matches += 1;
                if i as u8 == winner {
                    st.wins += 1;
                } else {
                    st.losses += 1;
                }
                self.stats.insert(a.clone(), st);
            }
        }
        kraterra_event("resigned", json!({ "match_id": match_id, "seat": seat }));
        self.matches.insert(match_id, m);
    }

    pub fn get_match(&self, match_id: String) -> Option<Match> {
        self.matches.get(&match_id).cloned()
    }
    pub fn stats_of(&self, account_id: AccountId) -> Stats {
        self.stats.get(&account_id).cloned().unwrap_or_default()
    }
    pub fn leaderboard(&self, limit: u32) -> Vec<(AccountId, Stats)> {
        let mut all: Vec<(AccountId, Stats)> = self.stats.iter().map(|(a, s)| (a.clone(), s.clone())).collect();
        all.sort_by(|a, b| b.1.wins.cmp(&a.1.wins).then(b.1.damage.cmp(&a.1.damage)));
        all.truncate(limit.min(100) as usize);
        all
    }
    pub fn get_config(&self) -> (AccountId, AccountId, u64) {
        (self.owner.clone(), self.referee.clone(), self.match_count)
    }

    // ---------- munition packs (NEP-171) ----------

    /// One free starter pack per account; its kind comes from the block's random seed.
    pub fn mint_starter(&mut self) -> String {
        let who = env::predecessor_account_id();
        require!(!self.starters.contains(&who), "you already have your starter pack");
        self.starters.insert(who.clone());
        let kind = env::random_seed_array()[0] % RARE_IDS.len() as u8;
        self.mint_internal(who, kind)
    }
    pub fn has_starter(&self, account_id: AccountId) -> bool {
        self.starters.contains(&account_id)
    }
    pub fn mint_pack(&mut self, receiver_id: AccountId, kind: u8) -> String {
        self.only_owner();
        require!((kind as usize) < RARE_IDS.len(), "no such kind");
        self.mint_internal(receiver_id, kind)
    }

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.transfer_nft(&sender, &receiver_id, &token_id, memo);
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.transfer_nft(&sender, &receiver_id, &token_id, memo);
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_ON_TRANSFER)
            .nft_on_transfer(sender.clone(), sender.clone(), token_id.clone(), msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).nft_resolve_transfer(sender, receiver_id, token_id))
            .into()
    }

    #[private]
    pub fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String) -> bool {
        let return_it = match env::promise_result_checked(0, 16) {
            Ok(v) => serde_json::from_slice::<bool>(&v).unwrap_or(true),
            Err(_) => true,
        };
        if !return_it {
            return true;
        }
        if self.packs.get(&token_id).map(|t| t.owner_id == receiver_id).unwrap_or(false) {
            self.move_nft(&receiver_id, &previous_owner_id, &token_id);
            nep171("nft_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": previous_owner_id, "token_ids": [token_id] }));
            return false;
        }
        true
    }

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        self.packs.get(&token_id).map(|p| json_token(&token_id, p))
    }
    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Kraterra Munitions".into(),
            symbol: "KRATER".into(),
            icon: Some(crate_svg(0)),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
    pub fn nft_total_supply(&self) -> near_sdk::json_types::U128 {
        near_sdk::json_types::U128(self.pack_ids.len() as u128)
    }
    pub fn nft_tokens(&self, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let start = from_index.map(|i| i.0 as u32).unwrap_or(0);
        let lim = limit.unwrap_or(50).min(100) as u32;
        (start..self.pack_ids.len().min(start.saturating_add(lim)))
            .filter_map(|i| {
                let id = self.pack_ids.get(i)?;
                self.packs.get(id).map(|p| json_token(id, p))
            })
            .collect()
    }
    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> near_sdk::json_types::U128 {
        near_sdk::json_types::U128(self.owned.get(&account_id).map(|s| s.len()).unwrap_or(0) as u128)
    }
    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let Some(set) = self.owned.get(&account_id) else { return vec![] };
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        set.iter().skip(start).take(limit.unwrap_or(50).min(100) as usize).filter_map(|id| self.packs.get(id).map(|p| json_token(id, p))).collect()
    }
}

// ---------- internals ----------

impl Kraterra {
    fn mint_internal(&mut self, owner: AccountId, kind: u8) -> String {
        let id = format!("pack-{}", self.pack_ids.len());
        self.packs.insert(id.clone(), Pack { owner_id: owner.clone(), kind, minted_ms: U64(env::block_timestamp_ms()) });
        self.pack_ids.push(id.clone());
        self.add_owned(&owner, &id);
        nep171("nft_mint", json!({ "owner_id": owner, "token_ids": [id], "memo": format!("{} pack", PACK_NAMES[kind as usize]) }));
        id
    }

    fn add_owned(&mut self, owner: &AccountId, id: &str) {
        if self.owned.get(owner).is_none() {
            self.owned.insert(owner.clone(), IterableSet::new(Key::OwnedSet { owner_hash: env::sha256(owner.as_bytes()) }));
        }
        self.owned.get_mut(owner).unwrap().insert(id.to_string());
    }

    fn transfer_nft(&mut self, sender: &AccountId, receiver: &AccountId, token_id: &str, memo: Option<String>) {
        let p = self.packs.get(token_id).unwrap_or_else(|| env::panic_str("no such token"));
        require!(&p.owner_id == sender, "only the owner can transfer");
        require!(sender != receiver, "already yours");
        self.move_nft(sender, receiver, token_id);
        let mut data = json!({ "old_owner_id": sender, "new_owner_id": receiver, "token_ids": [token_id] });
        if let Some(m) = memo {
            data["memo"] = json!(m);
        }
        nep171("nft_transfer", data);
    }

    fn move_nft(&mut self, from: &AccountId, to: &AccountId, token_id: &str) {
        self.packs.get_mut(token_id).unwrap().owner_id = to.clone();
        if let Some(set) = self.owned.get_mut(from) {
            set.remove(token_id);
        }
        self.add_owned(to, token_id);
    }
}

fn json_token(id: &str, p: &Pack) -> JsonToken {
    let k = p.kind as usize;
    JsonToken {
        token_id: id.to_string(),
        owner_id: p.owner_id.clone(),
        metadata: TokenMetadata {
            title: Some(format!("{} pack", PACK_NAMES[k])),
            description: Some(format!(
                "A Kraterra munition pack. Its owner can draft {} into any match: {}",
                PACK_NAMES[k], PACK_BLURBS[k]
            )),
            media: Some(crate_svg(p.kind)),
            copies: Some(1),
            issued_at: Some(p.minted_ms.0.to_string()),
            extra: Some(json!({ "kind": p.kind, "weapon": RARE_IDS[k] }).to_string()),
        },
    }
}

/// A voxel-style ammo crate, drawn onchain, coloured by its kind.
pub fn crate_svg(kind: u8) -> String {
    let c = PACK_COLORS[(kind as usize) % 3];
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' shape-rendering='crispEdges'>\
<rect width='32' height='32' fill='#141019'/>\
<rect x='0' y='26' width='32' height='6' fill='#3a2a1c'/><rect x='0' y='25' width='32' height='1' fill='#5c8a3a'/>\
<rect x='6' y='12' width='20' height='13' fill='#6b4a2a'/><rect x='6' y='10' width='20' height='3' fill='#8a6238'/>\
<rect x='6' y='12' width='2' height='13' fill='#4a321c'/><rect x='24' y='12' width='2' height='13' fill='#4a321c'/>\
<rect x='8' y='17' width='16' height='2' fill='#4a321c'/>\
<rect x='13' y='14' width='6' height='9' fill='{c}'/><rect x='14' y='15' width='4' height='2' fill='#ffffff' opacity='.6'/>\
<rect x='14' y='4' width='4' height='4' fill='{c}'/><rect x='15' y='2' width='2' height='2' fill='#ffffff'/>\
<rect x='9' y='6' width='2' height='2' fill='{c}' opacity='.7'/><rect x='22' y='5' width='2' height='2' fill='{c}' opacity='.7'/>\
</svg>"
    );
    format!("data:image/svg+xml;utf8,{}", svg.replace('#', "%23").replace('<', "%3C").replace('>', "%3E"))
}
